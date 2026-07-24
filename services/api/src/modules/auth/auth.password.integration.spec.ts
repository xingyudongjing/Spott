import { randomUUID } from 'node:crypto';
import { Client, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from './auth.service.js';
import { SessionTokenService } from './session-token.service.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseURL,
  ACCESS_TOKEN_SECRET: 'password-auth-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: 'password-auth-refresh-token-secret-at-least-32-bytes',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'password-auth-lookup-pepper-at-least-16-bytes',
});

const { FieldCrypto } = await import('../../platform/crypto.js');

class ClientDatabaseAdapter {
  constructor(private readonly client: Client) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    try {
      const result = await work(this.client as unknown as PoolClient);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

let connection: Client;
let service: AuthService;
const seededEmails: string[] = [];

function uniqueEmail(): string {
  const email = `pw_${randomUUID().replaceAll('-', '').slice(0, 20)}@example.com`;
  seededEmails.push(email);
  return email;
}

describe('password registration and login on PostgreSQL', () => {
  beforeAll(async () => {
    connection = new Client({
      connectionString: databaseURL,
      application_name: 'spott-password-auth-integration',
    });
    await connection.connect();
    service = new AuthService(
      new ClientDatabaseAdapter(connection) as never,
      new FieldCrypto(),
      {} as never,
      new SessionTokenService(),
    );
  });

  afterEach(async () => {
    if (seededEmails.length === 0) return;
    const emails = seededEmails.splice(0);
    const users = await connection.query<{ user_id: string }>(
      'SELECT user_id FROM identity.user_credentials WHERE email = ANY($1::citext[])',
      [emails],
    );
    const ids = users.rows.map((row) => row.user_id);
    if (ids.length === 0) return;
    await connection.query('DELETE FROM identity.user_credentials WHERE user_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM identity.sessions WHERE user_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM identity.devices WHERE user_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM identity.auth_identities WHERE user_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM identity.profiles WHERE user_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM commerce.wallets WHERE user_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM sync.change_log WHERE user_scope = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM sync.outbox_events WHERE aggregate_id = ANY($1::uuid[])', [ids]);
    await connection.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [ids]);
  });

  afterAll(async () => {
    await connection?.end();
  });

  it('registers a user, persists an scrypt credential, defaults the nickname, and issues a session', async () => {
    const email = uniqueEmail();
    const session = await service.registerWithPassword(
      { email, password: 'spott-dev-1', deviceId: randomUUID() },
      'native',
    );

    expect(session.accessToken).toBeTruthy();
    expect(session.refreshToken).toContain(session.sessionId);
    expect(session.refreshGeneration).toBe(0);
    expect(session.user.publicHandle).toMatch(/^spott_[0-9a-f]{12}$/);
    // TEMPORARY POLICY: password-registered users count as phone-verified until SMS lands.
    expect(session.user.phoneVerified).toBe(true);

    const credential = await connection.query<{ user_id: string; password_hash: string }>(
      'SELECT user_id, password_hash FROM identity.user_credentials WHERE email = $1',
      [email],
    );
    expect(credential.rowCount).toBe(1);
    expect(credential.rows[0]?.user_id).toBe(session.user.id);
    expect(credential.rows[0]?.password_hash).toMatch(/^scrypt:16384:8:1:[0-9a-f]{32}:[0-9a-f]{128}$/);

    const identity = await connection.query(
      `SELECT 1 FROM identity.auth_identities WHERE user_id = $1 AND provider = 'email'`,
      [session.user.id],
    );
    expect(identity.rowCount).toBe(1);

    const profile = await connection.query<{ nickname: string }>(
      'SELECT nickname FROM identity.profiles WHERE user_id = $1',
      [session.user.id],
    );
    expect(profile.rows[0]?.nickname).toBe(email.split('@', 1)[0]);

    const user = await connection.query<{ phone_verified_at: Date | null }>(
      'SELECT phone_verified_at FROM identity.users WHERE id = $1',
      [session.user.id],
    );
    expect(user.rows[0]?.phone_verified_at).not.toBeNull();
  });

  it('logs the registered user back in with the same SessionResponse shape', async () => {
    const email = uniqueEmail();
    const registered = await service.registerWithPassword(
      { email, password: 'spott-dev-1', nickname: '密码用户', deviceId: randomUUID() },
      'native',
    );
    const login = await service.loginWithPassword(
      { email, password: 'spott-dev-1', deviceId: randomUUID() },
      'native',
    );
    expect(login.user.id).toBe(registered.user.id);
    expect(login.user.publicHandle).toBe(registered.user.publicHandle);
    expect(login.user.phoneVerified).toBe(true);
    expect(login.sessionId).not.toBe(registered.sessionId);
    expect(Object.keys(login).toSorted()).toEqual(Object.keys(registered).toSorted());

    const profile = await connection.query<{ nickname: string }>(
      'SELECT nickname FROM identity.profiles WHERE user_id = $1',
      [registered.user.id],
    );
    expect(profile.rows[0]?.nickname).toBe('密码用户');
  });

  it('rejects duplicate registration for the same email, case-insensitively', async () => {
    const email = uniqueEmail();
    await service.registerWithPassword(
      { email, password: 'spott-dev-1', deviceId: randomUUID() },
      'native',
    );
    await expect(
      service.registerWithPassword(
        { email: email.toUpperCase(), password: 'other-password-1', deviceId: randomUUID() },
        'native',
      ),
    ).rejects.toMatchObject({ code: 'EMAIL_ALREADY_REGISTERED', status: 409 });
  });

  it('rejects wrong passwords and unknown emails with the same INVALID_CREDENTIALS envelope', async () => {
    const email = uniqueEmail();
    await service.registerWithPassword(
      { email, password: 'spott-dev-1', deviceId: randomUUID() },
      'native',
    );
    const expected = { code: 'INVALID_CREDENTIALS', status: 401, retryable: false };
    await expect(
      service.loginWithPassword(
        { email, password: 'wrong-password', deviceId: randomUUID() },
        'native',
      ),
    ).rejects.toMatchObject(expected);
    await expect(
      service.loginWithPassword(
        { email: `missing_${email}`, password: 'spott-dev-1', deviceId: randomUUID() },
        'native',
      ),
    ).rejects.toMatchObject(expected);
  });
});
