import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { RegistrationsService } from '../registrations/registrations.service.js';
import { EventsService } from './events.service.js';

const hostId = '10000000-0000-7000-8000-000000000001';
const offeredViewerId = '10000000-0000-7000-8000-000000000002';
const confirmedViewerId = '10000000-0000-7000-8000-000000000003';
const pendingViewerId = '10000000-0000-7000-8000-000000000004';
const unrelatedViewerId = '10000000-0000-7000-8000-000000000005';
const matchEventId = '20000000-0000-7000-8000-000000000001';
const publicEventId = '20000000-0000-7000-8000-000000000002';
const noPointEventId = '20000000-0000-7000-8000-000000000003';
const coordinateDraftId = '20000000-0000-7000-8000-000000000004';
const fullEventId = '20000000-0000-7000-8000-000000000005';
const completedEventId = '20000000-0000-7000-8000-000000000010';
const cancelledEventId = '20000000-0000-7000-8000-000000000011';
const legacyArchivedEventId = '20000000-0000-7000-8000-000000000012';
const paginationEventIds = [
  '20000000-0000-7000-8000-000000000020',
  '20000000-0000-7000-8000-000000000021',
  '20000000-0000-7000-8000-000000000022',
];

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

let pool: Pool;
let client: PoolClient;
let service: EventsService;

const viewer = (id: string) => ({
  id,
  sessionId: 'integration-session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
});

async function insertEvent(input: {
  id: string;
  slug: string;
  status?: string;
  title?: string;
  category?: string;
  startsAt?: string;
  capacity?: number;
  format?: string;
  primaryLocale?: string;
  supportedLocales?: string[];
  localeConfirmed?: boolean;
}): Promise<void> {
  await client.query(
    `INSERT INTO events.events(
       id, public_slug, organizer_id, status, title, description, category_id,
       starts_at, ends_at, deadline_at, capacity, registration_mode, waitlist_enabled,
       format, primary_locale, supported_locales, locale_confirmed_at
     ) VALUES (
       $1,$2,$3,$4::events.event_status,$5,'Integration event description long enough for tests',$6,
       $7::timestamptz,$7::timestamptz + interval '2 hours',$7::timestamptz - interval '1 day',
       $8,'automatic',true,$9,$10,$11,
       CASE WHEN $12 THEN clock_timestamp() ELSE NULL END
     )`,
    [
      input.id,
      input.slug,
      hostId,
      input.status ?? 'published',
      input.title ?? input.slug,
      input.category ?? 'food',
      input.startsAt ?? '2030-08-10T03:00:00.000Z',
      input.capacity ?? 10,
      input.format ?? 'in_person',
      input.primaryLocale ?? 'ja',
      input.supportedLocales ?? ['ja'],
      input.localeConfirmed ?? true,
    ],
  );
  await client.query('INSERT INTO events.event_capacity(event_id) VALUES ($1)', [input.id]);
}

async function insertLocation(
  eventId: string,
  visibility: 'public' | 'confirmed',
  longitude?: number,
  latitude?: number,
): Promise<void> {
  await client.query(
    `INSERT INTO events.event_locations(
       event_id, region_id, public_area, exact_address_cipher, exact_address_visibility, point
     ) VALUES (
       $1,'tokyo','渋谷',decode('636970686572','hex'),$2,
       CASE WHEN $3::double precision IS NULL THEN NULL
         ELSE ST_SetSRID(ST_MakePoint($3,$4),4326)::geography END
     )`,
    [eventId, visibility, longitude ?? null, latitude ?? null],
  );
}

async function insertFee(eventId: string, isFree: boolean): Promise<void> {
  await client.query(
    `INSERT INTO events.event_fees(
       event_id,is_free,amount_jpy,collector_name,method,refund_policy
     ) VALUES ($1,$2,CASE WHEN $2 THEN NULL ELSE 2500 END,
       CASE WHEN $2 THEN NULL ELSE 'Host' END,
       CASE WHEN $2 THEN NULL ELSE 'cash' END,
       CASE WHEN $2 THEN NULL ELSE 'No refund' END)`,
    [eventId, isFree],
  );
}

