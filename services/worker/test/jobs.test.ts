import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { jobNames } from '../src/jobs.js';
import { WorkerJobs } from '../src/jobs.js';

const config = parseConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://spott:spott@localhost/spott' });

function result<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount };
}

describe('worker job registry', () => {
  it('keeps all durable background responsibilities registered', () => {
    expect(jobNames).toEqual(expect.arrayContaining([
      'dispatchOutbox',
      'processMediaAssets',
      'renderPosterJobs',
      'fanoutAnnouncements',
      'scheduleEventReminders',
      'orchestrateNotifications',
      'deliverNotifications',
      'expireAndPromoteWaitlist',
      'expireFreePointLots',
      'expireEventPromotions',
      'reconcileLedger',
    ]));
  });

  it('takes due activity promotions offline without touching the ledger', async () => {
    const queries: string[] = [];
    const database = {
      query: async (text: string) => {
        queries.push(text);
        return result([{ id: 'promotion-1' }], 1);
      },
    };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireEventPromotions()).toMatchObject({ processed: 1, metadata: { expired: 1 } });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain('UPDATE commerce.event_promotions');
    expect(queries[0]).toContain("state = 'expired'");
    expect(queries[0]).toContain('expires_at <= clock_timestamp()');
    // Expiry is normal completion, so it must never write ledger entries.
    expect(queries[0]).not.toContain('point_entries');
  });

  it('consumes one announcement fan-out exactly once and uses a durable dedupe key', async () => {
    let consumed = false;
    const notificationCalls: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (text.includes('FROM community.announcements')) return result(consumed ? [] : [{
          id: '10000000-0000-0000-0000-000000000001',
          group_id: '20000000-0000-0000-0000-000000000001',
          author_id: '30000000-0000-0000-0000-000000000001',
          title: 'Meeting point changed',
          body: 'Tonight at seven',
          group_name: 'Tokyo walkers',
        }]);
        if (text.includes('FROM community.group_memberships')) return result([
          { user_id: '40000000-0000-0000-0000-000000000001' },
          { user_id: '40000000-0000-0000-0000-000000000002' },
        ]);
        if (text.includes('INSERT INTO notification.notifications')) {
          notificationCalls.push({ text, values });
          return result([{ id: 'notification' }]);
        }
        if (text.includes('INSERT INTO notification.fanout_receipts')) {
          consumed = true;
          return result([], 1);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.fanoutAnnouncements()).toMatchObject({ processed: 1, metadata: { notifications: 2 } });
    expect(await jobs.fanoutAnnouncements()).toMatchObject({ processed: 0 });
    expect(notificationCalls).toHaveLength(2);
    expect(notificationCalls[0]!.text).toContain('ON CONFLICT (user_id,type,dedupe_key) DO NOTHING');
    expect(notificationCalls[0]!.values.at(-1)).toBe('announcement:10000000-0000-0000-0000-000000000001');
  });

  it('queues a due reminder once with a registration-and-phase idempotency key', async () => {
    let queued = false;
    const keys: unknown[] = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (text.includes('CROSS JOIN LATERAL')) return result(queued ? [] : [{
          registration_id: '50000000-0000-0000-0000-000000000001',
          user_id: '60000000-0000-0000-0000-000000000001',
          event_id: '70000000-0000-0000-0000-000000000001',
          title: 'Coffee walk',
          starts_at: new Date('2026-07-16T09:00:00.000Z'),
          public_area: 'Shibuya',
          phase: '2h',
        }]);
        if (text.includes('INSERT INTO notification.notifications')) {
          queued = true;
          keys.push(values.at(-1));
          return result([{ id: 'notification' }]);
        }
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.scheduleEventReminders()).toMatchObject({ processed: 1 });
    expect(await jobs.scheduleEventReminders()).toMatchObject({ processed: 0 });
    expect(keys).toEqual(['reminder:50000000-0000-0000-0000-000000000001:2h']);
  });

  it('promotes one waitlist record once and keys the notice by offer id', async () => {
    let promoted = false;
    const noticeKeys: unknown[] = [];
    const capacityUpdates: Array<{ text: string; values: readonly unknown[] }> = [];
    const queryOrder: string[] = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        queryOrder.push(text);
        if (text.includes('WITH due AS')) return result([]);
        if (text.includes('SELECT c.event_id')) return result(promoted ? [] : [{
          event_id: '70000000-0000-0000-0000-000000000001', title: 'Coffee walk',
        }]);
        if (text.includes('SELECT r.id, r.user_id, r.party_size')) return result([{
          id: '50000000-0000-0000-0000-000000000001',
          user_id: '60000000-0000-0000-0000-000000000001',
          party_size: 3,
        }]);
        if (text.includes('SELECT e.capacity, c.confirmed_count')) return result([{
          capacity: 10,
          confirmed_count: 4,
          pending_count: 1,
          offered_count: 1,
        }]);
        if (text.includes('INSERT INTO events.waitlist_promotions')) return result([{
          id: '80000000-0000-0000-0000-000000000001', expires_at: new Date('2026-07-16T10:00:00.000Z'),
        }]);
        if (text.includes('INSERT INTO notification.notifications')) {
          promoted = true;
          noticeKeys.push(values.at(-1));
          return result([{ id: 'notification' }]);
        }
        if (text.includes('UPDATE events.event_capacity')) {
          capacityUpdates.push({ text, values });
          return result([], 1);
        }
        if (text.includes('UPDATE events.registrations')) return result([], 1);
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireAndPromoteWaitlist()).toMatchObject({ processed: 1, metadata: { promoted: 1 } });
    expect(await jobs.expireAndPromoteWaitlist()).toMatchObject({ processed: 0, metadata: { promoted: 0 } });
    expect(noticeKeys).toEqual(['waitlist-offer:80000000-0000-0000-0000-000000000001']);
    expect(capacityUpdates[0]?.text).toContain('offered_count = offered_count + $2');
    expect(capacityUpdates[0]?.values).toEqual([
      '70000000-0000-0000-0000-000000000001',
      3,
    ]);
    const registrationLock = queryOrder.findIndex((text) => text.includes('FOR UPDATE OF r'));
    const capacityLock = queryOrder.findIndex((text) => text.includes('FOR UPDATE OF c'));
    expect(registrationLock).toBeGreaterThanOrEqual(0);
    expect(capacityLock).toBeGreaterThan(registrationLock);
  });

  it('releases the complete offered party size when an offer expires', async () => {
    const capacityUpdates: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (text.includes('WITH due AS')) {
          expect(text).toContain("r.status = 'offered'");
          expect(text).toContain('FOR UPDATE OF r SKIP LOCKED');
          expect(text).not.toContain('FOR UPDATE OF p, r');
          return result([{
          registration_id: '50000000-0000-0000-0000-000000000001',
          event_id: '70000000-0000-0000-0000-000000000001',
          party_size: 3,
          }]);
        }
        if (text.includes('UPDATE events.event_capacity')) {
          capacityUpdates.push({ text, values });
          return result([], 1);
        }
        if (text.includes('SELECT c.event_id')) return result([]);
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireAndPromoteWaitlist()).toMatchObject({
      processed: 1,
      metadata: { expired: 1, promoted: 0 },
    });
    expect(capacityUpdates[0]?.text).toContain('offered_count = GREATEST(0, offered_count - $2)');
    expect(capacityUpdates[0]?.values).toEqual([
      '70000000-0000-0000-0000-000000000001',
      3,
    ]);
  });

  it('releases the seat, settles the registration and nudges the waitlist when a pending hold lapses', async () => {
    let released = false;
    const statements: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        statements.push({ text, values });
        if (text.includes('FROM events.registrations registration')) {
          return result(released ? [] : [{
            registration_id: '50000000-0000-0000-0000-000000000001',
            event_id: '70000000-0000-0000-0000-000000000001',
            user_id: '60000000-0000-0000-0000-000000000001',
            party_size: 2,
            hold_id: 'a0000000-0000-0000-0000-000000000001',
            title: 'Coffee walk',
          }]);
        }
        if (text.includes("UPDATE commerce.point_holds SET state = 'expired'")) {
          return result([{ id: 'a0000000-0000-0000-0000-000000000001' }], 1);
        }
        if (text.includes("UPDATE events.registrations SET status = 'cancelled'")) {
          released = true;
          return result([{ id: '50000000-0000-0000-0000-000000000001' }], 1);
        }
        return result([], 1);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
      query: async () => result([{ processed: 0 }]),
    };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireHoldsAndQuotes()).toMatchObject({ metadata: { releasedSeats: 1 } });

    const find = (needle: string) => statements.find((entry) => entry.text.includes(needle));
    // The seat must come back to the event, not stay inside `occupied`.
    const capacity = find('UPDATE events.event_capacity');
    expect(capacity?.text).toContain('pending_count = GREATEST(0, pending_count - $2)');
    expect(capacity?.values).toEqual(['70000000-0000-0000-0000-000000000001', 2]);
    // The waitlist has to be told a seat opened up, or the queue stays frozen.
    expect(find("'waitlist.promotion_requested'")).toBeTruthy();
    // Both writes stay conditional so a second worker cannot double release.
    expect(find("UPDATE commerce.point_holds SET state = 'expired'")?.text)
      .toContain("WHERE id = $1 AND state = 'active'");
    expect(find("UPDATE events.registrations SET status = 'cancelled'")?.text)
      .toContain("WHERE id = $1 AND status = 'pending'");
  });

  it('locks the registration before the capacity row so hold expiry cannot deadlock a decision', async () => {
    const order: string[] = [];
    const client = {
      query: async (text: string) => {
        order.push(text);
        if (text.includes('FROM events.registrations registration')) {
          expect(text).toContain("registration.status = 'pending'");
          expect(text).toContain("hold.state = 'active'");
          expect(text).toContain('FOR UPDATE OF registration SKIP LOCKED');
          return result([{
            registration_id: '50000000-0000-0000-0000-000000000001',
            event_id: '70000000-0000-0000-0000-000000000001',
            user_id: '60000000-0000-0000-0000-000000000001',
            party_size: 1,
            hold_id: 'a0000000-0000-0000-0000-000000000001',
            title: 'Coffee walk',
          }]);
        }
        // Nothing may progress once the hold flip finds no active row.
        if (text.includes("UPDATE commerce.point_holds SET state = 'expired'")) return result([], 0);
        return result([], 1);
      },
    };
    const database = {
      transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client),
      query: async () => result([{ processed: 0 }]),
    };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireHoldsAndQuotes()).toMatchObject({ metadata: { releasedSeats: 0 } });
    const registrationLock = order.findIndex((text) => text.includes('FOR UPDATE OF registration SKIP LOCKED'));
    const capacityLock = order.findIndex((text) => text.includes('FOR UPDATE OF event, capacity'));
    expect(registrationLock).toBeGreaterThanOrEqual(0);
    expect(capacityLock).toBeGreaterThan(registrationLock);
    // A lost race must not touch the counter.
    expect(order.some((text) => text.includes('UPDATE events.event_capacity'))).toBe(false);
  });

  it('never bulk expires a hold that still backs a pending seat', async () => {
    let sweep = '';
    const database = {
      transaction: async <T>(work: (value: { query: () => unknown }) => Promise<T>) => work({
        query: async () => result([]),
      }),
      query: async (text: string) => {
        sweep = text;
        return result([{ processed: 3 }]);
      },
    };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireHoldsAndQuotes()).toMatchObject({ processed: 3, metadata: { swept: 3 } });
    // Batch overflow must never strand a pending registration behind a dead hold.
    expect(sweep).toContain('NOT EXISTS');
    expect(sweep).toContain("registration.status = 'pending'");
  });

  it('rechecks locked capacity and skips a stale promotion that no longer fits', async () => {
    const mutations: string[] = [];
    const client = {
      query: async (text: string) => {
        if (text.includes('WITH due AS')) return result([]);
        if (text.includes('SELECT c.event_id')) return result([{
          event_id: '70000000-0000-0000-0000-000000000001',
          title: 'Coffee walk',
        }]);
        if (text.includes('SELECT r.id, r.user_id, r.party_size')) return result([{
          id: '50000000-0000-0000-0000-000000000001',
          user_id: '60000000-0000-0000-0000-000000000001',
          party_size: 3,
        }]);
        if (text.includes('SELECT e.capacity, c.confirmed_count')) return result([{
          capacity: 10,
          confirmed_count: 7,
          pending_count: 1,
          offered_count: 1,
        }]);
        mutations.push(text);
        return result([], 1);
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
    const jobs = new WorkerJobs(database as never, config);

    await expect(jobs.expireAndPromoteWaitlist()).resolves.toMatchObject({
      processed: 0,
      metadata: { promoted: 0 },
    });
    expect(mutations).toEqual([]);
  });
});
