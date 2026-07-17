import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  Client,
  type PoolClient,
  type QueryResult,
  type QueryResultRow,
} from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { SessionRequestChannel } from '../../platform/web-bff-authority.js';
import { AuthService, type SessionResponse } from './auth.service.js';
import {
  SessionTokenService,
  type DeviceBindingProof,
  type RefreshMutationInput,
  type RefreshMutationOutcome,
} from './session-token.service.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const refreshHmacKey = 'task5-refresh-token-secret-at-least-32-bytes';
const derivationKid = 'refresh-2026-07';
const derivationKey = Buffer.from('fedcba9876543210fedcba9876543210');
const bindingSecret = Buffer.alloc(32, 44).toString('base64url');

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseURL,
  ACCESS_TOKEN_SECRET: 'task5-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: refreshHmacKey,
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'task5-lookup-pepper-at-least-16-bytes',
  SPOTT_WEB_BFF_KEYS:
    `bff-2026-07:${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
  REFRESH_TOKEN_DERIVATION_KEYS:
    `${derivationKid}:${derivationKey.toString('base64url')}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: derivationKid,
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

interface SeededSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly secret: string;
  readonly refreshToken: string;
  readonly binding: DeviceBindingProof;
}

interface Task5RefreshContract {
  refresh(
    refreshToken: string,
    deviceId: string,
    platform: 'web' | 'ops',
    authority: undefined,
    requestChannel: SessionRequestChannel,
    attemptKey?: string,
    deviceBindingProof?: DeviceBindingProof,
  ): Promise<SessionResponse>;
}

class TwoPartyBarrier {
  private arrivals = 0;
  private readonly opened: Promise<void>;
  private open!: () => void;

  constructor() {
    this.opened = new Promise<void>((resolve) => { this.open = resolve; });
  }

  async wait(): Promise<void> {
    this.arrivals += 1;
    if (this.arrivals === 2) this.open();
    await this.opened;
  }
}

class ClientDatabaseAdapter {
  readonly events: string[] = [];

  constructor(
    private readonly client: Client,
    private readonly barrier: TwoPartyBarrier,
  ) {}

  async query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL TIME ZONE 'UTC'");
    await this.barrier.wait();
    try {
      const result = await work(this.client as unknown as PoolClient);
      const kind = typeof result === 'object' && result !== null && 'kind' in result
        ? String(result.kind)
        : 'session';
      this.events.push(`outcome:${kind}`);
      await this.client.query('COMMIT');
      this.events.push('commit');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      this.events.push('rollback');
      throw error;
    }
  }
}

const seededUserIds: string[] = [];
let setup: Client;

function refreshHash(secret: string): Buffer {
  return createHmac('sha256', refreshHmacKey).update(secret).digest();
}

function bindingHash(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

async function seedSession(options: { familySibling?: boolean } = {}): Promise<SeededSession> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const bindingId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  seededUserIds.push(userId);

  await setup.query(
    'INSERT INTO identity.users(id, public_handle) VALUES ($1, $2)',
    [userId, `task5_${userId.replaceAll('-', '').slice(0, 12)}`],
  );
  await setup.query(
    "INSERT INTO identity.devices(id, user_id, platform) VALUES ($1, $2, 'ios')",
    [deviceId, userId],
  );
  await setup.query(
    `INSERT INTO identity.sessions(
       id, user_id, device_id, refresh_hash, refresh_family_id,
       refresh_generation, current_derivation_kid, expires_at, transport_class
     ) VALUES ($1, $2, $3, $4, $5, 0, $6,
       clock_timestamp() + interval '1 day', 'native')`,
    [sessionId, userId, deviceId, refreshHash(secret), familyId, derivationKid],
  );
  await setup.query(
    `INSERT INTO identity.device_bindings(
       id, user_id, device_id, session_id, generation, current_hash, current_kid,
       absolute_expires_at
     ) VALUES ($1, $2, $3, $4, 3, $5, $6, clock_timestamp() + interval '1 day')`,
    [bindingId, userId, deviceId, sessionId, bindingHash(bindingSecret), derivationKid],
  );
  await setup.query(
    `UPDATE identity.sessions
     SET current_binding_id = $2, current_binding_generation = 3
     WHERE id = $1`,
    [sessionId, bindingId],
  );
  await setup.query(
    `UPDATE identity.session_refresh_history
     SET binding_id = $2, binding_generation = 3
     WHERE session_id = $1 AND generation = 0`,
    [sessionId, bindingId],
  );

  if (options.familySibling) {
    await setup.query(
      `INSERT INTO identity.sessions(
         id, user_id, device_id, refresh_hash, refresh_family_id,
         refresh_generation, current_derivation_kid, expires_at, transport_class
       ) VALUES ($1, $2, $3, $4, $5, 0, $6,
         clock_timestamp() + interval '1 day', 'native')`,
      [randomUUID(), userId, deviceId, refreshHash(randomBytes(32).toString('base64url')),
        familyId, derivationKid],
    );
  }

  return {
    userId,
    deviceId,
    sessionId,
    familyId,
    secret,
    refreshToken: `s2.${sessionId}.0.${secret}`,
    binding: { bindingId, generation: 3, proof: bindingSecret },
  };
}

