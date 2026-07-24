import { describe, expect, it, vi } from 'vitest';
import { EventAnnouncementsService, EVENT_ANNOUNCEMENT_DAILY_CAP } from './event-announcements.service.js';

const eventId = '019b0000-0000-7000-8600-000000000001';
const organizerId = '019b0000-0000-7000-8000-000000000010';
const strangerId = '019b0000-0000-7000-8000-000000000099';

interface Handler {
  match: (sql: string) => boolean;
  rows: unknown[];
  rowCount?: number;
}

function buildService(handlers: Handler[], captured?: Array<{ sql: string; values: unknown[] }>) {
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      captured?.push({ sql, values });
      for (const handler of handlers) {
        if (handler.match(sql)) {
          return { rows: handler.rows, rowCount: handler.rowCount ?? handler.rows.length };
        }
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const database = {
    pool: { connect: vi.fn(async () => client) },
    transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)),
    query: client.query,
  };
  const idempotency = {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
    claim: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new EventAnnouncementsService(database as never, idempotency as never);
  return { service, client, idempotency };
}

const organizerEvent: Handler = {
  match: (sql) => sql.includes('FROM events.events'),
  rows: [{ id: eventId, organizer_id: organizerId, title: '周末城市漫步' }],
};

describe('event host announcements — fan-out to confirmed attendees', () => {
  it('inserts one notification per confirmed attendee, excluding the organizer', async () => {
    const captured: Array<{ sql: string; values: unknown[] }> = [];
    const { service } = buildService(
      [
        organizerEvent,
        { match: (sql) => sql.includes('count(DISTINCT'), rows: [{ count: '0' }] },
        {
          match: (sql) => sql.includes('INSERT INTO notification.notifications'),
          rows: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }],
          rowCount: 3,
        },
      ],
      captured,
    );

    const result = (await service.send(organizerId, eventId, 'key-1', {
      title: '场地更新',
      body: '集合点改到公园北门。',
    })) as { recipientCount: number; remainingToday: number; announcementId: string };

    expect(result.recipientCount).toBe(3);
    expect(result.remainingToday).toBe(EVENT_ANNOUNCEMENT_DAILY_CAP - 1);

    const insert = captured.find((entry) =>
      entry.sql.includes('INSERT INTO notification.notifications'),
    );
    expect(insert).toBeDefined();
    // Confirmed-only, organizer excluded, deep-links to the event.
    expect(insert!.sql).toContain("status = 'confirmed'");
    expect(insert!.sql).toContain('registration.user_id <> $6');
    expect(insert!.values).toContain(organizerId);
    const payload = JSON.parse(insert!.values[2] as string) as {
      eventId: string;
      announcementTitle: string;
      body: string;
      announcementId: string;
      dedupeKey: string;
    };
    expect(payload).toMatchObject({
      eventId,
      announcementTitle: '场地更新',
      body: '集合点改到公园北门。',
    });
    expect(payload.dedupeKey).toBe(`host_announcement:${payload.announcementId}`);
  });

  it('rejects a non-organizer', async () => {
    const { service } = buildService([organizerEvent]);
    await expect(
      service.send(strangerId, eventId, 'key-2', { title: '标题', body: '内容' }),
    ).rejects.toMatchObject({ code: 'EVENT_ANNOUNCEMENT_FORBIDDEN', status: 403 });
  });

  it('rejects when the event does not exist', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('FROM events.events'), rows: [] },
    ]);
    await expect(
      service.send(organizerId, eventId, 'key-3', { title: '标题', body: '内容' }),
    ).rejects.toMatchObject({ code: 'EVENT_NOT_FOUND', status: 404 });
  });

  it('enforces the daily cap and never fans out once exceeded', async () => {
    const { service, client } = buildService([
      organizerEvent,
      {
        match: (sql) => sql.includes('count(DISTINCT'),
        rows: [{ count: String(EVENT_ANNOUNCEMENT_DAILY_CAP) }],
      },
    ]);
    await expect(
      service.send(organizerId, eventId, 'key-4', { title: '标题', body: '内容' }),
    ).rejects.toMatchObject({ code: 'EVENT_ANNOUNCEMENT_RATE_LIMITED', status: 429 });
    const fannedOut = client.query.mock.calls.some((call) =>
      String(call[0]).includes('INSERT INTO notification.notifications'),
    );
    expect(fannedOut).toBe(false);
  });

  it('replays an idempotent send without re-inserting', async () => {
    const { service, client, idempotency } = buildService([organizerEvent]);
    idempotency.claim.mockResolvedValueOnce({ status: 201, body: { announcementId: 'prior' } });
    const result = await service.send(organizerId, eventId, 'key-5', {
      title: '标题',
      body: '内容',
    });
    expect(result).toMatchObject({ announcementId: 'prior' });
    const fannedOut = client.query.mock.calls.some((call) =>
      String(call[0]).includes('INSERT INTO notification.notifications'),
    );
    expect(fannedOut).toBe(false);
  });

  it('lists announcements grouped by announcementId with remaining quota', async () => {
    const { service } = buildService([
      organizerEvent,
      {
        match: (sql) => sql.includes('GROUP BY'),
        rows: [
          {
            announcement_id: 'ann-1',
            title: '场地更新',
            body: '集合点改到公园北门。',
            sent_at: new Date('2026-07-24T02:00:00Z'),
            recipient_count: 3,
          },
        ],
      },
      { match: (sql) => sql.includes('count(DISTINCT'), rows: [{ count: '1' }] },
    ]);
    const result = (await service.list(organizerId, eventId)) as {
      items: Array<{ id: string; recipientCount: number }>;
      dailyLimit: number;
      remainingToday: number;
    };
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ id: 'ann-1', recipientCount: 3 });
    expect(result.dailyLimit).toBe(EVENT_ANNOUNCEMENT_DAILY_CAP);
    expect(result.remainingToday).toBe(EVENT_ANNOUNCEMENT_DAILY_CAP - 1);
  });
});
