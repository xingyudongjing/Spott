import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { createRemoteJWKSet, jwtVerify, SignJWT } from 'jose';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { configuration } from '../../config.js';
import { Database } from '../../platform/database.js';
import { FieldCrypto } from '../../platform/crypto.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import { webSessionCompletionAcceptedSQL } from '../../platform/web-session-completion-disposition.js';
import {
  decideTransport,
  parseRefreshCredential,
  type SessionRequestChannel,
  type SessionTransportClass,
  type VerifiedBFFAuthority,
} from '../../platform/web-bff-authority.js';
import {
  webRefreshEnvelopeDBClaimsSchema,
  type WebRefreshEnvelopeDBClaims,
} from './refresh-envelope-claims.js';
import {
  isCanonicalPersistentDeviceBindingProof,
  lockSessionMutationUser,
  persistentDeviceBindingHash,
  SessionTokenService,
  type DeviceBindingProof,
  type WebLogoutInput,
  type WebLogoutOutcome,
} from './session-token.service.js';
import {
  completionAttemptHash,
  completionDispositionAuthorityDigest,
  completionRequestDigest,
  deriveInitialWebRefreshSecret,
} from './web-session-completion-kdf.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z.string().regex(/^\+81[1-9][0-9]{8,9}$/);
const deviceSchema = z.string().uuid();
const canonicalUUIDSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
);
const codeSchema = z.string().regex(/^[0-9]{6}$/);
const persistentDeviceBindingProofSchema = z
  .object({
    bindingId: z.string().uuid(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    proof: z.string().refine(isCanonicalPersistentDeviceBindingProof),
    proofClass: z.literal('persistent'),
  })
  .strict();
export const deviceBindingUpgradeInputSchema = z
  .object({
    refreshToken: z.string(),
    deviceId: z.string().uuid(),
    attemptId: z.string().uuid(),
    newBinding: persistentDeviceBindingProofSchema.extend({ generation: z.literal(0) }),
  })
  .strict();

export type PersistentDeviceBindingProof = z.infer<typeof persistentDeviceBindingProofSchema>;
export type DeviceBindingUpgradeInput = z.infer<typeof deviceBindingUpgradeInputSchema>;

export const webEmailSessionCompletionInputSchema = z
  .object({
    credential: z
      .object({
        provider: z.literal('email'),
        challengeId: canonicalUUIDSchema,
        code: codeSchema,
      })
      .strict(),
    deviceId: canonicalUUIDSchema,
    attemptId: canonicalUUIDSchema,
    newBinding: persistentDeviceBindingProofSchema.extend({
      bindingId: canonicalUUIDSchema,
      generation: z.literal(0),
    }),
  })
  .strict();

export type WebEmailSessionCompletionInput = z.infer<
  typeof webEmailSessionCompletionInputSchema
>;

export const webSessionCompletionDispositionInputSchema = z
  .object({
    challengeId: canonicalUUIDSchema,
    deviceId: canonicalUUIDSchema,
    binding: persistentDeviceBindingProofSchema.extend({
      bindingId: canonicalUUIDSchema,
      generation: z.literal(0),
    }),
  })
  .strict();

export type WebSessionCompletionDispositionInput = z.infer<
  typeof webSessionCompletionDispositionInputSchema
>;

export const webSessionCompletionReconciliationSeconds = 2_678_400;

export interface WebSessionCompletionPendingResult {
  readonly state: 'pending';
  readonly sessionId: string;
  readonly bindingId: string;
  readonly deviceId: string;
}

export type WebSessionCompletionDispositionResult =
  | {
      readonly state: 'accepted';
      readonly material: WebSessionCompletionMaterial;
    }
  | {
      readonly state: 'discarded';
      readonly sessionId?: string | undefined;
      readonly bindingId: string;
      readonly deviceId: string;
    };

export type WebSessionCompletionRevocationResult =
  | Extract<WebSessionCompletionDispositionResult, { state: 'discarded' }>
  | {
      readonly state: 'revoked';
      readonly sessionId: string;
      readonly bindingId: string;
      readonly deviceId: string;
    };

interface UserRow {
  id: string;
  public_handle: string;
  status: string;
  phone_verified_at: Date | null;
  restriction_flags: string[];
}

interface BootstrapSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  device_user_id: string;
  device_risk_state: string;
  refresh_hash: Buffer;
  refresh_family_id: string;
  refresh_generation: string;
  current_derivation_kid: string | null;
  current_binding_id: string | null;
  current_binding_generation: string | null;
  transport_class: SessionTransportClass;
  session_active: boolean;
  history_session_id: string;
  history_family_id: string;
  history_generation: string;
  history_token_hash: Buffer;
  history_derivation_kid: string | null;
  history_transport_class: SessionTransportClass;
  history_binding_id: string | null;
  history_binding_generation: string | null;
  history_state: 'current' | 'consumed' | 'revoked';
  binding_id: string;
  binding_generation: string;
  binding_current_hash: Buffer;
  binding_current_kid: string;
  binding_proof_class: string;
  binding_active: boolean;
  user_status: string;
  public_handle: string;
  phone_verified_at: Date | null;
  restriction_flags: string[];
  admin_roles: string[];
}

interface BindingUpgradeSessionRow {
  id: string;
  user_id: string;
  device_id: string;
  device_user_id: string;
  device_risk_state: string;
  refresh_hash: Buffer;
  refresh_family_id: string;
  refresh_generation: string;
  current_derivation_kid: string | null;
  current_binding_id: string | null;
  current_binding_generation: string | null;
  transport_class: SessionTransportClass;
  expires_at: Date;
  session_active: boolean;
  user_status: string;
  public_handle: string;
  phone_verified_at: Date | null;
  restriction_flags: string[];
}

interface BindingUpgradeHistoryRow {
  session_id: string;
  family_id: string;
  generation: string;
  token_hash: Buffer;
  derivation_kid: string | null;
  transport_class: SessionTransportClass;
  binding_id: string | null;
  binding_generation: string | null;
  state: 'current' | 'consumed' | 'revoked';
}

interface IssuedBindingRow {
  id?: string;
  generation?: string;
  current_hash?: Buffer;
  current_kid?: string;
  issued_at: Date;
  absolute_expires_at: Date;
  revoked_at?: Date | null;
}

interface WebCompletionChallengeRow {
  id: string;
  email_hash: Buffer;
  email_cipher: Buffer;
  code_hash: Buffer;
  device_id: string;
  attempts: number;
  expires_at: Date;
  verified_at: Date | null;
  suspended_until: Date | null;
  unexpired: boolean;
  unsuspended: boolean;
}

interface WebCompletionOutcomeRow {
  challenge_id: string;
  attempt_hash: Buffer;
  request_digest: Buffer;
  user_id: string;
  device_id: string;
  session_id: string;
  family_id: string;
  binding_id: string;
  refresh_generation: string;
  binding_generation: string;
  derivation_version: 'v1';
  derivation_kid: string;
  recovery_expires_at: Date;
}

interface WebCompletionDispositionRow {
  attempt_hash: Buffer;
  challenge_id: string;
  device_id: string;
  binding_id: string;
  binding_generation: string;
  authority_digest: Buffer;
  authority_version: 'v1' | 'legacy-v0';
  authority_kid: string;
  state: 'pending' | 'accepted' | 'discarded';
  session_id: string | null;
  decision_expires_at: Date;
  retained_until: Date;
  decision_open: boolean;
  retention_open: boolean;
}

interface WebCompletionRecoveryRow extends WebCompletionOutcomeRow {
  recovery_active: boolean;
  session_refresh_hash: Buffer;
  session_derivation_kid: string | null;
  session_binding_id: string | null;
  session_binding_generation: string | null;
  session_expires_at: Date;
  session_active: boolean;
  transport_class: SessionTransportClass;
  history_family_id: string;
  history_token_hash: Buffer;
  history_derivation_kid: string | null;
  history_binding_id: string | null;
  history_binding_generation: string | null;
  history_state: 'current' | 'consumed' | 'revoked';
  binding_current_hash: Buffer;
  binding_current_kid: string;
  binding_issued_at: Date;
  binding_absolute_expires_at: Date;
  binding_active: boolean;
  binding_proof_class: string;
  public_handle: string;
  user_status: string;
  user_active: boolean;
  phone_verified_at: Date | null;
  restriction_flags: string[];
  device_risk_state: string;
}

export interface DeviceBindingUpgradeMaterial {
  sessionId: string;
  refreshFamilyId: string;
  refreshGeneration: number;
  transportClass: 'web_bff';
  bindingId: string;
  bindingGeneration: number;
  bindingIssuedAt: string;
  bindingAbsoluteExpiresAt: string;
  refreshTokenExpiresAt: string;
  user: {
    id: string;
    publicHandle: string;
    phoneVerified: boolean;
    restrictions: string[];
  };
}

export interface SessionResponse {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshGeneration: number;
  sessionId: string;
  user: {
    id: string;
    publicHandle: string;
    phoneVerified: boolean;
    restrictions: string[];
  };
}

export interface WebSessionCompletionMaterial extends SessionResponse {
  refreshFamilyId: string;
  refreshTokenExpiresAt: string;
  transportClass: 'web_bff';
  bindingId: string;
  bindingGeneration: 0;
  bindingIssuedAt: string;
  bindingAbsoluteExpiresAt: string;
}

export type ApplePlatform = 'ios' | 'web';

export type MergeCredential =
  | { provider: 'apple'; identityToken: string; nonce: string; platform: ApplePlatform }
  | { provider: 'google'; idToken: string }
  | { provider: 'email'; challengeId: string; code: string };

interface VerifiedMergeCredential {
  provider: 'apple' | 'google' | 'email';
  subject: string;
  credentialHash: Buffer;
}

interface MergeImpactRow {
  source_owned_events: string;
  source_owned_groups: string;
  source_paid_balance: string;
  source_free_balance: string;
  target_paid_balance: string;
  target_free_balance: string;
  phone_conflict: boolean;
  registration_conflicts: string;
  membership_conflicts: string;
  admin_account: boolean;
}

export function appleAudienceForPlatform(
  platform: ApplePlatform,
  config: { APPLE_BUNDLE_ID: string; APPLE_SERVICE_ID?: string | undefined },
): string {
  if (platform === 'ios') return config.APPLE_BUNDLE_ID;
  if (!config.APPLE_SERVICE_ID) {
    throw new DomainError('AUTH_PROVIDER_DISABLED', 'Web 端 Apple 登录暂未开放。', 503, {
      retryable: false,
    });
  }
  return config.APPLE_SERVICE_ID;
}

