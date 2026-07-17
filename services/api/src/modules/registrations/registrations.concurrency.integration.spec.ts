import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { RegistrationsService } from './registrations.service.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

const hostId = '91000000-0000-7000-8000-000000000001';
const offeredUserId = '91000000-0000-7000-8000-000000000002';
const waitlistedUserId = '91000000-0000-7000-8000-000000000003';
const eventId = '92000000-0000-7000-8000-000000000001';
const offeredRegistrationId = '93000000-0000-7000-8000-000000000001';
const waitlistedRegistrationId = '93000000-0000-7000-8000-000000000002';
const promotionId = '94000000-0000-7000-8000-000000000001';
const userIds = [hostId, offeredUserId, waitlistedUserId];
const registrationIds = [offeredRegistrationId, waitlistedRegistrationId];

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

interface WorkerJobsModule {
  WorkerJobs: new (database: unknown, config: unknown) => {
    expireAndPromoteWaitlist: () => Promise<unknown>;
  };
}

interface WorkerConfigModule {
  parseConfig: (environment: Record<string, string | undefined>) => unknown;
}

type QueryHook = <Row extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: readonly unknown[],
) => Promise<QueryResult<Row>>;

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => { resolve = fulfill; });
  return { promise, resolve };
}

async function loadModule<Module>(url: string): Promise<Module> {
  const loaded: unknown = await import(/* @vite-ignore */ url);
  return loaded as Module;
}

