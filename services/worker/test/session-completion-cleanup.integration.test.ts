import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { WorkerDatabase } from '../src/database.js';
import { WorkerJobs } from '../src/jobs.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
const exactPostgres = describe.runIf(databaseURL !== undefined);

type DispositionState = 'pending' | 'accepted' | 'discarded';

interface SeededCompletion {
  attemptHash: Buffer;
  challengeId: string;
  userId: string;
  deviceId: string;
  sessionId: string;
  bindingId: string;
}

exactPostgres('Web session completion cleanup on PostgreSQL', () => {
  let connectionString: string;
  let observer: Client;
  let blocker: Client;
  const seeded: SeededCompletion[] = [];

  beforeAll(async () => {
    if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');
    connectionString = databaseURL;
    observer = new Client({
      connectionString,
      application_name: 'spott-completion-cleanup-observer',
    });
    blocker = new Client({
      connectionString,
      application_name: 'spott-completion-cleanup-blocker',
    });
    await Promise.all([observer.connect(), blocker.connect()]);
  });

  afterEach(async () => {
    await blocker.query('ROLLBACK');
    const challengeIds = seeded.map((entry) => entry.challengeId);
    const sessionIds = seeded.map((entry) => entry.sessionId);
    const deviceIds = seeded.map((entry) => entry.deviceId);
    const userIds = seeded.map((entry) => entry.userId);
    seeded.splice(0);

    if (challengeIds.length > 0) {
      await observer.query(
        'DELETE FROM identity.web_session_completion_dispositions WHERE challenge_id = ANY($1::uuid[])',
        [challengeIds],
      );
      await observer.query(
        'DELETE FROM identity.web_session_completion_outcomes WHERE challenge_id = ANY($1::uuid[])',
        [challengeIds],
      );
      await observer.query(
        'DELETE FROM identity.email_challenges WHERE id = ANY($1::uuid[])',
        [challengeIds],
      );
    }
    if (sessionIds.length > 0) {
      await observer.query('DELETE FROM identity.sessions WHERE id = ANY($1::uuid[])', [sessionIds]);
    }
    if (deviceIds.length > 0) {
      await observer.query('DELETE FROM identity.devices WHERE id = ANY($1::uuid[])', [deviceIds]);
    }
    if (userIds.length > 0) {
      await observer.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]);
    }
  });

  afterAll(async () => {
    await Promise.all([observer?.end(), blocker?.end()]);
  });

  async function seedCompletion(input: {
    state: DispositionState;
    decision: 'open' | 'expired';
    retention: 'active' | 'expired';
    session: 'active' | 'expired';
  }): Promise<SeededCompletion> {
    const challengeId = randomUUID();
    const userId = randomUUID();
    const deviceId = randomUUID();
    const sessionId = randomUUID();
    const bindingId = randomUUID();
    const familyId = randomUUID();
    const attemptHash = randomBytes(32);
    const now = Date.now();
    const minute = 60_000;
    const day = 24 * 60 * minute;
    const createdAt = new Date(input.retention === 'expired'
      ? now - 30 * day - 10 * minute
      : now - 10 * minute);
    const decisionExpiresAt = new Date(input.decision === 'open'
      ? now + 5 * minute
      : input.retention === 'expired'
        ? now - 30 * day - 5 * minute
        : now - minute);
    const retainedUntil = new Date(input.retention === 'expired'
      ? now - minute
      : decisionExpiresAt.getTime() + 30 * day);
    const completedAt = new Date(createdAt.getTime() + minute);
    const sessionExpiresAt = new Date(input.session === 'active'
      ? now + 30 * day
      : now - minute);

    await observer.query(
      `INSERT INTO identity.users(id, public_handle)
       VALUES ($1, $2)`,
      [userId, `cleanup_${userId.replaceAll('-', '').slice(0, 16)}`],
    );
    await observer.query(
      `INSERT INTO identity.devices(id, user_id, platform)
       VALUES ($1, $2, 'web')`,
      [deviceId, userId],
    );
    await observer.query(
      `INSERT INTO identity.sessions(
         id, user_id, device_id, refresh_hash, refresh_family_id,
         current_derivation_kid, expires_at, transport_class
       ) VALUES ($1, $2, $3, $4, $5, 'cleanup-test', $6, 'web_bff')`,
      [sessionId, userId, deviceId, randomBytes(32), familyId, sessionExpiresAt],
    );
    await observer.query(
      `INSERT INTO identity.device_bindings(
         id, user_id, device_id, session_id, current_hash, current_kid,
         absolute_expires_at
       ) VALUES ($1, $2, $3, $4, $5, 'cleanup-test', $6)`,
      [bindingId, userId, deviceId, sessionId, randomBytes(32), sessionExpiresAt],
    );
    await observer.query(
      `UPDATE identity.sessions
       SET current_binding_id = $2, current_binding_generation = 0
       WHERE id = $1`,
      [sessionId, bindingId],
    );
    await observer.query(
      `UPDATE identity.session_refresh_history
       SET binding_id = $2, binding_generation = 0
       WHERE session_id = $1 AND generation = 0`,
      [sessionId, bindingId],
    );
    await observer.query(
      `INSERT INTO identity.email_challenges(
         id, email_hash, email_cipher, code_hash, device_id,
         expires_at, verified_at, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        challengeId,
        randomBytes(32),
        randomBytes(32),
        randomBytes(32),
        deviceId,
        new Date(createdAt.getTime() + 10 * minute),
        completedAt,
        createdAt,
      ],
    );
    await observer.query(
      `INSERT INTO identity.web_session_completion_outcomes(
         challenge_id, attempt_hash, request_digest, user_id, device_id,
         session_id, family_id, binding_id, refresh_generation,
         binding_generation, derivation_version, derivation_kid,
         created_at, recovery_expires_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 'v1', 'cleanup-test',
         $9, $10
       )`,
      [
        challengeId,
        attemptHash,
        randomBytes(32),
        userId,
        deviceId,
        sessionId,
        familyId,
        bindingId,
        completedAt,
        new Date(completedAt.getTime() + 5 * minute),
      ],
    );
    await observer.query(
      `INSERT INTO identity.web_session_completion_dispositions(
         attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         authority_digest, authority_version, authority_kid, state, session_id,
         created_at, completed_at, decision_expires_at, retained_until,
         accepted_at, discarded_at
       ) VALUES (
         $1, $2, $3, $4, 0, $5, 'v1', 'cleanup-test', $6::text, $7::uuid,
         $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::timestamptz,
         CASE WHEN $6::text = 'accepted' THEN $9::timestamptz ELSE NULL END,
         CASE WHEN $6::text = 'discarded' THEN $9::timestamptz ELSE NULL END
       )`,
      [
        attemptHash,
        challengeId,
        deviceId,
        bindingId,
        randomBytes(32),
        input.state,
        sessionId,
        createdAt,
        completedAt,
        decisionExpiresAt,
        retainedUntil,
      ],
    );
    const entry = { attemptHash, challengeId, userId, deviceId, sessionId, bindingId };
    seeded.push(entry);
    return entry;
  }

  function jobs(batchSize = 1): { database: WorkerDatabase; jobs: WorkerJobs } {
    const database = new WorkerDatabase(connectionString);
    return {
      database,
      jobs: new WorkerJobs(database, parseConfig({
        NODE_ENV: 'test',
        DATABASE_URL: connectionString,
        WORKER_BATCH_SIZE: String(batchSize),
      })),
    };
  }

  it('turns an expired pending disposition into discarded and revokes only its exact authority', async () => {
    const fixture = await seedCompletion({
      state: 'pending',
      decision: 'expired',
      retention: 'active',
      session: 'active',
    });
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 1,
        metadata: {
          pendingDiscarded: 1,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });
    } finally {
      await runtime.database.close();
    }

    const disposition = await observer.query<{ state: string; discarded: boolean }>(
      `SELECT state, discarded_at IS NOT NULL AS discarded
       FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1`,
      [fixture.attemptHash],
    );
    expect(disposition.rows).toEqual([{ state: 'discarded', discarded: true }]);
    const authority = await observer.query<{
      session_revoked: boolean;
      binding_revoked: boolean;
      history_state: string;
      consumed_reason: string | null;
    }>(
      `SELECT session.revoked_at IS NOT NULL AS session_revoked,
              binding.revoked_at IS NOT NULL AS binding_revoked,
              history.state AS history_state,
              history.consumed_reason
       FROM identity.sessions AS session
       JOIN identity.device_bindings AS binding
         ON binding.id = $2 AND binding.session_id = session.id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = 0
       WHERE session.id = $1`,
      [fixture.sessionId, fixture.bindingId],
    );
    expect(authority.rows).toEqual([{
      session_revoked: true,
      binding_revoked: true,
      history_state: 'revoked',
      consumed_reason: 'completion_discarded',
    }]);
    const retained = await observer.query<{ outcomes: string; challenges: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_outcomes
          WHERE challenge_id = $1) AS outcomes,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $1) AS challenges`,
      [fixture.challengeId],
    );
    expect(retained.rows).toEqual([{ outcomes: '1', challenges: '1' }]);
  });

  it('preserves an accepted outcome and challenge after recovery expiry but before retained_until', async () => {
    const fixture = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'active',
      session: 'active',
    });
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 0,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });
    } finally {
      await runtime.database.close();
    }

    const retained = await observer.query<{ disposition: string; outcome: string; challenge: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_dispositions
          WHERE attempt_hash = $1) AS disposition,
         (SELECT count(*)::text FROM identity.web_session_completion_outcomes
          WHERE attempt_hash = $1) AS outcome,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $2) AS challenge`,
      [fixture.attemptHash, fixture.challengeId],
    );
    expect(retained.rows).toEqual([{ disposition: '1', outcome: '1', challenge: '1' }]);
  });

  it('keeps an accepted durable marker past retention while its associated session is still active', async () => {
    const fixture = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'expired',
      session: 'active',
    });
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 0,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });
    } finally {
      await runtime.database.close();
    }

    const retained = await observer.query<{ disposition: string; outcome: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_dispositions
          WHERE attempt_hash = $1) AS disposition,
         (SELECT count(*)::text FROM identity.web_session_completion_outcomes
          WHERE attempt_hash = $1) AS outcome`,
      [fixture.attemptHash],
    );
    expect(retained.rows).toEqual([{ disposition: '1', outcome: '1' }]);
  });

  it('never deletes an outcome whose disposition marker is missing', async () => {
    const fixture = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'expired',
      session: 'expired',
    });
    await observer.query(
      'DELETE FROM identity.web_session_completion_dispositions WHERE attempt_hash = $1',
      [fixture.attemptHash],
    );
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 0,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });
    } finally {
      await runtime.database.close();
    }

    const retained = await observer.query<{ outcome: string; challenge: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_outcomes
          WHERE attempt_hash = $1) AS outcome,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $2) AS challenge`,
      [fixture.attemptHash, fixture.challengeId],
    );
    expect(retained.rows).toEqual([{ outcome: '1', challenge: '1' }]);
  });

  it('purges an accepted terminal record atomically after retention without revoking its session', async () => {
    const fixture = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'expired',
      session: 'expired',
    });
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 1,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 1,
          outcomes: 1,
          challenges: 1,
        },
      });
    } finally {
      await runtime.database.close();
    }

    const links = await observer.query<{ disposition: string; outcome: string; challenge: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_dispositions
          WHERE attempt_hash = $1) AS disposition,
         (SELECT count(*)::text FROM identity.web_session_completion_outcomes
          WHERE attempt_hash = $1) AS outcome,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $2) AS challenge`,
      [fixture.attemptHash, fixture.challengeId],
    );
    expect(links.rows).toEqual([{ disposition: '0', outcome: '0', challenge: '0' }]);
    const authority = await observer.query<{ session_revoked: boolean; binding_revoked: boolean; state: string }>(
      `SELECT session.revoked_at IS NOT NULL AS session_revoked,
              binding.revoked_at IS NOT NULL AS binding_revoked,
              history.state
       FROM identity.sessions AS session
       JOIN identity.device_bindings AS binding
         ON binding.id = $2 AND binding.session_id = session.id
       JOIN identity.session_refresh_history AS history
         ON history.session_id = session.id AND history.generation = 0
       WHERE session.id = $1`,
      [fixture.sessionId, fixture.bindingId],
    );
    expect(authority.rows).toEqual([{
      session_revoked: false,
      binding_revoked: false,
      state: 'current',
    }]);
  });

  it('keeps a shared challenge when another retained sessionless disposition still owns it', async () => {
    const fixture = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'expired',
      session: 'expired',
    });
    const siblingAttemptHash = randomBytes(32);
    await observer.query(
      `INSERT INTO identity.web_session_completion_dispositions(
         attempt_hash, challenge_id, device_id, binding_id, binding_generation,
         authority_digest, authority_version, authority_kid, state, session_id,
         created_at, completed_at, decision_expires_at, retained_until,
         accepted_at, discarded_at
       ) VALUES (
         $1, $2, $3, $4, 0, $5, 'v1', 'cleanup-test', 'discarded', NULL,
         clock_timestamp() - interval '1 minute', NULL, clock_timestamp(),
         clock_timestamp() + interval '30 days', NULL, clock_timestamp()
       )`,
      [
        siblingAttemptHash,
        fixture.challengeId,
        fixture.deviceId,
        randomUUID(),
        randomBytes(32),
      ],
    );
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 1,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 1,
          outcomes: 1,
          challenges: 0,
        },
      });
    } finally {
      await runtime.database.close();
    }

    const retained = await observer.query<{ dispositions: string; outcomes: string; challenges: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_dispositions
          WHERE challenge_id = $1) AS dispositions,
         (SELECT count(*)::text FROM identity.web_session_completion_outcomes
          WHERE challenge_id = $1) AS outcomes,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $1) AS challenges`,
      [fixture.challengeId],
    );
    expect(retained.rows).toEqual([{ dispositions: '1', outcomes: '0', challenges: '1' }]);
  });

  it('skips a locked disposition candidate and still cleans the oldest standalone challenge', async () => {
    const locked = await seedCompletion({
      state: 'pending',
      decision: 'expired',
      retention: 'active',
      session: 'active',
    });
    const standalone = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'active',
      session: 'active',
    });
    await observer.query(
      'DELETE FROM identity.web_session_completion_dispositions WHERE attempt_hash = $1',
      [standalone.attemptHash],
    );
    await observer.query(
      'DELETE FROM identity.web_session_completion_outcomes WHERE attempt_hash = $1',
      [standalone.attemptHash],
    );
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT attempt_hash
       FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = $1
       FOR UPDATE`,
      [locked.attemptHash],
    );
    const runtime = jobs();

    try {
      await expect(runtime.jobs.cleanupWebSessionCompletionRecords()).resolves.toEqual({
        processed: 1,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 1,
        },
      });
    } finally {
      await runtime.database.close();
      await blocker.query('ROLLBACK');
    }

    const remaining = await observer.query<{ locked_disposition: string; standalone_challenge: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_dispositions
          WHERE attempt_hash = $1) AS locked_disposition,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $2) AS standalone_challenge`,
      [locked.attemptHash, standalone.challengeId],
    );
    expect(remaining.rows).toEqual([{ locked_disposition: '1', standalone_challenge: '0' }]);
  });

  it('keeps the challenge when a sessionless discard commits after standalone claim', async () => {
    const fixture = await seedCompletion({
      state: 'accepted',
      decision: 'expired',
      retention: 'active',
      session: 'active',
    });
    await observer.query(
      'DELETE FROM identity.web_session_completion_dispositions WHERE attempt_hash = $1',
      [fixture.attemptHash],
    );
    await observer.query(
      'DELETE FROM identity.web_session_completion_outcomes WHERE attempt_hash = $1',
      [fixture.attemptHash],
    );

    const workerDatabase = new WorkerDatabase(connectionString);
    let claimedResolve: (() => void) | undefined;
    const claimed = new Promise<void>((resolve) => { claimedResolve = resolve; });
    let continueResolve: (() => void) | undefined;
    const canContinue = new Promise<void>((resolve) => { continueResolve = resolve; });
    const hookedDatabase = {
      transaction: async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
        const client = await workerDatabase.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query("SET LOCAL TIME ZONE 'UTC'");
          const hookedClient = new Proxy(client, {
            get(target, property) {
              if (property !== 'query') {
                const value = Reflect.get(target, property, target) as unknown;
                return typeof value === 'function' ? value.bind(target) : value;
              }
              return async (text: string, values: readonly unknown[] = []) => {
                const queryResult = await target.query(text, [...values]);
                if (
                  text.trimStart().startsWith('SELECT challenge.id')
                  && text.includes('challenge.verified_at IS NOT NULL')
                  && text.includes('FOR UPDATE SKIP LOCKED')
                  && queryResult.rows.some((row: { id?: string }) => row.id === fixture.challengeId)
                ) {
                  claimedResolve?.();
                  claimedResolve = undefined;
                  await canContinue;
                }
                return queryResult;
              };
            },
          }) as PoolClient;
          const value = await work(hookedClient);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
    const cleanup = new WorkerJobs(hookedDatabase as never, parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      WORKER_BATCH_SIZE: '1',
    })).cleanupWebSessionCompletionRecords();

    try {
      await Promise.race([
        claimed,
        cleanup.then(() => { throw new Error('Worker finished before claiming the challenge'); }),
        delay(2_000).then(() => { throw new Error('Worker did not claim the challenge'); }),
      ]);
      await observer.query(
        `INSERT INTO identity.web_session_completion_dispositions(
           attempt_hash, challenge_id, device_id, binding_id, binding_generation,
           authority_digest, authority_version, authority_kid, state, session_id,
           created_at, completed_at, decision_expires_at, retained_until,
           accepted_at, discarded_at
         ) VALUES (
           $1, $2, $3, $4, 0, $5, 'v1', 'cleanup-test', 'discarded', NULL,
           clock_timestamp() - interval '1 minute', NULL, clock_timestamp(),
           clock_timestamp() + interval '30 days', NULL, clock_timestamp()
         )`,
        [randomBytes(32), fixture.challengeId, fixture.deviceId, randomUUID(), randomBytes(32)],
      );
    } finally {
      continueResolve?.();
      continueResolve = undefined;
    }

    try {
      await expect(cleanup).resolves.toEqual({
        processed: 0,
        metadata: {
          pendingDiscarded: 0,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });
    } finally {
      await workerDatabase.close();
    }
    const retained = await observer.query<{ dispositions: string; challenges: string }>(
      `SELECT
         (SELECT count(*)::text FROM identity.web_session_completion_dispositions
          WHERE challenge_id = $1) AS dispositions,
         (SELECT count(*)::text FROM identity.email_challenges
          WHERE id = $1) AS challenges`,
      [fixture.challengeId],
    );
    expect(retained.rows).toEqual([{ dispositions: '1', challenges: '1' }]);
  });

  it('holds the disposition lock until exact revocation commits so a late accept cannot win', async () => {
    const fixture = await seedCompletion({
      state: 'pending',
      decision: 'expired',
      retention: 'active',
      session: 'active',
    });
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM identity.sessions WHERE id = $1 FOR UPDATE', [fixture.sessionId]);
    const runtime = jobs();
    const cleanup = runtime.jobs.cleanupWebSessionCompletionRecords();

    try {
      let workerIsWaiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const activity = await observer.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
             WHERE application_name = 'spott-worker'
               AND wait_event_type = 'Lock'
           ) AS waiting`,
        );
        if (activity.rows[0]?.waiting === true) {
          workerIsWaiting = true;
          break;
        }
        await delay(10);
      }
      expect(workerIsWaiting).toBe(true);

      await observer.query('BEGIN');
      await observer.query("SET LOCAL statement_timeout = '200ms'");
      await expect(observer.query(
        `UPDATE identity.web_session_completion_dispositions
         SET state = 'accepted', accepted_at = clock_timestamp()
         WHERE attempt_hash = $1 AND state = 'pending'`,
        [fixture.attemptHash],
      )).rejects.toMatchObject({ code: '57014' });
      await observer.query('ROLLBACK');

      await blocker.query('ROLLBACK');
      await expect(cleanup).resolves.toEqual({
        processed: 1,
        metadata: {
          pendingDiscarded: 1,
          terminalPurged: 0,
          outcomes: 0,
          challenges: 0,
        },
      });

      const lateAccept = await observer.query(
        `UPDATE identity.web_session_completion_dispositions
         SET state = 'accepted', accepted_at = clock_timestamp()
         WHERE attempt_hash = $1 AND state = 'pending'
           AND decision_expires_at > clock_timestamp()`,
        [fixture.attemptHash],
      );
      expect(lateAccept.rowCount).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      await runtime.database.close();
    }
  });
});