export function appleNonceDigest(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

@Injectable()
export class AuthService {
  private readonly appleKeys = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));
  private readonly googleKeys = createRemoteJWKSet(
    new URL('https://www.googleapis.com/oauth2/v3/certs'),
  );

  constructor(
    private readonly database: Database,
    private readonly crypto: FieldCrypto,
    private readonly idempotency: IdempotencyService,
    private readonly sessionTokens: SessionTokenService,
  ) {}

  async createEmailChallenge(
    emailValue: string,
    deviceValue: string,
  ): Promise<Record<string, unknown>> {
    const email = emailSchema.parse(emailValue);
    const deviceId = deviceSchema.parse(deviceValue);
    const code = this.otpCode();
    const codeHash = this.codeHash(code);
    const result = await this.database.query<{ id: string; expires_at: Date }>(
      `INSERT INTO identity.email_challenges(
         email_hash, email_cipher, code_hash, device_id, expires_at
       ) VALUES ($1, $2, $3, $4, clock_timestamp() + interval '10 minutes')
       RETURNING id, expires_at`,
      [this.crypto.lookupHash(email), this.crypto.encrypt(email), codeHash, deviceId],
    );
    const row = result.rows[0];
    if (!row)
      throw new DomainError('CHALLENGE_CREATE_FAILED', '验证码发送失败。', 503, {
        retryable: true,
      });
    // The console adapter is local-only. Production providers never return OTP material.
    if (configuration().OTP_PROVIDER === 'console')
      console.info(`[Spott OTP] email=${email} code=${code}`);
    return {
      challengeId: row.id,
      expiresAt: row.expires_at.toISOString(),
      retryAfterSeconds: 60,
      ...(configuration().NODE_ENV === 'development' ? { developmentCode: code } : {}),
    };
  }

  async verifyEmailChallenge(
    input: {
      challengeId: string;
      code: string;
      deviceId: string;
    },
    platform: 'ios' | 'web' | 'ops' = 'web',
    transportClass?: SessionTransportClass,
  ): Promise<SessionResponse> {
    const issuedTransport = transportClass ?? (platform === 'ops' ? 'ops' : undefined);
    if (!issuedTransport || this.platformForTransport(issuedTransport) !== platform) {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道校验失败，请重新登录。', 403, {
        retryable: false,
      });
    }
    const challengeId = deviceSchema.parse(input.challengeId);
    const code = codeSchema.parse(input.code);
    const deviceId = deviceSchema.parse(input.deviceId);
    const outcome = await this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        email_hash: Buffer;
        email_cipher: Buffer;
        code_hash: Buffer;
        attempts: number;
        expires_at: Date;
        verified_at: Date | null;
        suspended_until: Date | null;
      }>(
        `SELECT id, email_hash, email_cipher, code_hash, attempts, expires_at, verified_at, suspended_until
         FROM identity.email_challenges WHERE id = $1 FOR UPDATE`,
        [challengeId],
      );
      const challenge = result.rows[0];
      if (!challenge || challenge.verified_at || challenge.expires_at <= new Date()) {
        throw new DomainError('CHALLENGE_EXPIRED', '验证码已过期，请重新发送。', 400);
      }
      if (challenge.suspended_until && challenge.suspended_until > new Date()) {
        throw new DomainError('OTP_RATE_LIMITED', '尝试次数过多，请稍后再试。', 429, {
          meta: { retryAt: challenge.suspended_until.toISOString() },
        });
      }
      if (!this.matchesCode(challenge.code_hash, code)) {
        const nextAttempts = challenge.attempts + 1;
        const invalid = await client.query<{ suspended_until: Date | null }>(
          `UPDATE identity.email_challenges SET attempts = $2::integer,
             suspended_until = CASE WHEN $2::integer >= 5 THEN clock_timestamp() + interval '30 minutes' ELSE NULL END
           WHERE id = $1 RETURNING suspended_until`,
          [challengeId, Math.min(nextAttempts, 5)],
        );
        return {
          kind: 'invalid' as const,
          attempts: nextAttempts,
          retryAt: invalid.rows[0]?.suspended_until ?? null,
        };
      }
      await client.query(
        'UPDATE identity.email_challenges SET verified_at = clock_timestamp() WHERE id = $1',
        [challengeId],
      );

      const providerSubject = challenge.email_hash.toString('hex');
      let user = await this.findUserByIdentity(client, 'email', providerSubject);
      if (platform === 'ops') {
        if (!user) throw new DomainError('OPS_AUTH_FORBIDDEN', '该身份没有运营权限。', 403);
        const admin = await client.query(
          `SELECT id FROM admin.admin_users
           WHERE identity_user_id=$1 AND disabled_at IS NULL AND mfa_enrolled_at IS NOT NULL`,
          [user.id],
        );
        if (!admin.rowCount)
          throw new DomainError('OPS_AUTH_FORBIDDEN', '该身份没有运营权限或尚未完成 MFA。', 403);
      }
      if (!user) {
        user = await this.createUser(
          client,
          'email',
          providerSubject,
          challenge.email_cipher,
          challenge.email_hash,
        );
      }
      return {
        kind: 'verified' as const,
        session: await this.createSession(client, user, deviceId, platform, issuedTransport),
      };
    });
    if (outcome.kind === 'invalid') this.throwInvalidOtp(outcome.attempts, outcome.retryAt);
    return outcome.session;
  }

  async completeWebEmailSession(
    inputValue: WebEmailSessionCompletionInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<WebSessionCompletionPendingResult> {
    if (!authority) {
      throw new DomainError(
        'WEB_BFF_AUTHORITY_REQUIRED',
        '此操作必须通过安全 Web 通道完成。',
        403,
        { retryable: false },
      );
    }
    if (requestChannel !== 'verified_bff') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道不匹配，请重新登录。', 403, {
        retryable: false,
      });
    }
    const parsed = webEmailSessionCompletionInputSchema.safeParse(inputValue);
    if (!parsed.success) this.throwWebCompletionUnavailable();
    const input = parsed.data;
    const attemptHash = completionAttemptHash(input.attemptId);

    try {
      const outcome = await this.database.transaction(async (client) => {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1, 731647302894611011))',
          [input.attemptId],
        );
        const disposition = await this.lockWebCompletionDisposition(client, attemptHash);
        if (disposition) {
          this.assertWebCompletionDispositionAuthority(
            disposition,
            input.attemptId,
            {
              challengeId: input.credential.challengeId,
              deviceId: input.deviceId,
              binding: input.newBinding,
            },
          );
          if (disposition.state === 'discarded') {
            this.throwWebCompletionDiscarded();
          }
        }
        const challengeResult = await client.query<WebCompletionChallengeRow>(
          `SELECT id, email_hash, email_cipher, code_hash, device_id, attempts,
                  expires_at, verified_at, suspended_until,
                  expires_at > clock_timestamp() AS unexpired,
                  suspended_until IS NULL OR suspended_until <= clock_timestamp()
                    AS unsuspended
           FROM identity.email_challenges
           WHERE id = $1
           FOR UPDATE`,
          [input.credential.challengeId],
        );
        const challenge = challengeResult.rows[0];
        if (!challenge || challenge.device_id !== input.deviceId) {
          this.throwWebCompletionUnavailable();
        }

        const storedOutcomes = await client.query<WebCompletionOutcomeRow>(
          `SELECT challenge_id, attempt_hash, request_digest, user_id, device_id,
                  session_id, family_id, binding_id, refresh_generation,
                  binding_generation, derivation_version, derivation_kid,
                  recovery_expires_at
           FROM identity.web_session_completion_outcomes
           WHERE attempt_hash = $1 OR challenge_id = $2
           ORDER BY challenge_id
           FOR UPDATE`,
          [attemptHash, challenge.id],
        );
        if (storedOutcomes.rowCount !== 0) {
          if (!disposition) this.throwWebCompletionUnavailable();
          if (storedOutcomes.rowCount !== 1) this.throwWebCompletionUnavailable();
          const stored = storedOutcomes.rows[0];
          if (
            !stored ||
            stored.challenge_id !== challenge.id ||
            !this.sameHash(stored.attempt_hash, attemptHash) ||
            challenge.verified_at === null ||
            !this.matchesCode(challenge.code_hash, input.credential.code)
          ) {
            this.throwWebCompletionUnavailable();
          }
          await this.recoverWebEmailSession(client, input, attemptHash, stored);
          return {
            kind: 'completed' as const,
            material: {
              state: 'pending' as const,
              sessionId: stored.session_id,
              bindingId: stored.binding_id,
              deviceId: stored.device_id,
            },
          };
        }

        if (disposition) this.throwWebCompletionUnavailable();

        if (
          challenge.verified_at !== null ||
          !challenge.unexpired ||
          !challenge.unsuspended
        ) {
          this.throwWebCompletionUnavailable();
        }
        if (!this.matchesCode(challenge.code_hash, input.credential.code)) {
          // Deliberate OTP-safety exception: a rejected code may commit only the bounded
          // attempts/suspension counters. User, device, session, binding, and recovery outcome
          // creation stays outside this branch and therefore remains unchanged.
          const nextAttempts = challenge.attempts + 1;
          const invalid = await client.query<{ suspended_until: Date | null }>(
            `UPDATE identity.email_challenges
             SET attempts = $2::integer,
                 suspended_until = CASE
                   WHEN $2::integer >= 5
                     THEN clock_timestamp() + interval '30 minutes'
                   ELSE NULL
                 END
             WHERE id = $1
             RETURNING suspended_until`,
            [challenge.id, Math.min(nextAttempts, 5)],
          );
          return {
            kind: 'invalid' as const,
            attempts: nextAttempts,
            retryAt: invalid.rows[0]?.suspended_until ?? null,
          };
        }

        const providerSubject = challenge.email_hash.toString('hex');
        let user = await this.findUserByIdentity(client, 'email', providerSubject);
        if (!user) {
          user = await this.createUser(
            client,
            'email',
            providerSubject,
            challenge.email_cipher,
            challenge.email_hash,
          );
        }
        await this.prepareWebCompletionUser(client, user);
        await this.prepareOwnedDeviceForSession(client, user, input.deviceId, 'web');
        await this.assertWebCompletionDeviceAllowed(client, user.id, input.deviceId);

        const identifiers = await client.query<{ session_id: string; family_id: string }>(
          'SELECT uuidv7() AS session_id, uuidv7() AS family_id',
        );
        const ids = identifiers.rows[0];
        if (!ids) throw new Error('Web session completion identifiers were not generated');

        const keyring = configuration().REFRESH_TOKEN_DERIVATION_KEYS;
        const derivationKid = keyring.currentKid;
        const derivationKey = keyring.getKey(derivationKid);
        if (!derivationKey) throw new Error('Current Web completion derivation KID is unavailable');
        const requestDigest = completionRequestDigest({
          key: derivationKey,
          kid: derivationKid,
          attemptId: input.attemptId,
          challengeId: challenge.id,
          code: input.credential.code,
          deviceId: input.deviceId,
          bindingId: input.newBinding.bindingId,
          bindingGeneration: input.newBinding.generation,
          proof: input.newBinding.proof,
        });
        const refreshSecret = deriveInitialWebRefreshSecret({
          key: derivationKey,
          kid: derivationKid,
          attemptHash,
          challengeId: challenge.id,
          userId: user.id,
          deviceId: input.deviceId,
          sessionId: ids.session_id,
          familyId: ids.family_id,
          bindingId: input.newBinding.bindingId,
          generation: 0,
          transportClass: 'web_bff',
        });
        const refreshHash = this.refreshHash(refreshSecret);
        const proofFingerprint = createHash('sha256').update(input.newBinding.proof).digest();
        const proofClass = await client.query<{ accepted: boolean }>(
          `SELECT identity.claim_proof_hash_class($1, 'persistent') AS accepted`,
          [proofFingerprint],
        );
        if (proofClass.rows[0]?.accepted !== true) {
          throw new DomainError(
            'DEVICE_BINDING_PROOF_CLASS_INVALID',
            '临时迁移凭据不能成为长期设备绑定。',
            401,
            { retryable: false },
          );
        }
        const bindingHash = persistentDeviceBindingHash({
          proof: input.newBinding.proof,
          kid: derivationKid,
          userId: user.id,
          deviceId: input.deviceId,
          sessionId: ids.session_id,
          bindingId: input.newBinding.bindingId,
          generation: 0,
        });
        if (!bindingHash) this.throwWebCompletionUnavailable();

        const sessionResult = await client.query<{ expires_at: Date }>(
          `INSERT INTO identity.sessions(
             id, user_id, device_id, refresh_hash, refresh_family_id,
             refresh_generation, current_derivation_kid, expires_at, transport_class
           ) VALUES (
             $1, $2, $3, $4, $5, 0, $6,
             clock_timestamp() + interval '30 days', 'web_bff'
           )
           RETURNING expires_at`,
          [ids.session_id, user.id, input.deviceId, refreshHash, ids.family_id, derivationKid],
        );
        const session = sessionResult.rows[0];
        if (!session) throw new Error('Atomic Web session insert returned no row');

        const bindingResult = await client.query<IssuedBindingRow>(
          `INSERT INTO identity.device_bindings(
             id, user_id, device_id, session_id, generation, current_hash, current_kid,
             absolute_expires_at, proof_class
           ) VALUES ($1, $2, $3, $4, 0, $5, $6, $7, 'persistent')
           RETURNING issued_at, absolute_expires_at`,
          [input.newBinding.bindingId, user.id, input.deviceId, ids.session_id,
            bindingHash, derivationKid, session.expires_at],
        );
        const binding = bindingResult.rows[0];
        if (!binding) throw new Error('Atomic Web binding insert returned no row');

        const updatedSession = await client.query<{ id: string }>(
          `UPDATE identity.sessions
           SET current_binding_id = $2, current_binding_generation = 0
           WHERE id = $1 AND refresh_generation = 0 AND refresh_hash = $3
             AND current_binding_id IS NULL AND current_binding_generation IS NULL
           RETURNING id`,
          [ids.session_id, input.newBinding.bindingId, refreshHash],
        );
        const updatedHistory = await client.query<{ session_id: string }>(
          `UPDATE identity.session_refresh_history
           SET binding_id = $2, binding_generation = 0
           WHERE session_id = $1 AND generation = 0 AND state = 'current'
             AND token_hash = $3 AND derivation_kid = $4
             AND binding_id IS NULL AND binding_generation IS NULL
           RETURNING session_id`,
          [ids.session_id, input.newBinding.bindingId, refreshHash, derivationKid],
        );
        if (updatedSession.rowCount !== 1 || updatedHistory.rowCount !== 1) {
          throw new Error('Atomic Web session binding alignment lost current generation');
        }

        const verified = await client.query<{ id: string }>(
          `UPDATE identity.email_challenges
           SET verified_at = clock_timestamp()
           WHERE id = $1 AND verified_at IS NULL
           RETURNING id`,
          [challenge.id],
        );
        if (verified.rowCount !== 1) {
          throw new Error('Atomic Web session challenge was not consumed');
        }
        const insertedOutcome = await client.query<{
          challenge_id: string;
          recovery_expires_at: Date;
        }>(
          `WITH completion_clock AS (
             SELECT clock_timestamp() AS completed_at
           )
           INSERT INTO identity.web_session_completion_outcomes(
             challenge_id, attempt_hash, request_digest, user_id, device_id,
             session_id, family_id, binding_id, refresh_generation,
             binding_generation, derivation_version, derivation_kid,
             created_at, recovery_expires_at
           ) SELECT
             $1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 'v1', $9,
             completed_at,
             completed_at + make_interval(secs => $10::integer)
           FROM completion_clock
           RETURNING challenge_id, recovery_expires_at`,
          [challenge.id, attemptHash, requestDigest, user.id, input.deviceId,
            ids.session_id, ids.family_id, input.newBinding.bindingId,
            derivationKid, configuration().WEB_SESSION_COMPLETION_RECOVERY_SECONDS],
        );
        if (insertedOutcome.rowCount !== 1) {
          throw new Error('Atomic Web session outcome was not recorded');
        }
        const recordedOutcome = insertedOutcome.rows[0];
        if (!recordedOutcome) throw new Error('Atomic Web session outcome metadata was not returned');
        await this.insertWebCompletionDisposition(
          client,
          input.attemptId,
          {
            challengeId: input.credential.challengeId,
            deviceId: input.deviceId,
            binding: input.newBinding,
          },
          ids.session_id,
          'pending',
          recordedOutcome.recovery_expires_at,
        );

        return {
          kind: 'completed' as const,
          material: {
            state: 'pending' as const,
            sessionId: ids.session_id,
            bindingId: input.newBinding.bindingId,
            deviceId: input.deviceId,
          },
        };
      });
      if (outcome.kind === 'invalid') this.throwInvalidOtp(outcome.attempts, outcome.retryAt);
      return outcome.material;
    } catch (error) {
      if (this.pgCode(error) === '23505' || this.pgCode(error) === '23514') {
        this.throwWebCompletionUnavailable();
      }
      throw error;
    }
  }

  async acceptWebSessionCompletionAttempt(
    attemptValue: string,
    inputValue: WebSessionCompletionDispositionInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<WebSessionCompletionDispositionResult> {
    return this.transitionWebSessionCompletionAttempt(
      'accept',
      attemptValue,
      inputValue,
      authority,
      requestChannel,
    );
  }

  async discardWebSessionCompletionAttempt(
    attemptValue: string,
    inputValue: WebSessionCompletionDispositionInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<WebSessionCompletionDispositionResult> {
    return this.transitionWebSessionCompletionAttempt(
      'discard',
      attemptValue,
      inputValue,
      authority,
      requestChannel,
    );
  }

  async revokeWebSessionCompletionAttempt(
    attemptValue: string,
    inputValue: WebSessionCompletionDispositionInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<WebSessionCompletionRevocationResult> {
    if (!authority) {
      throw new DomainError(
        'WEB_BFF_AUTHORITY_REQUIRED',
        '此操作必须通过安全 Web 通道完成。',
        403,
        { retryable: false },
      );
    }
    if (requestChannel !== 'verified_bff') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道不匹配，请重新登录。', 403, {
        retryable: false,
      });
    }
    const attempt = canonicalUUIDSchema.safeParse(attemptValue);
    const input = webSessionCompletionDispositionInputSchema.safeParse(inputValue);
    if (!attempt.success || !input.success) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    return this.database.transaction(async (client) => {
      const attemptId = attempt.data;
      const dispositionInput = input.data;
      const attemptHash = completionAttemptHash(attemptId);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 731647302894611011))',
        [attemptId],
      );
      const disposition = await this.lockWebCompletionDisposition(client, attemptHash);
      if (!disposition) this.throwWebCompletionDispositionAuthorityInvalid();
      this.assertRetainedWebCompletionDispositionAuthority(
        disposition,
        attemptId,
        dispositionInput,
      );
      if (disposition.state === 'discarded') {
        return this.discardedWebCompletionResult(disposition);
      }

      const stored = await this.lockWebCompletionOutcome(client, attemptHash);
      if (!this.matchesExactWebCompletionOutcome(disposition, stored)) {
        this.throwWebCompletionDispositionAuthorityInvalid();
      }
      if (disposition.state === 'pending') {
        await this.discardPendingWebCompletion(client, disposition);
        return this.discardedWebCompletionResult({ ...disposition, state: 'discarded' });
      }

      return this.revokeAcceptedWebCompletion(client, disposition, stored);
    });
  }

  private async transitionWebSessionCompletionAttempt(
    operation: 'accept' | 'discard',
    attemptValue: string,
    inputValue: WebSessionCompletionDispositionInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<WebSessionCompletionDispositionResult> {
    if (!authority) {
      throw new DomainError(
        'WEB_BFF_AUTHORITY_REQUIRED',
        '此操作必须通过安全 Web 通道完成。',
        403,
        { retryable: false },
      );
    }
    if (requestChannel !== 'verified_bff') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道不匹配，请重新登录。', 403, {
        retryable: false,
      });
    }
    const attempt = canonicalUUIDSchema.safeParse(attemptValue);
    const input = webSessionCompletionDispositionInputSchema.safeParse(inputValue);
    if (!attempt.success || !input.success) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    return this.database.transaction(async (client) => {
      const attemptId = attempt.data;
      const dispositionInput = input.data;
      const attemptHash = completionAttemptHash(attemptId);
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 731647302894611011))',
        [attemptId],
      );
      let disposition = await this.lockWebCompletionDisposition(client, attemptHash);
      if (!disposition) {
        if (operation === 'accept') this.throwWebCompletionNotReady();
        await this.insertWebCompletionDisposition(
          client,
          attemptId,
          dispositionInput,
          null,
          'discarded',
        );
        return {
          state: 'discarded',
          bindingId: dispositionInput.binding.bindingId,
          deviceId: dispositionInput.deviceId,
        };
      }

      this.assertWebCompletionDispositionAuthority(disposition, attemptId, dispositionInput);
      if (disposition.state === 'discarded') {
        if (operation === 'accept') this.throwWebCompletionDiscarded();
        return this.discardedWebCompletionResult(disposition);
      }

      const stored = await this.lockWebCompletionOutcome(client, attemptHash);
      if (
        !stored
        || !disposition.session_id
        || stored.session_id !== disposition.session_id
        || stored.challenge_id !== disposition.challenge_id
        || stored.device_id !== disposition.device_id
        || stored.binding_id !== disposition.binding_id
        || !this.sameHash(stored.attempt_hash, disposition.attempt_hash)
        || this.generation(stored.refresh_generation) !== 0
        || this.generation(stored.binding_generation) !== 0
      ) {
        this.throwWebCompletionDispositionAuthorityInvalid();
      }

      if (disposition.state === 'accepted') {
        const recovered = await this.recoverWebSessionCompletion(
          client,
          attemptId,
          dispositionInput,
          attemptHash,
          stored,
          undefined,
          false,
        );
        return { state: 'accepted', material: recovered.material };
      }

      if (!disposition.decision_open || operation === 'discard') {
        await this.discardPendingWebCompletion(client, disposition);
        disposition = { ...disposition, state: 'discarded' };
        return this.discardedWebCompletionResult(disposition);
      }

      const accepted = await client.query<{ attempt_hash: Buffer }>(
        `UPDATE identity.web_session_completion_dispositions
         SET state = 'accepted', accepted_at = clock_timestamp()
         WHERE attempt_hash = $1 AND state = 'pending'
           AND decision_expires_at > clock_timestamp()
         RETURNING attempt_hash`,
        [attemptHash],
      );
      if (accepted.rowCount !== 1) this.throwWebCompletionNotReady();
      const recovered = await this.recoverWebSessionCompletion(
        client,
        attemptId,
        dispositionInput,
        attemptHash,
        stored,
        undefined,
        false,
      );
      return { state: 'accepted', material: recovered.material };
    });
  }

  private async lockWebCompletionDisposition(
    client: PoolClient,
    attemptHash: Buffer,
  ): Promise<WebCompletionDispositionRow | null> {
    const result = await client.query<WebCompletionDispositionRow>(
      `SELECT attempt_hash, challenge_id, device_id, binding_id, binding_generation,
              authority_digest, authority_version, authority_kid, state, session_id,
              decision_expires_at, retained_until,
              decision_expires_at > clock_timestamp() AS decision_open,
              retained_until > clock_timestamp() AS retention_open
       FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1
       FOR UPDATE`,
      [attemptHash],
    );
    return result.rows[0] ?? null;
  }

  private async lockWebCompletionOutcome(
    client: PoolClient,
    attemptHash: Buffer,
  ): Promise<WebCompletionOutcomeRow | null> {
    const result = await client.query<WebCompletionOutcomeRow>(
      `SELECT challenge_id, attempt_hash, request_digest, user_id, device_id,
              session_id, family_id, binding_id, refresh_generation,
              binding_generation, derivation_version, derivation_kid,
              recovery_expires_at
       FROM identity.web_session_completion_outcomes
       WHERE attempt_hash = $1
       FOR UPDATE`,
      [attemptHash],
    );
    return result.rows[0] ?? null;
  }

  private assertWebCompletionDispositionAuthority(
    disposition: WebCompletionDispositionRow,
    attemptId: string,
    input: WebSessionCompletionDispositionInput,
  ): void {
    if (
      disposition.challenge_id !== input.challengeId
      || disposition.device_id !== input.deviceId
      || disposition.binding_id !== input.binding.bindingId
      || this.generation(disposition.binding_generation) !== input.binding.generation
      || !this.sameHash(disposition.attempt_hash, completionAttemptHash(attemptId))
    ) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }
    if (disposition.authority_version === 'legacy-v0') return;

    const key = configuration().REFRESH_TOKEN_DERIVATION_KEYS.getKey(
      disposition.authority_kid,
    );
    if (!key) this.throwWebCompletionDispositionAuthorityInvalid();
    let digest: Buffer;
    try {
      digest = completionDispositionAuthorityDigest({
        key,
        kid: disposition.authority_kid,
        attemptId,
        challengeId: input.challengeId,
        deviceId: input.deviceId,
        bindingId: input.binding.bindingId,
        bindingGeneration: input.binding.generation,
        proof: input.binding.proof,
      });
    } catch {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }
    if (
      disposition.authority_version !== 'v1'
      || !this.sameHash(disposition.authority_digest, digest)
    ) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }
  }

  private assertRetainedWebCompletionDispositionAuthority(
    disposition: WebCompletionDispositionRow,
    attemptId: string,
    input: WebSessionCompletionDispositionInput,
  ): void {
    if (disposition.authority_version !== 'v1' || !disposition.retention_open) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }
    this.assertWebCompletionDispositionAuthority(disposition, attemptId, input);
  }

  private matchesExactWebCompletionOutcome(
    disposition: WebCompletionDispositionRow,
    stored: WebCompletionOutcomeRow | null,
  ): stored is WebCompletionOutcomeRow {
    return stored !== null
      && disposition.session_id !== null
      && stored.session_id === disposition.session_id
      && stored.challenge_id === disposition.challenge_id
      && stored.device_id === disposition.device_id
      && stored.binding_id === disposition.binding_id
      && this.sameHash(stored.attempt_hash, disposition.attempt_hash)
      && this.generation(stored.refresh_generation) === 0
      && this.generation(stored.binding_generation) === 0
      && stored.derivation_version === 'v1';
  }

  private async revokeAcceptedWebCompletion(
    client: PoolClient,
    disposition: WebCompletionDispositionRow,
    stored: WebCompletionOutcomeRow,
  ): Promise<WebSessionCompletionRevocationResult> {
    const candidate = await client.query<{ user_id: string }>(
      `SELECT user_id
       FROM identity.sessions
       WHERE id = $1`,
      [stored.session_id],
    );
    const userId = candidate.rows[0]?.user_id;
    if (!userId || userId !== stored.user_id) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    await lockSessionMutationUser(client, userId);
    const session = await client.query<{
      id: string;
      user_id: string;
      device_id: string;
      refresh_family_id: string;
      refresh_generation: string;
      current_binding_id: string | null;
      current_binding_generation: string | null;
    }>(
      `SELECT id, user_id, device_id, refresh_family_id, refresh_generation,
              current_binding_id, current_binding_generation
       FROM identity.sessions
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [stored.session_id, userId],
    );
    const exactSession = session.rows[0];
    if (
      !exactSession
      || exactSession.id !== stored.session_id
      || exactSession.user_id !== userId
      || exactSession.device_id !== disposition.device_id
      || exactSession.device_id !== stored.device_id
      || exactSession.refresh_family_id !== stored.family_id
    ) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    const history = await client.query<{
      family_id: string;
      generation: string;
      binding_id: string | null;
      binding_generation: string | null;
      state: 'current' | 'consumed' | 'revoked';
      consumed_reason: string | null;
    }>(
      `SELECT family_id, generation, binding_id, binding_generation,
              state, consumed_reason
       FROM identity.session_refresh_history
       WHERE session_id = $1
       ORDER BY generation
       FOR UPDATE`,
      [stored.session_id],
    );
    const bindings = await client.query<{
      id: string;
      user_id: string;
      device_id: string;
      session_id: string;
      generation: string;
      proof_class: string;
    }>(
      `SELECT id, user_id, device_id, session_id, generation, proof_class
       FROM identity.device_bindings
       WHERE session_id = $1
       ORDER BY id
       FOR UPDATE`,
      [stored.session_id],
    );
    const sessionGeneration = this.canonicalGeneration(exactSession.refresh_generation);
    const currentBindingGeneration = this.canonicalGeneration(
      exactSession.current_binding_generation,
    );
    if (
      sessionGeneration === null
      || exactSession.current_binding_id === null
      || currentBindingGeneration === null
      || history.rows.length === 0
    ) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    const lockedBindingGenerations = new Map<string, number>();
    for (const binding of bindings.rows) {
      const generation = this.canonicalGeneration(binding.generation);
      if (
        generation === null
        || binding.user_id !== userId
        || binding.device_id !== disposition.device_id
        || binding.session_id !== stored.session_id
        || binding.proof_class !== 'persistent'
        || lockedBindingGenerations.has(binding.id)
      ) {
        this.throwWebCompletionDispositionAuthorityInvalid();
      }
      lockedBindingGenerations.set(binding.id, generation);
    }

    let previousGeneration = -1;
    let currentHistory: typeof history.rows[number] | undefined;
    for (const row of history.rows) {
      const generation = this.canonicalGeneration(row.generation);
      const bindingGeneration = this.canonicalGeneration(row.binding_generation);
      const lockedBindingGeneration = row.binding_id === null
        ? undefined
        : lockedBindingGenerations.get(row.binding_id);
      if (
        generation === null
        || generation !== previousGeneration + 1
        || row.family_id !== stored.family_id
        || row.binding_id === null
        || bindingGeneration === null
        || lockedBindingGeneration !== bindingGeneration
        || (generation === 0 && (
          row.binding_id !== stored.binding_id
          || row.binding_id !== disposition.binding_id
          || bindingGeneration !== 0
        ))
      ) {
        this.throwWebCompletionDispositionAuthorityInvalid();
      }
      previousGeneration = generation;
      if (generation === sessionGeneration) currentHistory = row;
    }
    if (
      this.canonicalGeneration(history.rows[0]?.generation ?? null) !== 0
      || sessionGeneration !== previousGeneration
      || !currentHistory
      || currentHistory.binding_id !== exactSession.current_binding_id
      || this.canonicalGeneration(currentHistory.binding_generation)
        !== currentBindingGeneration
    ) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    if (
      lockedBindingGenerations.get(disposition.binding_id) !== 0
      || lockedBindingGenerations.get(exactSession.current_binding_id)
        !== currentBindingGeneration
    ) {
      this.throwWebCompletionDispositionAuthorityInvalid();
    }

    const revokedHistory = await client.query(
      `UPDATE identity.session_refresh_history
       SET state = 'revoked',
           consumed_reason = CASE
             WHEN state = 'current' THEN 'completion_revoked'
             ELSE consumed_reason
           END,
           consumed_at = COALESCE(consumed_at, clock_timestamp()),
           rotation_key_hash = NULL,
           successor_generation = NULL,
           successor_hash = NULL,
           successor_derivation_kid = NULL,
           recovery_expires_at = NULL
       WHERE session_id = $1`,
      [stored.session_id],
    );
    const persistentBindingCount = bindings.rows.filter(
      ({ proof_class }) => proof_class === 'persistent',
    ).length;
    const revokedBindings = await client.query(
      `UPDATE identity.device_bindings
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE session_id = $1 AND proof_class = 'persistent'`,
      [stored.session_id],
    );
    const revokedSession = await client.query(
      `UPDATE identity.sessions
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE id = $1 AND user_id = $2`,
      [stored.session_id, userId],
    );
    if (
      revokedHistory.rowCount !== history.rowCount
      || revokedBindings.rowCount !== persistentBindingCount
      || revokedSession.rowCount !== 1
    ) {
      throw new Error('Accepted Web completion revoke lost exact authority rows');
    }

    return {
      state: 'revoked',
      sessionId: stored.session_id,
      bindingId: disposition.binding_id,
      deviceId: disposition.device_id,
    };
  }

  private async insertWebCompletionDisposition(
    client: PoolClient,
    attemptId: string,
    input: WebSessionCompletionDispositionInput,
    sessionId: string | null,
    state: 'pending' | 'accepted' | 'discarded',
    decisionExpiresAt?: Date,
  ): Promise<void> {
    const keyring = configuration().REFRESH_TOKEN_DERIVATION_KEYS;
    const kid = keyring.currentKid;
    const key = keyring.getKey(kid);
    if (!key) throw new Error('Current Web completion disposition KID is unavailable');
    const attemptHash = completionAttemptHash(attemptId);
    const authorityDigest = completionDispositionAuthorityDigest({
      key,
      kid,
      attemptId,
      challengeId: input.challengeId,
      deviceId: input.deviceId,
      bindingId: input.binding.bindingId,
      bindingGeneration: input.binding.generation,
      proof: input.binding.proof,
    });
    const result = await client.query<{ attempt_hash: Buffer }>(
      `WITH disposition_clock AS (
         SELECT clock_timestamp() AS recorded_at
       )
       INSERT INTO identity.web_session_completion_dispositions(
         attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         authority_digest, authority_version, authority_kid, state, session_id,
         created_at, completed_at, decision_expires_at, retained_until,
         accepted_at, discarded_at
       ) SELECT
         $1, $2, $3, $4, 0, $5, 'v1', $6, $7, $8,
         recorded_at,
         CASE WHEN $8::uuid IS NULL THEN NULL ELSE recorded_at END,
         GREATEST(COALESCE($9::timestamptz, recorded_at), recorded_at),
         GREATEST(COALESCE($9::timestamptz, recorded_at), recorded_at)
           + make_interval(secs => $10::integer),
         CASE WHEN $7::text = 'accepted' THEN recorded_at ELSE NULL END,
         CASE WHEN $7::text = 'discarded' THEN recorded_at ELSE NULL END
       FROM disposition_clock
       RETURNING attempt_hash`,
      [
        attemptHash,
        input.challengeId,
        input.deviceId,
        input.binding.bindingId,
        authorityDigest,
        kid,
        state,
        sessionId,
        decisionExpiresAt ?? null,
        webSessionCompletionReconciliationSeconds,
      ],
    );
    if (result.rowCount !== 1) throw new Error('Web completion disposition was not recorded');
  }

  private async discardPendingWebCompletion(
    client: PoolClient,
    disposition: WebCompletionDispositionRow,
  ): Promise<void> {
    if (!disposition.session_id) throw new Error('Pending Web completion has no session');
    const exact = await client.query<{ session_id: string }>(
      `SELECT session.id AS session_id
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id
        AND history.generation = 0
        AND history.binding_id = $2
        AND history.binding_generation = 0
       JOIN identity.device_bindings AS binding
         ON binding.id = $2
        AND binding.session_id = session.id
        AND binding.device_id = $3
        AND binding.generation = 0
       WHERE session.id = $1
         AND session.device_id = $3
         AND session.current_binding_id = $2
         AND session.current_binding_generation = 0
       FOR UPDATE OF session, history, binding`,
      [disposition.session_id, disposition.binding_id, disposition.device_id],
    );
    if (exact.rowCount !== 1) throw new Error('Pending Web completion authority rows diverged');

    const history = await client.query(
      `UPDATE identity.session_refresh_history
       SET state = 'revoked',
           consumed_reason = CASE
             WHEN state = 'current' THEN 'completion_discarded'
             ELSE consumed_reason
           END,
           consumed_at = COALESCE(consumed_at, clock_timestamp()),
           rotation_key_hash = NULL,
           successor_generation = NULL,
           successor_hash = NULL,
           successor_derivation_kid = NULL,
           recovery_expires_at = NULL
       WHERE session_id = $1 AND generation = 0
         AND binding_id = $2 AND binding_generation = 0`,
      [disposition.session_id, disposition.binding_id],
    );
    const binding = await client.query(
      `UPDATE identity.device_bindings
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE id = $1 AND session_id = $2 AND device_id = $3 AND generation = 0`,
      [disposition.binding_id, disposition.session_id, disposition.device_id],
    );
    const session = await client.query(
      `UPDATE identity.sessions
       SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE id = $1 AND device_id = $2
         AND current_binding_id = $3 AND current_binding_generation = 0`,
      [disposition.session_id, disposition.device_id, disposition.binding_id],
    );
    const terminal = await client.query(
      `UPDATE identity.web_session_completion_dispositions
       SET state = 'discarded', discarded_at = clock_timestamp()
       WHERE attempt_hash = $1 AND state = 'pending'`,
      [disposition.attempt_hash],
    );
    if (
      history.rowCount !== 1
      || binding.rowCount !== 1
      || session.rowCount !== 1
      || terminal.rowCount !== 1
    ) {
      throw new Error('Pending Web completion discard lost exact authority rows');
    }
  }

  private discardedWebCompletionResult(
    disposition: WebCompletionDispositionRow,
  ): Extract<WebSessionCompletionDispositionResult, { state: 'discarded' }> {
    return {
      state: 'discarded',
      ...(disposition.session_id ? { sessionId: disposition.session_id } : {}),
      bindingId: disposition.binding_id,
      deviceId: disposition.device_id,
    };
  }

  async authenticateApple(
    input: {
      identityToken: string;
      nonce: string;
      deviceId: string;
      platform?: ApplePlatform | undefined;
    },
    transportClass: SessionTransportClass,
  ): Promise<SessionResponse> {
    if (transportClass === 'ops') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道校验失败，请重新登录。', 403);
    }
    const deviceId = deviceSchema.parse(input.deviceId);
    const platform = input.platform ?? 'ios';
    const expectedPlatform = transportClass === 'native' ? 'ios' : 'web';
    if (platform !== expectedPlatform) {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道校验失败，请重新登录。', 403, {
        retryable: false,
      });
    }
    const verified = await this.verifyAppleCredential({ ...input, platform });
    return this.authenticateExternal('apple', verified.subject, deviceId, transportClass);
  }

  async authenticateGoogle(
    input: { idToken: string; deviceId: string },
    transportClass: SessionTransportClass,
  ): Promise<SessionResponse> {
    if (transportClass === 'ops') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道校验失败，请重新登录。', 403);
    }
    const audience = configuration().GOOGLE_SERVER_CLIENT_ID;
    if (!audience) {
      throw new DomainError('AUTH_PROVIDER_DISABLED', 'Google 登录暂未开放。', 503, {
        retryable: false,
      });
    }
    const deviceId = deviceSchema.parse(input.deviceId);
    const verified = await this.verifyGoogleCredential(input.idToken, audience);
    return this.authenticateExternal('google', verified.subject, deviceId, transportClass);
  }

  async refresh(
    refreshToken: string,
    deviceValue: string,
    platform: 'web' | 'ops',
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
    attemptKey?: string,
    deviceBindingProof?: DeviceBindingProof,
    refreshEnvelopeClaims?: WebRefreshEnvelopeDBClaims,
  ): Promise<SessionResponse> {
    const credential = parseRefreshCredential(refreshToken);
    if (!credential) throw new DomainError('TOKEN_INVALID', '登录已失效。', 401);
    const deviceId = deviceSchema.parse(deviceValue);
    const stored = await this.database.query<{ transport_class: SessionTransportClass }>(
      'SELECT transport_class FROM identity.sessions WHERE id = $1',
      [credential.sessionId],
    );
    const transport = stored.rows[0]?.transport_class;
    if (!transport) throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401);

    const transportDecision = decideTransport({
      mode: configuration().WEB_SESSION_BFF_ENFORCEMENT,
      storedTransport: transport,
      route: platform === 'ops' ? 'ops_refresh' : 'refresh',
      authority: authority ? 'valid' : 'missing',
      requestChannel,
    });
    if (transportDecision.kind === 'reject') {
      throw new DomainError(
        transportDecision.code,
        transportDecision.code === 'WEB_BFF_AUTHORITY_REQUIRED'
          ? '此会话需要通过安全 Web 通道刷新。'
          : '会话通道不匹配，请重新登录。',
        403,
        { retryable: false },
      );
    }

    const outcome = await this.database.transaction((client) =>
      this.sessionTokens.rotate(
        client,
        {
          refreshToken,
          deviceId,
          attemptKey,
          deviceBindingProof,
          refreshEnvelopeClaims,
        },
        transport,
      ),
    );
    switch (outcome.kind) {
      case 'rotated':
      case 'recovered':
        return outcome.session;
      case 'reused':
        throw new DomainError('REFRESH_TOKEN_REUSED', '检测到异常登录，已撤销此设备会话。', 401);
      case 'reauth_required':
      case 'invalid':
        throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401);
    }
  }

  async bootstrap(
    refreshToken: string,
    deviceValue: string,
    proofValue: unknown,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
    refreshEnvelopeClaims?: WebRefreshEnvelopeDBClaims,
  ): Promise<SessionResponse> {
    const credential = parseRefreshCredential(refreshToken);
    const parsedDevice = deviceSchema.safeParse(deviceValue);
    const parsedProof = persistentDeviceBindingProofSchema.safeParse(proofValue);
    if (!credential || !parsedDevice.success || !parsedProof.success) {
      throw new DomainError('TOKEN_INVALID', '登录凭据无效，请重新登录。', 401);
    }

    const deviceId = parsedDevice.data;
    const proof = parsedProof.data;
    const suppliedRefreshHash = this.refreshHash(credential.secret);
    const result = await this.database.query<BootstrapSessionRow>(
      `SELECT
         session.id, session.user_id, session.device_id, session.refresh_hash,
         session.refresh_family_id, session.refresh_generation,
         session.current_derivation_kid, session.current_binding_id,
         session.current_binding_generation, session.transport_class,
         (session.revoked_at IS NULL AND session.reuse_detected_at IS NULL
           AND session.expires_at > clock_timestamp()) AS session_active,
         history.session_id AS history_session_id,
         history.family_id AS history_family_id,
         history.generation AS history_generation,
         history.token_hash AS history_token_hash,
         history.derivation_kid AS history_derivation_kid,
         history.transport_class AS history_transport_class,
         history.binding_id AS history_binding_id,
         history.binding_generation AS history_binding_generation,
         history.state AS history_state,
         binding.id AS binding_id,
         binding.generation AS binding_generation,
         binding.current_hash AS binding_current_hash,
         binding.current_kid AS binding_current_kid,
         binding.proof_class AS binding_proof_class,
         (binding.revoked_at IS NULL
           AND binding.absolute_expires_at > clock_timestamp()) AS binding_active,
         device.user_id AS device_user_id,
         device.risk_state AS device_risk_state,
         user_record.status AS user_status,
         user_record.public_handle, user_record.phone_verified_at,
         user_record.restriction_flags,
         COALESCE((
           SELECT admin_user.roles
           FROM admin.admin_users AS admin_user
           WHERE admin_user.identity_user_id = session.user_id
             AND admin_user.disabled_at IS NULL
             AND admin_user.mfa_enrolled_at IS NOT NULL
           LIMIT 1
       ), ARRAY[]::text[]) AS admin_roles
       FROM identity.sessions AS session
       JOIN identity.devices AS device
         ON device.id = session.device_id
        AND device.user_id = session.user_id
       JOIN identity.users AS user_record
         ON user_record.id = session.user_id AND user_record.deleted_at IS NULL
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id
        AND history.family_id = session.refresh_family_id
        AND history.generation = session.refresh_generation
        AND history.token_hash = session.refresh_hash
        AND history.derivation_kid IS NOT DISTINCT FROM session.current_derivation_kid
        AND history.transport_class = session.transport_class
        AND history.binding_id IS NOT DISTINCT FROM session.current_binding_id
        AND history.binding_generation IS NOT DISTINCT FROM session.current_binding_generation
        AND history.state = 'current'
       JOIN identity.device_bindings AS binding
         ON binding.id = session.current_binding_id
        AND binding.user_id = session.user_id
        AND binding.device_id = session.device_id
        AND binding.session_id = session.id
        AND binding.generation = session.current_binding_generation
        AND binding.proof_class = 'persistent'
        AND binding.revoked_at IS NULL
        AND binding.absolute_expires_at > clock_timestamp()
       WHERE session.id = $1
         AND session.device_id = $2
         AND ${webSessionCompletionAcceptedSQL}
         AND session.revoked_at IS NULL
         AND session.reuse_detected_at IS NULL
         AND session.expires_at > clock_timestamp()
         AND device.risk_state <> 'blocked'
         AND user_record.status = 'active'
         AND NOT ('loginBlocked' = ANY(user_record.restriction_flags))
         AND binding.id = $3
         AND binding.generation = $4::bigint
         AND session.refresh_hash = $5
         AND history.token_hash = $5`,
      [
        credential.sessionId,
        deviceId,
        proof.bindingId,
        proof.generation,
        suppliedRefreshHash,
      ],
    );
    const row = result.rows[0];
    const suppliedBindingHash = row
      ? persistentDeviceBindingHash({
          proof: proof.proof,
          kid: row.binding_current_kid,
          userId: row.user_id,
          deviceId: row.device_id,
          sessionId: row.id,
          bindingId: proof.bindingId,
          generation: proof.generation,
        })
      : null;
    if (
      !row ||
      !suppliedBindingHash ||
      !this.validBootstrapState(
        row,
        credential,
        deviceId,
        proof,
        suppliedRefreshHash,
        suppliedBindingHash,
        refreshEnvelopeClaims,
      )
    ) {
      throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401);
    }

    const transportDecision = decideTransport({
      mode: configuration().WEB_SESSION_BFF_ENFORCEMENT,
      storedTransport: row.transport_class,
      route: 'session_successor',
      authority: authority ? 'valid' : 'missing',
      requestChannel,
    });
    if (transportDecision.kind === 'reject') {
      throw new DomainError(
        transportDecision.code,
        transportDecision.code === 'WEB_BFF_AUTHORITY_REQUIRED'
          ? '此会话需要通过安全 Web 通道继续。'
          : '会话通道不匹配，请重新登录。',
        403,
        { retryable: false },
      );
    }

    const generation = this.generation(row.refresh_generation);
    if (generation === null)
      throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401);
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const roles = row.admin_roles.length > 0 ? ['operator', ...row.admin_roles] : ['user'];
    const accessToken = await new SignJWT({
      sid: row.id,
      phoneVerified: row.phone_verified_at !== null,
      restrictions: row.restriction_flags,
      roles,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('spott-api')
      .setAudience('spott-clients')
      .setSubject(row.user_id)
      .setJti(randomBytes(16).toString('base64url'))
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET));
    return {
      accessToken,
      accessTokenExpiresAt: expiresAt.toISOString(),
      refreshToken,
      refreshGeneration: generation,
      sessionId: row.id,
      user: {
        id: row.user_id,
        publicHandle: row.public_handle,
        phoneVerified: row.phone_verified_at !== null,
        restrictions: row.restriction_flags,
      },
    };
  }

  async logoutWebSession(
    input: WebLogoutInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<{ revokedCount: number }> {
    return this.logoutWebSessions(input, 'current', authority, requestChannel);
  }

  async logoutAllWebSessions(
    input: WebLogoutInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<{ revokedCount: number }> {
    return this.logoutWebSessions(input, 'all', authority, requestChannel);
  }

  private async logoutWebSessions(
    input: WebLogoutInput,
    scope: 'current' | 'all',
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<{ revokedCount: number }> {
    if (!authority) {
      throw new DomainError(
        'WEB_BFF_AUTHORITY_REQUIRED',
        '此操作必须通过安全 Web 通道完成。',
        403,
        { retryable: false },
      );
    }
    if (requestChannel !== 'verified_bff') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道不匹配，请重新登录。', 403, {
        retryable: false,
      });
    }

    const outcome: WebLogoutOutcome = await this.database.transaction((client) =>
      this.sessionTokens.revokeWebSessions(client, input, scope),
    );
    if (outcome.kind === 'transport_mismatch') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道不匹配，请重新登录。', 403, {
        retryable: false,
      });
    }
    if (outcome.kind !== 'revoked') {
      throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401, {
        retryable: false,
      });
    }
    return { revokedCount: outcome.revokedCount };
  }

  async upgradeDeviceBinding(
    inputValue: DeviceBindingUpgradeInput,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<DeviceBindingUpgradeMaterial> {
    if (!authority) {
      throw new DomainError(
        'WEB_BFF_AUTHORITY_REQUIRED',
        '此操作必须通过安全 Web 通道完成。',
        403,
        { retryable: false },
      );
    }
    if (requestChannel !== 'verified_bff') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道不匹配，请重新登录。', 403, {
        retryable: false,
      });
    }
    const parsedInput = deviceBindingUpgradeInputSchema.safeParse(inputValue);
    if (!parsedInput.success) {
      throw new DomainError('TOKEN_INVALID', '设备绑定凭据无效，请重新登录。', 401, {
        retryable: false,
      });
    }
    const input = parsedInput.data;
    const credential = parseRefreshCredential(input.refreshToken);
    if (!credential) {
      throw new DomainError('TOKEN_INVALID', '登录凭据无效，请重新登录。', 401, {
        retryable: false,
      });
    }

    try {
      return await this.database.transaction(async (client) => {
        const session = await this.lockBindingUpgradeSession(client, credential.sessionId);
        if (!session || session.transport_class !== 'web_bff') {
          throw new DomainError(
            session ? 'SESSION_TRANSPORT_MISMATCH' : 'TOKEN_EXPIRED',
            '登录已过期，请重新登录。',
            session ? 403 : 401,
            { retryable: false },
          );
        }
        const generation = this.generation(session.refresh_generation);
        if (generation === null) this.throwExpiredBindingUpgrade();
        const history = await this.lockBindingUpgradeHistory(client, session.id, generation);
        const suppliedRefreshHash = this.refreshHash(credential.secret);
        if (!history || !this.validBindingUpgradeState(
          session,
          history,
          credential,
          input.deviceId,
          suppliedRefreshHash,
          generation,
        )) {
          this.throwExpiredBindingUpgrade();
        }

        const rawProofFingerprint = createHash('sha256').update(input.newBinding.proof).digest();
        const proofClass = await client.query<{ accepted: boolean }>(
          `SELECT identity.claim_proof_hash_class($1, 'persistent') AS accepted`,
          [rawProofFingerprint],
        );
        if (proofClass.rows[0]?.accepted !== true) {
          throw new DomainError(
            'DEVICE_BINDING_PROOF_CLASS_INVALID',
            '临时迁移凭据不能升级为长期设备绑定。',
            401,
            { retryable: false },
          );
        }

        const requestHash = this.idempotency.requestHash(
          'POST',
          '/v1/auth/device-binding/upgrade',
          input,
        );
        const replay = await this.idempotency.claim<DeviceBindingUpgradeMaterial>(
          client,
          session.user_id,
          input.attemptId,
          requestHash,
        );
        if (replay) {
          if (replay.status !== 200) this.throwExpiredBindingUpgrade();
          const current = await this.currentIssuedBinding(client, session, history, input);
          if (!current) this.throwExpiredBindingUpgrade();
          return current;
        }

        if (
          session.current_binding_id !== null ||
          session.current_binding_generation !== null ||
          history.binding_id !== null ||
          history.binding_generation !== null
        ) {
          throw new DomainError(
            'DEVICE_BINDING_ALREADY_EXISTS',
            '当前会话已存在长期设备绑定，首次升级不能覆盖它。',
            409,
            { retryable: false },
          );
        }

        const bindingKid = configuration().REFRESH_TOKEN_DERIVATION_KEYS.currentKid;
        const bindingHash = persistentDeviceBindingHash({
          proof: input.newBinding.proof,
          kid: bindingKid,
          userId: session.user_id,
          deviceId: session.device_id,
          sessionId: session.id,
          bindingId: input.newBinding.bindingId,
          generation: input.newBinding.generation,
        });
        if (!bindingHash) {
          throw new DomainError('TOKEN_INVALID', '设备绑定凭据无效，请重新登录。', 401, {
            retryable: false,
          });
        }

        const inserted = await client.query<IssuedBindingRow>(
          `INSERT INTO identity.device_bindings(
             id, user_id, device_id, session_id, generation, current_hash, current_kid,
             absolute_expires_at, proof_class
           ) VALUES ($1, $2, $3, $4, $5::bigint, $6, $7, $8, 'persistent')
           RETURNING issued_at, absolute_expires_at`,
          [
            input.newBinding.bindingId,
            session.user_id,
            session.device_id,
            session.id,
            input.newBinding.generation,
            bindingHash,
            bindingKid,
            session.expires_at,
          ],
        );
        const binding = inserted.rows[0];
        if (!binding) throw new Error('Persistent device binding insert returned no row');

        const updatedSession = await client.query<{ id: string }>(
          `UPDATE identity.sessions
           SET current_binding_id = $2, current_binding_generation = $3::bigint
           WHERE id = $1 AND current_binding_id IS NULL
             AND current_binding_generation IS NULL AND refresh_hash = $4
             AND refresh_generation = $5::bigint AND revoked_at IS NULL
             AND reuse_detected_at IS NULL AND expires_at > clock_timestamp()
           RETURNING id`,
          [session.id, input.newBinding.bindingId, input.newBinding.generation,
            suppliedRefreshHash, generation],
        );
        if (updatedSession.rowCount !== 1) {
          throw new Error('Persistent binding lost the locked current session');
        }

        const updatedHistory = await client.query<{ session_id: string }>(
          `UPDATE identity.session_refresh_history
           SET binding_id = $3, binding_generation = $4::bigint
           WHERE session_id = $1 AND generation = $2::bigint AND state = 'current'
             AND binding_id IS NULL AND binding_generation IS NULL AND token_hash = $5
           RETURNING session_id`,
          [session.id, generation, input.newBinding.bindingId,
            input.newBinding.generation, suppliedRefreshHash],
        );
        if (updatedHistory.rowCount !== 1) {
          throw new Error('Persistent binding lost the locked current refresh history');
        }

        const material = this.bindingUpgradeMaterial(session, generation, input, binding);
        await this.idempotency.complete(
          client,
          session.user_id,
          input.attemptId,
          { status: 200, body: material },
          { type: 'device_binding', id: input.newBinding.bindingId },
        );
        return material;
      });
    } catch (error) {
      if (this.pgCode(error) === '23505' || this.pgCode(error) === '23514') {
        throw new DomainError(
          'DEVICE_BINDING_CONFLICT',
          '设备绑定已被使用或与临时凭据冲突。',
          409,
          { retryable: false },
        );
      }
      throw error;
    }
  }

  async refreshOps(refreshToken: string): Promise<SessionResponse> {
    const credential = parseRefreshCredential(refreshToken);
    if (!credential) {
      throw new DomainError('TOKEN_INVALID', '运营会话无效。', 401);
    }
    const result = await this.database.query<{ device_id: string }>(
      `SELECT device_id FROM identity.sessions WHERE id=$1 AND revoked_at IS NULL
       AND expires_at>clock_timestamp()`,
      [credential.sessionId],
    );
    const deviceId = result.rows[0]?.device_id;
    if (!deviceId) throw new DomainError('TOKEN_EXPIRED', '运营会话已过期。', 401);
    return this.refresh(refreshToken, deviceId, 'ops', undefined, 'ops');
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE identity.sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE id = $1 AND user_id = $2`,
      [sessionId, userId],
    );
    if (result.rowCount === 0) throw new DomainError('SESSION_NOT_FOUND', '设备会话不存在。', 404);
  }

  async revokeAllSessions(userId: string): Promise<{ revokedCount: number }> {
    return this.database.transaction(async (client) => {
      await lockSessionMutationUser(client, userId);
      const sessions = await client.query<{ id: string }>(
        `SELECT id FROM identity.sessions
         WHERE user_id = $1 AND revoked_at IS NULL
         ORDER BY id
         FOR UPDATE`,
        [userId],
      );
      const sessionIds = sessions.rows.map(({ id }) => id);
      if (sessionIds.length === 0) return { revokedCount: 0 };
      const result = await client.query(
        `UPDATE identity.sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp())
         WHERE id = ANY($1::uuid[]) AND user_id = $2 AND revoked_at IS NULL`,
        [sessionIds, userId],
      );
      return { revokedCount: result.rowCount ?? 0 };
    });
  }

  async cancelDeletion(userId: string): Promise<{ cancelled: boolean }> {
    const result = await this.database.query(
      `UPDATE identity.users SET status = 'active', deletion_requested_at = NULL,
         deletion_execute_after = NULL
       WHERE id = $1 AND status = 'deletion_pending'`,
      [userId],
    );
    return { cancelled: Boolean(result.rowCount) };
  }

  async createPhoneChallenge(
    userId: string,
    phoneValue: string,
    deviceValue: string,
  ): Promise<Record<string, unknown>> {
    const phone = phoneSchema.parse(phoneValue);
    const deviceId = deviceSchema.parse(deviceValue);
    const code = this.otpCode();
    const result = await this.database.query<{ id: string; expires_at: Date }>(
      `INSERT INTO identity.phone_challenges(
         phone_hash, phone_cipher, otp_hash, device_id, expires_at
       ) VALUES ($1, $2, $3, $4, clock_timestamp() + interval '10 minutes')
       RETURNING id, expires_at`,
      [this.crypto.lookupHash(phone), this.crypto.encrypt(phone), this.codeHash(code), deviceId],
    );
    const row = result.rows[0];
    if (!row)
      throw new DomainError('CHALLENGE_CREATE_FAILED', '验证码发送失败。', 503, {
        retryable: true,
      });
    if (configuration().OTP_PROVIDER === 'console')
      console.info(`[Spott OTP] user=${userId} phone=${phone} code=${code}`);
    return {
      challengeId: row.id,
      expiresAt: row.expires_at.toISOString(),
      retryAfterSeconds: 60,
      ...(configuration().NODE_ENV === 'development' ? { developmentCode: code } : {}),
    };
  }

  async verifyPhoneChallenge(
    userId: string,
    challengeId: string,
    codeValue: string,
  ): Promise<unknown> {
    const parsedChallengeId = deviceSchema.parse(challengeId);
    const code = codeSchema.parse(codeValue);
    const outcome = await this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        phone_hash: Buffer;
        phone_cipher: Buffer;
        otp_hash: Buffer;
        attempts: number;
        expires_at: Date;
        verified_at: Date | null;
        suspended_until: Date | null;
      }>(`SELECT * FROM identity.phone_challenges WHERE id = $1 FOR UPDATE`, [parsedChallengeId]);
      const challenge = result.rows[0];
      if (!challenge || (!challenge.verified_at && challenge.expires_at <= new Date())) {
        throw new DomainError('CHALLENGE_EXPIRED', '验证码已过期，请重新发送。', 400);
      }
      if (challenge.verified_at) {
        const binding = await this.activePhoneBinding(client, challenge.phone_hash);
        if (!binding) throw new DomainError('CHALLENGE_EXPIRED', '验证码已过期，请重新发送。', 400);
        this.assertPhoneBindingOwner(binding.user_id, userId);
        return {
          kind: 'verified' as const,
          value: {
            requestId: `phone_${parsedChallengeId}`,
            verifiedAt: challenge.verified_at.toISOString(),
            reward: await this.walletBalance(client, userId),
          },
        };
      }
      if (challenge.suspended_until && challenge.suspended_until > new Date()) {
        throw new DomainError('OTP_RATE_LIMITED', '尝试次数过多，请稍后再试。', 429, {
          meta: { retryAt: challenge.suspended_until.toISOString() },
        });
      }
      if (!this.matchesCode(challenge.otp_hash, code)) {
        const nextAttempts = challenge.attempts + 1;
        const invalid = await client.query<{ suspended_until: Date | null }>(
          `UPDATE identity.phone_challenges SET attempts = $2::integer,
             suspended_until = CASE WHEN $2::integer >= 5 THEN clock_timestamp() + interval '30 minutes' ELSE NULL END
           WHERE id = $1 RETURNING suspended_until`,
          [parsedChallengeId, Math.min(nextAttempts, 5)],
        );
        return {
          kind: 'invalid' as const,
          attempts: nextAttempts,
          retryAt: invalid.rows[0]?.suspended_until ?? null,
        };
      }

      const inserted = await client.query<{ id: string; user_id: string; verified_at: Date }>(
        `INSERT INTO identity.phone_bindings(user_id, phone_hash, phone_cipher)
         VALUES ($1, $2, $3)
         ON CONFLICT (phone_hash) WHERE unbound_at IS NULL DO NOTHING
         RETURNING id, user_id, verified_at`,
        [userId, challenge.phone_hash, challenge.phone_cipher],
      );
      const isNewBinding = inserted.rowCount === 1;
      const binding =
        inserted.rows[0] ?? (await this.activePhoneBinding(client, challenge.phone_hash));
      if (!binding) {
        throw new DomainError('PHONE_BINDING_CONFLICT', '手机号绑定状态暂时不可用，请重试。', 409, {
          retryable: true,
        });
      }
      this.assertPhoneBindingOwner(binding.user_id, userId);

      const verified = await client.query<{ verified_at: Date }>(
        `UPDATE identity.phone_challenges
         SET verified_at = COALESCE(verified_at, clock_timestamp())
         WHERE id = $1
         RETURNING verified_at`,
        [parsedChallengeId],
      );
      const verifiedAt = verified.rows[0]?.verified_at;
      if (!verifiedAt)
        throw new DomainError('PHONE_VERIFICATION_FAILED', '手机号验证失败，请重试。', 503, {
          retryable: true,
        });
      await client.query(
        'UPDATE identity.users SET phone_verified_at = COALESCE(phone_verified_at, clock_timestamp()) WHERE id = $1',
        [userId],
      );
      const wallet = isNewBinding
        ? await this.creditPhoneVerification(client, userId, challenge.phone_hash)
        : await this.walletBalance(client, userId);
      if (isNewBinding) {
        await this.recordUserChange(client, userId, 'phone_verified', { phoneVerified: true });
      }
      return {
        kind: 'verified' as const,
        value: {
          requestId: `phone_${parsedChallengeId}`,
          verifiedAt: verifiedAt.toISOString(),
          reward: wallet,
        },
      };
    });
    if (outcome.kind === 'invalid') this.throwInvalidOtp(outcome.attempts, outcome.retryAt);
    return outcome.value;
  }

  async requestDeletion(userId: string): Promise<{ executeAfter: string }> {
    return this.database.transaction(async (client) => {
      const blockers = await client.query<{
        active_events: string;
        owned_groups: string;
        paid_balance: string;
      }>(
        `SELECT
           (SELECT count(*) FROM events.events WHERE organizer_id = $1
             AND status IN ('published','registration_closed','in_progress'))::text AS active_events,
           (SELECT count(*) FROM community.groups WHERE owner_id = $1
             AND status IN ('active','transfer_pending','closing'))::text AS owned_groups,
           COALESCE((SELECT paid_balance FROM commerce.wallets WHERE user_id = $1), 0)::text AS paid_balance`,
        [userId],
      );
      const row = blockers.rows[0];
      if (
        !row ||
        Number(row.active_events) > 0 ||
        Number(row.owned_groups) > 0 ||
        BigInt(row.paid_balance) < 0n
      ) {
        throw new DomainError(
          'ACCOUNT_DELETION_BLOCKED',
          '请先处理未结束活动、群主转让或负积分。',
          409,
          {
            meta: row ?? {},
          },
        );
      }
      const updated = await client.query<{ deletion_execute_after: Date }>(
        `UPDATE identity.users SET status = 'deletion_pending',
           deletion_requested_at = clock_timestamp(),
           deletion_execute_after = clock_timestamp() + interval '14 days'
         WHERE id = $1 RETURNING deletion_execute_after`,
        [userId],
      );
      const executeAfter = updated.rows[0]?.deletion_execute_after;
      if (!executeAfter) throw new DomainError('USER_NOT_FOUND', '账号不存在。', 404);
      return { executeAfter: executeAfter.toISOString() };
    });
  }

  async mergePreview(
    userId: string,
    credential: MergeCredential,
  ): Promise<Record<string, unknown>> {
    const externallyVerified =
      credential.provider === 'email' ? null : await this.verifyMergeCredential(credential);
    return this.database.transaction(async (client) => {
      const verified =
        externallyVerified ?? (await this.verifyMergeEmailCredential(client, credential));
      try {
        await client.query(
          `INSERT INTO identity.auth_credential_uses(provider, credential_hash, purpose, used_by)
           VALUES ($1,$2,'account_merge',$3)`,
          [verified.provider, verified.credentialHash, userId],
        );
      } catch (error) {
        if (this.pgCode(error) === '23505') {
          throw new DomainError(
            'ACCOUNT_MERGE_CREDENTIAL_REPLAYED',
            '第二账号凭证已使用，请重新验证。',
            409,
          );
        }
        throw error;
      }
      const identity = await client.query<{ user_id: string }>(
        `SELECT identity_record.user_id
         FROM identity.auth_identities identity_record
         JOIN identity.users user_record ON user_record.id = identity_record.user_id
         WHERE identity_record.provider = $1 AND identity_record.provider_subject = $2
           AND user_record.deleted_at IS NULL AND user_record.status <> 'anonymized'
         FOR UPDATE OF identity_record, user_record`,
        [verified.provider, verified.subject],
      );
      const sourceUserId = identity.rows[0]?.user_id;
      if (!sourceUserId) {
        throw new DomainError(
          'ACCOUNT_MERGE_SECOND_ACCOUNT_NOT_FOUND',
          '已验证身份未绑定可合并账号。',
          404,
        );
      }
      if (sourceUserId === userId) {
        throw new DomainError('ACCOUNT_MERGE_SAME_ACCOUNT', '该身份已经属于当前账号。', 422);
      }
      const impact = await this.mergeImpact(client, sourceUserId, userId);
      const conflicts = this.mergeConflicts(impact);
      const mergeToken = randomBytes(32).toString('base64url');
      const proofHash = this.mergeProofHash(mergeToken);
      const preview = {
        provider: verified.provider,
        sourceUserId,
        targetUserId: userId,
        impact: {
          ownedEvents: Number(impact.source_owned_events ?? 0),
          ownedGroups: Number(impact.source_owned_groups ?? 0),
          sourceWallet: {
            paid: Number(impact.source_paid_balance ?? 0),
            free: Number(impact.source_free_balance ?? 0),
          },
          targetWallet: {
            paid: Number(impact.target_paid_balance ?? 0),
            free: Number(impact.target_free_balance ?? 0),
          },
        },
        conflicts,
      };
      const inserted = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO identity.account_merge_jobs(
           source_user_id, target_user_id, preview_json, verification_hash, expires_at
         ) VALUES ($1,$2,$3,$4,clock_timestamp() + interval '10 minutes')
         RETURNING id, expires_at`,
        [sourceUserId, userId, preview, proofHash],
      );
      const job = inserted.rows[0];
      if (!job)
        throw new DomainError('ACCOUNT_MERGE_PREVIEW_FAILED', '账号合并预览创建失败。', 500);
      return {
        jobId: job.id,
        mergeToken,
        expiresAt: job.expires_at.toISOString(),
        sourceUserId,
        targetUserId: userId,
        impact: preview.impact,
        conflicts,
        canCommit: conflicts.length === 0,
        requiresSecondVerification: false,
      };
    });
  }

  async mergeCommit(
    userId: string,
    currentSessionId: string,
    key: string,
    input: {
      jobId: string;
      mergeToken: string;
      deviceId: string;
      platform?: ApplePlatform | undefined;
    },
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<SessionResponse> {
    const runtimeConfiguration = configuration();
    if (
      runtimeConfiguration.NODE_ENV === 'production' &&
      runtimeConfiguration.ACCOUNT_MERGE_EXECUTION_ENABLED !== 'true'
    ) {
      throw new DomainError(
        'ACCOUNT_MERGE_EXECUTION_DISABLED',
        '账号合并正在进行安全升级，请稍后再试。',
        503,
        { retryable: false },
      );
    }
    const deviceId = deviceSchema.parse(input.deviceId);
    return this.database.transaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      const currentSession = await client.query<{ transport_class: SessionTransportClass }>(
        `SELECT session.transport_class
         FROM identity.sessions AS session
         WHERE session.id = $1 AND session.user_id = $2 AND session.revoked_at IS NULL
           AND session.expires_at > clock_timestamp()
           AND ${webSessionCompletionAcceptedSQL}
         FOR UPDATE`,
        [currentSessionId, userId],
      );
      const storedTransport = currentSession.rows[0]?.transport_class;
      if (!storedTransport) throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401);
      const transportDecision = decideTransport({
        mode: configuration().WEB_SESSION_BFF_ENFORCEMENT,
        storedTransport,
        route: 'session_successor',
        authority: authority ? 'valid' : 'missing',
        requestChannel,
      });
      if (transportDecision.kind === 'reject') {
        throw new DomainError(
          transportDecision.code,
          transportDecision.code === 'WEB_BFF_AUTHORITY_REQUIRED'
            ? '此会话需要通过安全 Web 通道继续。'
            : '会话通道不匹配，请重新登录。',
          403,
          { retryable: false },
        );
      }
      const request = { jobId: input.jobId, deviceId };
      const hash = this.idempotency.requestHash('POST', '/accounts/merge/commit', request);
      const replay = await this.idempotency.claim<SessionResponse>(client, userId, key, hash);
      if (replay) return replay.body;
      const result = await client.query<{
        id: string;
        source_user_id: string;
        target_user_id: string;
        state: string;
        preview_json: { conflicts?: unknown };
        verification_hash: Buffer | null;
        expires_at: Date;
      }>(
        `SELECT id, source_user_id, target_user_id, state, preview_json,
           verification_hash, expires_at
         FROM identity.account_merge_jobs
         WHERE id = $1 AND target_user_id = $2
         FOR UPDATE`,
        [input.jobId, userId],
      );
      const job = result.rows[0];
      if (!job) throw new DomainError('ACCOUNT_MERGE_NOT_FOUND', '账号合并任务不存在。', 404);
      if (job.state !== 'previewed') {
        throw new DomainError(
          'ACCOUNT_MERGE_ALREADY_CONSUMED',
          '账号合并任务已处理，不能重复提交。',
          409,
        );
      }
      if (job.expires_at <= new Date()) {
        await client.query(
          "UPDATE identity.account_merge_jobs SET state = 'expired' WHERE id = $1",
          [job.id],
        );
        throw new DomainError('ACCOUNT_MERGE_EXPIRED', '账号合并验证已过期，请重新验证。', 409);
      }
      const suppliedProof = this.mergeProofHash(input.mergeToken);
      if (
        !job.verification_hash ||
        job.verification_hash.length !== suppliedProof.length ||
        !timingSafeEqual(job.verification_hash, suppliedProof)
      ) {
        throw new DomainError('ACCOUNT_MERGE_PROOF_INVALID', '账号合并验证凭证无效。', 401);
      }
      await client.query(
        `SELECT id FROM identity.users
         WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
         ORDER BY id FOR UPDATE`,
        [[job.source_user_id, job.target_user_id]],
      );
      const currentImpact = await this.mergeImpact(client, job.source_user_id, job.target_user_id);
      const conflicts = this.mergeConflicts(currentImpact);
      if (conflicts.length > 0) {
        throw new DomainError('ACCOUNT_MERGE_CONFLICTS', '账号数据存在需要先处理的冲突。', 409, {
          meta: { conflicts },
        });
      }
      await this.performAccountMerge(client, job.source_user_id, job.target_user_id, job.id);
      await client.query(
        `UPDATE identity.account_merge_jobs SET state = 'committed', committed_at = clock_timestamp(),
           idempotency_key = $2 WHERE id = $1`,
        [job.id, key],
      );
      const target = await this.getUser(client, job.target_user_id);
      const body = await this.createSession(
        client,
        target,
        deviceId,
        this.platformForTransport(storedTransport),
        storedTransport,
      );
      await this.idempotency.complete(
        client,
        userId,
        key,
        { status: 200, body },
        {
          type: 'account_merge',
          id: job.id,
        },
      );
      return body;
    });
  }

  private async verifyAppleCredential(input: {
    identityToken: string;
    nonce: string;
    platform: ApplePlatform;
  }): Promise<VerifiedMergeCredential> {
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      verified = await jwtVerify(input.identityToken, this.appleKeys, {
        algorithms: ['RS256'],
        issuer: 'https://appleid.apple.com',
        audience: appleAudienceForPlatform(input.platform, configuration()),
      });
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError('AUTH_CREDENTIAL_INVALID', 'Apple 登录凭证校验失败。', 401);
    }
    if (verified.payload.nonce !== appleNonceDigest(input.nonce)) {
      throw new DomainError('AUTH_NONCE_INVALID', '登录凭证校验失败。', 401);
    }
    if (!verified.payload.sub)
      throw new DomainError('AUTH_SUBJECT_INVALID', '登录凭证缺少账号标识。', 401);
    return {
      provider: 'apple',
      subject: verified.payload.sub,
      credentialHash: createHash('sha256').update(input.identityToken).digest(),
    };
  }

  private async verifyGoogleCredential(
    idToken: string,
    audience: string,
  ): Promise<VerifiedMergeCredential> {
    let verified: Awaited<ReturnType<typeof jwtVerify>>;
    try {
      verified = await jwtVerify(idToken, this.googleKeys, {
        algorithms: ['RS256'],
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience,
      });
    } catch {
      throw new DomainError('AUTH_CREDENTIAL_INVALID', 'Google 登录凭证校验失败。', 401);
    }
    if (!verified.payload.sub)
      throw new DomainError('AUTH_SUBJECT_INVALID', '登录凭证缺少账号标识。', 401);
    return {
      provider: 'google',
      subject: verified.payload.sub,
      credentialHash: createHash('sha256').update(idToken).digest(),
    };
  }

  private async verifyMergeCredential(
    credential: Exclude<MergeCredential, { provider: 'email' }>,
  ): Promise<VerifiedMergeCredential> {
    if (credential.provider === 'apple') return this.verifyAppleCredential(credential);
    const audience = configuration().GOOGLE_SERVER_CLIENT_ID;
    if (!audience) {
      throw new DomainError('AUTH_PROVIDER_DISABLED', 'Google 登录暂未开放。', 503, {
        retryable: false,
      });
    }
    return this.verifyGoogleCredential(credential.idToken, audience);
  }

  private async verifyMergeEmailCredential(
    client: PoolClient,
    credential: MergeCredential,
  ): Promise<VerifiedMergeCredential> {
    if (credential.provider !== 'email') {
      throw new DomainError('ACCOUNT_MERGE_CREDENTIAL_INVALID', '账号合并凭证类型无效。', 400);
    }
    const challengeId = deviceSchema.parse(credential.challengeId);
    const code = codeSchema.parse(credential.code);
    const result = await client.query<{
      email_hash: Buffer;
      code_hash: Buffer;
      attempts: number;
      expires_at: Date;
      verified_at: Date | null;
      suspended_until: Date | null;
    }>(
      `SELECT email_hash, code_hash, attempts, expires_at, verified_at, suspended_until
       FROM identity.email_challenges WHERE id = $1 FOR UPDATE`,
      [challengeId],
    );
    const challenge = result.rows[0];
    if (!challenge || challenge.verified_at || challenge.expires_at <= new Date()) {
      throw new DomainError('CHALLENGE_EXPIRED', '验证码已过期，请重新发送。', 400);
    }
    if (challenge.suspended_until && challenge.suspended_until > new Date()) {
      throw new DomainError('OTP_RATE_LIMITED', '尝试次数过多，请稍后再试。', 429);
    }
    if (!this.matchesCode(challenge.code_hash, code)) {
      const attempts = Math.min(challenge.attempts + 1, 5);
      const invalid = await client.query<{ suspended_until: Date | null }>(
        `UPDATE identity.email_challenges SET attempts = $2,
           suspended_until = CASE WHEN $2 >= 5 THEN clock_timestamp() + interval '30 minutes' ELSE NULL END
         WHERE id = $1 RETURNING suspended_until`,
        [challengeId, attempts],
      );
      this.throwInvalidOtp(attempts, invalid.rows[0]?.suspended_until ?? null);
    }
    await client.query(
      'UPDATE identity.email_challenges SET verified_at = clock_timestamp() WHERE id = $1',
      [challengeId],
    );
    return {
      provider: 'email',
      subject: challenge.email_hash.toString('hex'),
      credentialHash: createHash('sha256').update(`${challengeId}:${code}`).digest(),
    };
  }

  private async mergeImpact(
    client: PoolClient,
    sourceUserId: string,
    targetUserId: string,
  ): Promise<MergeImpactRow> {
    const result = await client.query<MergeImpactRow>(
      `SELECT
         (SELECT count(*) FROM events.events WHERE organizer_id = $1 AND deleted_at IS NULL)::text
           AS source_owned_events,
         (SELECT count(*) FROM community.groups WHERE owner_id = $1 AND deleted_at IS NULL)::text
           AS source_owned_groups,
         COALESCE((SELECT paid_balance FROM commerce.wallets WHERE user_id = $1), 0)::text
           AS source_paid_balance,
         COALESCE((SELECT free_balance FROM commerce.wallets WHERE user_id = $1), 0)::text
           AS source_free_balance,
         COALESCE((SELECT paid_balance FROM commerce.wallets WHERE user_id = $2), 0)::text
           AS target_paid_balance,
         COALESCE((SELECT free_balance FROM commerce.wallets WHERE user_id = $2), 0)::text
           AS target_free_balance,
         (EXISTS(SELECT 1 FROM identity.phone_bindings WHERE user_id = $1 AND unbound_at IS NULL)
           AND EXISTS(SELECT 1 FROM identity.phone_bindings WHERE user_id = $2 AND unbound_at IS NULL))
           AS phone_conflict,
         (SELECT count(*) FROM events.registrations source_registration
          JOIN events.registrations target_registration
            ON target_registration.event_id = source_registration.event_id
           AND target_registration.user_id = $2 AND target_registration.deleted_at IS NULL
          WHERE source_registration.user_id = $1 AND source_registration.deleted_at IS NULL)::text
           AS registration_conflicts,
         (SELECT count(*) FROM community.group_memberships source_membership
          JOIN community.group_memberships target_membership
            ON target_membership.group_id = source_membership.group_id
           AND target_membership.user_id = $2
          WHERE source_membership.user_id = $1)::text AS membership_conflicts,
         EXISTS(SELECT 1 FROM admin.admin_users WHERE identity_user_id = $1 AND disabled_at IS NULL)
           AS admin_account`,
      [sourceUserId, targetUserId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('ACCOUNT_MERGE_PREVIEW_FAILED', '无法计算账号合并影响。', 500);
    return row;
  }

  private mergeConflicts(impact: MergeImpactRow): string[] {
    return [
      ...(impact.phone_conflict ? ['phoneBinding'] : []),
      ...(Number(impact.registration_conflicts ?? 0) > 0 ? ['eventRegistration'] : []),
      ...(Number(impact.membership_conflicts ?? 0) > 0 ? ['groupMembership'] : []),
      ...(impact.admin_account ? ['operatorAccount'] : []),
    ];
  }

  private mergeProofHash(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  private async performAccountMerge(
    client: PoolClient,
    sourceUserId: string,
    targetUserId: string,
    jobId: string,
  ): Promise<void> {
    const mediaTransfer = await client.query<{ outcome: string }>(
      'SELECT media.apply_account_merge($1) AS outcome',
      [jobId],
    );
    const mediaOutcome = mediaTransfer.rows[0]?.outcome;
    if (mediaOutcome === 'blocked_media_collision') {
      throw new DomainError(
        'ACCOUNT_MERGE_MEDIA_COLLISION',
        '媒体上传或附件记录存在冲突，请刷新合并预览后重试。',
        409,
        { retryable: false },
      );
    }
    if (mediaOutcome !== 'committed') {
      throw new DomainError(
        'ACCOUNT_MERGE_MEDIA_TRANSFER_FAILED',
        '媒体所有权迁移未完成，请稍后重试。',
        500,
        { retryable: true },
      );
    }

    await client.query(
      `UPDATE identity.profiles target_profile SET
         nickname = CASE WHEN target_profile.nickname = 'Spott 用户'
           THEN source_profile.nickname ELSE target_profile.nickname END,
         bio = CASE WHEN target_profile.bio = '' THEN source_profile.bio ELSE target_profile.bio END,
         region_id = COALESCE(target_profile.region_id, source_profile.region_id),
         avatar_asset_id = COALESCE(target_profile.avatar_asset_id, source_profile.avatar_asset_id),
         content_languages = ARRAY(SELECT DISTINCT language
           FROM unnest(target_profile.content_languages || source_profile.content_languages) language)
       FROM identity.profiles source_profile
       WHERE target_profile.user_id = $2 AND source_profile.user_id = $1`,
      [sourceUserId, targetUserId],
    );
    await client.query(
      `INSERT INTO identity.user_interests(user_id, tag_id, weight, source, created_at)
       SELECT $2, tag_id, weight, source, created_at FROM identity.user_interests WHERE user_id = $1
       ON CONFLICT (user_id, tag_id) DO UPDATE SET
         weight = GREATEST(identity.user_interests.weight, EXCLUDED.weight)`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM identity.user_interests WHERE user_id = $1', [sourceUserId]);

    await client.query(
      `INSERT INTO identity.follows(follower_id, target_type, target_id, created_at, deleted_at)
       SELECT $2, target_type, target_id, created_at, deleted_at
       FROM identity.follows
       WHERE follower_id = $1 AND NOT (target_type = 'user' AND target_id = $2)
       ON CONFLICT (follower_id, target_type, target_id) DO UPDATE SET
         deleted_at = CASE WHEN EXCLUDED.deleted_at IS NULL THEN NULL ELSE identity.follows.deleted_at END`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM identity.follows WHERE follower_id = $1', [sourceUserId]);
    await client.query(
      `INSERT INTO identity.follows(follower_id, target_type, target_id, created_at, deleted_at)
       SELECT follower_id, 'user', $2, created_at, deleted_at FROM identity.follows
       WHERE target_type = 'user' AND target_id = $1 AND follower_id <> $2
       ON CONFLICT (follower_id, target_type, target_id) DO UPDATE SET
         deleted_at = CASE WHEN EXCLUDED.deleted_at IS NULL THEN NULL ELSE identity.follows.deleted_at END`,
      [sourceUserId, targetUserId],
    );
    await client.query(
      "DELETE FROM identity.follows WHERE target_type = 'user' AND target_id = $1",
      [sourceUserId],
    );

    await client.query(
      `INSERT INTO identity.blocks(blocker_id, blocked_id, reason_code, created_at)
       SELECT $2, blocked_id, reason_code, created_at FROM identity.blocks
       WHERE blocker_id = $1 AND blocked_id <> $2 ON CONFLICT DO NOTHING`,
      [sourceUserId, targetUserId],
    );
    await client.query(
      `INSERT INTO identity.blocks(blocker_id, blocked_id, reason_code, created_at)
       SELECT blocker_id, $2, reason_code, created_at FROM identity.blocks
       WHERE blocked_id = $1 AND blocker_id <> $2 ON CONFLICT DO NOTHING`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM identity.blocks WHERE blocker_id = $1 OR blocked_id = $1', [
      sourceUserId,
    ]);

    await client.query('UPDATE events.events SET organizer_id = $2 WHERE organizer_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE events.events SET created_by = $2 WHERE created_by = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE events.events SET updated_by = $2 WHERE updated_by = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE events.registrations SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE events.checkins SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE events.checkins SET operator_id = $2 WHERE operator_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      'UPDATE events.attendance_corrections SET requested_by = $2 WHERE requested_by = $1',
      [sourceUserId, targetUserId],
    );
    await client.query(
      'UPDATE events.attendance_corrections SET decided_by = $2 WHERE decided_by = $1',
      [sourceUserId, targetUserId],
    );
    await client.query(
      `INSERT INTO events.event_favorites(user_id, event_id, created_at, deleted_at)
       SELECT $2, event_id, created_at, deleted_at FROM events.event_favorites WHERE user_id = $1
       ON CONFLICT (user_id, event_id) DO UPDATE SET
         deleted_at = CASE WHEN EXCLUDED.deleted_at IS NULL THEN NULL ELSE events.event_favorites.deleted_at END`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM events.event_favorites WHERE user_id = $1', [sourceUserId]);

    await client.query('UPDATE community.groups SET owner_id = $2 WHERE owner_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.group_memberships SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.group_admin_grants SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      'UPDATE community.group_admin_grants SET granted_by = $2 WHERE granted_by = $1',
      [sourceUserId, targetUserId],
    );
    await client.query('UPDATE community.announcements SET author_id = $2 WHERE author_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.comments SET author_id = $2 WHERE author_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.group_transfers SET from_user = $2 WHERE from_user = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.group_transfers SET to_user = $2 WHERE to_user = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.group_invites SET created_by = $2 WHERE created_by = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      'UPDATE community.group_dissolutions SET requested_by = $2 WHERE requested_by = $1',
      [sourceUserId, targetUserId],
    );
    await client.query(
      'UPDATE community.group_dissolutions SET cancelled_by = $2 WHERE cancelled_by = $1',
      [sourceUserId, targetUserId],
    );
    await client.query(
      `INSERT INTO community.announcement_reactions(announcement_id, user_id, reaction, created_at)
       SELECT announcement_id, $2, reaction, created_at FROM community.announcement_reactions WHERE user_id = $1
       ON CONFLICT DO NOTHING`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM community.announcement_reactions WHERE user_id = $1', [
      sourceUserId,
    ]);
    await client.query(
      `DELETE FROM community.achievement_awards source_award USING community.achievement_awards target_award
       WHERE source_award.user_id = $1 AND target_award.user_id = $2
         AND source_award.definition_id = target_award.definition_id
         AND source_award.revoked_at IS NULL AND target_award.revoked_at IS NULL`,
      [sourceUserId, targetUserId],
    );
    await client.query('UPDATE community.achievement_awards SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE community.feedback SET author_id = $2 WHERE author_id = $1', [
      sourceUserId,
      targetUserId,
    ]);

    await client.query(
      `UPDATE commerce.point_transactions source_transaction SET
         business_key = source_transaction.business_key || ':merged:' || left($1::text, 8)
       WHERE source_transaction.user_id = $1 AND EXISTS(
         SELECT 1 FROM commerce.point_transactions target_transaction
         WHERE target_transaction.user_id = $2
           AND target_transaction.business_key = source_transaction.business_key)`,
      [sourceUserId, targetUserId],
    );
    await client.query('UPDATE commerce.point_transactions SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      `UPDATE commerce.point_holds source_hold SET
         business_key = source_hold.business_key || ':merged:' || left($1::text, 8)
       WHERE source_hold.user_id = $1 AND EXISTS(
         SELECT 1 FROM commerce.point_holds target_hold
         WHERE target_hold.user_id = $2 AND target_hold.business_key = source_hold.business_key)`,
      [sourceUserId, targetUserId],
    );
    await client.query('UPDATE commerce.point_holds SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE commerce.store_orders SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE commerce.quotes SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      `UPDATE commerce.wallets target_wallet SET
         paid_balance = target_wallet.paid_balance + source_wallet.paid_balance,
         free_balance = target_wallet.free_balance + source_wallet.free_balance
       FROM commerce.wallets source_wallet
       WHERE target_wallet.user_id = $2 AND source_wallet.user_id = $1`,
      [sourceUserId, targetUserId],
    );
    await client.query(
      'UPDATE commerce.wallets SET paid_balance = 0, free_balance = 0 WHERE user_id = $1',
      [sourceUserId],
    );

    await client.query('UPDATE growth.poster_jobs SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE growth.share_links SET creator_id = $2 WHERE creator_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE growth.attributions SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE safety.reports SET reporter_id = $2 WHERE reporter_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE safety.appeals SET appellant_id = $2 WHERE appellant_id = $1', [
      sourceUserId,
      targetUserId,
    ]);

    await client.query(
      `INSERT INTO notification.preferences(
         user_id, notification_type, in_app, push, email, quiet_hours, locale, updated_at
       ) SELECT $2, notification_type, in_app, push, email, quiet_hours, locale, updated_at
         FROM notification.preferences WHERE user_id = $1
       ON CONFLICT (user_id, notification_type) DO NOTHING`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM notification.preferences WHERE user_id = $1', [sourceUserId]);
    await client.query('UPDATE notification.notifications SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query('UPDATE notification.device_tokens SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      `INSERT INTO analytics.consents(user_id, purpose, granted, policy_version, source, updated_at)
       SELECT $2, purpose, granted, policy_version, source, updated_at FROM analytics.consents WHERE user_id = $1
       ON CONFLICT (user_id, purpose) DO UPDATE SET
         granted = analytics.consents.granted AND EXCLUDED.granted,
         policy_version = EXCLUDED.policy_version,
         updated_at = GREATEST(analytics.consents.updated_at, EXCLUDED.updated_at)`,
      [sourceUserId, targetUserId],
    );
    await client.query('DELETE FROM analytics.consents WHERE user_id = $1', [sourceUserId]);

    await client.query(
      `UPDATE identity.phone_bindings SET user_id = $2
       WHERE user_id = $1 AND unbound_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM identity.phone_bindings
           WHERE user_id = $2 AND unbound_at IS NULL)`,
      [sourceUserId, targetUserId],
    );
    await client.query(
      'UPDATE identity.auth_identities SET user_id = $2, last_used_at = clock_timestamp() WHERE user_id = $1',
      [sourceUserId, targetUserId],
    );
    await client.query(
      'UPDATE identity.sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE user_id = $1',
      [sourceUserId],
    );
    await client.query('UPDATE identity.devices SET user_id = $2 WHERE user_id = $1', [
      sourceUserId,
      targetUserId,
    ]);
    await client.query(
      `UPDATE identity.users target_user SET
         phone_verified_at = COALESCE(target_user.phone_verified_at, source_user.phone_verified_at),
         restriction_flags = ARRAY(SELECT DISTINCT restriction
           FROM unnest(target_user.restriction_flags || source_user.restriction_flags) restriction)
       FROM identity.users source_user
       WHERE target_user.id = $2 AND source_user.id = $1`,
      [sourceUserId, targetUserId],
    );
    await client.query(
      `UPDATE identity.profiles SET deleted_at = COALESCE(deleted_at, clock_timestamp())
       WHERE user_id = $1`,
      [sourceUserId],
    );
    await client.query(
      `UPDATE identity.users SET status = 'anonymized',
         public_handle = $2, deleted_at = COALESCE(deleted_at, clock_timestamp())
       WHERE id = $1`,
      [sourceUserId, `merged_${randomBytes(6).toString('hex')}`],
    );
    await client.query(
      `INSERT INTO admin.audit_logs(
         actor_id, action, resource, resource_id, purpose, before_hash, after_hash, trace_id
       ) VALUES ($1,'account.merge.committed','account_merge',$2,'user_requested',$3,$4,$5)`,
      [
        targetUserId,
        jobId,
        createHash('sha256').update(sourceUserId).digest(),
        createHash('sha256').update(targetUserId).digest(),
        `merge-${jobId}`,
      ],
    );
    await this.recordUserChange(client, targetUserId, 'accounts_merged', {
      sourceUserId,
      mergeJobId: jobId,
    });
  }

  private async authenticateExternal(
    provider: 'apple' | 'google',
    subject: string,
    deviceId: string,
    transportClass: SessionTransportClass,
  ): Promise<SessionResponse> {
    return this.database.transaction(async (client) => {
      let user = await this.findUserByIdentity(client, provider, subject);
      user ??= await this.createUser(client, provider, subject, null, null);
      return this.createSession(
        client,
        user,
        deviceId,
        this.platformForTransport(transportClass),
        transportClass,
      );
    });
  }

  private async findUserByIdentity(
    client: PoolClient,
    provider: 'apple' | 'google' | 'email',
    subject: string,
  ): Promise<UserRow | null> {
    const result = await client.query<UserRow>(
      `SELECT u.id, u.public_handle, u.status, u.phone_verified_at, u.restriction_flags
       FROM identity.auth_identities ai JOIN identity.users u ON u.id = ai.user_id
       WHERE ai.provider = $1 AND ai.provider_subject = $2 AND u.deleted_at IS NULL`,
      [provider, subject],
    );
    return result.rows[0] ?? null;
  }

  private async createUser(
    client: PoolClient,
    provider: 'apple' | 'google' | 'email',
    subject: string,
    emailCipher: Buffer | null,
    emailHash: Buffer | null,
  ): Promise<UserRow> {
    const handle = `spott_${randomBytes(6).toString('hex')}`;
    const inserted = await client.query<UserRow>(
      `INSERT INTO identity.users(public_handle) VALUES ($1)
       RETURNING id, public_handle, status, phone_verified_at, restriction_flags`,
      [handle],
    );
    const user = inserted.rows[0];
    if (!user)
      throw new DomainError('USER_CREATE_FAILED', '账号创建失败。', 500, { retryable: true });
    await client.query(
      `INSERT INTO identity.auth_identities(
         user_id, provider, provider_subject, email_cipher, email_hash
       ) VALUES ($1, $2, $3, $4, $5)`,
      [user.id, provider, subject, emailCipher, emailHash],
    );
    await client.query(
      "INSERT INTO identity.profiles(user_id, nickname) VALUES ($1, 'Spott 用户')",
      [user.id],
    );
    await client.query('INSERT INTO commerce.wallets(user_id) VALUES ($1)', [user.id]);
    await this.recordUserChange(client, user.id, 'created', { publicHandle: user.public_handle });
    return user;
  }

  private async getUser(client: PoolClient, userId: string): Promise<UserRow> {
    const result = await client.query<UserRow>(
      `SELECT id, public_handle, status, phone_verified_at, restriction_flags
       FROM identity.users WHERE id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const user = result.rows[0];
    if (!user) throw new DomainError('USER_NOT_FOUND', '账号不存在。', 404);
    return user;
  }

  private async createSession(
    client: PoolClient,
    user: UserRow,
    deviceId: string,
    platform: 'ios' | 'web' | 'ops',
    transportClass: SessionTransportClass,
  ): Promise<SessionResponse> {
    await this.prepareOwnedDeviceForSession(client, user, deviceId, platform);
    await this.restoreDeletionPendingUser(client, user);
    const refreshSecret = randomBytes(32).toString('base64url');
    const session = await client.query<{ id: string }>(
      `INSERT INTO identity.sessions(
         user_id, device_id, refresh_hash, refresh_family_id, expires_at, transport_class
       ) VALUES ($1, $2, $3, uuidv7(), clock_timestamp() + interval '30 days', $4)
       RETURNING id`,
      [user.id, deviceId, this.refreshHash(refreshSecret), transportClass],
    );
    const sessionId = session.rows[0]?.id;
    if (!sessionId) throw new DomainError('SESSION_CREATE_FAILED', '登录会话创建失败。', 500);
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const admin = await client.query<{ roles: string[] }>(
      `SELECT roles FROM admin.admin_users
       WHERE identity_user_id = $1 AND disabled_at IS NULL AND mfa_enrolled_at IS NOT NULL`,
      [user.id],
    );
    const roles = admin.rows[0] ? ['operator', ...admin.rows[0].roles] : ['user'];
    const accessToken = await new SignJWT({
      sid: sessionId,
      phoneVerified: user.phone_verified_at !== null,
      restrictions: user.restriction_flags,
      roles,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('spott-api')
      .setAudience('spott-clients')
      .setSubject(user.id)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET));
    return {
      accessToken,
      accessTokenExpiresAt: expiresAt.toISOString(),
      refreshToken: `${sessionId}.${refreshSecret}`,
      refreshGeneration: 0,
      sessionId,
      user: {
        id: user.id,
        publicHandle: user.public_handle,
        phoneVerified: user.phone_verified_at !== null,
        restrictions: user.restriction_flags,
      },
    };
  }

  private async prepareOwnedDeviceForSession(
    client: PoolClient,
    user: UserRow,
    deviceId: string,
    platform: 'ios' | 'web' | 'ops',
  ): Promise<void> {
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text, 0))',
      [deviceId],
    );
    const existingDevice = await client.query<{ user_id: string | null }>(
      `SELECT user_id
       FROM identity.devices
       WHERE id = $1
       FOR UPDATE`,
      [deviceId],
    );
    const device = existingDevice.rows[0];
    if (!device) {
      await client.query(
        `INSERT INTO identity.devices(id, user_id, platform)
         VALUES ($1, $2, $3)`,
        [deviceId, user.id, platform],
      );
    } else if (device.user_id !== user.id) {
      throw new DomainError(
        'DEVICE_OWNERSHIP_CONFLICT',
        '该设备已绑定其他账号，不能直接接管。',
        409,
        { retryable: false },
      );
    } else {
      await client.query(
        `UPDATE identity.devices
         SET platform = $2, last_seen_at = clock_timestamp()
         WHERE id = $1`,
        [deviceId, platform],
      );
    }
  }

  private async restoreDeletionPendingUser(client: PoolClient, user: UserRow): Promise<void> {
    if (user.status === 'deletion_pending') {
      await client.query(
        `UPDATE identity.users SET status = 'active', deletion_requested_at = NULL,
           deletion_execute_after = NULL WHERE id = $1`,
        [user.id],
      );
      user.status = 'active';
      await this.recordUserChange(client, user.id, 'deletion_cancelled', {
        deletionPending: false,
      });
    }
  }

  private async prepareWebCompletionUser(client: PoolClient, user: UserRow): Promise<void> {
    const result = await client.query<UserRow>(
      `SELECT id, public_handle, status, phone_verified_at, restriction_flags
       FROM identity.users
       WHERE id = $1 AND deleted_at IS NULL
       FOR UPDATE`,
      [user.id],
    );
    const locked = result.rows[0];
    if (!locked) this.throwWebCompletionUnavailable();
    user.public_handle = locked.public_handle;
    user.status = locked.status;
    user.phone_verified_at = locked.phone_verified_at;
    user.restriction_flags = locked.restriction_flags;

    await this.restoreDeletionPendingUser(client, user);
    if (user.status !== 'active' || user.restriction_flags.includes('loginBlocked')) {
      this.throwWebCompletionUnavailable();
    }
  }

  private async assertWebCompletionDeviceAllowed(
    client: PoolClient,
    userId: string,
    deviceId: string,
  ): Promise<void> {
    const result = await client.query<{ risk_state: string }>(
      `SELECT risk_state
       FROM identity.devices
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [deviceId, userId],
    );
    if (!result.rows[0] || result.rows[0].risk_state === 'blocked') {
      this.throwWebCompletionUnavailable();
    }
  }

  private async recoverWebEmailSession(
    client: PoolClient,
    input: WebEmailSessionCompletionInput,
    attemptHash: Buffer,
    stored: WebCompletionOutcomeRow,
  ): Promise<{ kind: 'completed'; material: WebSessionCompletionMaterial }> {
    return this.recoverWebSessionCompletion(
      client,
      input.attemptId,
      {
        challengeId: input.credential.challengeId,
        deviceId: input.deviceId,
        binding: input.newBinding,
      },
      attemptHash,
      stored,
      input.credential.code,
    );
  }

  private async recoverWebSessionCompletion(
    client: PoolClient,
    attemptId: string,
    input: WebSessionCompletionDispositionInput,
    attemptHash: Buffer,
    stored: WebCompletionOutcomeRow,
    code?: string,
    requireRecoveryActive = true,
  ): Promise<{ kind: 'completed'; material: WebSessionCompletionMaterial }> {
    const result = await client.query<WebCompletionRecoveryRow>(
      `SELECT outcome.challenge_id, outcome.attempt_hash, outcome.request_digest,
              outcome.user_id, outcome.device_id, outcome.session_id,
              outcome.family_id, outcome.binding_id, outcome.refresh_generation,
              outcome.binding_generation, outcome.derivation_version,
              outcome.derivation_kid, outcome.recovery_expires_at,
              outcome.recovery_expires_at > clock_timestamp() AS recovery_active,
              session.refresh_hash AS session_refresh_hash,
              session.current_derivation_kid AS session_derivation_kid,
              session.current_binding_id AS session_binding_id,
              session.current_binding_generation AS session_binding_generation,
              session.expires_at AS session_expires_at,
              session.transport_class,
              session.revoked_at IS NULL AND session.reuse_detected_at IS NULL
                AND session.expires_at > clock_timestamp() AS session_active,
              history.family_id AS history_family_id,
              history.token_hash AS history_token_hash,
              history.derivation_kid AS history_derivation_kid,
              history.binding_id AS history_binding_id,
              history.binding_generation AS history_binding_generation,
              history.state AS history_state,
              binding.current_hash AS binding_current_hash,
              binding.current_kid AS binding_current_kid,
              binding.issued_at AS binding_issued_at,
              binding.absolute_expires_at AS binding_absolute_expires_at,
              binding.proof_class AS binding_proof_class,
              binding.revoked_at IS NULL
                AND binding.absolute_expires_at > clock_timestamp() AS binding_active,
              user_record.public_handle, user_record.status AS user_status,
              user_record.deleted_at IS NULL AS user_active,
              user_record.phone_verified_at, user_record.restriction_flags,
              device.risk_state AS device_risk_state
       FROM identity.web_session_completion_outcomes AS outcome
       JOIN identity.sessions AS session ON session.id = outcome.session_id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id
        AND history.generation = outcome.refresh_generation
       JOIN identity.device_bindings AS binding ON binding.id = outcome.binding_id
       JOIN identity.users AS user_record ON user_record.id = outcome.user_id
       JOIN identity.devices AS device
         ON device.id = outcome.device_id AND device.user_id = outcome.user_id
       WHERE outcome.challenge_id = $1
       FOR UPDATE OF session, history, binding, user_record, device`,
      [stored.challenge_id],
    );
    const row = result.rows[0];
    const key = configuration().REFRESH_TOKEN_DERIVATION_KEYS.getKey(stored.derivation_kid);
    if (!row || !key) this.throwWebCompletionUnavailable();
    const requestDigest = code === undefined
      ? null
      : completionRequestDigest({
          key,
          kid: stored.derivation_kid,
          attemptId,
          challengeId: input.challengeId,
          code,
          deviceId: input.deviceId,
          bindingId: input.binding.bindingId,
          bindingGeneration: input.binding.generation,
          proof: input.binding.proof,
        });
    const bindingHash = persistentDeviceBindingHash({
      proof: input.binding.proof,
      kid: row.binding_current_kid,
      userId: row.user_id,
      deviceId: row.device_id,
      sessionId: row.session_id,
      bindingId: row.binding_id,
      generation: 0,
    });
    if (!bindingHash) this.throwWebCompletionUnavailable();
    const refreshSecret = deriveInitialWebRefreshSecret({
      key,
      kid: stored.derivation_kid,
      attemptHash,
      challengeId: row.challenge_id,
      userId: row.user_id,
      deviceId: row.device_id,
      sessionId: row.session_id,
      familyId: row.family_id,
      bindingId: row.binding_id,
      generation: 0,
      transportClass: 'web_bff',
    });
    const refreshHash = this.refreshHash(refreshSecret);
    const refreshGeneration = this.generation(row.refresh_generation);
    const bindingGeneration = this.generation(row.binding_generation);
    if (
      row.challenge_id !== input.challengeId ||
      row.device_id !== input.deviceId ||
      row.binding_id !== input.binding.bindingId ||
      row.user_status !== 'active' ||
      !row.user_active ||
      row.restriction_flags.includes('loginBlocked') ||
      row.device_risk_state === 'blocked' ||
      row.derivation_version !== 'v1' ||
      (requireRecoveryActive && !row.recovery_active) ||
      !this.sameHash(row.attempt_hash, attemptHash) ||
      (requestDigest !== null && !this.sameHash(row.request_digest, requestDigest)) ||
      refreshGeneration !== 0 ||
      bindingGeneration !== 0 ||
      row.transport_class !== 'web_bff' ||
      !row.session_active ||
      row.session_derivation_kid !== row.derivation_kid ||
      row.session_binding_id !== row.binding_id ||
      this.generation(row.session_binding_generation) !== 0 ||
      row.history_family_id !== row.family_id ||
      row.history_derivation_kid !== row.derivation_kid ||
      row.history_binding_id !== row.binding_id ||
      this.generation(row.history_binding_generation) !== 0 ||
      row.history_state !== 'current' ||
      row.binding_current_kid !== row.derivation_kid ||
      row.binding_proof_class !== 'persistent' ||
      !row.binding_active ||
      !this.sameHash(row.binding_current_hash, bindingHash) ||
      !this.sameHash(row.session_refresh_hash, refreshHash) ||
      !this.sameHash(row.history_token_hash, refreshHash) ||
      !this.sameHash(row.session_refresh_hash, row.history_token_hash)
    ) {
      this.throwWebCompletionUnavailable();
    }

    return {
      kind: 'completed',
      material: await this.webCompletionMaterial(client, {
        user: {
          id: row.user_id,
          public_handle: row.public_handle,
          status: row.user_status,
          phone_verified_at: row.phone_verified_at,
          restriction_flags: row.restriction_flags,
        },
        sessionId: row.session_id,
        familyId: row.family_id,
        refreshSecret,
        sessionExpiresAt: row.session_expires_at,
        bindingId: row.binding_id,
        bindingIssuedAt: row.binding_issued_at,
        bindingExpiresAt: row.binding_absolute_expires_at,
      }),
    };
  }

  private async webCompletionMaterial(
    client: PoolClient,
    input: {
      user: UserRow;
      sessionId: string;
      familyId: string;
      refreshSecret: string;
      sessionExpiresAt: Date;
      bindingId: string;
      bindingIssuedAt: Date;
      bindingExpiresAt: Date;
    },
  ): Promise<WebSessionCompletionMaterial> {
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const admin = await client.query<{ roles: string[] }>(
      `SELECT roles FROM admin.admin_users
       WHERE identity_user_id = $1 AND disabled_at IS NULL AND mfa_enrolled_at IS NOT NULL`,
      [input.user.id],
    );
    const roles = admin.rows[0] ? ['operator', ...admin.rows[0].roles] : ['user'];
    const accessToken = await new SignJWT({
      sid: input.sessionId,
      phoneVerified: input.user.phone_verified_at !== null,
      restrictions: input.user.restriction_flags,
      roles,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer('spott-api')
      .setAudience('spott-clients')
      .setSubject(input.user.id)
      .setJti(randomBytes(16).toString('base64url'))
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1_000))
      .sign(new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET));
    return {
      accessToken,
      accessTokenExpiresAt: expiresAt.toISOString(),
      refreshToken: `s2.${input.sessionId}.0.${input.refreshSecret}`,
      refreshGeneration: 0,
      sessionId: input.sessionId,
      refreshFamilyId: input.familyId,
      refreshTokenExpiresAt: input.sessionExpiresAt.toISOString(),
      transportClass: 'web_bff',
      bindingId: input.bindingId,
      bindingGeneration: 0,
      bindingIssuedAt: input.bindingIssuedAt.toISOString(),
      bindingAbsoluteExpiresAt: input.bindingExpiresAt.toISOString(),
      user: {
        id: input.user.id,
        publicHandle: input.user.public_handle,
        phoneVerified: input.user.phone_verified_at !== null,
        restrictions: input.user.restriction_flags,
      },
    };
  }

  private throwWebCompletionUnavailable(): never {
    throw new DomainError(
      'AUTH_CHALLENGE_UNAVAILABLE',
      '本次登录无法继续，请重新获取验证码。',
      401,
      { retryable: false },
    );
  }

  private throwWebCompletionDispositionAuthorityInvalid(): never {
    throw new DomainError(
      'WEB_SESSION_COMPLETION_AUTHORITY_INVALID',
      '登录完成确认无效，请重新开始登录。',
      401,
      { retryable: false },
    );
  }

  private throwWebCompletionNotReady(): never {
    throw new DomainError(
      'WEB_SESSION_COMPLETION_NOT_READY',
      '登录完成结果尚未就绪，请重新完成登录。',
      409,
      { retryable: false },
    );
  }

  private throwWebCompletionDiscarded(): never {
    throw new DomainError(
      'WEB_SESSION_COMPLETION_DISCARDED',
      '本次登录完成结果已被安全丢弃，请重新开始登录。',
      409,
      { retryable: false },
    );
  }

  private platformForTransport(transportClass: SessionTransportClass): 'ios' | 'web' | 'ops' {
    if (transportClass === 'native') return 'ios';
    if (transportClass === 'ops') return 'ops';
    return 'web';
  }

  private async creditPhoneVerification(
    client: PoolClient,
    userId: string,
    phoneHash: Buffer,
  ): Promise<unknown> {
    // Once per phone number, for life. The grant ledger is keyed by the same HMAC lookup hash that
    // identity.phone_bindings uses, so re-binding a number -- on this account or any other -- can
    // never pay a second time. Keying on the binding id instead made every re-bind a fresh key.
    const grant = await client.query<{ phone_hash: Buffer }>(
      `INSERT INTO commerce.phone_verification_reward_grants(phone_hash, user_id)
       VALUES ($1, $2)
       ON CONFLICT (phone_hash) DO NOTHING RETURNING phone_hash`,
      [phoneHash, userId],
    );
    if (grant.rowCount !== 1) return this.walletBalance(client, userId);

    // Once per account. The stable business key means a second number bound by the same account
    // collides with the account's first reward instead of minting a new idempotency key.
    const transaction = await client.query<{ id: string }>(
      `INSERT INTO commerce.point_transactions(user_id, type, business_key, status, posted_at)
       VALUES ($1, 'phone_verified_reward', 'phone_verified:account', 'posted', clock_timestamp())
       ON CONFLICT (user_id, business_key) DO NOTHING RETURNING id`,
      [userId],
    );
    const transactionId = transaction.rows[0]?.id;
    if (!transactionId) {
      // The account already claimed its reward through another number, so release the grant we
      // just took rather than burning this number's one lifetime eligibility for nothing.
      await client.query(
        `DELETE FROM commerce.phone_verification_reward_grants
         WHERE phone_hash = $1 AND transaction_id IS NULL`,
        [phoneHash],
      );
      return this.walletBalance(client, userId);
    }

    const reward = await this.activeConfigBigInt(client, 'points.reward.phone_verified', 500n);
    const expiryDays = await this.activeConfigBigInt(client, 'points.expiry.free_days', 180n);
    await client.query(
      `INSERT INTO commerce.point_entries(transaction_id, account_code, bucket, amount, expires_at)
       VALUES
         ($1, $2, 'free', $3, clock_timestamp() + ($4::text || ' days')::interval),
         ($1, 'platform:rewards', 'free', -$3, NULL)`,
      [transactionId, `user:${userId}`, reward.toString(), expiryDays.toString()],
    );
    await client.query(
      'UPDATE commerce.wallets SET free_balance = free_balance + $2 WHERE user_id = $1',
      [userId, reward.toString()],
    );
    await client.query(
      `UPDATE commerce.phone_verification_reward_grants
       SET transaction_id = $2 WHERE phone_hash = $1`,
      [phoneHash, transactionId],
    );
    return this.walletBalance(client, userId);
  }

  private async walletBalance(client: PoolClient, userId: string): Promise<unknown> {
    const wallet = await client.query<{
      paid_balance: string;
      free_balance: string;
      version: string;
    }>('SELECT paid_balance, free_balance, version FROM commerce.wallets WHERE user_id = $1', [
      userId,
    ]);
    const row = wallet.rows[0];
    return {
      paidBalance: Number(row?.paid_balance ?? 0),
      freeBalance: Number(row?.free_balance ?? 0),
      totalBalance: Number(row?.paid_balance ?? 0) + Number(row?.free_balance ?? 0),
      version: Number(row?.version ?? 1),
    };
  }

  private async activePhoneBinding(
    client: PoolClient,
    phoneHash: Buffer,
  ): Promise<{ id: string; user_id: string; verified_at: Date } | undefined> {
    const binding = await client.query<{ id: string; user_id: string; verified_at: Date }>(
      `SELECT id, user_id, verified_at
       FROM identity.phone_bindings
       WHERE phone_hash = $1 AND unbound_at IS NULL
       FOR SHARE`,
      [phoneHash],
    );
    return binding.rows[0];
  }

  private assertPhoneBindingOwner(bindingUserId: string, currentUserId: string): void {
    if (bindingUserId === currentUserId) return;
    throw new DomainError('PHONE_ALREADY_BOUND', '该手机号已绑定其他账号。', 409, {
      actions: [{ type: 'previewMerge', label: '查看账号合并' }],
    });
  }

  private async activeConfigBigInt(
    client: PoolClient,
    key: string,
    fallback: bigint,
  ): Promise<bigint> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = $1 AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
      [key],
    );
    const value = result.rows[0]?.value_json;
    if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
    const catalog = await client.query<{ configured_value: string }>(
      `SELECT CASE
         WHEN COALESCE((SELECT value_json #>> '{}' FROM admin.config_revisions
           WHERE key = 'points.lifecycle.stage' AND state = 'active'
           ORDER BY version DESC LIMIT 1), 'launch') = 'stable'
         THEN stable_value ELSE launch_value END::text AS configured_value
       FROM commerce.point_rule_catalog WHERE key = $1`,
      [key],
    );
    return catalog.rows[0] ? BigInt(catalog.rows[0].configured_value) : fallback;
  }

  private async recordUserChange(
    client: PoolClient,
    userId: string,
    topic: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const eventType = `user.${topic}`;
    await client.query(
      `SELECT sync.record_change($1, $2, 'user', $1, 'upsert',
         (SELECT version FROM identity.users WHERE id = $1), $3, $4)`,
      [userId, eventType, Object.keys(payload), payload],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('identity.user', $1, $2, $3)`,
      [userId, eventType, payload],
    );
  }

  private async lockBindingUpgradeSession(
    client: PoolClient,
    sessionId: string,
  ): Promise<BindingUpgradeSessionRow | null> {
    const result = await client.query<BindingUpgradeSessionRow>(
      `SELECT session.id, session.user_id, session.device_id,
              device.user_id AS device_user_id, device.risk_state AS device_risk_state,
              session.refresh_hash, session.refresh_family_id, session.refresh_generation,
              session.current_derivation_kid, session.current_binding_id,
              session.current_binding_generation, session.transport_class, session.expires_at,
              (session.revoked_at IS NULL AND session.reuse_detected_at IS NULL
                AND session.expires_at > clock_timestamp()) AS session_active,
              user_record.status AS user_status, user_record.public_handle,
              user_record.phone_verified_at, user_record.restriction_flags
       FROM identity.sessions AS session
       JOIN identity.devices AS device ON device.id = session.device_id
       JOIN identity.users AS user_record
         ON user_record.id = session.user_id AND user_record.deleted_at IS NULL
       WHERE session.id = $1
         AND ${webSessionCompletionAcceptedSQL}
       FOR UPDATE OF session, device`,
      [sessionId],
    );
    return result.rows[0] ?? null;
  }

  private async lockBindingUpgradeHistory(
    client: PoolClient,
    sessionId: string,
    generation: number,
  ): Promise<BindingUpgradeHistoryRow | null> {
    const result = await client.query<BindingUpgradeHistoryRow>(
      `SELECT session_id, family_id, generation, token_hash, derivation_kid,
              transport_class, binding_id, binding_generation, state
       FROM identity.session_refresh_history
       WHERE session_id = $1 AND generation = $2::bigint
       FOR UPDATE`,
      [sessionId, generation],
    );
    return result.rows[0] ?? null;
  }

  private validBindingUpgradeState(
    session: BindingUpgradeSessionRow,
    history: BindingUpgradeHistoryRow,
    credential: NonNullable<ReturnType<typeof parseRefreshCredential>>,
    deviceId: string,
    suppliedRefreshHash: Buffer,
    generation: number,
  ): boolean {
    const historyGeneration = this.generation(history.generation);
    const storedLegacyCredential = generation === 0 && session.current_derivation_kid === null;
    const canonicalCredential = credential.version === 'legacy'
      ? storedLegacyCredential
      : !storedLegacyCredential && credential.generation === generation;
    return canonicalCredential
      && session.id === credential.sessionId
      && session.device_id === deviceId
      && session.device_user_id === session.user_id
      && session.device_risk_state !== 'blocked'
      && session.user_status === 'active'
      && !session.restriction_flags.includes('loginBlocked')
      && session.session_active
      && this.sameHash(session.refresh_hash, suppliedRefreshHash)
      && history.session_id === session.id
      && history.family_id === session.refresh_family_id
      && historyGeneration === generation
      && this.sameHash(history.token_hash, suppliedRefreshHash)
      && this.sameHash(history.token_hash, session.refresh_hash)
      && history.derivation_kid === session.current_derivation_kid
      && history.transport_class === session.transport_class
      && history.binding_id === session.current_binding_id
      && this.generation(history.binding_generation)
        === this.generation(session.current_binding_generation)
      && history.state === 'current';
  }

  private async currentIssuedBinding(
    client: PoolClient,
    session: BindingUpgradeSessionRow,
    history: BindingUpgradeHistoryRow,
    input: DeviceBindingUpgradeInput,
  ): Promise<DeviceBindingUpgradeMaterial | null> {
    if (
      session.current_binding_id !== input.newBinding.bindingId ||
      this.generation(session.current_binding_generation) !== input.newBinding.generation ||
      history.binding_id !== input.newBinding.bindingId ||
      this.generation(history.binding_generation) !== input.newBinding.generation
    ) {
      return null;
    }
    const result = await client.query<IssuedBindingRow>(
      `SELECT id, generation, current_hash, current_kid, issued_at,
              absolute_expires_at, revoked_at
       FROM identity.device_bindings
       WHERE id = $1 AND user_id = $2 AND device_id = $3 AND session_id = $4
         AND generation = $5::bigint AND proof_class = 'persistent'
         AND revoked_at IS NULL AND absolute_expires_at > clock_timestamp()
       FOR UPDATE`,
      [input.newBinding.bindingId, session.user_id, session.device_id,
        session.id, input.newBinding.generation],
    );
    const binding = result.rows[0];
    if (!binding || !binding.current_hash || !binding.current_kid) return null;
    const suppliedHash = persistentDeviceBindingHash({
      proof: input.newBinding.proof,
      kid: binding.current_kid,
      userId: session.user_id,
      deviceId: session.device_id,
      sessionId: session.id,
      bindingId: input.newBinding.bindingId,
      generation: input.newBinding.generation,
    });
    if (!suppliedHash || !this.sameHash(suppliedHash, binding.current_hash)) return null;
    const generation = this.generation(session.refresh_generation);
    if (generation === null) return null;
    return this.bindingUpgradeMaterial(session, generation, input, binding);
  }

  private bindingUpgradeMaterial(
    session: BindingUpgradeSessionRow,
    generation: number,
    input: DeviceBindingUpgradeInput,
    binding: Pick<IssuedBindingRow, 'issued_at' | 'absolute_expires_at'>,
  ): DeviceBindingUpgradeMaterial {
    return {
      sessionId: session.id,
      refreshFamilyId: session.refresh_family_id,
      refreshGeneration: generation,
      transportClass: 'web_bff',
      bindingId: input.newBinding.bindingId,
      bindingGeneration: input.newBinding.generation,
      bindingIssuedAt: binding.issued_at.toISOString(),
      bindingAbsoluteExpiresAt: binding.absolute_expires_at.toISOString(),
      refreshTokenExpiresAt: session.expires_at.toISOString(),
      user: {
        id: session.user_id,
        publicHandle: session.public_handle,
        phoneVerified: session.phone_verified_at !== null,
        restrictions: session.restriction_flags,
      },
    };
  }

  private throwExpiredBindingUpgrade(): never {
    throw new DomainError('TOKEN_EXPIRED', '登录已过期，请重新登录。', 401, {
      retryable: false,
    });
  }

  private validBootstrapState(
    row: BootstrapSessionRow,
    credential: NonNullable<ReturnType<typeof parseRefreshCredential>>,
    deviceId: string,
    proof: PersistentDeviceBindingProof,
    suppliedRefreshHash: Buffer,
    suppliedBindingHash: Buffer,
    refreshEnvelopeClaims: WebRefreshEnvelopeDBClaims | undefined,
  ): boolean {
    const generation = this.generation(row.refresh_generation);
    const currentBindingGeneration = this.generation(row.current_binding_generation);
    const historyGeneration = this.generation(row.history_generation);
    const historyBindingGeneration = this.generation(row.history_binding_generation);
    const bindingGeneration = this.generation(row.binding_generation);
    if (
      generation === null ||
      currentBindingGeneration === null ||
      historyGeneration === null ||
      historyBindingGeneration === null ||
      bindingGeneration === null
    ) {
      return false;
    }

    const storedLegacyCredential = generation === 0 && row.current_derivation_kid === null;
    const canonicalCredential =
      credential.version === 'legacy'
        ? storedLegacyCredential
        : !storedLegacyCredential && credential.generation === generation;
    return (
      canonicalCredential &&
      row.id === credential.sessionId &&
      row.device_id === deviceId &&
      row.device_user_id === row.user_id &&
      row.device_risk_state !== 'blocked' &&
      row.user_status === 'active' &&
      !row.restriction_flags.includes('loginBlocked') &&
      row.session_active &&
      this.sameHash(row.refresh_hash, suppliedRefreshHash) &&
      row.history_session_id === row.id &&
      row.history_family_id === row.refresh_family_id &&
      historyGeneration === generation &&
      this.sameHash(row.history_token_hash, suppliedRefreshHash) &&
      this.sameHash(row.history_token_hash, row.refresh_hash) &&
      row.history_derivation_kid === row.current_derivation_kid &&
      row.history_transport_class === row.transport_class &&
      row.history_state === 'current' &&
      row.current_binding_id === proof.bindingId &&
      currentBindingGeneration === proof.generation &&
      row.history_binding_id === proof.bindingId &&
      historyBindingGeneration === proof.generation &&
      row.binding_id === proof.bindingId &&
      bindingGeneration === proof.generation &&
      row.binding_proof_class === 'persistent' &&
      row.binding_active &&
      this.sameHash(row.binding_current_hash, suppliedBindingHash) &&
      this.validRefreshEnvelopeClaims(
        refreshEnvelopeClaims,
        row.transport_class,
        row.id,
        row.refresh_family_id,
        generation,
        row.history_binding_id,
        historyBindingGeneration,
      )
    );
  }

  private validRefreshEnvelopeClaims(
    value: unknown,
    transportClass: SessionTransportClass,
    sessionId: string,
    familyId: string,
    generation: number,
    bindingId: string | null,
    bindingGeneration: number,
  ): boolean {
    if (transportClass !== 'web_bff') return value === undefined;
    const parsed = webRefreshEnvelopeDBClaimsSchema.safeParse(value);
    return parsed.success
      && parsed.data.sessionId === sessionId
      && parsed.data.familyId === familyId
      && parsed.data.generation === generation
      && parsed.data.transportClass === 'web_bff'
      && parsed.data.persistentBindingId === bindingId
      && parsed.data.persistentBindingGeneration === bindingGeneration;
  }

  private sameHash(left: Buffer, right: Buffer): boolean {
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private generation(value: string | number | null): number | null {
    if (value === null) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private canonicalGeneration(value: string | number | null): number | null {
    const generation = this.generation(value);
    if (generation === null) return null;
    return typeof value === 'string' && value !== String(generation) ? null : generation;
  }

  private matchesCode(expected: Buffer, suppliedCode: string): boolean {
    const actual = this.codeHash(suppliedCode);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private throwInvalidOtp(attempts: number, retryAt: Date | null): never {
    const rateLimited = attempts >= 5;
    throw new DomainError(
      rateLimited ? 'OTP_RATE_LIMITED' : 'OTP_INVALID',
      '验证码不正确。',
      rateLimited ? 429 : 400,
      {
        meta: {
          remainingAttempts: Math.max(0, 5 - attempts),
          ...(retryAt ? { retryAt: retryAt.toISOString() } : {}),
        },
      },
    );
  }

  private otpCode(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  private codeHash(code: string): Buffer {
    return createHmac('sha256', configuration().REFRESH_TOKEN_SECRET).update(code).digest();
  }

  private refreshHash(secret: string): Buffer {
    return createHmac('sha256', configuration().REFRESH_TOKEN_SECRET).update(secret).digest();
  }

  private pgCode(error: unknown): string | undefined {
    return typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string'
      ? error.code
      : undefined;
  }
}
