import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { configuration } from '../../config.js';
import {
  frameFields,
  parseRefreshCredential,
  type ParsedRefreshCredential,
  type SessionTransportClass,
} from '../../platform/web-bff-authority.js';
import type { SessionResponse } from './auth.service.js';

const successorContext = 'spott:refresh-successor';
const successorVersion = 'v2';
const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const minimumBindingProofLength = 32;
const maximumBindingProofLength = 1_024;

export interface DeviceBindingProof {
  readonly bindingId: string;
  readonly generation: number;
  readonly proof: string;
}

export interface RefreshMutationInput {
  readonly refreshToken: string;
  readonly deviceId: string;
  readonly attemptKey?: string | undefined;
  readonly deviceBindingProof?: DeviceBindingProof | undefined;
}

export interface SessionTokenResponse extends SessionResponse {
  readonly refreshGeneration: number;
}

export type RefreshMutationOutcome =
  | { readonly kind: 'rotated'; readonly session: SessionTokenResponse }
  | { readonly kind: 'recovered'; readonly session: SessionTokenResponse }
  | { readonly kind: 'reused'; readonly sessionId: string; readonly familyId: string }
  | { readonly kind: 'reauth_required' }
  | { readonly kind: 'invalid' };

export interface RefreshSuccessorDerivationInput {
  readonly key: Buffer;
  readonly version: string;
  readonly kid: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly predecessorGeneration: number;
  readonly predecessorHash: Buffer;
  readonly successorGeneration: number;
  readonly attemptHash: Buffer;
  readonly bindingId: string;
  readonly bindingGeneration: number;
}

interface LockedSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly device_id: string;
  readonly refresh_hash: Buffer;
  readonly refresh_family_id: string;
  readonly refresh_generation: string;
  readonly current_derivation_kid: string | null;
  readonly current_binding_id: string | null;
  readonly current_binding_generation: string | null;
  readonly expires_at: Date;
  readonly session_unexpired: boolean;
  readonly revoked_at: Date | null;
  readonly reuse_detected_at: Date | null;
  readonly transport_class: SessionTransportClass;
  readonly public_handle: string;
  readonly status: string;
  readonly phone_verified_at: Date | null;
  readonly restriction_flags: string[];
}

interface RefreshHistoryRow {
  readonly session_id: string;
  readonly family_id: string;
  readonly generation: string;
  readonly token_hash: Buffer;
  readonly derivation_kid: string | null;
  readonly transport_class: SessionTransportClass;
  readonly binding_id: string | null;
  readonly binding_generation: string | null;
  readonly state: 'current' | 'consumed' | 'revoked';
  readonly consumed_at: Date | null;
  readonly rotation_key_hash: Buffer | null;
  readonly successor_generation: string | null;
  readonly successor_hash: Buffer | null;
  readonly successor_derivation_kid: string | null;
  readonly recovery_expires_at: Date | null;
  readonly recovery_open: boolean;
}

interface BindingRow {
  readonly id: string;
  readonly generation: string;
  readonly current_hash: Buffer;
}

interface VerifiedBinding {
  readonly id: string;
  readonly generation: number;
}

export function parseRefreshToken(value: unknown): ParsedRefreshCredential | null {
  return parseRefreshCredential(value);
}