beforeAll(async () => {
  pool = new Pool({ connectionString: databaseURL, max: 1 });
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query("SET LOCAL TIME ZONE 'UTC'");

  for (const [id, handle, verified] of [
    [hostId, 'integration_host', true],
    [offeredViewerId, 'integration_offered', true],
    [confirmedViewerId, 'integration_confirmed', true],
    [pendingViewerId, 'integration_pending', true],
    [unrelatedViewerId, 'integration_unrelated', false],
  ] as const) {
    await client.query(
      `INSERT INTO identity.users(id,public_handle,phone_verified_at)
       VALUES ($1,$2,CASE WHEN $3 THEN clock_timestamp() ELSE NULL END)`,
      [id, handle, verified],
    );
    await client.query(
      'INSERT INTO identity.profiles(user_id,nickname) VALUES ($1,$2)',
      [id, handle.replace('integration_', '')],
    );
  }

  await insertEvent({
    id: matchEventId,
    slug: 'integration-match',
    title: 'Tokyo coffee integration',
    category: 'food',
    startsAt: '2030-08-10T03:00:00.000Z',
    format: 'hybrid',
    supportedLocales: ['ja', 'en'],
  });
  await insertLocation(matchEventId, 'confirmed', 139.767125, 35.681236);
  await insertFee(matchEventId, false);
  await client.query(
    `UPDATE events.event_capacity
     SET confirmed_count=2,pending_count=2,offered_count=3,waitlist_count=1
     WHERE event_id=$1`,
    [matchEventId],
  );
  await client.query(
    `INSERT INTO events.registrations(id,event_id,user_id,status,party_size,waitlist_joined_at,confirmed_at)
     VALUES
       ('30000000-0000-7000-8000-000000000001',$1,$2,'offered',3,clock_timestamp(),NULL),
       ('30000000-0000-7000-8000-000000000002',$1,$3,'confirmed',2,NULL,clock_timestamp()),
       ('30000000-0000-7000-8000-000000000003',$1,$4,'pending',2,NULL,NULL)`,
    [matchEventId, offeredViewerId, confirmedViewerId, pendingViewerId],
  );
  await client.query(
    `INSERT INTO events.waitlist_promotions(id,registration_id,expires_at)
     VALUES ('40000000-0000-7000-8000-000000000001',
       '30000000-0000-7000-8000-000000000001','2030-08-09T23:00:00.000Z')`,
  );
  await client.query(
    'INSERT INTO events.event_favorites(user_id,event_id) VALUES ($1,$2)',
    [offeredViewerId, matchEventId],
  );

  await insertEvent({ id: publicEventId, slug: 'integration-public', startsAt: '2030-08-11T03:00:00.000Z' });
  await insertLocation(publicEventId, 'public', 139.701234, 35.612345);
  await insertFee(publicEventId, true);

  await insertEvent({
    id: noPointEventId,
    slug: 'integration-unconfirmed-no-point',
    startsAt: '2030-08-12T03:00:00.000Z',
    localeConfirmed: false,
  });
  await insertLocation(noPointEventId, 'confirmed');
  await insertFee(noPointEventId, true);

  await insertEvent({ id: coordinateDraftId, slug: 'integration-coordinate-draft', status: 'draft' });

  await insertEvent({
    id: fullEventId,
    slug: 'integration-full',
    title: 'Tokyo coffee full integration',
    category: 'food',
    startsAt: '2030-08-10T04:00:00.000Z',
    format: 'hybrid',
    supportedLocales: ['ja', 'en'],
  });
  await insertLocation(fullEventId, 'confirmed', 139.766, 35.682);
  await insertFee(fullEventId, false);
  await client.query(
    'UPDATE events.event_capacity SET confirmed_count=4,pending_count=3,offered_count=3 WHERE event_id=$1',
    [fullEventId],
  );

  for (const [index, id] of paginationEventIds.entries()) {
    await insertEvent({
      id,
      slug: `integration-page-${index}`,
      category: 'pagination',
      startsAt: '2030-09-01T03:00:00.000Z',
    });
    await insertFee(id, true);
  }

  await insertEvent({
    id: completedEventId,
    slug: 'integration-completed',
    status: 'ended',
    startsAt: '2029-01-01T03:00:00.000Z',
  });
  await client.query(
    `INSERT INTO events.registrations(id,event_id,user_id,status,party_size)
     VALUES
       ('30000000-0000-7000-8000-000000000010',$1,$2,'checked_in',4),
       ('30000000-0000-7000-8000-000000000011',$1,$3,'no_show',1)`,
    [completedEventId, confirmedViewerId, unrelatedViewerId],
  );
  await insertEvent({
    id: cancelledEventId,
    slug: 'integration-cancelled',
    status: 'cancelled',
    startsAt: '2029-02-01T03:00:00.000Z',
  });
  await client.query("UPDATE events.events SET status='archived' WHERE id=$1", [cancelledEventId]);
  await insertEvent({
    id: legacyArchivedEventId,
    slug: 'integration-legacy-archived',
    status: 'archived',
    startsAt: '2029-03-01T03:00:00.000Z',
  });

  const database = {
    query: <T extends Record<string, unknown>>(text: string, values: readonly unknown[] = []) => (
      client.query<T>(text, [...values])
    ),
  };
  service = new EventsService(
    database as never,
    {
      encrypt: () => Buffer.from('cipher'),
      decrypt: () => '東京都渋谷区1-2-3',
    } as never,
    {} as never,
    {} as never,
  );
});

