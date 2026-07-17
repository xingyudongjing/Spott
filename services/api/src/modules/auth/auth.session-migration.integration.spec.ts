import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const root = resolve(import.meta.dirname, '../../../../..');
const migrationsDirectory = join(root, 'database', 'migrations');
const databaseName = `spott_session_migration_${process.pid}_${Date.now()}_test`;
const maintenanceURL = new URL(databaseURL);
maintenanceURL.pathname = '/postgres';
const isolatedURL = new URL(databaseURL);
isolatedURL.pathname = `/${databaseName}`;

const userId = 'a1000000-0000-7000-8000-000000000001';
const iosDeviceId = 'a2000000-0000-7000-8000-000000000001';
const opsDeviceId = 'a2000000-0000-7000-8000-000000000002';
const webDeviceId = 'a2000000-0000-7000-8000-000000000003';
const iosSessionId = 'a3000000-0000-7000-8000-000000000001';
const opsSessionId = 'a3000000-0000-7000-8000-000000000002';
const webSessionId = 'a3000000-0000-7000-8000-000000000003';
const compatibleSessionId = 'a3000000-0000-7000-8000-000000000004';

let maintenance: Client | undefined;
let isolated: Client | undefined;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function applyMigration(client: Client, filename: string): Promise<void> {
  const sql = await readFile(join(migrationsDirectory, filename), 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  await client.query(sql);
  await client.query(
    'INSERT INTO public.schema_migrations(version, checksum) VALUES ($1, $2)',
    [filename, checksum],
  );
}

async function seedLegacySessions(client: Client): Promise<void> {
  await client.query(
    `INSERT INTO identity.users(id, public_handle)
     VALUES ($1, 'session_migration_user')`,
    [userId],
  );
  await client.query(
    `INSERT INTO identity.devices(id, user_id, platform)
     VALUES ($1, $4, 'ios'), ($2, $4, 'ops'), ($3, $4, 'web')`,
    [iosDeviceId, opsDeviceId, webDeviceId, userId],
  );
  await client.query(
    `INSERT INTO identity.sessions(
       id, user_id, device_id, refresh_hash, refresh_family_id, expires_at
     ) VALUES
       ($1, $7, $4, decode('01', 'hex'), 'a4000000-0000-7000-8000-000000000001', clock_timestamp() + interval '30 days'),
       ($2, $7, $5, decode('02', 'hex'), 'a4000000-0000-7000-8000-000000000002', clock_timestamp() + interval '30 days'),
       ($3, $7, $6, decode('03', 'hex'), 'a4000000-0000-7000-8000-000000000003', clock_timestamp() + interval '30 days')`,
    [iosSessionId, opsSessionId, webSessionId, iosDeviceId, opsDeviceId, webDeviceId, userId],
  );
}

async function insertPersistentProof(
  client: Client,
  id: string,
  hash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO identity.device_bindings(
       id, user_id, device_id, session_id, current_hash, current_kid,
       absolute_expires_at
     ) VALUES (
       $1, $2, $3, $4, decode($5, 'hex'), 'integration-kid',
       clock_timestamp() + interval '1 day'
     )`,
    [id, userId, iosDeviceId, iosSessionId, hash],
  );
}

async function insertTemporaryProof(
  client: Client,
  id: string,
  attemptHash: string,
  hash: string,
): Promise<void> {
  await client.query(
    `INSERT INTO identity.web_migration_intents(
       id, attempt_hash, temporary_binding_hash, mac_version, mac_kid,
       issued_at, expires_at
     ) VALUES (
       $1, decode($2, 'hex'), decode($3, 'hex'), 'v1', 'integration-kid',
       clock_timestamp(), clock_timestamp() + interval '5 minutes'
     )`,
    [id, attemptHash, hash],
  );
}

type ProofRaceOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown };

async function raceProofClasses(
  firstClass: 'persistent' | 'migration_temporary',
  suffix: '3' | '4',
  hash: string,
): Promise<ProofRaceOutcome> {
  const first = new Client({ connectionString: isolatedURL.toString() });
  const second = new Client({ connectionString: isolatedURL.toString() });
  await Promise.all([first.connect(), second.connect()]);
  const secondBackend = await second.query<{ pid: number }>(
    'SELECT pg_backend_pid() AS pid',
  );
  const secondPID = secondBackend.rows[0]?.pid;
  if (secondPID === undefined) throw new Error('Competing proof connection has no backend PID');
  await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
  try {
    if (firstClass === 'persistent') {
      await insertPersistentProof(first, `b2000000-0000-7000-8000-00000000000${suffix}`, hash);
    } else {
      await insertTemporaryProof(
        first,
        `b1000000-0000-7000-8000-00000000000${suffix}`,
        `100${suffix}`,
        hash,
      );
    }

    let competingSettled = false;
    const competingInsert = (
      firstClass === 'persistent'
        ? insertTemporaryProof(
            second,
            `b1000000-0000-7000-8000-00000000000${suffix}`,
            `100${suffix}`,
            hash,
          )
        : insertPersistentProof(
            second,
            `b2000000-0000-7000-8000-00000000000${suffix}`,
            hash,
          )
    ).then<ProofRaceOutcome, ProofRaceOutcome>(
      () => ({ status: 'fulfilled' }),
      (error: unknown) => ({ status: 'rejected', error }),
    ).finally(() => { competingSettled = true; });

    let observedLockWait = false;
    const lockWaitDeadline = Date.now() + 5_000;
    while (!competingSettled && Date.now() < lockWaitDeadline) {
      const activity = await first.query<{
        state: string;
        wait_event_type: string | null;
      }>(
        `SELECT state, wait_event_type
         FROM pg_stat_activity
         WHERE pid = $1`,
        [secondPID],
      );
      if (
        activity.rows[0]?.state === 'active'
        && activity.rows[0].wait_event_type === 'Lock'
      ) {
        observedLockWait = true;
        break;
      }
      await delay(10);
    }
    if (!competingSettled && !observedLockWait) {
      throw new Error('Competing proof insert never reached the database lock barrier');
    }
    await first.query('COMMIT');
    const outcome = await competingInsert;
    await second.query(outcome.status === 'fulfilled' ? 'COMMIT' : 'ROLLBACK');
    return outcome;
  } finally {
    await first.query('ROLLBACK').catch(() => undefined);
    await second.query('ROLLBACK').catch(() => undefined);
    await Promise.all([first.end(), second.end()]);
  }
}

describe('0021 Web session security migration on PostgreSQL', () => {
  beforeAll(async () => {
    maintenance = new Client({
      connectionString: maintenanceURL.toString(),
      application_name: 'spott-session-migration-test-maintenance',
    });
    await maintenance.connect();
    await maintenance.query(`CREATE DATABASE ${quoteIdentifier(databaseName)} TEMPLATE template0`);

    isolated = new Client({
      connectionString: isolatedURL.toString(),
      application_name: 'spott-session-migration-test',
    });
    await isolated.connect();

    const migrationFiles = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_.+\.sql$/.test(name) && name < '0021_')
      .toSorted();
    for (const filename of migrationFiles) await applyMigration(isolated, filename);
    await seedLegacySessions(isolated);
    await applyMigration(isolated, '0021_web_session_security.sql');
  }, 120_000);

  afterAll(async () => {
    await isolated?.end().catch(() => undefined);
    if (maintenance) {
      await maintenance.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [databaseName],
      ).catch(() => undefined);
      await maintenance.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`,
      ).catch(() => undefined);
      await maintenance.end();
    }
  }, 30_000);

  it('backfills old sessions, locks transport, and preserves old-format inserts', async () => {
    if (!isolated) throw new Error('Isolated migration database was not initialized');
    const rows = await isolated.query<{
      platform: string;
      transport_class: string;
      refresh_generation: string;
    }>(
      `SELECT device.platform, session.transport_class, session.refresh_generation
       FROM identity.sessions AS session
       JOIN identity.devices AS device ON device.id = session.device_id
       WHERE session.id = ANY($1::uuid[])
       ORDER BY CASE device.platform WHEN 'ios' THEN 1 WHEN 'ops' THEN 2 ELSE 3 END`,
      [[iosSessionId, opsSessionId, webSessionId]],
    );
    expect(rows.rows).toEqual([
      expect.objectContaining({ platform: 'ios', transport_class: 'native', refresh_generation: '0' }),
      expect.objectContaining({ platform: 'ops', transport_class: 'ops', refresh_generation: '0' }),
      expect.objectContaining({ platform: 'web', transport_class: 'legacy_unclassified', refresh_generation: '0' }),
    ]);

    const historyRows = await isolated.query(
      `SELECT session_id
       FROM identity.session_refresh_history
       WHERE session_id = ANY($1::uuid[])
       ORDER BY session_id`,
      [[iosSessionId, opsSessionId, webSessionId]],
    );
    expect(historyRows.rows).toHaveLength(3);

    await expect(isolated.query(
      `UPDATE identity.sessions
       SET transport_class = 'web_bff'
       WHERE id = $1 AND transport_class = 'native'`,
      [iosSessionId],
    )).rejects.toMatchObject({ code: 'P0001' });

    await isolated.query(
      `INSERT INTO identity.sessions(
         id, user_id, device_id, refresh_hash, refresh_family_id, expires_at
       ) VALUES (
         $1, $2, $3, decode('04', 'hex'),
         'a4000000-0000-7000-8000-000000000004',
         clock_timestamp() + interval '30 days'
       )`,
      [compatibleSessionId, userId, webDeviceId],
    );
    const compatible = await isolated.query<{
      refresh_generation: string;
      transport_class: string;
      state: string;
    }>(
      `SELECT session.refresh_generation, session.transport_class, history.state
       FROM identity.sessions AS session
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id
        AND history.generation = session.refresh_generation
       WHERE session.id = $1`,
      [compatibleSessionId],
    );
    expect(compatible.rows).toEqual([{
      refresh_generation: '0',
      transport_class: 'legacy_unclassified',
      state: 'current',
    }]);
  }, 30_000);

  it('keeps persistent and migration proof hashes disjoint under sequential and concurrent writes', async () => {
    if (!isolated) throw new Error('Isolated migration database was not initialized');

    await insertTemporaryProof(
      isolated,
      'b1000000-0000-7000-8000-000000000001',
      '1001',
      'aa01',
    );
    await expect(insertPersistentProof(
      isolated,
      'b2000000-0000-7000-8000-000000000001',
      'aa01',
    )).rejects.toMatchObject({ code: '23514' });

    await insertPersistentProof(
      isolated,
      'b2000000-0000-7000-8000-000000000002',
      'aa02',
    );
    await expect(insertTemporaryProof(
      isolated,
      'b1000000-0000-7000-8000-000000000002',
      '1002',
      'aa02',
    )).rejects.toMatchObject({ code: '23514' });

    const temporaryFirst = await raceProofClasses('migration_temporary', '3', 'aa03');
    expect(temporaryFirst).toMatchObject({ status: 'rejected', error: { code: '23514' } });
    const persistentFirst = await raceProofClasses('persistent', '4', 'aa04');
    expect(persistentFirst).toMatchObject({ status: 'rejected', error: { code: '23514' } });
  }, 30_000);
});
