import { createHash, createHmac } from 'node:crypto';
import { jwtVerify } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import type {
  SessionTransportClass,
  VerifiedBFFAuthority,
} from '../../platform/web-bff-authority.js';
import {
  appleAudienceForPlatform,
  appleNonceDigest,
  AuthService,
  type SessionResponse,
} from './auth.service.js';
import type { WebRefreshEnvelopeDBClaims } from './refresh-envelope-claims.js';
import {
  persistentDeviceBindingHash,
  type DeviceBindingProof,
} from './session-token.service.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1:55432/spott_auth_service_unit_test',
  ACCESS_TOKEN_SECRET: 'auth-service-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: 'auth-service-refresh-token-secret-at-least-32-bytes',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'auth-service-lookup-pepper-at-least-16-bytes',
  GOOGLE_SERVER_CLIENT_ID: 'spott-google-server-client.apps.googleusercontent.com',
  SPOTT_WEB_BFF_KEYS:
    `bff-2026-07:${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
  REFRESH_TOKEN_DERIVATION_KEYS:
    `refresh-2026-07:${Buffer.from('fedcba9876543210fedcba9876543210').toString('base64url')}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: 'refresh-2026-07',
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

const currentUserId = '019b0000-0000-7000-8000-000000000001';
const secondUserId = '019b0000-0000-7000-8000-000000000002';
const currentSessionId = '019b0000-0000-7000-8000-000000000003';
const phoneChallengeId = '019b0000-0000-7000-8000-000000000040';
type SessionRequestChannel = 'headerless_native' | 'consumer_web' | 'verified_bff' | 'ops';

interface PhoneBindingState {
  id: string;
  user_id: string;
  verified_at: Date;
}