async function rotateWith(
  client: Client,
  input: RefreshMutationInput,
  barrier: { wait(): Promise<void> },
): Promise<RefreshMutationOutcome> {
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");
  await barrier.wait();
  try {
    const outcome = await new SessionTokenService().rotate(
      client as unknown as PoolClient,
      input,
      'native',
    );
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

function authService(database: ClientDatabaseAdapter): Task5RefreshContract {
  return Reflect.construct(AuthService, [
    database,
    {},
    {},
    new SessionTokenService(),
  ]) as Task5RefreshContract;
}

describe('committed stable refresh reuse handling on PostgreSQL', () => {
  beforeAll(async () => {
    setup = new Client({
      connectionString: databaseURL,
      application_name: 'spott-task5-session-setup',
    });
    await setup.connect();
  });

  afterEach(async () => {
    if (seededUserIds.length === 0) return;
    const ids = seededUserIds.splice(0);
    await setup.query(
      `UPDATE identity.sessions
       SET current_binding_id = NULL, current_binding_generation = NULL
       WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );
    await setup.query('DELETE FROM identity.device_bindings WHERE user_id = ANY($1::uuid[])', [ids]);
    await setup.query('DELETE FROM identity.sessions WHERE user_id = ANY($1::uuid[])', [ids]);
    await setup.query('DELETE FROM identity.devices WHERE user_id = ANY($1::uuid[])', [ids]);
    await setup.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [ids]);
  });

  afterAll(async () => {
    await setup?.end();
  });

  it('serializes two same-attempt AuthService clients as rotated plus recovered with one generation advance', async () => {
    const seeded = await seedSession();
    const clientA = new Client({ connectionString: databaseURL });
    const clientB = new Client({ connectionString: databaseURL });
    const barrier = new TwoPartyBarrier();
    const attempt = randomUUID();
    await Promise.all([clientA.connect(), clientB.connect()]);
    const databaseA = new ClientDatabaseAdapter(clientA, barrier);
    const databaseB = new ClientDatabaseAdapter(clientB, barrier);
    try {
      const [first, second] = await Promise.all([
        authService(databaseA).refresh(
          seeded.refreshToken,
          seeded.deviceId,
          'web',
          undefined,
          'headerless_native',
          attempt,
          seeded.binding,
        ),
        authService(databaseB).refresh(
          seeded.refreshToken,
          seeded.deviceId,
          'web',
          undefined,
          'headerless_native',
          attempt,
          seeded.binding,
        ),
      ]);

      expect(first.refreshToken).toBe(second.refreshToken);
      expect([...databaseA.events, ...databaseB.events]).toEqual(expect.arrayContaining([
        'outcome:rotated',
        'outcome:recovered',
      ]));
      expect(databaseA.events.at(-1)).toBe('commit');
      expect(databaseB.events.at(-1)).toBe('commit');
      const state = await setup.query<{
        refresh_generation: string;
        current_count: string;
        history_count: string;
      }>(
        `SELECT session.refresh_generation,
                (SELECT count(*) FROM identity.session_refresh_history history
                 WHERE history.session_id = session.id AND history.state = 'current')::text
                   AS current_count,
                (SELECT count(*) FROM identity.session_refresh_history history
                 WHERE history.session_id = session.id)::text AS history_count
         FROM identity.sessions session WHERE session.id = $1`,
        [seeded.sessionId],
      );
      expect(state.rows).toEqual([{
        refresh_generation: '1',
        current_count: '1',
        history_count: '2',
      }]);
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  }, 30_000);

  it('commits family revocation before AuthService maps a different-attempt reuse to 401', async () => {
    const seeded = await seedSession({ familySibling: true });
    const clientA = new Client({ connectionString: databaseURL });
    const clientB = new Client({ connectionString: databaseURL });
    const barrier = new TwoPartyBarrier();
    await Promise.all([clientA.connect(), clientB.connect()]);
    const databaseA = new ClientDatabaseAdapter(clientA, barrier);
    const databaseB = new ClientDatabaseAdapter(clientB, barrier);
    try {
      const calls = [
        authService(databaseA).refresh(
          seeded.refreshToken,
          seeded.deviceId,
          'web',
          undefined,
          'headerless_native',
          randomUUID(),
          seeded.binding,
        ),
        authService(databaseB).refresh(
          seeded.refreshToken,
          seeded.deviceId,
          'web',
          undefined,
          'headerless_native',
          randomUUID(),
          seeded.binding,
        ),
      ];
      const results = await Promise.allSettled(calls);

      expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find(({ status }) => status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: { code: 'REFRESH_TOKEN_REUSED', status: 401 },
      });
      expect([...databaseA.events, ...databaseB.events]).toEqual(expect.arrayContaining([
        'outcome:rotated',
        'outcome:reused',
      ]));
      expect(databaseA.events.at(-1)).toBe('commit');
      expect(databaseB.events.at(-1)).toBe('commit');

      const third = new Client({ connectionString: databaseURL });
      await third.connect();
      try {
        const committed = await third.query<{
          session_count: string;
          revoked_count: string;
          reused_count: string;
        }>(
          `SELECT count(*)::text AS session_count,
                  count(*) FILTER (WHERE revoked_at IS NOT NULL)::text AS revoked_count,
                  count(*) FILTER (WHERE reuse_detected_at IS NOT NULL)::text AS reused_count
           FROM identity.sessions WHERE refresh_family_id = $1`,
          [seeded.familyId],
        );
        expect(committed.rows).toEqual([{
          session_count: '2',
          revoked_count: '2',
          reused_count: '2',
        }]);
      } finally {
        await third.end();
      }
    } finally {
      await Promise.all([clientA.end(), clientB.end()]);
    }
  }, 30_000);

  it('does not revoke a victim family for one-byte-mutated unknown material', async () => {
    const seeded = await seedSession();
    const client = new Client({ connectionString: databaseURL });
    await client.connect();
    try {
      const mutated = Buffer.from(seeded.secret, 'base64url');
      const firstByte = mutated[0];
      if (firstByte === undefined) throw new Error('seeded refresh secret was empty');
      mutated[0] = firstByte ^ 0x01;
      const outcome = await rotateWith(client, {
        refreshToken: `s2.${seeded.sessionId}.0.${mutated.toString('base64url')}`,
        deviceId: seeded.deviceId,
        attemptKey: randomUUID(),
        deviceBindingProof: seeded.binding,
      }, { wait: () => Promise.resolve() });
      expect(outcome).toEqual({ kind: 'invalid' });

      const victim = await setup.query<{
        refresh_generation: string;
        revoked_at: Date | null;
        reuse_detected_at: Date | null;
      }>(
        `SELECT refresh_generation, revoked_at, reuse_detected_at
         FROM identity.sessions WHERE id = $1`,
        [seeded.sessionId],
      );
      expect(victim.rows).toEqual([{
        refresh_generation: '0',
        revoked_at: null,
        reuse_detected_at: null,
      }]);
    } finally {
      await client.end();
    }
  });
});
