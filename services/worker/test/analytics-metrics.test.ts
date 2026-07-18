import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { jobNames, WorkerJobs } from '../src/jobs.js';

const config = parseConfig({ NODE_ENV: 'test', DATABASE_URL: 'postgres://spott:spott@localhost/spott' });

function result<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount };
}

interface EmittedEvent {
  eventName: string;
  platform: string;
  sessionId: string;
  properties: Record<string, unknown>;
}

// Drives the server-authoritative analytics derivation job with a mocked
// database so we can assert the North Star population, the P1 funnel snapshot
// and the P2 business-invariant counters land in analytics.product_events.
function buildHarness(
  overrides: { windowConfig?: number | null; outboxDelayConfig?: number | null; snapshotDue?: boolean } = {},
) {
  const emitted: EmittedEvent[] = [];
  const paramsByMarker = new Map<string, readonly unknown[]>();

  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      // Config-centre reads (never hard-coded thresholds). The key rides in as a
      // bind parameter, so the fixture keys off the parameter, not the SQL text.
      if (text.includes('admin.config_revisions')) {
        if (values[0] === 'analytics.northstar.window_days') {
          return overrides.windowConfig == null ? result([]) : result([{ value_json: overrides.windowConfig }]);
        }
        if (values[0] === 'analytics.invariant.outbox_delay_seconds') {
          return overrides.outboxDelayConfig == null ? result([]) : result([{ value_json: overrides.outboxDelayConfig }]);
        }
        return result([]);
      }
      if (text.includes('AS due')) {
        // Snapshot schedule gate: default to due so the emission-focused tests run.
        return result([{ due: overrides.snapshotDue ?? true }]);
      }
      if (text.includes('/* metric:northstar */')) {
        paramsByMarker.set('northstar', values);
        return result([{ requalified_users: '7' }]);
      }
      if (text.includes('/* metric:funnel_participant */')) {
        return result([{
          registrations_submitted: '120',
          registrations_confirmed: '90',
          attendance_checked_in: '64',
          feedback_submitted: '31',
        }]);
      }
      if (text.includes('/* metric:funnel_host */')) {
        return result([{
          drafts: '5', submitted: '4', published: '12',
          with_registration: '9', completed: '7', repeat_hosts: '3',
        }]);
      }
      if (text.includes('/* metric:funnel_group */')) {
        return result([{ groups: '8', members_joined: '40', members_active: '25', members_left: '6' }]);
      }
      if (text.includes('/* metric:funnel_spread */')) {
        return result([{ shares_created: '50', opens: '30', registered: '12', attended: '7' }]);
      }
      if (text.includes('/* invariant:oversell */')) return result([{ count: '2' }]);
      if (text.includes('/* invariant:duplicate_checkin */')) return result([{ count: '0' }]);
      if (text.includes('/* invariant:negative_total_balance */')) return result([{ count: '1' }]);
      if (text.includes('/* invariant:expired_offer */')) return result([{ count: '5' }]);
      if (text.includes('/* invariant:outbox_delay */')) {
        paramsByMarker.set('outbox_delay', values);
        return result([{ count: '3' }]);
      }
      if (text.includes('/* invariant:sync_cursor_error */')) return result([{ count: '0' }]);
      if (text.includes('INSERT INTO analytics.product_events')) {
        emitted.push({
          eventName: values[0] as string,
          platform: values[5] as string,
          sessionId: values[4] as string,
          properties: values[6] as Record<string, unknown>,
        });
        return result([], 1);
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  const database = { transaction: async <T>(work: (value: typeof client) => Promise<T>) => work(client) };
  const jobs = new WorkerJobs(database as never, config);
  return { jobs, emitted, paramsByMarker };
}

describe('deriveAnalyticsMetrics', () => {
  it('is a registered durable worker responsibility', () => {
    expect(jobNames).toContain('deriveAnalyticsMetrics');
  });

  it('reports no work and emits nothing when the snapshot interval has not elapsed', async () => {
    // Otherwise processed is always non-zero, the worker loop never idles, and a
    // duplicate snapshot is written to analytics.product_events every cycle.
    const { jobs, emitted } = buildHarness({ snapshotDue: false });

    const outcome = await jobs.deriveAnalyticsMetrics();

    expect(outcome.processed).toBe(0);
    expect(emitted).toHaveLength(0);
  });

  it('records the North Star with a configuration-driven retention window', async () => {
    const { jobs, emitted, paramsByMarker } = buildHarness({ windowConfig: 45 });

    const outcome = await jobs.deriveAnalyticsMetrics();

    expect(paramsByMarker.get('northstar')).toContain(45);
    const northStar = emitted.find((event) => event.eventName === 'metrics_northstar_recorded');
    expect(northStar).toBeDefined();
    expect(northStar!.platform).toBe('server');
    expect(northStar!.properties).toMatchObject({ window_days: 45, requalified_users: 7 });
    expect(outcome.metadata).toMatchObject({ requalifiedUsers: 7 });
  });

  it('falls back to a 60-day window when no active configuration exists', async () => {
    const { jobs, emitted, paramsByMarker } = buildHarness({ windowConfig: null });

    await jobs.deriveAnalyticsMetrics();

    expect(paramsByMarker.get('northstar')).toContain(60);
    const northStar = emitted.find((event) => event.eventName === 'metrics_northstar_recorded');
    expect(northStar!.properties).toMatchObject({ window_days: 60 });
  });

  it('emits the participant funnel snapshot with only aggregate, non-PII counters', async () => {
    const { jobs, emitted } = buildHarness({ windowConfig: 60 });

    await jobs.deriveAnalyticsMetrics();

    const funnel = emitted.find((event) => event.eventName === 'funnel_participant_recorded');
    expect(funnel).toBeDefined();
    expect(funnel!.properties).toMatchObject({
      registrations_submitted: 120,
      registrations_confirmed: 90,
      attendance_checked_in: 64,
      feedback_submitted: 31,
    });
    // Aggregate counters only — no identifiers may ride along on server metrics.
    for (const value of Object.values(funnel!.properties)) {
      expect(typeof value).toBe('number');
    }
  });

  it('emits the host, group and spread funnels as aggregate-only snapshots', async () => {
    const { jobs, emitted } = buildHarness({ windowConfig: 60 });

    await jobs.deriveAnalyticsMetrics();

    const host = emitted.find((e) => e.eventName === 'funnel_host_recorded');
    const group = emitted.find((e) => e.eventName === 'funnel_group_recorded');
    const spread = emitted.find((e) => e.eventName === 'funnel_spread_recorded');
    expect(host?.properties).toMatchObject({ drafts: 5, published: 12, completed: 7, repeat_hosts: 3 });
    expect(group?.properties).toMatchObject({ groups: 8, members_joined: 40, members_active: 25 });
    expect(spread?.properties).toMatchObject({ shares_created: 50, opens: 30, registered: 12, attended: 7 });
    for (const snapshot of [host, group, spread]) {
      expect(snapshot?.platform).toBe('server');
      for (const value of Object.values(snapshot?.properties ?? {})) {
        expect(typeof value).toBe('number');
      }
    }
  });

  it('records every required business invariant counter with a configurable outbox-delay threshold', async () => {
    const { jobs, emitted, paramsByMarker } = buildHarness({ windowConfig: 60, outboxDelayConfig: 90 });

    const outcome = await jobs.deriveAnalyticsMetrics();

    const invariants = emitted.filter((event) => event.eventName === 'invariant_metric_recorded');
    const byName = new Map(invariants.map((event) => [event.properties.invariant, event.properties.count]));
    expect(byName.get('oversell')).toBe(2);
    expect(byName.get('duplicate_checkin')).toBe(0);
    expect(byName.get('negative_total_balance')).toBe(1);
    expect(byName.get('expired_offer')).toBe(5);
    expect(byName.get('outbox_delay')).toBe(3);
    expect(byName.get('sync_cursor_error')).toBe(0);
    expect(paramsByMarker.get('outbox_delay')).toContain(90);
    // Four counters are non-zero; two of those (oversell, negative balance) are the
    // P0 hard invariants that must never fire.
    expect(outcome.metadata).toMatchObject({ invariantsFlagged: 4, p0Breaches: 2 });
  });

  it('shares a single server session id across all metrics emitted in one run', async () => {
    const { jobs, emitted } = buildHarness({ windowConfig: 60 });

    await jobs.deriveAnalyticsMetrics();

    const sessions = new Set(emitted.map((event) => event.sessionId));
    expect(sessions.size).toBe(1);
    expect([...sessions][0]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