function phoneVerificationHarness(initialBinding?: PhoneBindingState) {
  const verifiedAt = new Date('2026-07-16T01:02:03.000Z');
  const challenge = {
    id: phoneChallengeId,
    phone_hash: Buffer.alloc(32, 7),
    phone_cipher: Buffer.alloc(48, 8),
    otp_hash: Buffer.alloc(32, 9),
    attempts: 0,
    expires_at: new Date('2099-07-16T01:12:03.000Z'),
    verified_at: null as Date | null,
    suspended_until: null as Date | null,
  };
  let binding = initialBinding;
  let rewardCredited = Boolean(initialBinding);
  let rewardGranted = Boolean(initialBinding);
  let freeBalance = initialBinding ? 600 : 100;
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM identity.phone_challenges')) {
        return { rows: [{ ...challenge }], rowCount: 1 };
      }
      if (sql.includes('FROM identity.phone_bindings')) {
        return { rows: binding ? [{ ...binding }] : [], rowCount: binding ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO identity.phone_bindings')) {
        if (binding) {
          if (sql.includes('ON CONFLICT')) return { rows: [], rowCount: 0 };
          throw Object.assign(new Error('active phone already exists'), { code: '23505' });
        }
        binding = {
          id: '019b0000-0000-7000-8100-000000000001',
          user_id: currentUserId,
          verified_at: verifiedAt,
        };
        return { rows: [{ ...binding }], rowCount: 1 };
      }
      if (sql.includes('UPDATE identity.phone_challenges') && sql.includes('SET verified_at')) {
        challenge.verified_at ??= verifiedAt;
        return { rows: [{ verified_at: challenge.verified_at }], rowCount: 1 };
      }
      if (sql.includes('UPDATE identity.users SET phone_verified_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO commerce.phone_verification_reward_grants')) {
        if (rewardGranted) return { rows: [], rowCount: 0 };
        rewardGranted = true;
        return { rows: [{ phone_hash: challenge.phone_hash }], rowCount: 1 };
      }
      if (sql.includes('UPDATE commerce.phone_verification_reward_grants')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO commerce.point_transactions')) {
        if (rewardCredited) return { rows: [], rowCount: 0 };
        rewardCredited = true;
        return { rows: [{ id: '019b0000-0000-7000-8300-000000000001' }], rowCount: 1 };
      }
      if (sql.includes('FROM admin.config_revisions')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM commerce.point_rule_catalog')) {
        return { rows: [{ configured_value: '500' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO commerce.point_entries')) return { rows: [], rowCount: 2 };
      if (sql.includes('UPDATE commerce.wallets SET free_balance')) {
        freeBalance += 500;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM commerce.wallets')) {
        return {
          rows: [{ paid_balance: '0', free_balance: String(freeBalance), version: '2' }],
          rowCount: 1,
        };
      }
      if (sql.includes('sync.record_change') || sql.includes('INSERT INTO sync.outbox_events')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected phone verification query: ${sql}`);
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };
  const service = new AuthService(database as never, {} as never, {} as never, {} as never);
  (service as unknown as { matchesCode: () => boolean }).matchesCode = () => true;
  return { service, client, challenge, verifiedAt };
}

describe('Apple identity audience isolation', () => {
  it('keeps iOS bundle and Web Service ID audiences mutually exclusive', () => {
    const config = {
      APPLE_BUNDLE_ID: 'com.yaokai.Spott',
      APPLE_SERVICE_ID: 'jp.spott.web',
    };
    expect(appleAudienceForPlatform('ios', config)).toBe('com.yaokai.Spott');
    expect(appleAudienceForPlatform('web', config)).toBe('jp.spott.web');
    expect(() =>
      appleAudienceForPlatform('web', {
        APPLE_BUNDLE_ID: 'com.yaokai.Spott',
      }),
    ).toThrowError('Web 端 Apple 登录暂未开放。');
  });

  it('requires the SHA-256 digest of the caller nonce for both platforms', () => {
    const nonce = 'nonce-with-at-least-thirty-two-random-characters';
    expect(appleNonceDigest(nonce)).toBe(createHash('sha256').update(nonce).digest('hex'));
  });

  it.each([
    ['native', 'web'],
    ['web_bff', 'ios'],
    ['legacy_unclassified', 'ios'],
  ] as const)(
    'rejects %s transport with caller-controlled %s Apple platform before provider verification',
    async (transportClass, platform) => {
      const service = new AuthService({} as never, {} as never, {} as never, {} as never);
      const internal = service as unknown as { verifyAppleCredential: ReturnType<typeof vi.fn> };
      internal.verifyAppleCredential = vi.fn().mockResolvedValue({
        provider: 'apple',
        subject: 'apple-subject',
        credentialHash: Buffer.alloc(32, 7),
      });

      await expect(
        service.authenticateApple(
          {
            identityToken: 'apple-token',
            nonce: 'nonce-with-at-least-thirty-two-random-characters',
            deviceId: '019b0000-0000-7000-8000-000000000020',
            platform,
          },
          transportClass,
        ),
      ).rejects.toMatchObject({
        code: 'SESSION_TRANSPORT_MISMATCH',
        status: 403,
      });
      expect(internal.verifyAppleCredential).not.toHaveBeenCalled();
    },
  );
});

describe('Google native transport isolation', () => {
  it('passes a trusted native Google issuance through without reclassifying it as Web', async () => {
    const service = new AuthService({} as never, {} as never, {} as never, {} as never);
    const internal = service as unknown as {
      verifyGoogleCredential: ReturnType<typeof vi.fn>;
      authenticateExternal: ReturnType<typeof vi.fn>;
    };
    internal.verifyGoogleCredential = vi.fn().mockResolvedValue({
      provider: 'google',
      subject: 'native-google-subject',
      credentialHash: Buffer.alloc(32, 7),
    });
    internal.authenticateExternal = vi
      .fn()
      .mockResolvedValue({ sessionId: 'native-google-session' });

    await expect(
      service.authenticateGoogle(
        {
          idToken: 'native-google-token',
          deviceId: '019b0000-0000-7000-8000-000000000020',
        },
        'native',
      ),
    ).resolves.toEqual({ sessionId: 'native-google-session' });
    expect(internal.authenticateExternal).toHaveBeenCalledWith(
      'google',
      'native-google-subject',
      '019b0000-0000-7000-8000-000000000020',
      'native',
    );
  });
});

describe('AuthService account merge proof handshake', () => {
  it('delegates every media ownership transfer to the migration-0022 definer boundary', async () => {
    const jobId = '019b0000-0000-7000-9000-000000000090';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('media.apply_account_merge')) {
          return { rows: [{ outcome: 'committed' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new AuthService({} as never, {} as never, {} as never, {} as never);

    await (
      service as unknown as {
        performAccountMerge(
          transactionClient: typeof client,
          sourceUserId: string,
          targetUserId: string,
          jobId: string,
        ): Promise<void>;
      }
    ).performAccountMerge(client, secondUserId, currentUserId, jobId);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/SELECT\s+media\.apply_account_merge\(\$1\)\s+AS\s+outcome/u),
      [jobId],
    );
    expect(
      client.query.mock.calls.some(([sql]) => /UPDATE\s+media\.assets/iu.test(String(sql))),
    ).toBe(false);
  });

  it('creates a short-lived preview only after resolving a different verified identity', async () => {
    const expiresAt = new Date('2026-07-15T00:10:00Z');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO identity.auth_credential_uses'))
          return { rows: [], rowCount: 1 };
        if (sql.includes('FROM identity.auth_identities')) {
          return { rows: [{ user_id: secondUserId }], rowCount: 1 };
        }
        if (sql.includes('AS registration_conflicts')) {
          return {
            rows: [
              {
                source_owned_events: '2',
                source_owned_groups: '1',
                source_paid_balance: '500',
                source_free_balance: '80',
                target_paid_balance: '0',
                target_free_balance: '100',
                phone_conflict: false,
                registration_conflicts: '0',
                membership_conflicts: '0',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO identity.account_merge_jobs')) {
          return {
            rows: [{ id: '019b0000-0000-7000-9000-000000000001', expires_at: expiresAt }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const service = new AuthService(database as never, {} as never, {} as never, {} as never);
    (
      service as unknown as {
        verifyMergeCredential: () => Promise<{
          provider: 'google';
          subject: string;
          credentialHash: Buffer;
        }>;
      }
    ).verifyMergeCredential = vi.fn().mockResolvedValue({
      provider: 'google',
      subject: 'google-subject',
      credentialHash: Buffer.alloc(32, 7),
    });

    const result = (await service.mergePreview(currentUserId, {
      provider: 'google',
      idToken: 'verified-id-token',
    })) as {
      jobId: string;
      mergeToken: string;
      sourceUserId: string;
      targetUserId: string;
      canCommit: boolean;
    };

    expect(result.jobId).toBe('019b0000-0000-7000-9000-000000000001');
    expect(result.mergeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.sourceUserId).toBe(secondUserId);
    expect(result.targetUserId).toBe(currentUserId);
    expect(result.canCommit).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('verification_hash'))).toBe(true);
  });

  it('rejects commit when the one-time proof does not match the verified preview', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM identity.sessions')) {
          return { rows: [{ transport_class: 'native' }], rowCount: 1 };
        }
        if (sql.includes('FROM identity.account_merge_jobs')) {
          return {
            rows: [
              {
                id: '019b0000-0000-7000-9000-000000000001',
                source_user_id: secondUserId,
                target_user_id: currentUserId,
                state: 'previewed',
                preview_json: { conflicts: [] },
                verification_hash: Buffer.alloc(32, 1),
                expires_at: new Date(Date.now() + 60_000),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
    };
    const service = new AuthService(
      database as never,
      {} as never,
      idempotency as never,
      {} as never,
    );

    await expect(
      (service as unknown as MergeCommitContract).mergeCommit(
        currentUserId,
        currentSessionId,
        '019b0000-0000-7000-8000-000000000010',
        {
          jobId: '019b0000-0000-7000-9000-000000000001',
          mergeToken: 'invalid-proof-that-does-not-match-the-preview-token',
          deviceId: '019b0000-0000-7000-8000-000000000020',
        },
        undefined,
        'headerless_native',
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MERGE_PROOF_INVALID', status: 401 });
  });
});

describe('AuthService refresh credential boundary', () => {
  const deviceId = '019b0000-0000-7000-8000-000000000020';
  const malformed = `${currentSessionId}.${'a'.repeat(1_024)}`;

  it('rejects malformed or oversized consumer refresh material before any database operation', async () => {
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error('database must not be touched')),
      query: vi.fn().mockRejectedValue(new Error('database must not be touched')),
    };
    const service = new AuthService(database as never, {} as never, {} as never, {} as never);

    await expect(
      service.refresh(malformed, deviceId, 'web', undefined, 'headerless_native'),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects malformed or oversized Ops refresh material before its device lookup', async () => {
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error('database must not be touched')),
      query: vi.fn().mockRejectedValue(new Error('database must not be touched')),
    };
    const service = new AuthService(database as never, {} as never, {} as never, {} as never);

    await expect(service.refreshOps(malformed)).rejects.toMatchObject({
      code: 'TOKEN_INVALID',
      status: 401,
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('maps reused to HTTP 401 only after the mutation transaction resolves and commits', async () => {
    const order: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM identity.sessions')) {
          return {
            rows: [
              {
                id: currentSessionId,
                user_id: currentUserId,
                device_id: deviceId,
                refresh_hash: Buffer.alloc(32),
                expires_at: new Date(Date.now() + 60_000),
                revoked_at: new Date(),
                reuse_detected_at: null,
                transport_class: 'native',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.startsWith('UPDATE identity.sessions')) return { rows: [], rowCount: 1 };
        throw new Error(`Unexpected legacy refresh query: ${sql}`);
      }),
    };
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{ transport_class: 'native' }],
        rowCount: 1,
      }),
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => {
        try {
          const result = await work(client);
          const kind =
            typeof result === 'object' && result !== null && 'kind' in result
              ? String(result.kind)
              : 'session';
          order.push(`outcome:${kind}`, 'commit');
          return result;
        } catch (error) {
          order.push('rollback');
          throw error;
        }
      }),
    };
    const sessionTokens = {
      rotate: vi.fn().mockImplementation(async () => {
        order.push('rotate');
        return { kind: 'reused', sessionId: currentSessionId, familyId: currentSessionId };
      }),
    };
    const service = Reflect.construct(AuthService, [
      database,
      {},
      {},
      sessionTokens,
    ]) as Task5RefreshContract;
    const secret = Buffer.alloc(32, 19).toString('base64url');
    let caught: unknown;
    try {
      await service.refresh(
        `s2.${currentSessionId}.0.${secret}`,
        deviceId,
        'web',
        undefined,
        'headerless_native',
        '019b0000-0000-7000-8000-000000000050',
        {
          bindingId: '019b0000-0000-7000-8000-000000000051',
          generation: 3,
          proof: Buffer.alloc(32, 20).toString('base64url'),
        },
      );
    } catch (error) {
      caught = error;
      order.push('mapped');
    }

    expect(caught).toMatchObject({ code: 'REFRESH_TOKEN_REUSED', status: 401 });
    expect(order).toEqual(['rotate', 'outcome:reused', 'commit', 'mapped']);
    expect(sessionTokens.rotate).toHaveBeenCalledOnce();
  });
});

const bootstrapDeviceId = '019b0000-0000-7000-8000-000000000020';
const bootstrapFamilyId = '019b0000-0000-7000-8000-000000000021';
const bootstrapBindingId = '019b0000-0000-7000-8000-000000000022';
const bootstrapSecret = Buffer.alloc(32, 21).toString('base64url');
const bootstrapBindingSecret = Buffer.alloc(32, 22).toString('base64url');
const bootstrapRefreshHash = createHmac('sha256', process.env.REFRESH_TOKEN_SECRET as string)
  .update(bootstrapSecret)
  .digest();
const bootstrapBindingHash = persistentDeviceBindingHash({
  proof: bootstrapBindingSecret,
  kid: 'refresh-2026-07',
  userId: currentUserId,
  deviceId: bootstrapDeviceId,
  sessionId: currentSessionId,
  bindingId: bootstrapBindingId,
  generation: 4,
});
if (!bootstrapBindingHash) throw new Error('Bootstrap binding hash fixture was not derived');
const bootstrapProof = {
  bindingId: bootstrapBindingId,
  generation: 4,
  proof: bootstrapBindingSecret,
  proofClass: 'persistent',
} as const;
const bootstrapAuthority: VerifiedBFFAuthority = {
  version: 'v1',
  kid: 'bff-2026-07',
  timestamp: 1_784_246_400_000,
  nonceHash: Buffer.alloc(32, 7),
};
const bootstrapEnvelopeClaims = {
  sessionId: currentSessionId,
  familyId: bootstrapFamilyId,
  generation: 3,
  transportClass: 'web_bff',
  persistentBindingId: bootstrapBindingId,
  persistentBindingGeneration: 4,
} as const;
const baseBootstrapRow = {
  id: currentSessionId,
  user_id: currentUserId,
  device_id: bootstrapDeviceId,
  device_user_id: currentUserId,
  device_risk_state: 'normal',
  refresh_hash: bootstrapRefreshHash,
  refresh_family_id: bootstrapFamilyId,
  refresh_generation: '3',
  current_derivation_kid: 'refresh-2026-07' as string | null,
  current_binding_id: bootstrapBindingId,
  current_binding_generation: '4',
  transport_class: 'native' as SessionTransportClass,
  session_active: true,
  history_session_id: currentSessionId,
  history_family_id: bootstrapFamilyId,
  history_generation: '3',
  history_token_hash: bootstrapRefreshHash,
  history_derivation_kid: 'refresh-2026-07' as string | null,
  history_transport_class: 'native' as SessionTransportClass,
  history_binding_id: bootstrapBindingId,
  history_binding_generation: '4',
  history_state: 'current',
  binding_id: bootstrapBindingId,
  binding_generation: '4',
  binding_current_hash: bootstrapBindingHash,
  binding_current_kid: 'refresh-2026-07',
  binding_proof_class: 'persistent',
  binding_active: true,
  user_status: 'active',
  public_handle: 'spott_bootstrap',
  phone_verified_at: new Date('2026-07-15T00:00:00.000Z'),
  restriction_flags: ['trusted'],
  admin_roles: [] as string[],
};

function bootstrapHarness(overrides: Partial<typeof baseBootstrapRow> = {}) {
  const row = { ...baseBootstrapRow, ...overrides };
  const database = {
    query: vi.fn().mockResolvedValue({ rows: [row], rowCount: 1 }),
    transaction: vi.fn().mockRejectedValue(new Error('bootstrap must remain read-only')),
  };
  const service = new AuthService(
    database as never,
    {} as never,
    {} as never,
    {} as never,
  ) as unknown as Task7BootstrapContract;
  return { database, row, service };
}

describe('AuthService read-only session bootstrap', () => {
  it('signs a fresh access token while preserving the exact current sid, refresh credential, and generation', async () => {
    const { database, service } = bootstrapHarness();
    const refreshToken = `s2.${currentSessionId}.3.${bootstrapSecret}`;

    const first = await service.bootstrap(
      refreshToken,
      bootstrapDeviceId,
      bootstrapProof,
      undefined,
      'headerless_native',
    );
    const second = await service.bootstrap(
      refreshToken,
      bootstrapDeviceId,
      bootstrapProof,
      undefined,
      'headerless_native',
    );

    expect(first).toMatchObject({
      refreshToken,
      refreshGeneration: 3,
      sessionId: currentSessionId,
      user: {
        id: currentUserId,
        publicHandle: 'spott_bootstrap',
        phoneVerified: true,
        restrictions: ['trusted'],
      },
    });
    expect(second.accessToken).not.toBe(first.accessToken);
    const verified = await jwtVerify(
      first.accessToken,
      new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET as string),
      { issuer: 'spott-api', audience: 'spott-clients' },
    );
    expect(verified.payload).toMatchObject({
      sub: currentUserId,
      sid: currentSessionId,
      roles: ['user'],
    });

    expect(database.query).toHaveBeenCalledTimes(2);
    expect(database.transaction).not.toHaveBeenCalled();
    for (const [sql, values] of database.query.mock.calls) {
      expect(String(sql)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/iu);
      expect(String(sql)).not.toMatch(/FOR\s+UPDATE/iu);
      expect(String(sql)).toMatch(/JOIN\s+identity\.devices/iu);
      expect(String(sql)).toContain("device.risk_state <> 'blocked'");
      expect(String(sql)).toContain("user_record.status = 'active'");
      expect(String(sql)).toContain("NOT ('loginBlocked' = ANY(user_record.restriction_flags))");
      expect(values).not.toContain(bootstrapSecret);
      expect(values).not.toContain(bootstrapBindingSecret);
    }
  });

  it('accepts a canonical generation-zero legacy credential without rotating or rewriting it', async () => {
    const { service } = bootstrapHarness({
      refresh_generation: '0',
      current_derivation_kid: null,
      history_generation: '0',
      history_derivation_kid: null,
    });
    const refreshToken = `${currentSessionId}.${bootstrapSecret}`;

    await expect(
      service.bootstrap(
        refreshToken,
        bootstrapDeviceId,
        bootstrapProof,
        undefined,
        'headerless_native',
      ),
    ).resolves.toMatchObject({
      refreshToken,
      refreshGeneration: 0,
      sessionId: currentSessionId,
    });
  });

  it.each([
    ['refresh credential', 'malformed', bootstrapDeviceId, bootstrapProof],
    ['device id', `s2.${currentSessionId}.3.${bootstrapSecret}`, 'not-a-uuid', bootstrapProof],
    [
      'binding id',
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      {
        ...bootstrapProof,
        bindingId: 'not-a-uuid',
      },
    ],
    [
      'binding generation',
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      {
        ...bootstrapProof,
        generation: -1,
      },
    ],
    [
      'binding secret',
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      {
        ...bootstrapProof,
        proof: 'too-short',
      },
    ],
    [
      'proof class',
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      {
        ...bootstrapProof,
        proofClass: 'migration_temporary',
      },
    ],
  ])(
    'rejects malformed %s before the database boundary',
    async (_label, refreshToken, deviceId, proof) => {
      const database = {
        query: vi.fn().mockRejectedValue(new Error('database must not be touched')),
        transaction: vi.fn().mockRejectedValue(new Error('database must not be touched')),
      };
      const service = new AuthService(
        database as never,
        {} as never,
        {} as never,
        {} as never,
      ) as unknown as Task7BootstrapContract;

      await expect(
        service.bootstrap(refreshToken, deviceId, proof, undefined, 'headerless_native'),
      ).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
      expect(database.query).not.toHaveBeenCalled();
      expect(database.transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['different session', { id: secondUserId }],
    ['different device', { device_id: '019b0000-0000-7000-8000-000000000099' }],
    ['device owned by another user', { device_user_id: secondUserId }],
    ['blocked device', { device_risk_state: 'blocked' }],
    ['non-active user', { user_status: 'deletion_pending' }],
    ['login-blocked user', { restriction_flags: ['trusted', 'loginBlocked'] }],
    ['inactive session', { session_active: false }],
    ['different generation', { refresh_generation: '4' }],
    ['different current refresh hash', { refresh_hash: Buffer.alloc(32, 1) }],
    ['different family history', { history_family_id: '019b0000-0000-7000-8000-000000000099' }],
    ['different history generation', { history_generation: '2' }],
    ['consumed history', { history_state: 'consumed' }],
    ['different history token', { history_token_hash: Buffer.alloc(32, 2) }],
    ['different derivation history', { history_derivation_kid: 'old-kid' }],
    [
      'different transport history',
      { history_transport_class: 'web_bff' as SessionTransportClass },
    ],
    ['different binding history', { history_binding_id: '019b0000-0000-7000-8000-000000000099' }],
    ['different binding generation history', { history_binding_generation: '3' }],
    ['different current binding', { current_binding_id: '019b0000-0000-7000-8000-000000000099' }],
    ['different persistent binding', { binding_id: '019b0000-0000-7000-8000-000000000099' }],
    ['different binding generation', { binding_generation: '3' }],
    ['wrong proof class', { binding_proof_class: 'migration_temporary' }],
    ['inactive binding', { binding_active: false }],
    ['wrong binding secret', { binding_current_hash: Buffer.alloc(32, 3) }],
  ])(
    'rejects %s instead of bootstrapping stale or non-canonical state',
    async (_label, overrides) => {
      const { service } = bootstrapHarness(overrides);

      await expect(
        service.bootstrap(
          `s2.${currentSessionId}.3.${bootstrapSecret}`,
          bootstrapDeviceId,
          bootstrapProof,
          undefined,
          'headerless_native',
        ),
      ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    },
  );

  it('uses only verified BFF metadata to authorize a current Web transport', async () => {
    const { service } = bootstrapHarness({
      transport_class: 'web_bff',
      history_transport_class: 'web_bff',
    });
    const refreshToken = `s2.${currentSessionId}.3.${bootstrapSecret}`;

    await expect(
      service.bootstrap(
        refreshToken,
        bootstrapDeviceId,
        bootstrapProof,
        undefined,
        'headerless_native',
        bootstrapEnvelopeClaims,
      ),
    ).rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_REQUIRED', status: 403 });

    await expect(
      service.bootstrap(
        refreshToken,
        bootstrapDeviceId,
        bootstrapProof,
        bootstrapAuthority,
        'verified_bff',
        bootstrapEnvelopeClaims,
      ),
    ).resolves.toMatchObject({ sessionId: currentSessionId, refreshGeneration: 3 });
  });

  it.each([
    ['missing claims', undefined],
    ['different session', { ...bootstrapEnvelopeClaims, sessionId: secondUserId }],
    ['different family', {
      ...bootstrapEnvelopeClaims,
      familyId: '019b0000-0000-7000-8000-000000000099',
    }],
    ['different generation', { ...bootstrapEnvelopeClaims, generation: 2 }],
    ['different binding', {
      ...bootstrapEnvelopeClaims,
      persistentBindingId: '019b0000-0000-7000-8000-000000000099',
    }],
    ['different binding generation', {
      ...bootstrapEnvelopeClaims,
      persistentBindingGeneration: 3,
    }],
  ] as const)('fails closed read-only for web_bff bootstrap with %s', async (_label, claims) => {
    const { database, service } = bootstrapHarness({
      transport_class: 'web_bff',
      history_transport_class: 'web_bff',
    });

    await expect(service.bootstrap(
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      bootstrapProof,
      bootstrapAuthority,
      'verified_bff',
      claims,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    expect(database.query).toHaveBeenCalledOnce();
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('rejects web envelope claims on a native bootstrap without changing native claimless compatibility', async () => {
    const disguised = bootstrapHarness();
    await expect(disguised.service.bootstrap(
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      bootstrapProof,
      undefined,
      'headerless_native',
      bootstrapEnvelopeClaims,
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    expect(disguised.database.query).toHaveBeenCalledOnce();
    expect(disguised.database.transaction).not.toHaveBeenCalled();

    const compatible = bootstrapHarness();
    await expect(compatible.service.bootstrap(
      `s2.${currentSessionId}.3.${bootstrapSecret}`,
      bootstrapDeviceId,
      bootstrapProof,
      undefined,
      'headerless_native',
    )).resolves.toMatchObject({ sessionId: currentSessionId });
  });

  it('marks an initially issued full AuthSession as refresh generation zero', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM identity.devices') && sql.includes('FOR UPDATE')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO identity.devices')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO identity.sessions')) {
          return { rows: [{ id: currentSessionId }], rowCount: 1 };
        }
        if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected initial session query: ${sql}`);
      }),
    };
    const service = new AuthService({} as never, {} as never, {} as never, {} as never);
    const createSession = (
      service as unknown as {
        createSession(
          transactionClient: typeof client,
          user: {
            id: string;
            public_handle: string;
            status: string;
            phone_verified_at: Date | null;
            restriction_flags: string[];
          },
          deviceId: string,
          platform: 'ios',
          transport: 'native',
        ): Promise<SessionResponse & { refreshGeneration: number }>;
      }
    ).createSession.bind(service);

    await expect(
      createSession(
        client,
        {
          id: currentUserId,
          public_handle: 'spott_initial',
          status: 'active',
          phone_verified_at: null,
          restriction_flags: [],
        },
        bootstrapDeviceId,
        'ios',
        'native',
      ),
    ).resolves.toMatchObject({
      sessionId: currentSessionId,
      refreshGeneration: 0,
    });
  });
});