afterAll(async () => {
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
  await pool.end();
});

describe('PostGIS discovery integration', () => {
  it('keeps a durable completion fact and never invents it for archived failures', async () => {
    const initial = await client.query<{ completed_at: Date | null }>(
      'SELECT completed_at FROM events.events WHERE id=$1',
      [completedEventId],
    );
    expect(initial.rows[0]?.completed_at).toBeInstanceOf(Date);
    await client.query("UPDATE events.events SET status='archived' WHERE id=$1", [completedEventId]);
    const facts = await client.query<{ id: string; completed: boolean }>(
      `SELECT id, completed_at IS NOT NULL AS completed FROM events.events
       WHERE id = ANY($1::uuid[]) ORDER BY id`,
      [[completedEventId, cancelledEventId, legacyArchivedEventId]],
    );
    expect(facts.rows).toEqual([
      { id: completedEventId, completed: true },
      { id: cancelledEventId, completed: false },
      { id: legacyArchivedEventId, completed: false },
    ]);
  });

  it('filters every member before pagination and maps real capacity, point, trust and offer facts', async () => {
    const result = await service.discovery(viewer(offeredViewerId), {
      query: 'coffee',
      region: 'tokyo',
      category: 'food',
      startsAfter: new Date('2030-08-10T00:00:00.000Z'),
      startsBefore: new Date('2030-08-10T23:59:59.000Z'),
      availableOnly: true,
      format: 'hybrid',
      language: 'ja',
      price: 'paid',
      bounds: { west: 139.7, south: 35.6, east: 139.8, north: 35.7 },
      limit: 20,
    }) as {
      items: Array<Record<string, unknown>>;
    };

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id: matchEventId,
      availableCapacity: 3,
      coordinate: { latitude: 35.68, longitude: 139.77, precision: 'approximate' },
      viewerRegistration: {
        id: '30000000-0000-7000-8000-000000000001',
        status: 'offered',
        partySize: 3,
        offerExpiresAt: '2030-08-09T23:00:00.000Z',
      },
      organizer: {
        trust: {
          phoneVerified: true,
          completedEventCount: 1,
          attendanceRateBand: '70_89',
        },
      },
    });
  });

  it('agrees with registration admission when pending and offered parties reserve the remaining seats', async () => {
    const registrationService = new RegistrationsService(
      { transaction: async <T>(work: (db: PoolClient) => Promise<T>) => work(client) } as never,
      {
        requestHash: () => Buffer.alloc(32),
        claim: async () => null,
        complete: async () => undefined,
      } as never,
      {} as never,
    );

    await expect(registrationService.register(
      viewer(unrelatedViewerId) as never,
      matchEventId,
      '50000000-0000-7000-8000-000000000001',
      {
        partySize: 4,
        quoteId: '50000000-0000-7000-8000-000000000002',
        joinWaitlistIfFull: false,
        answers: {},
      },
    )).rejects.toMatchObject({ code: 'REGISTRATION_CAPACITY_FULL' });

    const available = await service.discovery(undefined, {
      query: 'coffee',
      startsAfter: new Date('2030-08-10T00:00:00.000Z'),
      startsBefore: new Date('2030-08-10T23:59:59.000Z'),
      availableOnly: true,
      limit: 20,
    }) as { items: Array<{ id: string; availableCapacity: number }> };
    expect(available.items).toEqual([
      expect.objectContaining({ id: matchEventId, availableCapacity: 3 }),
    ]);
  });

  it('uses the starts-at/id cursor without a duplicate or skipped equal timestamp', async () => {
    const first = await service.discovery(undefined, {
      category: 'pagination',
      startsAfter: new Date('2030-09-01T00:00:00.000Z'),
      limit: 2,
    }) as { items: Array<{ id: string }>; nextCursor: string; hasMore: boolean };
    const second = await service.discovery(undefined, {
      category: 'pagination',
      startsAfter: new Date('2030-09-01T00:00:00.000Z'),
      cursor: first.nextCursor,
      limit: 2,
    }) as { items: Array<{ id: string }>; nextCursor: null; hasMore: boolean };

    expect(first.items.map((item) => item.id)).toEqual(paginationEventIds.slice(0, 2));
    expect(second.items.map((item) => item.id)).toEqual(paginationEventIds.slice(2));
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
  });

  it('keeps hosted and favorite projections on the same real fact model', async () => {
    const hosted = await service.hosted(viewer(hostId)) as {
      items: Array<Record<string, unknown>>;
    };
    const favorites = await service.favorites(viewer(offeredViewerId)) as {
      items: Array<Record<string, unknown>>;
    };
    const hostedMatch = hosted.items.find((item) => item.id === matchEventId);

    expect(hostedMatch).toMatchObject({
      coordinate: { latitude: 35.681236, longitude: 139.767125, precision: 'exact' },
      exactAddress: '東京都渋谷区1-2-3',
      availableCapacity: 3,
      organizer: { trust: { phoneVerified: true, completedEventCount: 1 } },
    });
    expect(favorites.items).toHaveLength(1);
    expect(favorites.items[0]).toMatchObject({
      id: matchEventId,
      coordinate: { latitude: 35.68, longitude: 139.77, precision: 'approximate' },
      availableCapacity: 3,
      viewerRegistration: { status: 'offered', partySize: 3 },
    });
  });

  it('does not match an unconfirmed legacy locale and never fabricates missing points', async () => {
    const explicitLocale = await service.discovery(undefined, {
      language: 'ja',
      startsAfter: new Date('2030-08-12T00:00:00.000Z'),
      startsBefore: new Date('2030-08-12T23:59:59.000Z'),
      limit: 20,
    }) as { items: Array<{ id: string }> };
    const ordinary = await service.discovery(undefined, {
      startsAfter: new Date('2030-08-12T00:00:00.000Z'),
      startsBefore: new Date('2030-08-12T23:59:59.000Z'),
      limit: 20,
    }) as { items: Array<{ id: string; coordinate: unknown }> };

    expect(explicitLocale.items).toEqual([]);
    expect(ordinary.items).toEqual([expect.objectContaining({ id: noPointEventId, coordinate: null })]);
  });

  it('returns detail precision from the complete visibility/viewer matrix', async () => {
    const internals = service as unknown as {
      loadEvent: (db: PoolClient, id: string, viewerId?: string) => Promise<Record<string, unknown>>;
      toView: (row: Record<string, unknown>, viewerValue: ReturnType<typeof viewer> | undefined, detail: boolean) => Record<string, unknown>;
    };
    const offeredRow = await internals.loadEvent(client, matchEventId, offeredViewerId);
    const confirmedRow = await internals.loadEvent(client, matchEventId, confirmedViewerId);
    const hostRow = await internals.loadEvent(client, matchEventId, hostId);
    const publicRow = await internals.loadEvent(client, publicEventId, unrelatedViewerId);

    expect(internals.toView(offeredRow, viewer(offeredViewerId), true)).toMatchObject({
      coordinate: { precision: 'approximate' }, exactAddress: null,
    });
    expect(internals.toView(confirmedRow, viewer(confirmedViewerId), true)).toMatchObject({
      coordinate: { latitude: 35.681236, longitude: 139.767125, precision: 'exact' },
      exactAddress: '東京都渋谷区1-2-3',
    });
    expect(internals.toView(hostRow, viewer(hostId), true)).toMatchObject({
      coordinate: { precision: 'exact' }, exactAddress: '東京都渋谷区1-2-3',
    });
    expect(internals.toView(publicRow, viewer(unrelatedViewerId), true)).toMatchObject({
      coordinate: { latitude: 35.612345, longitude: 139.701234, precision: 'exact' },
      exactAddress: '東京都渋谷区1-2-3',
    });
  });

  it('writes a real point and preserves it when a later draft update omits coordinates', async () => {
    const internals = service as unknown as {
      upsertDetails: (
        db: PoolClient,
        id: string,
        input: Record<string, unknown>,
      ) => Promise<void>;
    };
    await internals.upsertDetails(client, coordinateDraftId, {
      coordinate: { latitude: 35.6895, longitude: 139.6917 },
    });
    await internals.upsertDetails(client, coordinateDraftId, { publicArea: '新宿' });
    const point = await client.query<{ longitude: number; latitude: number }>(
      `SELECT ST_X(point::geometry) AS longitude, ST_Y(point::geometry) AS latitude
       FROM events.event_locations WHERE event_id=$1`,
      [coordinateDraftId],
    );

    expect(point.rows[0]).toEqual({ longitude: 139.6917, latitude: 35.6895 });
  });
});
