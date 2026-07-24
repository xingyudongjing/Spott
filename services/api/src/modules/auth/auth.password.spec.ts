import { createHash } from 'node:crypto';
import { DomainError } from '@spott/domain';
import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from './password-hash.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1:55432/spott_auth_password_unit_test',
  ACCESS_TOKEN_SECRET: 'auth-password-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: 'auth-password-refresh-token-secret-at-least-32-bytes',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'auth-password-lookup-pepper-at-least-16-bytes',
});

const userId = '019b0000-0000-7000-8000-000000000011';
const sessionId = '019b0000-0000-7000-8000-000000000012';
const deviceId = '019b0000-0000-7000-8000-000000000013';

const fieldCrypto = {
  lookupHash: (normalized: string) => createHash('sha256').update(normalized).digest(),
  encrypt: (plainText: string) => Buffer.from(plainText, 'utf8'),
};

interface RegisterHarnessOptions {
  existingCredential?: boolean;
  existingEmailIdentity?: boolean;
}

function registerHarness(options: RegisterHarnessOptions = {}) {
  const captured = {
    nicknames: [] as unknown[][],
    credentialInserts: [] as unknown[][],
    phoneVerifiedUpdates: 0,
  };
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('FROM identity.user_credentials')) {
        return options.existingCredential
          ? { rows: [{ user_id: userId }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM identity.auth_identities')) {
        return options.existingEmailIdentity
          ? {
              rows: [{
                id: userId,
                public_handle: 'spott_existing01',
                status: 'active',
                phone_verified_at: null,
                restriction_flags: [],
              }],
              rowCount: 1,
            }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO identity.users')) {
        return {
          rows: [{
            id: userId,
            public_handle: 'spott_a1b2c3d4e5f6',
            status: 'active',
            phone_verified_at: null,
            restriction_flags: [],
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('INSERT INTO identity.auth_identities')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO identity.profiles')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO commerce.wallets')) return { rows: [], rowCount: 1 };
      if (sql.includes('sync.record_change') || sql.includes('INSERT INTO sync.outbox_events')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE identity.profiles SET nickname')) {
        captured.nicknames.push(values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO identity.user_credentials')) {
        captured.credentialInserts.push(values);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE identity.users') && sql.includes('SET phone_verified_at')) {
        captured.phoneVerifiedUpdates += 1;
        return { rows: [{ phone_verified_at: new Date('2026-07-23T01:02:03.000Z') }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO identity.devices')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO identity.sessions')) {
        return { rows: [{ id: sessionId }], rowCount: 1 };
      }
      if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected password register query: ${sql}`);
    }),
  };
  const database = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };
  const service = new AuthService(database as never, fieldCrypto as never, {} as never, {} as never);
  return { service, client, captured };
}

function loginHarness(storedHash: string | undefined) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO identity.devices')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO identity.sessions')) {
        return { rows: [{ id: sessionId }], rowCount: 1 };
      }
      if (sql.includes('FROM admin.admin_users')) return { rows: [], rowCount: 0 };
      throw new Error(`Unexpected password login query: ${sql}`);
    }),
  };
  const database = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM identity.user_credentials')) {
        return storedHash === undefined
          ? { rows: [], rowCount: 0 }
          : {
              rows: [{
                id: userId,
                public_handle: 'spott_a1b2c3d4e5f6',
                status: 'active',
                phone_verified_at: new Date('2026-07-23T01:02:03.000Z'),
                restriction_flags: [],
                password_hash: storedHash,
              }],
              rowCount: 1,
            };
      }
      throw new Error(`Unexpected password login lookup: ${sql}`);
    }),
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
      work(client),
    ),
  };
  const service = new AuthService(database as never, fieldCrypto as never, {} as never, {} as never);
  return { service, database };
}

describe('scrypt password hashing', () => {
  it('round-trips a password through hash and verify', async () => {
    const stored = await hashPassword('spott-dev-1');
    expect(stored).toMatch(/^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$/);
    await expect(verifyPassword('spott-dev-1', stored)).resolves.toBe(true);
  });

  it('salts every hash independently', async () => {
    const first = await hashPassword('spott-dev-1');
    const second = await hashPassword('spott-dev-1');
    expect(first).not.toBe(second);
    await expect(verifyPassword('spott-dev-1', second)).resolves.toBe(true);
  });

  it('rejects a wrong password and malformed stored digests', async () => {
    const stored = await hashPassword('spott-dev-1');
    await expect(verifyPassword('spott-dev-2', stored)).resolves.toBe(false);
    await expect(verifyPassword('spott-dev-1', 'not-a-digest')).resolves.toBe(false);
    await expect(verifyPassword('anything', DUMMY_PASSWORD_HASH)).resolves.toBe(false);
  });
});

describe('password registration', () => {
  it('creates the user, defaults nickname to the email local-part, stores an scrypt digest, and marks phoneVerified', async () => {
    const { service, captured } = registerHarness();
    const session = await service.registerWithPassword(
      { email: 'devtest@spott.jp', password: 'spott-dev-1', deviceId },
      'native',
    );
    expect(session.sessionId).toBe(sessionId);
    expect(session.user.id).toBe(userId);
    expect(session.user.publicHandle).toBe('spott_a1b2c3d4e5f6');
    // TEMPORARY POLICY: password-registered users are treated as phone-verified until SMS lands.
    expect(session.user.phoneVerified).toBe(true);
    expect(captured.phoneVerifiedUpdates).toBe(1);
    expect(captured.nicknames).toHaveLength(1);
    expect(captured.nicknames[0]?.[1]).toBe('devtest');
    expect(captured.credentialInserts).toHaveLength(1);
    const [insertedUserId, insertedEmail, storedHash] = captured.credentialInserts[0] ?? [];
    expect(insertedUserId).toBe(userId);
    expect(insertedEmail).toBe('devtest@spott.jp');
    expect(String(storedHash)).toMatch(/^scrypt:16384:8:1:/);
    await expect(verifyPassword('spott-dev-1', String(storedHash))).resolves.toBe(true);
  });

  it('honours an explicit nickname', async () => {
    const { service, captured } = registerHarness();
    await service.registerWithPassword(
      { email: 'devtest@spott.jp', password: 'spott-dev-1', nickname: '开发者', deviceId },
      'native',
    );
    expect(captured.nicknames[0]?.[1]).toBe('开发者');
  });

  it('rejects a duplicate credential email with EMAIL_ALREADY_REGISTERED', async () => {
    const { service } = registerHarness({ existingCredential: true });
    const attempt = service.registerWithPassword(
      { email: 'devtest@spott.jp', password: 'spott-dev-1', deviceId },
      'native',
    );
    await expect(attempt).rejects.toMatchObject({
      name: 'DomainError',
      code: 'EMAIL_ALREADY_REGISTERED',
      status: 409,
    });
  });

  it('rejects an email already owned by an OTP identity with EMAIL_ALREADY_REGISTERED', async () => {
    const { service } = registerHarness({ existingEmailIdentity: true });
    const attempt = service.registerWithPassword(
      { email: 'devtest@spott.jp', password: 'spott-dev-1', deviceId },
      'native',
    );
    await expect(attempt).rejects.toMatchObject({
      code: 'EMAIL_ALREADY_REGISTERED',
      status: 409,
    });
  });

  it('rejects the ops transport before touching the database', async () => {
    const { service, client } = registerHarness();
    await expect(
      service.registerWithPassword(
        { email: 'devtest@spott.jp', password: 'spott-dev-1', deviceId },
        'ops',
      ),
    ).rejects.toMatchObject({ code: 'SESSION_TRANSPORT_MISMATCH', status: 403 });
    expect(client.query).not.toHaveBeenCalled();
  });
});

describe('password login', () => {
  it('issues a session for the correct password', async () => {
    const stored = await hashPassword('spott-dev-1');
    const { service } = loginHarness(stored);
    const session = await service.loginWithPassword(
      { email: 'devtest@spott.jp', password: 'spott-dev-1', deviceId },
      'native',
    );
    expect(session.sessionId).toBe(sessionId);
    expect(session.user.id).toBe(userId);
    expect(session.user.phoneVerified).toBe(true);
  });

  it('rejects a wrong password with a non-retryable INVALID_CREDENTIALS', async () => {
    const stored = await hashPassword('spott-dev-1');
    const { service } = loginHarness(stored);
    const attempt = service.loginWithPassword(
      { email: 'devtest@spott.jp', password: 'wrong-password', deviceId },
      'native',
    );
    await expect(attempt).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
      status: 401,
      retryable: false,
    });
  });

  it('answers an unknown email with the same INVALID_CREDENTIALS envelope', async () => {
    const { service } = loginHarness(undefined);
    let caught: unknown;
    try {
      await service.loginWithPassword(
        { email: 'nobody@spott.jp', password: 'spott-dev-1', deviceId },
        'native',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DomainError);
    const domainError = caught as DomainError;
    expect(domainError.code).toBe('INVALID_CREDENTIALS');
    expect(domainError.status).toBe(401);
    expect(domainError.retryable).toBe(false);
    // Unknown email and wrong password must be indistinguishable.
    const stored = await hashPassword('spott-dev-1');
    const { service: wrongPasswordService } = loginHarness(stored);
    let wrongPasswordError: unknown;
    try {
      await wrongPasswordService.loginWithPassword(
        { email: 'devtest@spott.jp', password: 'wrong-password', deviceId },
        'native',
      );
    } catch (error) {
      wrongPasswordError = error;
    }
    const comparable = wrongPasswordError as DomainError;
    expect(domainError.message).toBe(comparable.message);
    expect(domainError.code).toBe(comparable.code);
    expect(domainError.status).toBe(comparable.status);
  });
});