describe('AuthService first persistent Web device-binding upgrade', () => {
  const deviceId = '019b0000-0000-7000-8000-000000000061';
  const familyId = '019b0000-0000-7000-8000-000000000062';
  const bindingId = '019b0000-0000-7000-8000-000000000063';
  const attemptId = '019b0000-0000-7000-8000-000000000064';
  const refreshSecret = Buffer.alloc(32, 31).toString('base64url');
  const proof = Buffer.alloc(32, 47).toString('base64url');
  const refreshHash = createHmac('sha256', process.env.REFRESH_TOKEN_SECRET as string)
    .update(refreshSecret)
    .digest();
  const refreshExpiresAt = new Date('2026-08-17T03:04:05.000Z');
  const bindingIssuedAt = new Date('2026-07-18T03:04:05.000Z');
  const input = {
    refreshToken: `${currentSessionId}.${refreshSecret}`,
    deviceId,
    attemptId,
    newBinding: {
      bindingId,
      generation: 0 as const,
      proof,
      proofClass: 'persistent' as const,
    },
  };
  const authority: VerifiedBFFAuthority = {
    version: 'v1',
    kid: 'bff-2026-07',
    timestamp: 1_784_346_245_000,
    nonceHash: Buffer.alloc(32, 12),
  };

  type UpgradeContract = {
    upgradeDeviceBinding(
      upgradeInput: typeof input,
      verifiedAuthority: VerifiedBFFAuthority | undefined,
      channel: SessionRequestChannel,
    ): Promise<Record<string, unknown>>;
  };

  function harness() {
    const session = {
      id: currentSessionId,
      user_id: currentUserId,
      device_id: deviceId,
      device_user_id: currentUserId,
      device_risk_state: 'normal',
      refresh_hash: refreshHash,
      refresh_family_id: familyId,
      refresh_generation: '0',
      current_derivation_kid: null,
      current_binding_id: null as string | null,
      current_binding_generation: null as string | null,
      transport_class: 'web_bff',
      expires_at: refreshExpiresAt,
      session_active: true,
      user_status: 'active',
      public_handle: 'spott_binding_upgrade',
      phone_verified_at: null,
      restriction_flags: [],
    };
    const history = {
      session_id: currentSessionId,
      family_id: familyId,
      generation: '0',
      token_hash: refreshHash,
      derivation_kid: null,
      transport_class: 'web_bff',
      binding_id: null as string | null,
      binding_generation: null as string | null,
      state: 'current',
    };
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        void values;
        if (sql.includes('FROM identity.sessions AS session') && sql.includes('FOR UPDATE')) {
          return { rows: [session], rowCount: 1 };
        }
        if (sql.includes('FROM identity.session_refresh_history') && sql.includes('FOR UPDATE')) {
          return { rows: [history], rowCount: 1 };
        }
        if (sql.includes('identity.claim_proof_hash_class')) {
          return { rows: [{ accepted: true }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO identity.device_bindings')) {
          return {
            rows: [{ issued_at: bindingIssuedAt, absolute_expires_at: refreshExpiresAt }],
            rowCount: 1,
          };
        }
        if (sql.includes('UPDATE identity.sessions') && sql.includes('current_binding_id')) {
          session.current_binding_id = bindingId;
          session.current_binding_generation = '0';
          return { rows: [{ id: currentSessionId }], rowCount: 1 };
        }
        if (sql.includes('UPDATE identity.session_refresh_history')) {
          history.binding_id = bindingId;
          history.binding_generation = '0';
          return { rows: [{ session_id: currentSessionId }], rowCount: 1 };
        }
        throw new Error(`Unexpected binding upgrade query: ${sql}`);
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32, 71)),
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const service = new AuthService(
      database as never,
      {} as never,
      idempotency as never,
      {} as never,
    ) as unknown as UpgradeContract;
    return { service, database, client, idempotency };
  }

  it('fails closed before PostgreSQL when verified BFF authority is absent', async () => {
    const { service, database } = harness();

    await expect(
      service.upgradeDeviceBinding(input, undefined, 'consumer_web'),
    ).rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_REQUIRED', status: 403 });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it.each([
    ['canonically equivalent Unicode', `${'A'.repeat(31)}e\u0301`],
    ['non-canonical base64url', `${proof.slice(0, -1)}9`],
  ])('rejects %s persistent proof before PostgreSQL', async (_label, invalidProof) => {
    const { service, database } = harness();

    await expect(service.upgradeDeviceBinding({
      ...input,
      newBinding: { ...input.newBinding, proof: invalidProof },
    }, authority, 'verified_bff')).rejects.toMatchObject({ code: 'TOKEN_INVALID', status: 401 });
    expect(database.transaction).not.toHaveBeenCalled();
  });

  it('atomically binds the current session/history and returns no proof or refresh credential', async () => {
    const { service, client, idempotency } = harness();

    const material = await service.upgradeDeviceBinding(input, authority, 'verified_bff');

    expect(material).toEqual({
      sessionId: currentSessionId,
      refreshFamilyId: familyId,
      refreshGeneration: 0,
      transportClass: 'web_bff',
      bindingId,
      bindingGeneration: 0,
      bindingIssuedAt: bindingIssuedAt.toISOString(),
      bindingAbsoluteExpiresAt: refreshExpiresAt.toISOString(),
      refreshTokenExpiresAt: refreshExpiresAt.toISOString(),
      user: {
        id: currentUserId,
        publicHandle: 'spott_binding_upgrade',
        phoneVerified: false,
        restrictions: [],
      },
    });
    expect(JSON.stringify(material)).not.toContain(proof);
    expect(JSON.stringify(material)).not.toContain(refreshSecret);
    expect(idempotency.requestHash).toHaveBeenCalledWith(
      'POST',
      '/v1/auth/device-binding/upgrade',
      input,
    );
    expect(idempotency.claim).toHaveBeenCalledWith(
      client,
      currentUserId,
      attemptId,
      Buffer.alloc(32, 71),
    );
    expect(idempotency.complete).toHaveBeenCalledWith(
      client,
      currentUserId,
      attemptId,
      { status: 200, body: material },
      { type: 'device_binding', id: bindingId },
    );

    const proofClassClaim = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('identity.claim_proof_hash_class'));
    expect(proofClassClaim?.[1]).toEqual([
      createHash('sha256').update(proof).digest(),
    ]);

    const bindingInsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO identity.device_bindings'));
    expect(bindingInsert).toBeDefined();
    const storedValues = bindingInsert?.[1] ?? [];
    expect(storedValues).toContain('refresh-2026-07');
    expect(storedValues).not.toContain(proof);
    expect(storedValues).not.toContain(createHash('sha256').update(proof).digest());
    expect(storedValues.some((value) => Buffer.isBuffer(value) && value.byteLength === 32)).toBe(true);
  });
});