export function deriveSuccessorSecret(input: RefreshSuccessorDerivationInput): string {
  if (input.key.byteLength < 32) throw new Error('Refresh successor key must contain at least 32 bytes');
  if (!input.version || !input.kid) throw new Error('Refresh successor version and KID are required');
  if (!canonicalUUIDPattern.test(input.sessionId) || !canonicalUUIDPattern.test(input.familyId)
    || !canonicalUUIDPattern.test(input.bindingId)) {
    throw new Error('Refresh successor identifiers must be canonical UUIDs');
  }
  for (const generation of [
    input.predecessorGeneration,
    input.successorGeneration,
    input.bindingGeneration,
  ]) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw new Error('Refresh successor generations must be non-negative safe integers');
    }
  }
  if (input.predecessorHash.byteLength !== 32 || input.attemptHash.byteLength !== 32) {
    throw new Error('Refresh successor hashes must contain exactly 32 bytes');
  }

  return createHmac('sha256', input.key).update(frameFields([
    successorContext,
    input.version,
    input.kid,
    input.sessionId,
    input.familyId,
    String(input.predecessorGeneration),
    input.predecessorHash.toString('hex'),
    String(input.successorGeneration),
    input.attemptHash.toString('hex'),
    input.bindingId,
    String(input.bindingGeneration),
  ])).digest('base64url');
}

@Injectable()
export class SessionTokenService {
  async rotate(
    client: PoolClient,
    input: RefreshMutationInput,
    verifiedTransport: SessionTransportClass,
  ): Promise<RefreshMutationOutcome> {
    const credential = parseRefreshToken(input.refreshToken);
    if (!credential || !canonicalUUIDPattern.test(input.deviceId)) return { kind: 'invalid' };
    const attemptHash = this.attemptHash(input.attemptKey);
    if (input.attemptKey !== undefined && attemptHash === null) return { kind: 'invalid' };
    if (input.deviceBindingProof !== undefined && !this.validBindingProofShape(input.deviceBindingProof)) {
      return { kind: 'invalid' };
    }

    const session = await this.lockSession(client, credential.sessionId);
    if (!session || session.device_id !== input.deviceId
      || session.transport_class !== verifiedTransport) {
      return { kind: 'invalid' };
    }
    if (session.revoked_at || session.reuse_detected_at || !session.session_unexpired) {
      return { kind: 'reauth_required' };
    }

    const currentGeneration = this.generation(session.refresh_generation);
    if (currentGeneration === null) return { kind: 'invalid' };
    const predecessorHash = this.refreshHash(credential.secret);
    const matchesCurrent = this.equalHash(predecessorHash, session.refresh_hash);
    const storedLegacyCredential = currentGeneration === 0
      && session.current_derivation_kid === null;
    const canonicalCurrentRepresentation = credential.version === 'legacy'
      ? storedLegacyCredential
      : !storedLegacyCredential && credential.generation === currentGeneration;

    if (matchesCurrent) {
      if (!canonicalCurrentRepresentation) return { kind: 'invalid' };
      return this.rotateCurrent(
        client,
        input,
        credential,
        session,
        currentGeneration,
        predecessorHash,
        attemptHash,
      );
    }

    return this.recoverConsumed(
      client,
      input,
      credential,
      session,
      currentGeneration,
      predecessorHash,
      attemptHash,
    );
  }

