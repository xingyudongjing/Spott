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
