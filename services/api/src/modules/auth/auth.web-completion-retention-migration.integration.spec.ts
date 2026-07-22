import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const root = resolve(import.meta.dirname, '../../../../..');
const migrationPath = resolve(
  root,
  'database/migrations/0032_web_session_completion_revoke_retention.sql',
);
const seededAttempts: Buffer[] = [];
let observer: Client;

async function seedRetainedDisposition(input: {
  authorityVersion: 'v1' | 'legacy-v0';
  retentionDays: 30 | 31;
}): Promise<Buffer> {
  const attemptHash = randomBytes(32);
  seededAttempts.push(attemptHash);
  await observer.query(
    `WITH repair_clock AS (
       SELECT clock_timestamp() AS recorded_at
     )
     INSERT INTO identity.web_session_completion_dispositions(
       attempt_hash, challenge_id, device_id, binding_id, binding_generation,
       authority_digest, authority_version, authority_kid, state, session_id,
       created_at, completed_at, decision_expires_at, retained_until,
       accepted_at, discarded_at
     )
     SELECT $1, $2, $3, $4, 0, $5, $6::text, 'retention-repair-test',
       'accepted', $7, recorded_at, recorded_at,
       recorded_at + interval '1 minute',
       recorded_at + interval '1 minute' + make_interval(days => $8::integer),
       recorded_at, NULL
     FROM repair_clock`,
    [
      attemptHash,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomBytes(32),
      input.authorityVersion,
      randomUUID(),
      input.retentionDays,
    ],
  );
  return attemptHash;
}

describe('0032 Web completion revoke retention migration on PostgreSQL', () => {
  beforeAll(async () => {
    observer = new Client({
      connectionString: databaseURL,
      application_name: 'spott-web-completion-retention-migration-test',
    });
    await observer.connect();
  });

  afterAll(async () => {
    if (observer) {
      if (seededAttempts.length > 0) {
        await observer.query(
          `DELETE FROM identity.web_session_completion_dispositions
           WHERE attempt_hash = ANY($1::bytea[])`,
          [seededAttempts],
        );
      }
      await observer.end();
    }
  });

  it('replays deterministically, backfills exact 30-day rows, and restores immutability', async () => {
    const exists = existsSync(migrationPath);
    expect(exists).toBe(true);
    if (!exists) return;

    const thirtyDayV1 = await seedRetainedDisposition({
      authorityVersion: 'v1',
      retentionDays: 30,
    });
    const thirtyOneDayV1 = await seedRetainedDisposition({
      authorityVersion: 'v1',
      retentionDays: 31,
    });
    const thirtyDayLegacy = await seedRetainedDisposition({
      authorityVersion: 'legacy-v0',
      retentionDays: 30,
    });
    const migration = await readFile(migrationPath, 'utf8');

    await observer.query(migration);
    await observer.query(migration);

    const rows = await observer.query<{ attempt_hash: Buffer; retained_seconds: string }>(
      `SELECT attempt_hash,
         EXTRACT(EPOCH FROM (retained_until - decision_expires_at))::bigint::text
           AS retained_seconds
       FROM identity.web_session_completion_dispositions
       WHERE attempt_hash = ANY($1::bytea[])
       ORDER BY attempt_hash`,
      [[thirtyDayV1, thirtyOneDayV1, thirtyDayLegacy]],
    );
    expect(rows.rows).toHaveLength(3);
    const retainedSeconds = new Map(rows.rows.map(({ attempt_hash, retained_seconds }) => (
      [attempt_hash.toString('hex'), retained_seconds]
    )));
    expect(retainedSeconds.get(thirtyDayV1.toString('hex'))).toBe('2678400');
    expect(retainedSeconds.get(thirtyOneDayV1.toString('hex'))).toBe('2678400');
    expect(retainedSeconds.get(thirtyDayLegacy.toString('hex'))).toBe('2592000');

    await expect(observer.query(
      `UPDATE identity.web_session_completion_dispositions
       SET retained_until = retained_until + interval '1 second'
       WHERE attempt_hash = $1`,
      [thirtyDayV1],
    )).rejects.toMatchObject({ code: '55000' });
  });
});