  private async rotateCurrent(
    client: PoolClient,
    input: RefreshMutationInput,
    credential: ParsedRefreshCredential,
    session: LockedSessionRow,
    predecessorGeneration: number,
    predecessorHash: Buffer,
    attemptHash: Buffer | null,
  ): Promise<RefreshMutationOutcome> {
    const predecessor = await this.lockHistoryGeneration(client, session.id, predecessorGeneration);
    if (!this.isCurrentHistory(predecessor, session, predecessorGeneration, predecessorHash)) {
      return { kind: 'invalid' };
    }

    let binding: VerifiedBinding | null = null;
    if (attemptHash !== null && input.deviceBindingProof !== undefined) {
      binding = await this.verifyBinding(client, session, input.deviceBindingProof);
      if (!binding) return { kind: 'reauth_required' };
    }

    const hasCompleteRecoveryProof = attemptHash !== null && input.deviceBindingProof !== undefined;
    const compatibilityAllowed = credential.version === 'legacy'
      || session.transport_class === 'native'
      || session.transport_class === 'ops'
      || session.transport_class === 'legacy_unclassified';
    if (!hasCompleteRecoveryProof && !compatibilityAllowed) return { kind: 'reauth_required' };

    const keyring = configuration().REFRESH_TOKEN_DERIVATION_KEYS;
    const recoveryMaterial = credential.version === 's2'
      && attemptHash !== null
      && binding !== null
      ? { attemptHash, binding, kid: keyring.currentKid }
      : null;
    const successorGeneration = predecessorGeneration + 1;
    if (!Number.isSafeInteger(successorGeneration)) return { kind: 'reauth_required' };
    const successorKid = recoveryMaterial?.kid ?? null;
    const successorSecret = recoveryMaterial
      ? deriveSuccessorSecret({
          key: this.requiredDerivationKey(recoveryMaterial.kid),
          version: successorVersion,
          kid: recoveryMaterial.kid,
          sessionId: session.id,
          familyId: session.refresh_family_id,
          predecessorGeneration,
          predecessorHash,
          successorGeneration,
          attemptHash: recoveryMaterial.attemptHash,
          bindingId: recoveryMaterial.binding.id,
          bindingGeneration: recoveryMaterial.binding.generation,
        })
      : randomBytes(32).toString('base64url');
    const successorHash = this.refreshHash(successorSecret);

    const updatedSession = await client.query<{ id: string }>(
      `UPDATE identity.sessions
       SET refresh_hash = $5,
           refresh_generation = $4,
           current_derivation_kid = $6,
           current_binding_id = COALESCE($7::uuid, current_binding_id),
           current_binding_generation = CASE
             WHEN $7::uuid IS NULL THEN current_binding_generation ELSE $8::bigint END
       WHERE id = $1 AND refresh_generation = $2::bigint AND refresh_hash = $3
         AND revoked_at IS NULL AND reuse_detected_at IS NULL
         AND expires_at > clock_timestamp()
       RETURNING id`,
      [
        session.id,
        predecessorGeneration,
        predecessorHash,
        successorGeneration,
        successorHash,
        successorKid,
        binding?.id ?? null,
        binding?.generation ?? null,
      ],
    );
    if (updatedSession.rowCount !== 1) throw new Error('Stable refresh session update lost its row lock');

    if (recoveryMaterial) {
      const consumed = await client.query<{ generation: string }>(
        `UPDATE identity.session_refresh_history
         SET state = 'consumed', consumed_reason = 'rotated', consumed_at = clock_timestamp(),
             rotation_key_hash = $3, successor_generation = $4::bigint,
             successor_hash = $5, successor_derivation_kid = $6,
             binding_id = $7, binding_generation = $8::bigint,
             recovery_expires_at = clock_timestamp() + make_interval(secs => $9::integer)
         WHERE session_id = $1 AND generation = $2::bigint AND state = 'current'
         RETURNING generation`,
        [
          session.id,
          predecessorGeneration,
          recoveryMaterial.attemptHash,
          successorGeneration,
          successorHash,
          successorKid,
          recoveryMaterial.binding.id,
          recoveryMaterial.binding.generation,
          configuration().WEB_SESSION_RECOVERY_SECONDS,
        ],
      );
      if (consumed.rowCount !== 1) throw new Error('Stable refresh predecessor was not current');
    } else {
      const consumed = await client.query<{ generation: string }>(
        `UPDATE identity.session_refresh_history
         SET state = 'consumed', consumed_reason = 'rotated', consumed_at = clock_timestamp(),
             rotation_key_hash = NULL, successor_generation = NULL, successor_hash = NULL,
             successor_derivation_kid = NULL, recovery_expires_at = NULL
         WHERE session_id = $1 AND generation = $2::bigint AND state = 'current'
         RETURNING generation`,
        [session.id, predecessorGeneration],
      );
      if (consumed.rowCount !== 1) throw new Error('Compatibility refresh predecessor was not current');
    }

    const inserted = await client.query<{ generation: string }>(
      `INSERT INTO identity.session_refresh_history(
         session_id, family_id, generation, token_hash, derivation_kid,
         transport_class, binding_id, binding_generation, state
       ) VALUES ($1, $2, $3::bigint, $4, $5, $6, $7, $8::bigint, 'current')
       RETURNING generation`,
      [
        session.id,
        session.refresh_family_id,
        successorGeneration,
        successorHash,
        successorKid,
        session.transport_class,
        binding?.id ?? null,
        binding?.generation ?? null,
      ],
    );
    if (inserted.rowCount !== 1) throw new Error('Stable refresh successor history was not inserted');

    return {
      kind: 'rotated',
      session: await this.sessionResponse(
        client,
        session,
        successorGeneration,
        successorSecret,
      ),
    };
  }

