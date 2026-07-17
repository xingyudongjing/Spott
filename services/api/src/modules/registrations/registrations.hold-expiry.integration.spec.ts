import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { PointsService } from '../points/points.service.js';
import { RegistrationsService } from './registrations.service.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const registrationFee = 500n;
const grantedPoints = 5000n;

interface WorkerJobsModule {
  WorkerJobs: new (database: unknown, config: unknown) => {
    expireHoldsAndQuotes: () => Promise<{ processed: number; metadata?: Record<string, unknown> }>;
  };
}

interface WorkerConfigModule {
  parseConfig: (environment: Record<string, string | undefined>) => unknown;
}

interface Fixture {
  hostId: string;
  applicantId: string;
  waitlistedId: string;
  eventId: string;
  pendingRegistrationId: string;
  waitlistedRegistrationId: string;
}

async function loadModule<Module>(url: string): Promise<Module> {
  const loaded: unknown = await import(/* @vite-ignore */ url);
  return loaded as Module;
}

function databaseFor(pool: Pool) {
  return {
    async query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
      return pool.query<Row>(text, [...values]);
    },
    async transaction<Value>(work: (client: PoolClient) => Promise<Value>): Promise<Value> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        await client.query("SET LOCAL deadlock_timeout = '100ms'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

type TestDatabase = ReturnType<typeof databaseFor>;

/**
 * Seeds an approval mode event whose only free seats are taken by a `pending`
 * registration: two seats occupied through `pending_count`, backed by a 15
 * minute point hold, with one more user waiting behind it.
 *
 * Every fixture uses fresh identifiers because `commerce.point_entries` is
 * append-only, so ledger rows from earlier runs can never be deleted.
 */
async function seed(pool: Pool, points: PointsService, database: TestDatabase): Promise<Fixture> {
  const fixture: Fixture = {
    hostId: randomUUID(),
    applicantId: randomUUID(),
    waitlistedId: randomUUID(),
    eventId: randomUUID(),
    pendingRegistrationId: randomUUID(),
    waitlistedRegistrationId: randomUUID(),
  };
  const suffix = fixture.eventId.slice(0, 8);
  await pool.query(
    `INSERT INTO identity.users(id,public_handle,phone_verified_at) VALUES
       ($1,'hold_host_' || $4,clock_timestamp()),
       ($2,'hold_applicant_' || $4,clock_timestamp()),
       ($3,'hold_waiting_' || $4,clock_timestamp())`,
    [fixture.hostId, fixture.applicantId, fixture.waitlistedId, suffix],
  );
  await pool.query(
    'INSERT INTO commerce.wallets(user_id) VALUES ($1),($2),($3)',
    [fixture.hostId, fixture.applicantId, fixture.waitlistedId],
  );
  // Fund the applicant through the real ledger so wallet and entries agree.
  await database.transaction(async (client) => {
    await points.credit(
      client,
      fixture.applicantId,
      grantedPoints,
      'free',
      'grant',
      `hold_expiry_grant:${fixture.applicantId}`,
    );
  });
  await pool.query(
    `INSERT INTO events.events(
       id,public_slug,organizer_id,status,title,description,category_id,
       starts_at,ends_at,capacity,registration_mode,waitlist_enabled
     ) VALUES (
       $1,'hold-expiry-' || $3,$2,'published','Hold expiry event',
       'An approval mode fixture for the pending hold expiry contract','walk',
       clock_timestamp()+interval '30 days',clock_timestamp()+interval '30 days 2 hours',
       2,'approval',true
     )`,
    [fixture.eventId, fixture.hostId, suffix],
  );
  // Capacity 2 is fully occupied by the single pending party of 2.
  await pool.query(
    'INSERT INTO events.event_capacity(event_id,pending_count,waitlist_count) VALUES ($1,2,1)',
    [fixture.eventId],
  );
  await pool.query(
    `INSERT INTO events.registrations(id,event_id,user_id,status,party_size,waitlist_joined_at) VALUES
       ($1,$3,$4,'pending',2,NULL),
       ($2,$3,$5,'waitlisted',1,clock_timestamp()-interval '1 hour')`,
    [
      fixture.pendingRegistrationId,
      fixture.waitlistedRegistrationId,
      fixture.eventId,
      fixture.applicantId,
      fixture.waitlistedId,
    ],
  );
  await database.transaction(async (client) => {
    await points.createHold(
      client,
      fixture.applicantId,
      registrationFee,
      `registration_hold:${fixture.pendingRegistrationId}`,
      '15 minutes',
    );
  });
  return fixture;
}

/**
 * Drops the event side of a fixture. The worker sweeps scan every event in the
 * database, so leaving a released seat or a waiting registration behind would
 * let this fixture steer another spec's job run. The append-only ledger and the
 * users that own it stay: their identifiers are unique per fixture and inert.
 */
async function dropEventFixture(pool: Pool, fixture: Fixture): Promise<void> {
  const registrationIds = [fixture.pendingRegistrationId, fixture.waitlistedRegistrationId];
  await pool.query('DELETE FROM admin.audit_logs WHERE resource_id=ANY($1::text[])', [registrationIds]);
  await pool.query('DELETE FROM sync.change_log WHERE entity_id=ANY($1::uuid[])', [registrationIds]);
  await pool.query('DELETE FROM sync.outbox_events WHERE aggregate_id=$1', [fixture.eventId]);
  await pool.query('DELETE FROM events.waitlist_promotions WHERE registration_id=ANY($1::uuid[])', [registrationIds]);
  await pool.query('DELETE FROM events.registrations WHERE id=ANY($1::uuid[])', [registrationIds]);
  await pool.query('DELETE FROM events.event_capacity WHERE event_id=$1', [fixture.eventId]);
  await pool.query('DELETE FROM events.events WHERE id=$1', [fixture.eventId]);
}

describe('pending registration hold expiry releases the seat', () => {
  let pool: Pool;
  let database: TestDatabase;
  let points: PointsService;
  let service: RegistrationsService;
  let worker: { expireHoldsAndQuotes: () => Promise<{ processed: number; metadata?: Record<string, unknown> }> };
  let fixture: Fixture;

  function host() {
    return {
      id: fixture.hostId,
      sessionId: 'hold-expiry-session',
      phoneVerified: true,
      restrictions: [],
      roles: ['verified'],
    };
  }

  async function capacityRow() {
    const result = await pool.query<{ pending_count: number; confirmed_count: number; offered_count: number }>(
      'SELECT pending_count,confirmed_count,offered_count FROM events.event_capacity WHERE event_id=$1',
      [fixture.eventId],
    );
    return result.rows[0];
  }

  async function registrationStatus(id: string): Promise<string | undefined> {
    const result = await pool.query<{ status: string }>(
      'SELECT status::text FROM events.registrations WHERE id=$1',
      [id],
    );
    return result.rows[0]?.status;
  }

  async function expireTheHold(): Promise<void> {
    await pool.query(
      `UPDATE commerce.point_holds SET expires_at = clock_timestamp() - interval '1 minute'
       WHERE business_key = $1`,
      [`registration_hold:${fixture.pendingRegistrationId}`],
    );
  }

  async function promotionRequests(): Promise<number> {
    const result = await pool.query(
      "SELECT event_id FROM sync.outbox_events WHERE aggregate_id=$1 AND type='waitlist.promotion_requested'",
      [fixture.eventId],
    );
    return result.rows.length;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseURL, max: 8 });
    database = databaseFor(pool);
    points = new PointsService(database as never);
    const idempotency = {
      requestHash: () => Buffer.alloc(32),
      claim: async () => null,
      complete: async () => undefined,
    };
    service = new RegistrationsService(database as never, idempotency as never, points);
    const [{ WorkerJobs }, { parseConfig }] = await Promise.all([
      loadModule<WorkerJobsModule>(new URL('../../../../worker/src/jobs.ts', import.meta.url).href),
      loadModule<WorkerConfigModule>(new URL('../../../../worker/src/config.ts', import.meta.url).href),
    ]);
    worker = new WorkerJobs(database, parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseURL,
      WORKER_BATCH_SIZE: '10',
    }));
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    fixture = await seed(pool, points, database);
  });

  afterEach(async () => {
    await dropEventFixture(pool, fixture).catch(() => undefined);
  });

  it('keeps the seat occupied while the hold is still active', async () => {
    await expect(capacityRow()).resolves.toEqual({
      pending_count: 2,
      confirmed_count: 0,
      offered_count: 0,
    });
    // Nothing is due yet, so the sweep must not touch the pending registration.
    await worker.expireHoldsAndQuotes();
    expect(await registrationStatus(fixture.pendingRegistrationId)).toBe('pending');
    await expect(capacityRow()).resolves.toMatchObject({ pending_count: 2 });
    expect(await promotionRequests()).toBe(0);
  });

  it('releases pending_count and settles the registration when the hold expires', async () => {
    await expireTheHold();

    const outcome = await worker.expireHoldsAndQuotes();
    expect(outcome.processed).toBeGreaterThanOrEqual(1);

    // (a) the seat must come back to the event.
    await expect(capacityRow()).resolves.toEqual({
      pending_count: 0,
      confirmed_count: 0,
      offered_count: 0,
    });
    // The registration must reach a terminal state, never linger as `pending`.
    expect(await registrationStatus(fixture.pendingRegistrationId)).toBe('cancelled');
    const hold = await pool.query<{ state: string }>(
      'SELECT state::text FROM commerce.point_holds WHERE business_key=$1',
      [`registration_hold:${fixture.pendingRegistrationId}`],
    );
    expect(hold.rows[0]?.state).toBe('expired');
  });

  it('asks the waitlist to advance once the expired seat is free', async () => {
    await expireTheHold();
    await worker.expireHoldsAndQuotes();
    expect(await promotionRequests()).toBe(1);
  });

  it('never double releases the seat when several workers sweep concurrently', async () => {
    await expireTheHold();
    // Race four sweeps; only one may move the registration and the counter.
    const settled = await Promise.allSettled([
      worker.expireHoldsAndQuotes(),
      worker.expireHoldsAndQuotes(),
      worker.expireHoldsAndQuotes(),
      worker.expireHoldsAndQuotes(),
    ]);
    expect(settled.map((entry) => entry.status)).toEqual([
      'fulfilled', 'fulfilled', 'fulfilled', 'fulfilled',
    ]);
    await expect(capacityRow()).resolves.toEqual({
      pending_count: 0,
      confirmed_count: 0,
      offered_count: 0,
    });
    expect(await promotionRequests()).toBe(1);
  });

  it('rejects the host decision with a state error instead of a point hold 409', async () => {
    await expireTheHold();
    await worker.expireHoldsAndQuotes();

    // (b) the host must not be trapped behind POINT_HOLD_EXPIRED / 409.
    await expect(
      service.decide(host() as never, fixture.pendingRegistrationId, randomUUID(), { decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION', status: 422 });
  });

  it('refuses to capture a clock expired hold before the sweep has run', async () => {
    await expireTheHold();
    // The sweep has not run yet, so the hold row still reads `active`, but its
    // points are already available to spend elsewhere: capture must refuse.
    await expect(
      service.decide(host() as never, fixture.pendingRegistrationId, randomUUID(), { decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'POINT_HOLD_EXPIRED', status: 409 });
    expect(await registrationStatus(fixture.pendingRegistrationId)).toBe('pending');
  });

  it('still lets the host reject a lapsed pending registration', async () => {
    await expireTheHold();
    await service.decide(host(), fixture.pendingRegistrationId, randomUUID(), { decision: 'reject' });
    expect(await registrationStatus(fixture.pendingRegistrationId)).toBe('rejected');
    await expect(capacityRow()).resolves.toMatchObject({ pending_count: 0 });
  });

  it('leaves the applicant points untouched because an expired hold was never charged', async () => {
    const before = await points.wallet(fixture.applicantId);
    await expireTheHold();
    await worker.expireHoldsAndQuotes();

    const after = await points.wallet(fixture.applicantId);
    expect(after.totalBalance).toBe(before.totalBalance);
    expect(after.totalBalance).toBe(Number(grantedPoints));
    // No registration_fee transaction may exist: the hold reserved points, it
    // never spent them, so there is nothing to refund.
    const charges = await pool.query(
      'SELECT id FROM commerce.point_transactions WHERE user_id=$1 AND business_key=$2',
      [fixture.applicantId, `registration_fee:${fixture.pendingRegistrationId}`],
    );
    expect(charges.rows).toHaveLength(0);
  });

  it('lets the applicant hold points again after the lapsed seat is released', async () => {
    await expireTheHold();
    await worker.expireHoldsAndQuotes();
    // The expired hold must stop reserving the applicant's balance, otherwise a
    // re-registration would fail with POINTS_INSUFFICIENT.
    const held = await database.transaction(async (client) => points.createHold(
      client,
      fixture.applicantId,
      grantedPoints,
      `registration_hold:${randomUUID()}`,
      '15 minutes',
    ));
    expect(held).toBeTruthy();
  });
});
