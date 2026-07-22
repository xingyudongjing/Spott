import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { Client, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { VerifiedBFFAuthority } from '../../platform/web-bff-authority.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import {
  AuthService,
  type DeviceBindingUpgradeInput,
  type DeviceBindingUpgradeMaterial,
} from './auth.service.js';
import type { WebRefreshEnvelopeDBClaims } from './refresh-envelope-claims.js';
import { SessionTokenService } from './session-token.service.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const refreshSecretKey = 'binding-upgrade-refresh-secret-at-least-32-bytes';
const derivationKid = 'refresh-2026-07';
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: databaseURL,
  ACCESS_TOKEN_SECRET: 'binding-upgrade-access-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: refreshSecretKey,
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'binding-upgrade-lookup-pepper-at-least-16-bytes',
  SPOTT_WEB_BFF_KEYS:
    `bff-2026-07:${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url')}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-2026-07',
  REFRESH_TOKEN_DERIVATION_KEYS:
    `${derivationKid}:${Buffer.from('fedcba9876543210fedcba9876543210').toString('base64url')}`,
  REFRESH_TOKEN_DERIVATION_CURRENT_KID: derivationKid,
  WEB_SESSION_BFF_ENFORCEMENT: 'off',
  WEB_SESSION_RECOVERY_SECONDS: '120',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.jp',
});

const authority: VerifiedBFFAuthority = {
  version: 'v1',
  kid: 'bff-2026-07',
  timestamp: 1_784_346_245_000,
  nonceHash: Buffer.alloc(32, 12),
};

interface SeededWebSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly refreshSecret: string;
  readonly refreshToken: string;
}

class ClientDatabaseAdapter {
  constructor(private readonly client: Client) {}

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL TIME ZONE 'UTC'");
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

class ConcurrentLogoutDatabaseAdapter {
  private acquiredUserMutationLock = false;

  constructor(
    private readonly client: Client,
    private readonly preUserLockSessionBarrier: TwoPartyBarrier,
  ) {}

  query<T extends QueryResultRow>(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<QueryResult<T>> {
    return this.client.query<T>(text, [...values]);
  }

  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    await this.client.query('BEGIN');
    await this.client.query("SET LOCAL TIME ZONE 'UTC'");
    await this.client.query("SET LOCAL deadlock_timeout = '100ms'");
    const wrappedClient = {
      query: async <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => {
        if (text.includes('pg_advisory_xact_lock') && text.includes('session-mutation-user')) {
          this.acquiredUserMutationLock = true;
        }
        const result = await this.client.query<Row>(text, [...values]);
        if (
          !this.acquiredUserMutationLock
          && text.includes('FROM identity.sessions AS session')
          && text.includes('FOR UPDATE')
        ) {
          await this.preUserLockSessionBarrier.wait();
        }
        return result;
      },
    } as PoolClient;
    try {
      const result = await work(wrappedClient);
      await this.client.query('COMMIT');
      return result;
    } catch (error) {
      await this.client.query('ROLLBACK');
      throw error;
    }
  }
}

let client: Client;
let service: AuthService;
const seededUserIds: string[] = [];
const seededMigrationIntentIds: string[] = [];

function refreshHash(secret: string): Buffer {
  return createHmac('sha256', refreshSecretKey).update(secret).digest();
}

async function seedWebSession(): Promise<SeededWebSession> {
  const userId = randomUUID();
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshSecret = randomBytes(32).toString('base64url');
  seededUserIds.push(userId);

  await client.query(
    'INSERT INTO identity.users(id, public_handle) VALUES ($1, $2)',
    [userId, `binding_${userId.replaceAll('-', '').slice(0, 12)}`],
  );
  await client.query(
    "INSERT INTO identity.devices(id, user_id, platform) VALUES ($1, $2, 'web')",
    [deviceId, userId],
  );
  await client.query(
    `INSERT INTO identity.sessions(
       id, user_id, device_id, refresh_hash, refresh_family_id,
       refresh_generation, current_derivation_kid, expires_at, transport_class
     ) VALUES ($1, $2, $3, $4, $5, 0, NULL,
       clock_timestamp() + interval '1 day', 'web_bff')`,
    [sessionId, userId, deviceId, refreshHash(refreshSecret), familyId],
  );
  return {
    userId,
    deviceId,
    sessionId,
    familyId,
    refreshSecret,
    refreshToken: `${sessionId}.${refreshSecret}`,
  };
}

async function seedAdditionalWebSession(userId: string): Promise<SeededWebSession> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshSecret = randomBytes(32).toString('base64url');
  await client.query(
    "INSERT INTO identity.devices(id, user_id, platform) VALUES ($1, $2, 'web')",
    [deviceId, userId],
  );
  await client.query(
    `INSERT INTO identity.sessions(
       id, user_id, device_id, refresh_hash, refresh_family_id,
       refresh_generation, current_derivation_kid, expires_at, transport_class
     ) VALUES ($1, $2, $3, $4, $5, 0, NULL,
       clock_timestamp() + interval '1 day', 'web_bff')`,
    [sessionId, userId, deviceId, refreshHash(refreshSecret), familyId],
  );
  return {
    userId,
    deviceId,
    sessionId,
    familyId,
    refreshSecret,
    refreshToken: `${sessionId}.${refreshSecret}`,
  };
}

async function seedAdditionalNativeSession(userId: string): Promise<SeededWebSession> {
  const deviceId = randomUUID();
  const sessionId = randomUUID();
  const familyId = randomUUID();
  const refreshSecret = randomBytes(32).toString('base64url');
  await client.query(
    "INSERT INTO identity.devices(id, user_id, platform) VALUES ($1, $2, 'ios')",
    [deviceId, userId],
  );
  await client.query(
    `INSERT INTO identity.sessions(
       id, user_id, device_id, refresh_hash, refresh_family_id,
       refresh_generation, current_derivation_kid, expires_at, transport_class
     ) VALUES ($1, $2, $3, $4, $5, 0, NULL,
       clock_timestamp() + interval '1 day', 'native')`,
    [sessionId, userId, deviceId, refreshHash(refreshSecret), familyId],
  );
  return {
    userId,
    deviceId,
    sessionId,
    familyId,
    refreshSecret,
    refreshToken: `${sessionId}.${refreshSecret}`,
  };
}

function upgradeInput(
  seeded: SeededWebSession,
  overrides: Partial<DeviceBindingUpgradeInput> = {},
): DeviceBindingUpgradeInput {
  return {
    refreshToken: seeded.refreshToken,
    deviceId: seeded.deviceId,
    attemptId: randomUUID(),
    newBinding: {
      bindingId: randomUUID(),
      generation: 0,
      proof: randomBytes(32).toString('base64url'),
      proofClass: 'persistent',
    },
    ...overrides,
  };
}

function refreshEnvelopeClaims(
  seeded: SeededWebSession,
  input: DeviceBindingUpgradeInput,
): WebRefreshEnvelopeDBClaims {
  return {
    sessionId: seeded.sessionId,
    familyId: seeded.familyId,
    generation: 0,
    transportClass: 'web_bff',
    persistentBindingId: input.newBinding.bindingId,
    persistentBindingGeneration: input.newBinding.generation,
  };
}

describe('first persistent Web device-binding upgrade on PostgreSQL', () => {
  beforeAll(async () => {
    client = new Client({
      connectionString: databaseURL,
      application_name: 'spott-binding-upgrade-integration',
    });
    await client.connect();
    service = new AuthService(
      new ClientDatabaseAdapter(client) as never,
      {} as never,
      new IdempotencyService(),
      new SessionTokenService(),
    );
  });

  afterEach(async () => {
    if (seededMigrationIntentIds.length > 0) {
      const ids = seededMigrationIntentIds.splice(0);
      await client.query('DELETE FROM identity.web_migration_intents WHERE id = ANY($1::uuid[])', [ids]);
    }
    if (seededUserIds.length === 0) return;
    const ids = seededUserIds.splice(0);
    await client.query(
      `UPDATE identity.sessions
       SET current_binding_id = NULL, current_binding_generation = NULL
       WHERE user_id = ANY($1::uuid[])`,
      [ids],
    );
    await client.query('DELETE FROM sync.idempotency_keys WHERE user_id = ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM identity.device_bindings WHERE user_id = ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM identity.sessions WHERE user_id = ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM identity.devices WHERE user_id = ANY($1::uuid[])', [ids]);
    await client.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [ids]);
  });

  afterAll(async () => {
    await client?.end();
  });

  it('atomically issues one domain-separated binding and replays the exact safe material', async () => {
    const seeded = await seedWebSession();
    const input = upgradeInput(seeded);

    const first = await service.upgradeDeviceBinding(input, authority, 'verified_bff');
    const retry = await service.upgradeDeviceBinding(input, authority, 'verified_bff');

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      sessionId: seeded.sessionId,
      refreshFamilyId: seeded.familyId,
      refreshGeneration: 0,
      transportClass: 'web_bff',
      bindingId: input.newBinding.bindingId,
      bindingGeneration: 0,
      user: { id: seeded.userId },
    });
    const state = await client.query<{
      current_binding_id: string;
      current_binding_generation: string;
      history_binding_id: string;
      history_binding_generation: string;
      current_hash: Buffer;
      current_kid: string;
      proof_class: string;
      binding_count: string;
      idempotency_count: string;
      response_body: DeviceBindingUpgradeMaterial;
    }>(
      `SELECT session.current_binding_id, session.current_binding_generation,
              history.binding_id AS history_binding_id,
              history.binding_generation AS history_binding_generation,
              binding.current_hash, binding.current_kid, registry.proof_class,
              (SELECT count(*) FROM identity.device_bindings counted
               WHERE counted.session_id = session.id)::text AS binding_count,
              (SELECT count(*) FROM sync.idempotency_keys idempotency
               WHERE idempotency.user_id = session.user_id)::text AS idempotency_count,
              idempotency.response_body
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = session.refresh_generation
       JOIN identity.device_bindings AS binding ON binding.id = session.current_binding_id
       JOIN identity.proof_hash_classes AS registry ON registry.proof_hash = binding.current_hash
       JOIN sync.idempotency_keys AS idempotency
         ON idempotency.user_id = session.user_id AND idempotency.key = $2
       WHERE session.id = $1`,
      [seeded.sessionId, input.attemptId],
    );
    const row = state.rows[0];
    expect(row).toMatchObject({
      current_binding_id: input.newBinding.bindingId,
      current_binding_generation: '0',
      history_binding_id: input.newBinding.bindingId,
      history_binding_generation: '0',
      current_kid: derivationKid,
      proof_class: 'persistent',
      binding_count: '1',
      idempotency_count: '1',
      response_body: first,
    });
    expect(row?.current_hash).not.toEqual(createHash('sha256').update(input.newBinding.proof).digest());
    expect(JSON.stringify(row?.response_body)).not.toContain(input.newBinding.proof);
    expect(JSON.stringify(row?.response_body)).not.toContain(seeded.refreshSecret);

    await expect(service.bootstrap(
      seeded.refreshToken,
      seeded.deviceId,
      input.newBinding,
      authority,
      'verified_bff',
      refreshEnvelopeClaims(seeded, input),
    )).resolves.toMatchObject({
      sessionId: seeded.sessionId,
      refreshToken: seeded.refreshToken,
      refreshGeneration: 0,
    });

    await client.query(
      'UPDATE identity.device_bindings SET current_kid = $2 WHERE id = $1',
      [input.newBinding.bindingId, 'retired-or-forged-kid'],
    );
    await expect(service.bootstrap(
      seeded.refreshToken,
      seeded.deviceId,
      input.newBinding,
      authority,
      'verified_bff',
      refreshEnvelopeClaims(seeded, input),
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
  });

  it('checks refresh envelope DB claims before any rotate or reuse mutation', async () => {
    const seeded = await seedWebSession();
    const input = upgradeInput(seeded);
    await service.upgradeDeviceBinding(input, authority, 'verified_bff');
    const claims = refreshEnvelopeClaims(seeded, input);
    const attemptId = randomUUID();

    await expect(service.refresh(
      seeded.refreshToken,
      seeded.deviceId,
      'web',
      authority,
      'verified_bff',
      attemptId,
      input.newBinding,
      { ...claims, generation: 1 },
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });

    const unchanged = await client.query<{
      refresh_generation: string;
      revoked_at: Date | null;
      reuse_detected_at: Date | null;
      current_count: string;
      history_count: string;
    }>(
      `SELECT session.refresh_generation, session.revoked_at, session.reuse_detected_at,
              (SELECT count(*) FROM identity.session_refresh_history history
               WHERE history.session_id = session.id AND history.state = 'current')::text
                 AS current_count,
              (SELECT count(*) FROM identity.session_refresh_history history
               WHERE history.session_id = session.id)::text AS history_count
       FROM identity.sessions AS session WHERE session.id = $1`,
      [seeded.sessionId],
    );
    expect(unchanged.rows).toEqual([{
      refresh_generation: '0',
      revoked_at: null,
      reuse_detected_at: null,
      current_count: '1',
      history_count: '1',
    }]);

    const rotated = await service.refresh(
      seeded.refreshToken,
      seeded.deviceId,
      'web',
      authority,
      'verified_bff',
      attemptId,
      input.newBinding,
      claims,
    );
    expect(rotated).toMatchObject({ sessionId: seeded.sessionId, refreshGeneration: 1 });

    await expect(service.refresh(
      seeded.refreshToken,
      seeded.deviceId,
      'web',
      authority,
      'verified_bff',
      randomUUID(),
      input.newBinding,
      { ...claims, familyId: randomUUID() },
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    const notRevoked = await client.query<{ revoked_at: Date | null; reuse_detected_at: Date | null }>(
      'SELECT revoked_at, reuse_detected_at FROM identity.sessions WHERE id = $1',
      [seeded.sessionId],
    );
    expect(notRevoked.rows).toEqual([{ revoked_at: null, reuse_detected_at: null }]);
  });

  it('rejects a second attempt instead of silently rotating or rebinding the issued session', async () => {
    const seeded = await seedWebSession();
    const firstInput = upgradeInput(seeded);
    await service.upgradeDeviceBinding(firstInput, authority, 'verified_bff');
    const secondInput = upgradeInput(seeded);

    await expect(
      service.upgradeDeviceBinding(secondInput, authority, 'verified_bff'),
    ).rejects.toMatchObject({ code: 'DEVICE_BINDING_ALREADY_EXISTS', status: 409 });

    const state = await client.query<{ binding_count: string; idempotency_count: string }>(
      `SELECT
         (SELECT count(*) FROM identity.device_bindings WHERE session_id = $1)::text AS binding_count,
         (SELECT count(*) FROM sync.idempotency_keys WHERE user_id = $2)::text AS idempotency_count`,
      [seeded.sessionId, seeded.userId],
    );
    expect(state.rows).toEqual([{ binding_count: '1', idempotency_count: '1' }]);
  });

  it('revokes only the fully verified current Web session and its persistent binding', async () => {
    const owner = await seedWebSession();
    const sibling = await seedAdditionalWebSession(owner.userId);
    const victim = await seedWebSession();
    const ownerUpgrade = upgradeInput(owner);
    const siblingUpgrade = upgradeInput(sibling);
    const victimUpgrade = upgradeInput(victim);
    await service.upgradeDeviceBinding(ownerUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(siblingUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(victimUpgrade, authority, 'verified_bff');

    await expect(service.logoutWebSession({
      refreshToken: owner.refreshToken,
      deviceId: owner.deviceId,
      deviceBindingProof: ownerUpgrade.newBinding,
      refreshEnvelopeClaims: refreshEnvelopeClaims(owner, ownerUpgrade),
    }, authority, 'verified_bff')).resolves.toEqual({ revokedCount: 1 });

    const state = await client.query<{
      id: string;
      revoked: boolean;
      binding_revoked: boolean;
      history_state: string;
    }>(
      `SELECT session.id, session.revoked_at IS NOT NULL AS revoked,
              binding.revoked_at IS NOT NULL AS binding_revoked,
              history.state AS history_state
       FROM identity.sessions AS session
       JOIN identity.device_bindings AS binding ON binding.id = session.current_binding_id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = session.refresh_generation
       WHERE session.id = ANY($1::uuid[]) ORDER BY session.id`,
      [[owner.sessionId, sibling.sessionId, victim.sessionId]],
    );
    const byId = new Map(state.rows.map((row) => [row.id, row]));
    expect(byId.get(owner.sessionId)).toMatchObject({
      revoked: true,
      binding_revoked: true,
      history_state: 'revoked',
    });
    expect(byId.get(sibling.sessionId)).toMatchObject({
      revoked: false,
      binding_revoked: false,
      history_state: 'current',
    });
    expect(byId.get(victim.sessionId)).toMatchObject({
      revoked: false,
      binding_revoked: false,
      history_state: 'current',
    });
  });

  it('derives logout-all ownership from the verified Web binding and revokes every owner binding, including one on an already-revoked session', async () => {
    const owner = await seedWebSession();
    const sibling = await seedAdditionalNativeSession(owner.userId);
    const alreadyRevoked = await seedAdditionalWebSession(owner.userId);
    const victim = await seedWebSession();
    const ownerUpgrade = upgradeInput(owner);
    const alreadyRevokedUpgrade = upgradeInput(alreadyRevoked);
    const victimUpgrade = upgradeInput(victim);
    await service.upgradeDeviceBinding(ownerUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(alreadyRevokedUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(victimUpgrade, authority, 'verified_bff');
    await client.query(
      'UPDATE identity.sessions SET revoked_at = clock_timestamp() WHERE id = $1',
      [alreadyRevoked.sessionId],
    );

    await expect(service.logoutAllWebSessions({
      refreshToken: owner.refreshToken,
      deviceId: owner.deviceId,
      deviceBindingProof: ownerUpgrade.newBinding,
      refreshEnvelopeClaims: refreshEnvelopeClaims(owner, ownerUpgrade),
    }, authority, 'verified_bff')).resolves.toEqual({ revokedCount: 2 });

    const state = await client.query<{ user_id: string; active_sessions: string; active_bindings: string }>(
      `SELECT user_record.id AS user_id,
              (SELECT count(*) FROM identity.sessions session
               WHERE session.user_id = user_record.id AND session.revoked_at IS NULL)::text
                AS active_sessions,
              (SELECT count(*) FROM identity.device_bindings binding
               WHERE binding.user_id = user_record.id AND binding.revoked_at IS NULL)::text
                AS active_bindings
       FROM identity.users user_record WHERE user_record.id = ANY($1::uuid[])
       ORDER BY user_record.id`,
      [[owner.userId, victim.userId]],
    );
    const byUser = new Map(state.rows.map((row) => [row.user_id, row]));
    expect(byUser.get(owner.userId)).toMatchObject({ active_sessions: '0', active_bindings: '0' });
    expect(byUser.get(victim.userId)).toMatchObject({ active_sessions: '1', active_bindings: '1' });
    const ownerHistory = await client.query<{
      session_id: string;
      state: string;
      consumed_reason: string | null;
      successor_generation: string | null;
      recovery_expires_at: Date | null;
    }>(
      `SELECT history.session_id, history.state, history.consumed_reason,
              history.successor_generation, history.recovery_expires_at
       FROM identity.session_refresh_history AS history
       JOIN identity.sessions AS session ON session.id = history.session_id
       WHERE session.user_id = $1 ORDER BY history.session_id, history.generation`,
      [owner.userId],
    );
    const historyBySession = new Map(ownerHistory.rows.map((row) => [row.session_id, row]));
    expect(historyBySession.get(owner.sessionId)).toMatchObject({
      state: 'revoked',
      consumed_reason: 'logout_all',
      successor_generation: null,
      recovery_expires_at: null,
    });
    expect(historyBySession.get(alreadyRevoked.sessionId)).toMatchObject({
      state: 'revoked',
      consumed_reason: 'logout_all',
      successor_generation: null,
      recovery_expires_at: null,
    });
    const nativeState = await client.query<{ transport_class: string; revoked: boolean }>(
      `SELECT transport_class, revoked_at IS NOT NULL AS revoked
       FROM identity.sessions WHERE id = $1`,
      [sibling.sessionId],
    );
    expect(nativeState.rows).toEqual([{ transport_class: 'native', revoked: true }]);
  });

  it('serializes concurrent logout-all from two valid bindings without a PostgreSQL deadlock', async () => {
    const first = await seedWebSession();
    const second = await seedAdditionalWebSession(first.userId);
    const firstUpgrade = upgradeInput(first);
    const secondUpgrade = upgradeInput(second);
    await service.upgradeDeviceBinding(firstUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(secondUpgrade, authority, 'verified_bff');

    const firstClient = new Client({ connectionString: databaseURL });
    const secondClient = new Client({ connectionString: databaseURL });
    const barrier = new TwoPartyBarrier();
    await Promise.all([firstClient.connect(), secondClient.connect()]);
    try {
      const firstService = new AuthService(
        new ConcurrentLogoutDatabaseAdapter(firstClient, barrier) as never,
        {} as never,
        new IdempotencyService(),
        new SessionTokenService(),
      );
      const secondService = new AuthService(
        new ConcurrentLogoutDatabaseAdapter(secondClient, barrier) as never,
        {} as never,
        new IdempotencyService(),
        new SessionTokenService(),
      );
      const outcomes = await Promise.allSettled([
        firstService.logoutAllWebSessions({
          refreshToken: first.refreshToken,
          deviceId: first.deviceId,
          deviceBindingProof: firstUpgrade.newBinding,
          refreshEnvelopeClaims: refreshEnvelopeClaims(first, firstUpgrade),
        }, authority, 'verified_bff'),
        secondService.logoutAllWebSessions({
          refreshToken: second.refreshToken,
          deviceId: second.deviceId,
          deviceBindingProof: secondUpgrade.newBinding,
          refreshEnvelopeClaims: refreshEnvelopeClaims(second, secondUpgrade),
        }, authority, 'verified_bff'),
      ]);

      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect(outcome.reason as unknown).toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
        }
      }
      const successes = outcomes.filter(
        (outcome): outcome is PromiseFulfilledResult<{ revokedCount: number }> =>
          outcome.status === 'fulfilled',
      );
      expect(successes).toHaveLength(1);
      expect(successes[0]?.value).toEqual({ revokedCount: 2 });
      const finalState = await client.query<{ active_sessions: string; active_bindings: string }>(
        `SELECT
           (SELECT count(*) FROM identity.sessions
            WHERE user_id = $1 AND revoked_at IS NULL)::text AS active_sessions,
           (SELECT count(*) FROM identity.device_bindings
            WHERE user_id = $1 AND revoked_at IS NULL)::text AS active_bindings`,
        [first.userId],
      );
      expect(finalState.rows).toEqual([{ active_sessions: '0', active_bindings: '0' }]);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
    }
  });

  it('keeps native DELETE-all behavior while isolating a mixed-platform owner from another user', async () => {
    const ownerWeb = await seedWebSession();
    const ownerNative = await seedAdditionalNativeSession(ownerWeb.userId);
    const victim = await seedWebSession();
    const ownerUpgrade = upgradeInput(ownerWeb);
    const victimUpgrade = upgradeInput(victim);
    await service.upgradeDeviceBinding(ownerUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(victimUpgrade, authority, 'verified_bff');

    await expect(service.revokeAllSessions(ownerWeb.userId)).resolves.toEqual({ revokedCount: 2 });

    const state = await client.query<{ id: string; revoked: boolean }>(
      `SELECT id, revoked_at IS NOT NULL AS revoked
       FROM identity.sessions
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [[ownerWeb.sessionId, ownerNative.sessionId, victim.sessionId]],
    );
    const byId = new Map(state.rows.map((row) => [row.id, row.revoked]));
    expect(byId.get(ownerWeb.sessionId)).toBe(true);
    expect(byId.get(ownerNative.sessionId)).toBe(true);
    expect(byId.get(victim.sessionId)).toBe(false);
  });

  it('leaves every session unchanged for wrong proof, wrong envelope, and temporary proof class', async () => {
    const owner = await seedWebSession();
    const victim = await seedWebSession();
    const ownerUpgrade = upgradeInput(owner);
    const victimUpgrade = upgradeInput(victim);
    await service.upgradeDeviceBinding(ownerUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(victimUpgrade, authority, 'verified_bff');
    const base = {
      refreshToken: owner.refreshToken,
      deviceId: owner.deviceId,
      deviceBindingProof: ownerUpgrade.newBinding,
      refreshEnvelopeClaims: refreshEnvelopeClaims(owner, ownerUpgrade),
    };

    for (const input of [
      {
        ...base,
        deviceBindingProof: {
          ...base.deviceBindingProof,
          proof: randomBytes(32).toString('base64url'),
        },
      },
      {
        ...base,
        refreshEnvelopeClaims: { ...base.refreshEnvelopeClaims, familyId: victim.familyId },
      },
      {
        ...base,
        deviceBindingProof: {
          ...base.deviceBindingProof,
          proofClass: 'migration_temporary' as const,
        },
      },
    ]) {
      await expect(service.logoutAllWebSessions(
        input as never,
        authority,
        'verified_bff',
      )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    }

    const unchanged = await client.query<{ active: string }>(
      `SELECT count(*)::text AS active FROM identity.sessions
       WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
      [[owner.sessionId, victim.sessionId]],
    );
    expect(unchanged.rows).toEqual([{ active: '2' }]);
  });

  it('fails closed for a foreign-owner binding, blocked device, and expired verified credential', async () => {
    const owner = await seedWebSession();
    const victim = await seedWebSession();
    const ownerUpgrade = upgradeInput(owner);
    const victimUpgrade = upgradeInput(victim);
    await service.upgradeDeviceBinding(ownerUpgrade, authority, 'verified_bff');
    await service.upgradeDeviceBinding(victimUpgrade, authority, 'verified_bff');
    const base = {
      refreshToken: owner.refreshToken,
      deviceId: owner.deviceId,
      deviceBindingProof: ownerUpgrade.newBinding,
      refreshEnvelopeClaims: refreshEnvelopeClaims(owner, ownerUpgrade),
    };

    await expect(service.logoutAllWebSessions({
      ...base,
      deviceBindingProof: victimUpgrade.newBinding,
      refreshEnvelopeClaims: {
        ...base.refreshEnvelopeClaims,
        persistentBindingId: victimUpgrade.newBinding.bindingId,
      },
    }, authority, 'verified_bff')).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });

    await client.query("UPDATE identity.devices SET risk_state = 'blocked' WHERE id = $1", [owner.deviceId]);
    await expect(service.logoutAllWebSessions(
      base,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });
    await client.query("UPDATE identity.devices SET risk_state = 'normal' WHERE id = $1", [owner.deviceId]);

    await client.query(
      "UPDATE identity.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1",
      [owner.sessionId],
    );
    await expect(service.logoutAllWebSessions(
      base,
      authority,
      'verified_bff',
    )).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', status: 401 });

    const unchanged = await client.query<{
      id: string;
      session_active: boolean;
      binding_active: boolean;
      history_state: string;
    }>(
      `SELECT session.id,
              session.revoked_at IS NULL AS session_active,
              binding.revoked_at IS NULL AS binding_active,
              history.state AS history_state
       FROM identity.sessions AS session
       JOIN identity.device_bindings AS binding ON binding.id = session.current_binding_id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = session.refresh_generation
       WHERE session.id = ANY($1::uuid[]) ORDER BY session.id`,
      [[owner.sessionId, victim.sessionId]],
    );
    expect(unchanged.rows).toHaveLength(2);
    for (const row of unchanged.rows) {
      expect(row).toMatchObject({
        session_active: true,
        binding_active: true,
        history_state: 'current',
      });
    }
  });

  it('refuses proof material already registered as migration-temporary with zero mutation', async () => {
    const seeded = await seedWebSession();
    const temporaryProof = randomBytes(32).toString('base64url');
    const migrationIntentId = randomUUID();
    seededMigrationIntentIds.push(migrationIntentId);
    await client.query(
      `INSERT INTO identity.web_migration_intents(
         id, attempt_hash, temporary_binding_hash, mac_version, mac_kid,
         issued_at, expires_at
       ) VALUES ($1, $2, $3, 'v1', 'bff-2026-07',
         clock_timestamp(), clock_timestamp() + interval '5 minutes')`,
      [migrationIntentId, createHash('sha256').update(randomUUID()).digest(),
        createHash('sha256').update(temporaryProof).digest()],
    );
    const input = upgradeInput(seeded, {
      newBinding: {
        bindingId: randomUUID(),
        generation: 0,
        proof: temporaryProof,
        proofClass: 'persistent',
      },
    });

    await expect(
      service.upgradeDeviceBinding(input, authority, 'verified_bff'),
    ).rejects.toMatchObject({ code: 'DEVICE_BINDING_PROOF_CLASS_INVALID', status: 401 });

    const state = await client.query<{
      current_binding_id: string | null;
      history_binding_id: string | null;
      binding_count: string;
      idempotency_count: string;
    }>(
      `SELECT session.current_binding_id, history.binding_id AS history_binding_id,
              (SELECT count(*) FROM identity.device_bindings WHERE session_id = $1)::text AS binding_count,
              (SELECT count(*) FROM sync.idempotency_keys WHERE user_id = $2)::text AS idempotency_count
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = session.refresh_generation
       WHERE session.id = $1`,
      [seeded.sessionId, seeded.userId],
    );
    expect(state.rows).toEqual([{
      current_binding_id: null,
      history_binding_id: null,
      binding_count: '0',
      idempotency_count: '0',
    }]);
  });
});