  private async recoverConsumed(
    client: PoolClient,
    input: RefreshMutationInput,
    credential: ParsedRefreshCredential,
    session: LockedSessionRow,
    currentGeneration: number,
    predecessorHash: Buffer,
    attemptHash: Buffer | null,
  ): Promise<RefreshMutationOutcome> {
    const predecessor = await this.lockHistoryHash(client, session.id, predecessorHash);
    if (!predecessor || predecessor.state !== 'consumed'
      || predecessor.session_id !== session.id
      || predecessor.family_id !== session.refresh_family_id
      || predecessor.transport_class !== session.transport_class
      || !this.equalHash(predecessor.token_hash, predecessorHash)) {
      return { kind: 'invalid' };
    }
    const predecessorGeneration = this.generation(predecessor.generation);
    if (predecessorGeneration === null
      || credential.version === 'legacy'
      || credential.generation !== predecessorGeneration) {
      return credential.version === 'legacy' ? { kind: 'reauth_required' } : { kind: 'invalid' };
    }
    if (attemptHash === null || input.deviceBindingProof === undefined
      || predecessor.rotation_key_hash === null
      || predecessor.binding_id === null
      || predecessor.binding_generation === null) {
      return { kind: 'reauth_required' };
    }
    const recordedBindingGeneration = this.generation(predecessor.binding_generation);
    if (recordedBindingGeneration === null
      || input.deviceBindingProof.bindingId !== predecessor.binding_id
      || input.deviceBindingProof.generation !== recordedBindingGeneration) {
      return { kind: 'reauth_required' };
    }
    const binding = await this.verifyBinding(client, session, input.deviceBindingProof);
    if (!binding) return { kind: 'reauth_required' };
    if (!this.equalHash(attemptHash, predecessor.rotation_key_hash)) {
      const revoked = await client.query<{ id: string }>(
        `UPDATE identity.sessions
         SET reuse_detected_at = COALESCE(reuse_detected_at, clock_timestamp()),
             revoked_at = COALESCE(revoked_at, clock_timestamp())
         WHERE refresh_family_id = $1 AND revoked_at IS NULL
         RETURNING id`,
        [session.refresh_family_id],
      );
      if (!revoked.rowCount) throw new Error('Refresh reuse family had no active session to revoke');
      return { kind: 'reused', sessionId: session.id, familyId: session.refresh_family_id };
    }
    if (!predecessor.recovery_open
      || predecessor.successor_generation === null
      || predecessor.successor_hash === null
      || predecessor.successor_derivation_kid === null) {
      return { kind: 'reauth_required' };
    }

    const successorGeneration = this.generation(predecessor.successor_generation);
    const expectedSuccessorGeneration = predecessorGeneration + 1;
    if (!Number.isSafeInteger(expectedSuccessorGeneration)
      || successorGeneration === null
      || successorGeneration !== expectedSuccessorGeneration
      || successorGeneration !== currentGeneration
      || session.current_derivation_kid !== predecessor.successor_derivation_kid
      || !this.equalHash(session.refresh_hash, predecessor.successor_hash)) {
      return { kind: 'reauth_required' };
    }
    const successor = await this.lockHistoryGeneration(client, session.id, successorGeneration);
    if (!successor || successor.state !== 'current'
      || successor.family_id !== session.refresh_family_id
      || successor.transport_class !== session.transport_class
      || successor.derivation_kid !== predecessor.successor_derivation_kid
      || successor.binding_id !== binding.id
      || this.generation(successor.binding_generation) !== binding.generation
      || !this.equalHash(successor.token_hash, predecessor.successor_hash)) {
      return { kind: 'reauth_required' };
    }
    const derivationKey = configuration().REFRESH_TOKEN_DERIVATION_KEYS.getKey(
      predecessor.successor_derivation_kid,
    );
    if (!derivationKey) return { kind: 'reauth_required' };
    const successorSecret = deriveSuccessorSecret({
      key: derivationKey,
      version: successorVersion,
      kid: predecessor.successor_derivation_kid,
      sessionId: session.id,
      familyId: session.refresh_family_id,
      predecessorGeneration,
      predecessorHash: predecessor.token_hash,
      successorGeneration,
      attemptHash,
      bindingId: binding.id,
      bindingGeneration: binding.generation,
    });
    const reconstructedHash = this.refreshHash(successorSecret);
    if (!this.equalHash(reconstructedHash, predecessor.successor_hash)
      || !this.equalHash(reconstructedHash, session.refresh_hash)
      || !this.equalHash(reconstructedHash, successor.token_hash)) {
      return { kind: 'reauth_required' };
    }

    return {
      kind: 'recovered',
      session: await this.sessionResponse(client, session, successorGeneration, successorSecret),
    };
  }