function databaseWithHook(pool: Pool, hook: QueryHook) {
  return {
    async transaction<Value>(work: (client: PoolClient) => Promise<Value>): Promise<Value> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        await client.query("SET LOCAL deadlock_timeout = '100ms'");
        await client.query("SET LOCAL lock_timeout = '2s'");
        const hookedClient = {
          query: <Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) => (
            hook<Row>(client, text, values)
          ),
        } as PoolClient;
        const value = await work(hookedClient);
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

async function cleanup(pool: Pool): Promise<void> {
  await pool.query('DELETE FROM notification.deliveries WHERE notification_id IN (SELECT id FROM notification.notifications WHERE user_id=ANY($1::uuid[]))', [userIds]);
  await pool.query('DELETE FROM notification.notifications WHERE user_id=ANY($1::uuid[])', [userIds]);
  await pool.query('DELETE FROM sync.change_log WHERE entity_id=ANY($1::uuid[])', [registrationIds]);
  await pool.query('DELETE FROM sync.outbox_events WHERE aggregate_id=$1', [eventId]);
  await pool.query('DELETE FROM events.waitlist_promotions WHERE registration_id=ANY($1::uuid[])', [registrationIds]);
  await pool.query('DELETE FROM events.registrations WHERE id=ANY($1::uuid[])', [registrationIds]);
  await pool.query('DELETE FROM events.event_capacity WHERE event_id=$1', [eventId]);
  await pool.query('DELETE FROM events.events WHERE id=$1', [eventId]);
  await pool.query('DELETE FROM identity.users WHERE id=ANY($1::uuid[])', [userIds]);
}

describe('registration cancellation and waitlist worker concurrency', () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseURL, max: 8 });
    await cleanup(pool);
    await pool.query(
      `INSERT INTO identity.users(id,public_handle,phone_verified_at) VALUES
         ($1,'concurrency_host',clock_timestamp()),
         ($2,'concurrency_offered',clock_timestamp()),
         ($3,'concurrency_waitlisted',clock_timestamp())`,
      userIds,
    );
    await pool.query(
      `INSERT INTO events.events(
         id,public_slug,organizer_id,status,title,description,category_id,
         starts_at,ends_at,capacity,registration_mode,waitlist_enabled
       ) VALUES (
         $1,'concurrency-event',$2,'published','Concurrency event',
         'A deterministic waitlist concurrency integration fixture','walk',
         clock_timestamp()+interval '30 days',clock_timestamp()+interval '30 days 2 hours',
         10,'automatic',true
       )`,
      [eventId, hostId],
    );
    await pool.query(
      `INSERT INTO events.event_capacity(event_id,offered_count,waitlist_count)
       VALUES ($1,1,1)`,
      [eventId],
    );
    await pool.query(
      `INSERT INTO events.registrations(
         id,event_id,user_id,status,party_size,waitlist_joined_at
       ) VALUES
         ($1,$3,$4,'offered',1,clock_timestamp()-interval '2 hours'),
         ($2,$3,$5,'waitlisted',1,clock_timestamp()-interval '1 hour')`,
      [offeredRegistrationId, waitlistedRegistrationId, eventId, offeredUserId, waitlistedUserId],
    );
    await pool.query(
      `INSERT INTO events.waitlist_promotions(
         id,registration_id,offered_at,expires_at
       ) VALUES ($1,$2,clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour')`,
      [promotionId, offeredRegistrationId],
    );
  });

  afterAll(async () => {
    await cleanup(pool).catch(() => undefined);
    await pool.end();
  });

  it('finishes cancellation and promotion without a registration/capacity/promotion deadlock', async () => {
    const cancelHasCapacity = deferred();
    const continueCancel = deferred();
    const workerExpiredScanDone = deferred();
    const workerCapacityRequested = deferred();

    const cancellationDatabase = databaseWithHook(pool, async <Row extends QueryResultRow>(
      client: PoolClient,
      text: string,
      values: readonly unknown[],
    ) => {
      const result = await client.query<Row>(text, [...values]);
      if (
        text.includes('FROM events.events e JOIN events.event_capacity c')
        && text.includes('FOR UPDATE OF e, c')
      ) {
        cancelHasCapacity.resolve();
        await continueCancel.promise;
      }
      return result;
    });
    const workerDatabase = databaseWithHook(pool, async <Row extends QueryResultRow>(
      client: PoolClient,
      text: string,
      values: readonly unknown[],
    ) => {
      if (text.includes('SELECT e.capacity, c.confirmed_count')) {
        const pending = client.query<Row>(text, [...values]);
        workerCapacityRequested.resolve();
        return pending;
      }
      const result = await client.query<Row>(text, [...values]);
      if (text.includes('WITH due AS')) workerExpiredScanDone.resolve();
      return result;
    });

    const idempotency = {
      requestHash: () => Buffer.alloc(32),
      claim: async () => null,
      complete: async () => undefined,
    };
    const points = {
      wallet: async () => ({ freeBalance: 0, paidBalance: 0, totalBalance: 0 }),
      configBigInt: async () => 24n,
    };
    const service = new RegistrationsService(cancellationDatabase as never, idempotency as never, points as never);
    const workerJobsURL = new URL('../../../../worker/src/jobs.ts', import.meta.url).href;
    const workerConfigURL = new URL('../../../../worker/src/config.ts', import.meta.url).href;
    const [{ WorkerJobs }, { parseConfig }] = await Promise.all([
      loadModule<WorkerJobsModule>(workerJobsURL),
      loadModule<WorkerConfigModule>(workerConfigURL),
    ]);
    const worker = new WorkerJobs(workerDatabase, parseConfig({
      NODE_ENV: 'test',
      DATABASE_URL: databaseURL,
      WORKER_BATCH_SIZE: '10',
    }));
    const user = {
      id: offeredUserId,
      sessionId: 'concurrency-session',
      phoneVerified: true,
      restrictions: [],
      roles: ['verified'],
    };

    const cancellation = service.cancel(
      user,
      offeredRegistrationId,
      '95000000-0000-7000-8000-000000000001',
    );
    await cancelHasCapacity.promise;
    const workerRun = worker.expireAndPromoteWaitlist();
    await workerExpiredScanDone.promise;
    await workerCapacityRequested.promise;
    continueCancel.resolve();

    const settled = await Promise.allSettled([cancellation, workerRun]);
    expect(settled.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);

    const registrations = await pool.query<{ id: string; status: string }>(
      'SELECT id,status::text FROM events.registrations WHERE id=ANY($1::uuid[]) ORDER BY id',
      [registrationIds],
    );
    expect(registrations.rows).toEqual([
      { id: offeredRegistrationId, status: 'cancelled' },
      { id: waitlistedRegistrationId, status: 'offered' },
    ]);
    const capacity = await pool.query<{ offered_count: number; waitlist_count: number }>(
      'SELECT offered_count,waitlist_count FROM events.event_capacity WHERE event_id=$1',
      [eventId],
    );
    expect(capacity.rows[0]).toEqual({ offered_count: 1, waitlist_count: 0 });
  }, 10_000);
});