describe('AuthService device ownership isolation', () => {
  const deviceId = '019b0000-0000-7000-8000-000000000060';
  const user = {
    id: currentUserId,
    public_handle: 'spott_device_owner',
    status: 'active',
    phone_verified_at: null,
    restriction_flags: [],
  };

  function createSessionWith(client: { query: ReturnType<typeof vi.fn> }) {
    const service = new AuthService({} as never, {} as never, {} as never, {} as never);
    return (
      service as unknown as {
        createSession(
          transactionClient: typeof client,
          sessionUser: typeof user,
          sessionDeviceId: string,
          platform: 'ios' | 'web',
          transport: 'native' | 'web_bff',
        ): Promise<SessionResponse>;
      }
    ).createSession.bind(service);
  }

  it('locks and rejects an existing device owned by another user before any mutation', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM identity.devices') && sql.includes('FOR UPDATE')) {
          return { rows: [{ user_id: secondUserId }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO identity.devices')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO identity.sessions')) {
          return { rows: [{ id: currentSessionId }], rowCount: 1 };
        }
        if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected device ownership query: ${sql}`);
      }),
    };

    await expect(
      createSessionWith(client)(client, user, deviceId, 'ios', 'native'),
    ).rejects.toMatchObject({ code: 'DEVICE_OWNERSHIP_CONFLICT', status: 409 });
    expect(queries[0]).toMatch(/SELECT\s+pg_advisory_xact_lock/iu);
    expect(queries[1]).toMatch(/FROM\s+identity\.devices[\s\S]*FOR\s+UPDATE/iu);
    expect(queries.some((sql) => /INSERT\s+INTO\s+identity\.(?:devices|sessions)/iu.test(sql))).toBe(
      false,
    );
    expect(queries.some((sql) => /UPDATE\s+identity\.devices/iu.test(sql))).toBe(false);
  });

  it('updates only non-owner device fields for the same owner and creates a new session', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM identity.devices') && sql.includes('FOR UPDATE')) {
          return { rows: [{ user_id: currentUserId }], rowCount: 1 };
        }
        if (sql.includes('UPDATE identity.devices')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO identity.devices')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO identity.sessions')) {
          return { rows: [{ id: currentSessionId }], rowCount: 1 };
        }
        if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected same-owner session query: ${sql}`);
      }),
    };

    await expect(
      createSessionWith(client)(client, user, deviceId, 'web', 'web_bff'),
    ).resolves.toMatchObject({ sessionId: currentSessionId });
    expect(queries.slice(0, 3)).toEqual([
      expect.stringMatching(/SELECT\s+pg_advisory_xact_lock/iu),
      expect.stringMatching(/FROM\s+identity\.devices[\s\S]*FOR\s+UPDATE/iu),
      expect.stringMatching(/UPDATE\s+identity\.devices/iu),
    ]);
    expect(queries).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/ON\s+CONFLICT\s*\(id\)[\s\S]*user_id\s*=\s*EXCLUDED\.user_id/iu),
      ]),
    );
  });

  it('inserts an unclaimed device only after locking and checking ownership', async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM identity.devices') && sql.includes('FOR UPDATE')) {
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO identity.devices')) return { rows: [], rowCount: 1 };
        if (sql.includes('INSERT INTO identity.sessions')) {
          return { rows: [{ id: currentSessionId }], rowCount: 1 };
        }
        if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
        throw new Error(`Unexpected new-device session query: ${sql}`);
      }),
    };

    await expect(
      createSessionWith(client)(client, user, deviceId, 'ios', 'native'),
    ).resolves.toMatchObject({ sessionId: currentSessionId });
    expect(queries.slice(0, 3)).toEqual([
      expect.stringMatching(/SELECT\s+pg_advisory_xact_lock/iu),
      expect.stringMatching(/FROM\s+identity\.devices[\s\S]*FOR\s+UPDATE/iu),
      expect.stringMatching(/INSERT\s+INTO\s+identity\.devices/iu),
    ]);
    expect(queries[2]).not.toMatch(/ON\s+CONFLICT/iu);
  });
});