  private async lockSession(client: PoolClient, id: string): Promise<LockedSessionRow | null> {
    const result = await client.query<LockedSessionRow>(
      `SELECT session.id, session.user_id, session.device_id, session.refresh_hash,
              session.refresh_family_id, session.refresh_generation,
              session.current_derivation_kid, session.current_binding_id,
              session.current_binding_generation, session.expires_at,
              session.expires_at > clock_timestamp() AS session_unexpired, session.revoked_at,
              session.reuse_detected_at, session.transport_class,
              user_record.public_handle, user_record.status, user_record.phone_verified_at,
              user_record.restriction_flags
       FROM identity.sessions AS session
       JOIN identity.users AS user_record ON user_record.id = session.user_id
       WHERE session.id = $1 AND user_record.deleted_at IS NULL
       FOR UPDATE OF session`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  private async lockHistoryGeneration(
    client: PoolClient,
    id: string,
    generation: number,
  ): Promise<RefreshHistoryRow | null> {
    const result = await client.query<RefreshHistoryRow>(
      `SELECT session_id, family_id, generation, token_hash, derivation_kid,
              transport_class, binding_id, binding_generation, state, consumed_at,
              rotation_key_hash, successor_generation, successor_hash,
              successor_derivation_kid, recovery_expires_at,
              recovery_expires_at > clock_timestamp() AS recovery_open
       FROM identity.session_refresh_history
       WHERE session_id = $1 AND generation = $2::bigint
       FOR UPDATE`,
      [id, generation],
    );
    return result.rows[0] ?? null;
  }

  private async lockHistoryHash(
    client: PoolClient,
    id: string,
    tokenHash: Buffer,
  ): Promise<RefreshHistoryRow | null> {
    const result = await client.query<RefreshHistoryRow>(
      `SELECT session_id, family_id, generation, token_hash, derivation_kid,
              transport_class, binding_id, binding_generation, state, consumed_at,
              rotation_key_hash, successor_generation, successor_hash,
              successor_derivation_kid, recovery_expires_at,
              recovery_expires_at > clock_timestamp() AS recovery_open
       FROM identity.session_refresh_history
       WHERE session_id = $1 AND token_hash = $2
       FOR UPDATE`,
      [id, tokenHash],
    );
    return result.rows[0] ?? null;
  }

  private isCurrentHistory(
    history: RefreshHistoryRow | null,
    session: LockedSessionRow,
    generation: number,
    predecessorHash: Buffer,
  ): boolean {
    return history !== null
      && history.state === 'current'
      && history.session_id === session.id
      && history.family_id === session.refresh_family_id
      && history.transport_class === session.transport_class
      && history.derivation_kid === session.current_derivation_kid
      && this.generation(history.generation) === generation
      && this.equalHash(history.token_hash, predecessorHash)
      && this.equalHash(history.token_hash, session.refresh_hash);
  }

  private async verifyBinding(
    client: PoolClient,
    session: LockedSessionRow,
    proof: DeviceBindingProof,
  ): Promise<VerifiedBinding | null> {
    if (session.current_binding_id !== proof.bindingId
      || this.generation(session.current_binding_generation) !== proof.generation) {
      return null;
    }
    const result = await client.query<BindingRow>(
      `SELECT id, generation, current_hash
       FROM identity.device_bindings
       WHERE id = $1 AND user_id = $2 AND device_id = $3 AND session_id = $4
         AND generation = $5::bigint AND proof_class = 'persistent'
         AND revoked_at IS NULL AND absolute_expires_at > clock_timestamp()
       FOR UPDATE`,
      [proof.bindingId, session.user_id, session.device_id, session.id, proof.generation],
    );
    const binding = result.rows[0];
    if (!binding || this.generation(binding.generation) !== proof.generation
      || !this.equalHash(this.bindingHash(proof.proof), binding.current_hash)) {
      return null;
    }
    return { id: binding.id, generation: proof.generation };
  }

  private async sessionResponse(
    client: PoolClient,
    session: LockedSessionRow,
    generation: number,
    secret: string,
  ): Promise<SessionTokenResponse> {
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const admin = await client.query<{ roles: string[] }>(
      `SELECT roles FROM admin.admin_users
       WHERE identity_user_id = $1 AND disabled_at IS NULL AND mfa_enrolled_at IS NOT NULL`,
      [session.user_id],
    );
    const roles = admin.rows[0] ? ['operator', ...admin.rows[0].roles] : ['user'];
    const accessToken = await new SignJWT({
      sid: session.id,
      phoneVerified: session.phone_verified_at !== null,
      restrictions: session.restriction_flags,
      roles,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('spott-api')
      .setAudience('spott-clients')
      .setSubject(session.user_id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET));
    return {
      accessToken,
      accessTokenExpiresAt: expiresAt.toISOString(),
      refreshToken: `s2.${session.id}.${generation}.${secret}`,
      refreshGeneration: generation,
      sessionId: session.id,
      user: {
        id: session.user_id,
        publicHandle: session.public_handle,
        phoneVerified: session.phone_verified_at !== null,
        restrictions: session.restriction_flags,
      },
    };
  }

  private attemptHash(value: string | undefined): Buffer | null {
    if (value === undefined) return null;
    if (!canonicalUUIDPattern.test(value)) return null;
    return createHash('sha256').update(value).digest();
  }

  private validBindingProofShape(proof: DeviceBindingProof): boolean {
    return canonicalUUIDPattern.test(proof.bindingId)
      && Number.isSafeInteger(proof.generation)
      && proof.generation >= 0
      && typeof proof.proof === 'string'
      && proof.proof.length >= minimumBindingProofLength
      && proof.proof.length <= maximumBindingProofLength;
  }

  private refreshHash(secret: string): Buffer {
    return createHmac('sha256', configuration().REFRESH_TOKEN_SECRET).update(secret).digest();
  }

  private bindingHash(proof: string): Buffer {
    return createHash('sha256').update(proof).digest();
  }

  private equalHash(left: Buffer, right: Buffer): boolean {
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private generation(value: string | number | null): number | null {
    if (value === null) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private requiredDerivationKey(kid: string): Buffer {
    const key = configuration().REFRESH_TOKEN_DERIVATION_KEYS.getKey(kid);
    if (!key) throw new Error('Current refresh derivation KID is unavailable');
    return key;
  }
}
