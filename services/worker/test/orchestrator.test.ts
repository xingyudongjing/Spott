import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { WorkerJobs } from '../src/jobs.js';

const config = parseConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://spott:spott@localhost/spott' });

function result<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount };
}

interface Notification {
  id: string;
  user_id: string;
  type: string;
  resource_public_id: string | null;
}

interface PreferenceRow {
  in_app: boolean;
  push: boolean;
  email: boolean;
  quiet_start: string | null;
  quiet_end: string | null;
  now_jst: string;
}

interface DeliveryInsert {
  notificationId: string;
  channel: string;
  state: 'queued' | 'suppressed';
  reason: string | null;
}

function orchestratorHarness(opts: {
  notifications: Notification[];
  pref?: Partial<PreferenceRow>;
  config?: Array<{ key: string; value_json: unknown }>;
  freqCount?: number;
}): { jobs: WorkerJobs; deliveries: DeliveryInsert[] } {
  const deliveries: DeliveryInsert[] = [];
  let served = false;
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      // Per-resource daily frequency count. Check before the batch select because
      // both statements read from notification.notifications.
      if (text.includes('count(*)') && text.includes('notification.notifications')) {
        return result([{ c: opts.freqCount ?? 1 }]);
      }
      if (text.includes('FROM notification.notifications n') && text.includes('NOT EXISTS')) {
        if (served) return result<Notification>([]);
        served = true;
        return result(opts.notifications);
      }
      if (text.includes('FROM admin.config_revisions')) {
        return result(opts.config ?? []);
      }
      if (text.includes('FROM (SELECT 1) seed') || text.includes('notification.preferences p')) {
        const base: PreferenceRow = {
          in_app: true,
          push: true,
          email: false,
          quiet_start: null,
          quiet_end: null,
          now_jst: '12:00',
        };
        return result([{ ...base, ...opts.pref }]);
      }
      if (text.includes('INSERT INTO notification.deliveries')) {
        const suppressed = text.includes("'suppressed'");
        deliveries.push({
          notificationId: String(values[0]),
          channel: String(values[1]),
          state: suppressed ? 'suppressed' : 'queued',
          reason: suppressed ? String(values[2]) : null,
        });
        return result([], 1);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
  return { jobs: new WorkerJobs(database as never, config), deliveries };
}

const NOTIFICATION_ID = '90000000-0000-0000-0000-000000000001';
const USER_ID = '80000000-0000-0000-0000-000000000001';

function notification(type: string, resource: string | null = 'resource-1'): Notification {
  return { id: NOTIFICATION_ID, user_id: USER_ID, type, resource_public_id: resource };
}

function channels(deliveries: DeliveryInsert[], state: 'queued' | 'suppressed'): string[] {
  return deliveries.filter((delivery) => delivery.state === state).map((delivery) => delivery.channel).sort();
}

describe('notification orchestrator', () => {
  it('always keeps the in-app channel even when the user disabled the type', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('group.announcement')],
      pref: { in_app: false, push: false, email: false },
    });

    await jobs.orchestrateNotifications();

    expect(channels(deliveries, 'queued')).toContain('in_app');
    expect(deliveries.find((delivery) => delivery.channel === 'in_app')?.state).toBe('queued');
  });

  it('suppresses ordinary push during the default 22:00-08:00 quiet window with no stored preference', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('group.announcement')],
      pref: { now_jst: '23:30' },
      config: [],
    });

    await jobs.orchestrateNotifications();

    expect(channels(deliveries, 'queued')).toEqual(['in_app']);
    const push = deliveries.find((delivery) => delivery.channel === 'push');
    expect(push).toMatchObject({ state: 'suppressed', reason: 'QUIET_HOURS' });
  });

  it('honours a configured quiet window instead of hardcoding 22:00-08:00', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('group.announcement')],
      pref: { now_jst: '21:00' },
      config: [{ key: 'notification.quiet_hours', value_json: '20:00-06:00' }],
    });

    await jobs.orchestrateNotifications();

    const push = deliveries.find((delivery) => delivery.channel === 'push');
    expect(push).toMatchObject({ state: 'suppressed', reason: 'QUIET_HOURS' });
  });

  it('lets waitlist promotion bypass the quiet window but still delivers in-app', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('waitlist.offered')],
      pref: { now_jst: '23:30' },
    });

    await jobs.orchestrateNotifications();

    expect(channels(deliveries, 'queued')).toEqual(['in_app', 'push']);
    expect(channels(deliveries, 'suppressed')).toEqual([]);
  });

  it('keeps push for a non-closable service notification even if the user turned push off', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('waitlist.offered')],
      pref: { push: false },
    });

    await jobs.orchestrateNotifications();

    expect(channels(deliveries, 'queued')).toContain('push');
  });

  it('delivers the mandatory email channel for account-safety notifications regardless of preference', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('moderation.decided')],
      pref: { push: true, email: false, now_jst: '23:30' },
    });

    await jobs.orchestrateNotifications();

    // Safety notice: in-app + email are mandatory; email is not gated by quiet hours.
    expect(channels(deliveries, 'queued')).toEqual(['email', 'in_app']);
  });

  it('caps ordinary announcement push at the configured per-event daily limit', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('group.announcement')],
      pref: { now_jst: '12:00' },
      freqCount: 3,
    });

    await jobs.orchestrateNotifications();

    expect(channels(deliveries, 'queued')).toEqual(['in_app']);
    const push = deliveries.find((delivery) => delivery.channel === 'push');
    expect(push).toMatchObject({ state: 'suppressed', reason: 'FREQUENCY_CAPPED' });
  });

  it('still sends ordinary announcement push while under the daily cap', async () => {
    const { jobs, deliveries } = orchestratorHarness({
      notifications: [notification('group.announcement')],
      pref: { now_jst: '12:00' },
      freqCount: 2,
    });

    await jobs.orchestrateNotifications();

    expect(channels(deliveries, 'queued')).toEqual(['in_app', 'push']);
  });
});