interface Task5RefreshContract {
  refresh(
    refreshToken: string,
    deviceId: string,
    platform: 'web' | 'ops',
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
    attemptKey?: string,
    deviceBindingProof?: DeviceBindingProof,
    refreshEnvelopeClaims?: WebRefreshEnvelopeDBClaims,
  ): Promise<SessionResponse>;
}

interface Task7BootstrapContract {
  bootstrap(
    refreshToken: string,
    deviceId: string,
    deviceBindingProof: unknown,
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
    refreshEnvelopeClaims?: WebRefreshEnvelopeDBClaims,
  ): Promise<SessionResponse & { refreshGeneration: number }>;
}

interface MergeCommitContract {
  mergeCommit(
    userId: string,
    currentSessionId: string,
    key: string,
    input: {
      jobId: string;
      mergeToken: string;
      deviceId: string;
      platform?: 'ios' | 'web';
    },
    authority: VerifiedBFFAuthority | undefined,
    requestChannel: SessionRequestChannel,
  ): Promise<unknown>;
}

function mergeTransportHarness(transportClass: SessionTransportClass) {
  const jobId = '019b0000-0000-7000-9000-000000000001';
  const deviceId = '019b0000-0000-7000-8000-000000000020';
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SET TRANSACTION')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM identity.sessions')) {
        return { rows: [{ transport_class: transportClass }], rowCount: 1 };
      }
      if (sql.includes('FROM identity.account_merge_jobs')) {
        return {
          rows: [
            {
              id: jobId,
              source_user_id: secondUserId,
              target_user_id: currentUserId,
              state: 'previewed',
              preview_json: { conflicts: [] },
              verification_hash: Buffer.alloc(32, 1),
              expires_at: new Date(Date.now() + 60_000),
            },
          ],
          rowCount: 1,
        };
      }
      if (
        sql.includes('FROM identity.users') ||
        sql.includes('UPDATE identity.account_merge_jobs')
      ) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected merge transport query: ${sql}`);
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };
  const idempotency = {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32, 2)),
    claim: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new AuthService(
    database as never,
    {} as never,
    idempotency as never,
    {} as never,
  );
  const privateService = service as unknown as {
    mergeProofHash: () => Buffer;
    mergeImpact: () => Promise<Record<string, unknown>>;
    mergeConflicts: () => readonly unknown[];
    performAccountMerge: () => Promise<void>;
    getUser: () => Promise<Record<string, unknown>>;
    createSession: ReturnType<typeof vi.fn>;
  };
  privateService.mergeProofHash = () => Buffer.alloc(32, 1);
  privateService.mergeImpact = vi.fn().mockResolvedValue({});
  privateService.mergeConflicts = vi.fn().mockReturnValue([]);
  privateService.performAccountMerge = vi.fn().mockResolvedValue(undefined);
  privateService.getUser = vi.fn().mockResolvedValue({
    id: currentUserId,
    public_handle: 'spott_target',
    status: 'active',
    phone_verified_at: null,
    restriction_flags: [],
  });
  privateService.createSession = vi.fn().mockResolvedValue({ sessionId: 'successor-session' });
  return {
    service: service as unknown as MergeCommitContract,
    privateService,
    idempotency,
    client,
    input: {
      jobId,
      mergeToken: 'valid-merge-proof-with-more-than-thirty-two-characters',
      deviceId,
      platform: 'ios' as const,
    },
  };
}

describe('AuthService immutable merge successor transport', () => {
  const authority: VerifiedBFFAuthority = {
    version: 'v1',
    kid: 'bff-2026-07',
    timestamp: 1_784_246_400_000,
    nonceHash: Buffer.alloc(32, 7),
  };
  const key = '019b0000-0000-7000-8000-000000000010';

  it('rejects a stored web_bff merge without verifier-attached authority', async () => {
    const { service, privateService, input } = mergeTransportHarness('web_bff');

    await expect(
      service.mergeCommit(currentUserId, currentSessionId, key, input, undefined, 'consumer_web'),
    ).rejects.toMatchObject({ code: 'WEB_BFF_AUTHORITY_REQUIRED', status: 403 });
    expect(privateService.createSession).not.toHaveBeenCalled();
  });

  it('inherits web_bff for an authorized merge and ignores caller platform', async () => {
    const { service, privateService, client, input } = mergeTransportHarness('web_bff');

    await expect(
      service.mergeCommit(currentUserId, currentSessionId, key, input, authority, 'verified_bff'),
    ).resolves.toEqual({ sessionId: 'successor-session' });
    expect(privateService.createSession).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: currentUserId }),
      input.deviceId,
      'web',
      'web_bff',
    );
  });

  it('keeps a native merge successor native despite a caller web platform', async () => {
    const { service, privateService, client, input } = mergeTransportHarness('native');

    await service.mergeCommit(
      currentUserId,
      currentSessionId,
      key,
      { ...input, platform: 'web' },
      undefined,
      'headerless_native',
    );

    expect(privateService.createSession).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ id: currentUserId }),
      input.deviceId,
      'ios',
      'native',
    );
  });

  it('rejects a browser-context native merge before idempotency or account mutation', async () => {
    const { service, privateService, idempotency, input } = mergeTransportHarness('native');

    await expect(
      service.mergeCommit(currentUserId, currentSessionId, key, input, undefined, 'consumer_web'),
    ).rejects.toMatchObject({ code: 'SESSION_TRANSPORT_MISMATCH', status: 403 });
    expect(idempotency.claim).not.toHaveBeenCalled();
    expect(idempotency.complete).not.toHaveBeenCalled();
    expect(privateService.performAccountMerge).not.toHaveBeenCalled();
    expect(privateService.createSession).not.toHaveBeenCalled();
  });
});

describe('AuthService Ops email verification', () => {
  it('requires the verified email identity to belong to an MFA-enrolled operator', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM identity.email_challenges')) {
          return {
            rows: [
              {
                id: '019b0000-0000-7000-8000-000000000030',
                email_hash: Buffer.alloc(32, 4),
                email_cipher: Buffer.alloc(32, 5),
                code_hash: Buffer.alloc(32, 6),
                attempts: 0,
                expires_at: new Date(Date.now() + 60_000),
                verified_at: null,
                suspended_until: null,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM identity.auth_identities')) {
          return {
            rows: [
              {
                id: currentUserId,
                public_handle: 'spott_ops',
                status: 'active',
                phone_verified_at: new Date(),
                restriction_flags: [],
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM admin.admin_users')) {
          return { rows: [{ id: '019b0000-0000-7000-8200-000000000001' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const service = new AuthService(database as never, {} as never, {} as never, {} as never);
    (service as unknown as { matchesCode: () => boolean }).matchesCode = () => true;
    (service as unknown as { createSession: () => Promise<unknown> }).createSession = vi
      .fn()
      .mockResolvedValue({
        sessionId: '019b0000-0000-7000-8000-000000000031',
        accessToken: 'access',
        accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshToken: 'refresh',
        user: { id: currentUserId },
      });

    await expect(
      service.verifyEmailChallenge(
        {
          challengeId: '019b0000-0000-7000-8000-000000000030',
          code: '123456',
          deviceId: '019b0000-0000-7000-8000-000000000032',
        },
        'ops',
      ),
    ).resolves.toMatchObject({ accessToken: 'access' });
    expect(client.query.mock.calls.some(([sql]) => sql.includes('admin.admin_users'))).toBe(true);
    expect(
      (service as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession,
    ).toHaveBeenCalledWith(
      client,
      expect.anything(),
      '019b0000-0000-7000-8000-000000000032',
      'ops',
      'ops',
    );
  });
});

describe('AuthService phone verification idempotency', () => {
  it('replays success after the first committed response is lost without duplicating side effects', async () => {
    const { service, client, verifiedAt } = phoneVerificationHarness();

    const first = await service.verifyPhoneChallenge(currentUserId, phoneChallengeId, '123456');
    const replay = await service.verifyPhoneChallenge(currentUserId, phoneChallengeId, '123456');

    expect(first).toEqual({
      requestId: `phone_${phoneChallengeId}`,
      verifiedAt: verifiedAt.toISOString(),
      reward: { paidBalance: 0, freeBalance: 600, totalBalance: 600, version: 2 },
    });
    expect(replay).toEqual(first);
    expect(
      client.query.mock.calls.filter(([sql]) =>
        sql.includes('INSERT INTO commerce.point_transactions'),
      ),
    ).toHaveLength(1);
    expect(
      client.query.mock.calls.filter(([sql]) => sql.includes('sync.record_change')),
    ).toHaveLength(1);
    expect(
      client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO sync.outbox_events')),
    ).toHaveLength(1);
  });

  it('treats an existing active binding owned by the current user as a successful duplicate submission', async () => {
    const existingBinding = {
      id: '019b0000-0000-7000-8100-000000000002',
      user_id: currentUserId,
      verified_at: new Date('2026-07-15T01:02:03.000Z'),
    };
    const { service, client, verifiedAt } = phoneVerificationHarness(existingBinding);

    await expect(
      service.verifyPhoneChallenge(currentUserId, phoneChallengeId, '123456'),
    ).resolves.toEqual({
      requestId: `phone_${phoneChallengeId}`,
      verifiedAt: verifiedAt.toISOString(),
      reward: { paidBalance: 0, freeBalance: 600, totalBalance: 600, version: 2 },
    });
    expect(
      client.query.mock.calls.some(([sql]) =>
        sql.includes('INSERT INTO commerce.point_transactions'),
      ),
    ).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => sql.includes('sync.record_change'))).toBe(false);
  });

  it('still rejects a phone number actively bound to another user', async () => {
    const existingBinding = {
      id: '019b0000-0000-7000-8100-000000000003',
      user_id: secondUserId,
      verified_at: new Date('2026-07-15T01:02:03.000Z'),
    };
    const { service } = phoneVerificationHarness(existingBinding);

    await expect(
      service.verifyPhoneChallenge(currentUserId, phoneChallengeId, '123456'),
    ).rejects.toMatchObject({ code: 'PHONE_ALREADY_BOUND', status: 409 });
  });
});

interface RewardBindingRow {
  id: string;
  user_id: string;
  phone_hash: Buffer;
  verified_at: Date;
  unbound_at: Date | null;
}

/**
 * Models the reward-relevant database invariants that actually exist in the schema:
 * - identity.phone_bindings: UNIQUE(phone_hash) WHERE unbound_at IS NULL
 * - commerce.point_transactions: UNIQUE(user_id, business_key)
 * so that any idempotency key the service picks is judged against the real constraints.
 */
function phoneRewardLedgerHarness() {
  const bindings: RewardBindingRow[] = [];
  const pointTransactions = new Map<string, string>();
  const rewardGrants = new Map<string, { user_id: string; transaction_id: string | null }>();
  const freeBalances = new Map<string, number>();
  const challenges = new Map<
    string,
    { id: string; phone_hash: Buffer; phone_cipher: Buffer; verified_at: Date | null }
  >();
  const verifiedAt = new Date('2026-07-16T01:02:03.000Z');
  let sequence = 0;
  const nextId = (prefix: string): string => `${prefix}-${++sequence}`;

  const client = {
    query: vi.fn(async (sql: string, parameters: unknown[] = []) => {
      if (sql.includes('FROM identity.phone_challenges')) {
        const challenge = challenges.get(parameters[0] as string);
        if (!challenge) throw new Error(`missing challenge ${String(parameters[0])}`);
        return {
          rows: [
            {
              ...challenge,
              otp_hash: Buffer.alloc(32, 9),
              attempts: 0,
              expires_at: new Date('2099-07-16T01:12:03.000Z'),
              suspended_until: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO identity.phone_bindings')) {
        const [userId, phoneHash, phoneCipher] = parameters as [string, Buffer, Buffer];
        const active = bindings.find(
          (row) => row.phone_hash.equals(phoneHash) && row.unbound_at === null,
        );
        if (active) return { rows: [], rowCount: 0 };
        const row: RewardBindingRow = {
          id: nextId('binding'),
          user_id: userId,
          phone_hash: phoneHash,
          verified_at: verifiedAt,
          unbound_at: null,
        };
        void phoneCipher;
        bindings.push(row);
        return {
          rows: [{ id: row.id, user_id: row.user_id, verified_at: row.verified_at }],
          rowCount: 1,
        };
      }
      if (sql.includes('FROM identity.phone_bindings')) {
        const phoneHash = parameters[0] as Buffer;
        const active = bindings.find(
          (row) => row.phone_hash.equals(phoneHash) && row.unbound_at === null,
        );
        return active
          ? {
              rows: [{ id: active.id, user_id: active.user_id, verified_at: active.verified_at }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('UPDATE identity.phone_challenges') && sql.includes('SET verified_at')) {
        const challenge = challenges.get(parameters[0] as string);
        if (!challenge) throw new Error('missing challenge');
        challenge.verified_at ??= verifiedAt;
        return { rows: [{ verified_at: challenge.verified_at }], rowCount: 1 };
      }
      if (sql.includes('UPDATE identity.users SET phone_verified_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO commerce.phone_verification_reward_grants')) {
        const [phoneHash, userId] = parameters as [Buffer, string];
        const key = phoneHash.toString('hex');
        if (rewardGrants.has(key)) return { rows: [], rowCount: 0 };
        rewardGrants.set(key, { user_id: userId, transaction_id: null });
        return { rows: [{ phone_hash: phoneHash }], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM commerce.phone_verification_reward_grants')) {
        const key = (parameters[0] as Buffer).toString('hex');
        const grant = rewardGrants.get(key);
        if (grant && grant.transaction_id === null) rewardGrants.delete(key);
        return { rows: [], rowCount: grant ? 1 : 0 };
      }
      if (sql.includes('UPDATE commerce.phone_verification_reward_grants')) {
        const [phoneHash, transactionId] = parameters as [Buffer, string];
        const grant = rewardGrants.get(phoneHash.toString('hex'));
        if (grant) grant.transaction_id = transactionId;
        return { rows: [], rowCount: grant ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO commerce.point_transactions')) {
        const userId = parameters[0] as string;
        const businessKey =
          (parameters[1] as string | undefined) ??
          /'phone_verified_reward',\s*'([^']+)'/u.exec(sql)?.[1] ??
          'unparsed_business_key';
        const uniqueKey = `${userId}|${businessKey}`;
        if (pointTransactions.has(uniqueKey)) return { rows: [], rowCount: 0 };
        const id = nextId('transaction');
        pointTransactions.set(uniqueKey, id);
        return { rows: [{ id }], rowCount: 1 };
      }
      if (sql.includes('FROM admin.config_revisions')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM commerce.point_rule_catalog')) {
        const configured =
          parameters[0] === 'points.expiry.free_days' ? { configured_value: '180' } : { configured_value: '500' };
        return { rows: [configured], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO commerce.point_entries')) return { rows: [], rowCount: 2 };
      if (sql.includes('UPDATE commerce.wallets SET free_balance')) {
        const [userId, amount] = parameters as [string, string];
        freeBalances.set(userId, (freeBalances.get(userId) ?? 0) + Number(amount));
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('FROM commerce.wallets')) {
        const userId = parameters[0] as string;
        return {
          rows: [
            {
              paid_balance: '0',
              free_balance: String(freeBalances.get(userId) ?? 0),
              version: '2',
            },
          ],
          rowCount: 1,
        };
      }
      if (sql.includes('sync.record_change') || sql.includes('INSERT INTO sync.outbox_events')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected reward ledger query: ${sql}`);
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };
  const service = new AuthService(database as never, {} as never, {} as never, {} as never);
  (service as unknown as { matchesCode: () => boolean }).matchesCode = () => true;

  return {
    service,
    freeBalance: (userId: string): number => freeBalances.get(userId) ?? 0,
    unbind: (phoneByte: number): void => {
      for (const row of bindings) {
        if (row.phone_hash[0] === phoneByte) row.unbound_at = new Date();
      }
    },
    verify: async (userId: string, phoneByte: number): Promise<unknown> => {
      const challengeId = `019b0000-0000-7000-8000-0000000000${(40 + phoneByte).toString(16).padStart(2, '0')}`;
      challenges.set(challengeId, {
        id: challengeId,
        phone_hash: Buffer.alloc(32, phoneByte),
        phone_cipher: Buffer.alloc(48, phoneByte),
        verified_at: null,
      });
      return service.verifyPhoneChallenge(userId, challengeId, '123456');
    },
  };
}

describe('AuthService phone verification reward farming', () => {
  it('pays the 500 point welcome reward at most once per account, however many numbers are bound', async () => {
    const harness = phoneRewardLedgerHarness();

    await harness.verify(currentUserId, 0x11);
    expect(harness.freeBalance(currentUserId)).toBe(500);

    await harness.verify(currentUserId, 0x22);
    await harness.verify(currentUserId, 0x33);

    expect(harness.freeBalance(currentUserId)).toBe(500);
  });

  it('pays the 500 point welcome reward at most once per phone number, across accounts', async () => {
    const harness = phoneRewardLedgerHarness();

    await harness.verify(currentUserId, 0x44);
    expect(harness.freeBalance(currentUserId)).toBe(500);

    harness.unbind(0x44);
    await harness.verify(secondUserId, 0x44);

    expect(harness.freeBalance(secondUserId)).toBe(0);
  });

  it('does not re-pay when the same account unbinds and re-binds the same number', async () => {
    const harness = phoneRewardLedgerHarness();

    await harness.verify(currentUserId, 0x55);
    harness.unbind(0x55);
    await harness.verify(currentUserId, 0x55);

    expect(harness.freeBalance(currentUserId)).toBe(500);
  });
});
