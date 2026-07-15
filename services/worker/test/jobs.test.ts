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
      'reconcileLedger',
    ]));
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
    const client = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (text.includes('WITH due AS')) return result([]);
        if (text.includes('SELECT c.event_id')) return result(promoted ? [] : [{
          event_id: '70000000-0000-0000-0000-000000000001', title: 'Coffee walk',
        }]);
        if (text.includes('SELECT r.id, r.user_id, r.party_size')) return result([{
          id: '50000000-0000-0000-0000-000000000001',
          user_id: '60000000-0000-0000-0000-000000000001',
          party_size: 1,
        }]);
        if (text.includes('INSERT INTO events.waitlist_promotions')) return result([{
          id: '80000000-0000-0000-0000-000000000001', expires_at: new Date('2026-07-16T10:00:00.000Z'),
        }]);
        if (text.includes('INSERT INTO notification.notifications')) {
          promoted = true;
          noticeKeys.push(values.at(-1));
          return result([{ id: 'notification' }]);
        }
        if (text.includes('UPDATE events.registrations') || text.includes('UPDATE events.event_capacity')) return result([], 1);
        throw new Error(`Unexpected SQL: ${text}`);
      },
    };
    const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
    const jobs = new WorkerJobs(database as never, config);

    expect(await jobs.expireAndPromoteWaitlist()).toMatchObject({ processed: 1, metadata: { promoted: 1 } });
    expect(await jobs.expireAndPromoteWaitlist()).toMatchObject({ processed: 0, metadata: { promoted: 0 } });
    expect(noticeKeys).toEqual(['waitlist-offer:80000000-0000-0000-0000-000000000001']);
  });
});
