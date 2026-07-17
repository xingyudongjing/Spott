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
import {
  decideTransport,
  parseRefreshCredential,
  type SessionRequestChannel,
  type SessionTransportClass,
  type VerifiedBFFAuthority,
} from '../../platform/web-bff-authority.js';
import { SessionTokenService, type DeviceBindingProof } from './session-token.service.js';

const emailSchema = z.string().trim().toLowerCase().email().max(254);
const phoneSchema = z.string().regex(/^\+81[1-9][0-9]{8,9}$/);
const deviceSchema = z.string().uuid();
const codeSchema = z.string().regex(/^[0-9]{6}$/);
const persistentDeviceBindingProofSchema = z
  .object({
    bindingId: z.string().uuid(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    proof: z.string().min(32).max(1_024),
    proofClass: z.literal('persistent'),
  })
  .strict();

export type PersistentDeviceBindingProof = z.infer<typeof persistentDeviceBindingProofSchema>;

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
  binding_proof_class: string;
  binding_active: boolean;
  user_status: string;
  public_handle: string;
  phone_verified_at: Date | null;
  restriction_flags: string[];
  admin_roles: string[];
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
    const suppliedBindingHash = createHash('sha256').update(proof.proof).digest();
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
         AND session.revoked_at IS NULL
         AND session.reuse_detected_at IS NULL
         AND session.expires_at > clock_timestamp()
         AND device.risk_state <> 'blocked'
         AND user_record.status = 'active'
         AND NOT ('loginBlocked' = ANY(user_record.restriction_flags))
         AND binding.id = $3
         AND binding.generation = $4::bigint
         AND session.refresh_hash = $5
         AND history.token_hash = $5
         AND binding.current_hash = $6`,
      [
        credential.sessionId,
        deviceId,
        proof.bindingId,
        proof.generation,
        suppliedRefreshHash,
        suppliedBindingHash,
      ],
    );
    const row = result.rows[0];
    if (
      !row ||
      !this.validBootstrapState(
        row,
        credential,
        deviceId,
        proof,
        suppliedRefreshHash,
        suppliedBindingHash,
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
    const result = await this.database.query(
      `UPDATE identity.sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    return { revokedCount: result.rowCount ?? 0 };
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
        `SELECT transport_class
         FROM identity.sessions
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
           AND expires_at > clock_timestamp()
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
    await client.query(
      `INSERT INTO identity.devices(id, user_id, platform)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform, last_seen_at = clock_timestamp()`,
      [deviceId, user.id, platform],
    );
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

  private validBootstrapState(
    row: BootstrapSessionRow,
    credential: NonNullable<ReturnType<typeof parseRefreshCredential>>,
    deviceId: string,
    proof: PersistentDeviceBindingProof,
    suppliedRefreshHash: Buffer,
    suppliedBindingHash: Buffer,
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
      this.sameHash(row.binding_current_hash, suppliedBindingHash)
    );
  }

  private sameHash(left: Buffer, right: Buffer): boolean {
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private generation(value: string | number | null): number | null {
    if (value === null) return null;
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
