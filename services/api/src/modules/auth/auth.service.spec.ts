import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  appleAudienceForPlatform,
  appleNonceDigest,
  AuthService,
} from './auth.service.js';

const currentUserId = '019b0000-0000-7000-8000-000000000001';
const secondUserId = '019b0000-0000-7000-8000-000000000002';

describe('Apple identity audience isolation', () => {
  it('keeps iOS bundle and Web Service ID audiences mutually exclusive', () => {
    const config = {
      APPLE_BUNDLE_ID: 'com.yaokai.Spott',
      APPLE_SERVICE_ID: 'jp.spott.web',
    };
    expect(appleAudienceForPlatform('ios', config)).toBe('com.yaokai.Spott');
    expect(appleAudienceForPlatform('web', config)).toBe('jp.spott.web');
    expect(() => appleAudienceForPlatform('web', {
      APPLE_BUNDLE_ID: 'com.yaokai.Spott',
    })).toThrowError(expect.objectContaining({ code: 'AUTH_PROVIDER_DISABLED', status: 503 }));
  });

  it('requires the SHA-256 digest of the caller nonce for both platforms', () => {
    const nonce = 'nonce-with-at-least-thirty-two-random-characters';
    expect(appleNonceDigest(nonce)).toBe(createHash('sha256').update(nonce).digest('hex'));
  });
});

describe('AuthService account merge proof handshake', () => {
  it('creates a short-lived preview only after resolving a different verified identity', async () => {
    const expiresAt = new Date('2026-07-15T00:10:00Z');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('INSERT INTO identity.auth_credential_uses')) return { rows: [], rowCount: 1 };
        if (sql.includes('FROM identity.auth_identities')) {
          return { rows: [{ user_id: secondUserId }], rowCount: 1 };
        }
        if (sql.includes('AS registration_conflicts')) {
          return {
            rows: [{
              source_owned_events: '2',
              source_owned_groups: '1',
              source_paid_balance: '500',
              source_free_balance: '80',
              target_paid_balance: '0',
              target_free_balance: '100',
              phone_conflict: false,
              registration_conflicts: '0',
              membership_conflicts: '0',
            }],
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
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new AuthService(database as never, {} as never, {} as never);
    (service as unknown as {
      verifyMergeCredential: () => Promise<{ provider: 'google'; subject: string; credentialHash: Buffer }>;
    }).verifyMergeCredential = vi.fn().mockResolvedValue({
      provider: 'google',
      subject: 'google-subject',
      credentialHash: Buffer.alloc(32, 7),
    });

    const result = await service.mergePreview(currentUserId, {
      provider: 'google',
      idToken: 'verified-id-token',
    }) as { jobId: string; mergeToken: string; sourceUserId: string; targetUserId: string; canCommit: boolean };

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
        if (sql.includes('FROM identity.account_merge_jobs')) {
          return {
            rows: [{
              id: '019b0000-0000-7000-9000-000000000001',
              source_user_id: secondUserId,
              target_user_id: currentUserId,
              state: 'previewed',
              preview_json: { conflicts: [] },
              verification_hash: Buffer.alloc(32, 1),
              expires_at: new Date(Date.now() + 60_000),
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn(),
    };
    const service = new AuthService(database as never, {} as never, idempotency as never);

    await expect(service.mergeCommit(currentUserId, '019b0000-0000-7000-8000-000000000010', {
      jobId: '019b0000-0000-7000-9000-000000000001',
      mergeToken: 'invalid-proof-that-does-not-match-the-preview-token',
      deviceId: '019b0000-0000-7000-8000-000000000020',
    })).rejects.toMatchObject({ code: 'ACCOUNT_MERGE_PROOF_INVALID', status: 401 });
  });
});

describe('AuthService Ops email verification', () => {
  it('requires the verified email identity to belong to an MFA-enrolled operator', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM identity.email_challenges')) {
          return { rows: [{
            id: '019b0000-0000-7000-8000-000000000030',
            email_hash: Buffer.alloc(32, 4),
            email_cipher: Buffer.alloc(32, 5),
            code_hash: Buffer.alloc(32, 6),
            attempts: 0,
            expires_at: new Date(Date.now() + 60_000),
            verified_at: null,
            suspended_until: null,
          }], rowCount: 1 };
        }
        if (sql.includes('FROM identity.auth_identities')) {
          return { rows: [{
            id: currentUserId,
            public_handle: 'spott_ops',
            status: 'active',
            phone_verified_at: new Date(),
            restriction_flags: [],
          }], rowCount: 1 };
        }
        if (sql.includes('FROM admin.admin_users')) {
          return { rows: [{ id: '019b0000-0000-7000-8200-000000000001' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new AuthService(database as never, {} as never, {} as never);
    (service as unknown as { matchesCode: () => boolean }).matchesCode = () => true;
    (service as unknown as { createSession: () => Promise<unknown> }).createSession = vi.fn().mockResolvedValue({
      sessionId: '019b0000-0000-7000-8000-000000000031',
      accessToken: 'access',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: 'refresh',
      user: { id: currentUserId },
    });

    await expect(service.verifyEmailChallenge({
      challengeId: '019b0000-0000-7000-8000-000000000030',
      code: '123456',
      deviceId: '019b0000-0000-7000-8000-000000000032',
    }, 'ops')).resolves.toMatchObject({ accessToken: 'access' });
    expect(client.query.mock.calls.some(([sql]) => sql.includes('admin.admin_users'))).toBe(true);
    expect((service as unknown as { createSession: ReturnType<typeof vi.fn> }).createSession)
      .toHaveBeenCalledWith(client, expect.anything(), '019b0000-0000-7000-8000-000000000032', 'ops');
  });
});
