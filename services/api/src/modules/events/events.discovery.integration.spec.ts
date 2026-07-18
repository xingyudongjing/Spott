import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { IdempotencyService } from '../../platform/idempotency.js';
import { RegistrationsService } from '../registrations/registrations.service.js';
import { EventsService } from './events.service.js';

const hostId = '10000000-0000-7000-8000-000000000001';
const offeredViewerId = '10000000-0000-7000-8000-000000000002';
const confirmedViewerId = '10000000-0000-7000-8000-000000000003';
const pendingViewerId = '10000000-0000-7000-8000-000000000004';
const unrelatedViewerId = '10000000-0000-7000-8000-000000000005';
const deletedRegistrationViewerId = '10000000-0000-7000-8000-000000000006';
const matchEventId = '20000000-0000-7000-8000-000000000001';
const publicEventId = '20000000-0000-7000-8000-000000000002';
const noPointEventId = '20000000-0000-7000-8000-000000000003';
const coordinateDraftId = '20000000-0000-7000-8000-000000000004';
const fullEventId = '20000000-0000-7000-8000-000000000005';
const contactEventId = '20000000-0000-7000-8000-000000000006';
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

const integrationLookupHash = (value: string) => createHmac(
  'sha256',
  'events-integration-private-fingerprint-pepper',
).update(value).digest();

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
    [deletedRegistrationViewerId, 'integration_deleted_reg', true],
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
    `INSERT INTO events.registrations(
       id,event_id,user_id,status,party_size,confirmed_at,deleted_at
     ) VALUES (
       '30000000-0000-7000-8000-000000000004',$1,$2,'confirmed',1,
       clock_timestamp(),clock_timestamp()
     )`,
    [matchEventId, deletedRegistrationViewerId],
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
  await client.query(
    'INSERT INTO events.event_favorites(user_id,event_id) VALUES ($1,$2)',
    [deletedRegistrationViewerId, matchEventId],
  );

  await insertEvent({ id: publicEventId, slug: 'integration-public', startsAt: '2030-08-11T03:00:00.000Z' });
  await insertLocation(publicEventId, 'public', 139.701234, 35.612345);
  await insertFee(publicEventId, true);

  await insertEvent({
    id: contactEventId,
    slug: 'integration-contact',
    title: 'Encrypted organizer contact integration',
    category: 'contact',
    startsAt: '2030-08-11T06:00:00.000Z',
  });
  await insertLocation(contactEventId, 'confirmed', 139.712345, 35.623456);
  await insertFee(contactEventId, true);
  await client.query(
    `INSERT INTO events.event_contact_channels(
       event_id,kind,label_cipher,value_cipher,updated_by
     ) VALUES ($1,'email',$2,$3,$4)`,
    [
      contactEventId,
      Buffer.from('encrypted:Private event desk'),
      Buffer.from('encrypted:host@example.jp'),
      hostId,
    ],
  );
  await client.query(
    `INSERT INTO events.registrations(
       id,event_id,user_id,status,party_size,waitlist_joined_at,confirmed_at
     ) VALUES
       ('30000000-0000-7000-8000-000000000020',$1,$2,'pending',1,NULL,NULL),
       ('30000000-0000-7000-8000-000000000021',$1,$3,'waitlisted',1,clock_timestamp(),NULL),
       ('30000000-0000-7000-8000-000000000022',$1,$4,'offered',1,clock_timestamp(),NULL),
       ('30000000-0000-7000-8000-000000000023',$1,$5,'confirmed',1,NULL,clock_timestamp()),
       ('30000000-0000-7000-8000-000000000024',$1,$6,'checked_in',1,NULL,clock_timestamp())`,
    [
      contactEventId,
      pendingViewerId,
      deletedRegistrationViewerId,
      offeredViewerId,
      confirmedViewerId,
      unrelatedViewerId,
    ],
  );

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
    await insertLocation(id, 'confirmed');
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
  const fieldCrypto = {
    encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
    decrypt: (cipher: Buffer) => {
      const value = cipher.toString('utf8');
      return value.startsWith('encrypted:')
        ? value.slice('encrypted:'.length)
        : '東京都渋谷区1-2-3';
    },
    lookupHash: integrationLookupHash,
  };
  service = new EventsService(
    database as never,
    fieldCrypto as never,
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
    const completedAt = initial.rows[0]!.completed_at;
    await client.query('UPDATE events.events SET completed_at=NULL WHERE id=$1', [completedEventId]);
    await client.query(
      "UPDATE events.events SET completed_at='2000-01-01T00:00:00.000Z' WHERE id=$1",
      [legacyArchivedEventId],
    );
    const protectedFacts = await client.query<{ id: string; completed_at: Date | null }>(
      'SELECT id,completed_at FROM events.events WHERE id=ANY($1::uuid[]) ORDER BY id',
      [[completedEventId, legacyArchivedEventId]],
    );
    expect(protectedFacts.rows).toEqual([
      { id: completedEventId, completed_at: completedAt },
      { id: legacyArchivedEventId, completed_at: null },
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
        expectedEventVersion: 1,
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
    const deletedFavorite = await service.favorites(viewer(deletedRegistrationViewerId)) as {
      items: Array<Record<string, unknown>>;
    };
    expect(deletedFavorite.items).toEqual([expect.objectContaining({
      id: matchEventId,
      viewerRegistration: null,
      registrationStatus: null,
    })]);
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
    const deletedRegistrationRow = await internals.loadEvent(
      client,
      matchEventId,
      deletedRegistrationViewerId,
    );

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
    expect(internals.toView(
      deletedRegistrationRow,
      viewer(deletedRegistrationViewerId),
      true,
    )).toMatchObject({
      coordinate: { precision: 'approximate' },
      exactAddress: null,
      viewerRegistration: null,
    });
  });

  it('enforces the real PostgreSQL organizer-contact disclosure matrix and strips discovery output', async () => {
    const internals = service as unknown as {
      loadEvent: (db: PoolClient, id: string, viewerId?: string) => Promise<Record<string, unknown>>;
      toView: (row: Record<string, unknown>, viewerValue: ReturnType<typeof viewer> | undefined, detail: boolean) => Record<string, unknown>;
    };
    const detailFor = async (viewerId?: string) => {
      const row = await internals.loadEvent(client, contactEventId, viewerId);
      return internals.toView(row, viewerId ? viewer(viewerId) : undefined, true);
    };

    await expect(detailFor()).resolves.toMatchObject({ organizerContact: null });
    await expect(detailFor(pendingViewerId)).resolves.toMatchObject({ organizerContact: null });
    await expect(detailFor(deletedRegistrationViewerId)).resolves.toMatchObject({ organizerContact: null });
    await expect(detailFor(offeredViewerId)).resolves.toMatchObject({ organizerContact: null });
    await expect(detailFor(confirmedViewerId)).resolves.toMatchObject({
      organizerContact: { kind: 'email', label: 'Private event desk', value: 'host@example.jp' },
    });
    await expect(detailFor(unrelatedViewerId)).resolves.toMatchObject({
      organizerContact: { kind: 'email', label: 'Private event desk', value: 'host@example.jp' },
    });
    await expect(detailFor(hostId)).resolves.toMatchObject({
      organizerContact: { kind: 'email', label: 'Private event desk', value: 'host@example.jp' },
    });

    const discovery = await service.discovery(undefined, {
      category: 'contact',
      startsAfter: new Date('2030-08-11T00:00:00.000Z'),
      startsBefore: new Date('2030-08-12T00:00:00.000Z'),
      limit: 20,
    }) as { items: Array<Record<string, unknown>> };
    expect(discovery.items).toHaveLength(1);
    expect(discovery.items[0]).not.toHaveProperty('organizerContact');

    const columns = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name,data_type FROM information_schema.columns
       WHERE table_schema='events' AND table_name='event_contact_channels'
       ORDER BY column_name`,
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      { column_name: 'label_cipher', data_type: 'bytea' },
      { column_name: 'value_cipher', data_type: 'bytea' },
    ]));
    expect(columns.rows).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ column_name: 'label' }),
      expect.objectContaining({ column_name: 'value_hash' }),
    ]));
  });

  it('keeps private contact and exact address plaintext out of real revision and idempotency JSON', async () => {
    const database = {
      transaction: async <T>(work: (db: PoolClient) => Promise<T>) => work(client),
    };
    const fieldCrypto = {
      encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
      decrypt: (cipher: Buffer) => {
        const value = cipher.toString('utf8');
        return value.startsWith('encrypted:')
          ? value.slice('encrypted:'.length)
          : '東京都渋谷区1-2-3';
      },
      lookupHash: integrationLookupHash,
    };
    const mutatingService = new EventsService(
      database as never,
      fieldCrypto as never,
      new IdempotencyService(),
      {} as never,
    );
    const version = await client.query<{ version: string }>(
      'SELECT version FROM events.events WHERE id=$1',
      [contactEventId],
    );
    const idempotencyKey = '50000000-0000-7000-8000-000000000020';
    const contactUpdate = {
      organizerContact: {
        kind: 'email' as const,
        label: 'Updated private event desk',
        value: 'updated-host@example.jp',
      },
    };

    const response = await mutatingService.update(
      viewer(hostId),
      contactEventId,
      idempotencyKey,
      Number(version.rows[0]!.version),
      contactUpdate,
    ) as Record<string, unknown>;

    expect(response).toMatchObject({ exactAddress: null, organizerContact: null });
    const revision = await client.query<{ before_json: unknown; after_json: unknown }>(
      `SELECT before_json,after_json FROM events.event_revisions
       WHERE event_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [contactEventId],
    );
    const replay = await client.query<{ request_hash: Buffer; response_body: unknown }>(
      'SELECT request_hash,response_body FROM sync.idempotency_keys WHERE user_id=$1 AND key=$2',
      [hostId, idempotencyKey],
    );
    for (const persisted of [revision.rows[0], replay.rows[0]]) {
      const serialized = JSON.stringify(persisted);
      expect(serialized).not.toContain('updated-host@example.jp');
      expect(serialized).not.toContain('Updated private event desk');
      expect(serialized).not.toContain('東京都渋谷区1-2-3');
    }
    const publicDictionaryHash = new IdempotencyService().requestHash(
      'PATCH',
      `/events/${contactEventId}`,
      contactUpdate,
    );
    expect(replay.rows[0]!.request_hash).not.toEqual(publicDictionaryHash);
    expect(replay.rows[0]!.request_hash).toHaveLength(32);

    const encrypted = await client.query<{
      label_cipher: Buffer;
      value_cipher: Buffer;
    }>(
      'SELECT label_cipher,value_cipher FROM events.event_contact_channels WHERE event_id=$1',
      [contactEventId],
    );
    expect(encrypted.rows[0]?.label_cipher.toString('utf8')).toBe('encrypted:Updated private event desk');
    expect(encrypted.rows[0]?.value_cipher.toString('utf8')).toBe('encrypted:updated-host@example.jp');

    const liveVersion = await client.query<{ version: string }>(
      'SELECT version FROM events.events WHERE id=$1',
      [contactEventId],
    );
    const secondIdempotencyKey = '50000000-0000-7000-8000-000000000022';
    await mutatingService.update(
      viewer(hostId),
      contactEventId,
      secondIdempotencyKey,
      Number(liveVersion.rows[0]!.version),
      contactUpdate,
    );
    const fingerprints = await client.query<{ request_hash: Buffer }>(
      `SELECT request_hash FROM sync.idempotency_keys
       WHERE user_id=$1 AND key = ANY($2::uuid[]) ORDER BY key`,
      [hostId, [idempotencyKey, secondIdempotencyKey]],
    );
    expect(fingerprints.rows).toHaveLength(2);
    expect(fingerprints.rows[0]!.request_hash).not.toEqual(fingerprints.rows[1]!.request_hash);

    const removalVersion = await client.query<{ version: string }>(
      'SELECT version FROM events.events WHERE id=$1',
      [contactEventId],
    );
    await expect(mutatingService.update(
      viewer(hostId),
      contactEventId,
      '50000000-0000-7000-8000-000000000021',
      Number(removalVersion.rows[0]!.version),
      { organizerContact: null },
    )).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      status: 422,
      fieldErrors: [expect.objectContaining({ field: 'organizerContact' })],
    });
    const preserved = await client.query<{ label_cipher: Buffer; value_cipher: Buffer }>(
      'SELECT label_cipher,value_cipher FROM events.event_contact_channels WHERE event_id=$1',
      [contactEventId],
    );
    expect(preserved.rows[0]?.label_cipher.toString('utf8')).toBe('encrypted:Updated private event desk');
    expect(preserved.rows[0]?.value_cipher.toString('utf8')).toBe('encrypted:updated-host@example.jp');
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
    const hosted = await service.hosted(viewer(hostId)) as { items: Array<Record<string, unknown>> };
    expect(hosted.items.find((item) => item.id === coordinateDraftId)).toMatchObject({
      region: null,
      publicArea: null,
      fee: null,
      coordinate: { latitude: 35.6895, longitude: 139.6917, precision: 'exact' },
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
