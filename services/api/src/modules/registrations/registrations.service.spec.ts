import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationsService } from './registrations.service.js';

describe('RegistrationsService correction window', () => {
  afterEach(() => vi.useRealTimers());

  it('does not open post-event correction requests while the event is still running', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T10:30:00.000Z'));
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          starts_at: new Date('2026-07-15T10:00:00.000Z'),
          ends_at: new Date('2026-07-15T11:00:00.000Z'),
        }],
      }),
    };
    const points = { configBigInt: vi.fn().mockResolvedValue(60n) };
    const service = new RegistrationsService({} as never, {} as never, points as never);
    const checkinWindow = service as unknown as {
      assertCheckinWindow: (
        transactionClient: typeof client,
        eventId: string,
        allowCorrection: boolean,
        correctionOnly: boolean,
      ) => Promise<'normal' | 'correction'>;
    };

    await expect(checkinWindow.assertCheckinWindow(
      client,
      '019b0000-0000-7000-8100-000000000001',
      true,
      true,
    )).rejects.toMatchObject({ code: 'CHECKIN_WINDOW_CLOSED' });
  });

  it('accepts a correction request for 48 hours after the event ends', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T10:00:00.000Z'));
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          starts_at: new Date('2026-07-15T10:00:00.000Z'),
          ends_at: new Date('2026-07-15T11:00:00.000Z'),
        }],
      }),
    };
    const points = { configBigInt: vi.fn().mockResolvedValue(60n) };
    const service = new RegistrationsService({} as never, {} as never, points as never);
    const checkinWindow = service as unknown as {
      assertCheckinWindow: (
        transactionClient: typeof client,
        eventId: string,
        allowCorrection: boolean,
        correctionOnly: boolean,
      ) => Promise<'normal' | 'correction'>;
    };

    await expect(checkinWindow.assertCheckinWindow(
      client,
      '019b0000-0000-7000-8100-000000000001',
      true,
      true,
    )).resolves.toBe('correction');
  });
});

describe('RegistrationsService host attendee pagination', () => {
  it('filters and orders by the same updated timestamp encoded in nextCursor', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ organizer_id: '019b0000-0000-7000-8000-000000000002' }] })
      .mockResolvedValueOnce({ rows: [] });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    await service.attendees(
      {
        id: '019b0000-0000-7000-8000-000000000002',
        sessionId: 'session',
        phoneVerified: true,
        restrictions: [],
        roles: ['host'],
      },
      '019b0000-0000-7000-8100-000000000001',
      undefined,
      Buffer.from('2026-07-15T10:00:00.000Z').toString('base64url'),
      20,
    );

    expect(query.mock.calls[1]?.[0]).toContain('registration.updated_at < $3');
    expect(query.mock.calls[1]?.[0]).toContain('ORDER BY registration.updated_at DESC');
  });
});

describe('RegistrationsService host correction queue', () => {
  it('returns correction ids with the attendee registration needed for a decision', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ organizer_id: '019b0000-0000-7000-8000-000000000002' }] })
      .mockResolvedValueOnce({
        rows: [{
          id: '019b0000-0000-7000-9000-000000000010',
          registration_id: '019b0000-0000-7000-9000-000000000011',
          user_id: '019b0000-0000-7000-9000-000000000012',
          registration_status: 'correction_pending',
          party_size: 1,
          reason: '现场网络中断',
          status: 'pending',
          created_at: new Date('2026-07-16T01:00:00Z'),
          decided_at: null,
          nickname: 'Hikari',
          public_handle: 'hikari',
        }],
      });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    const result = await service.corrections(
      {
        id: '019b0000-0000-7000-8000-000000000002',
        sessionId: 'session',
        phoneVerified: true,
        restrictions: [],
        roles: ['host'],
      },
      '019b0000-0000-7000-8100-000000000001',
      'pending',
      20,
    ) as { items: Array<{ id: string; registration: { id: string }; attendee: { publicHandle: string } }> };

    expect(result.items[0]?.id).toBe('019b0000-0000-7000-9000-000000000010');
    expect(result.items[0]?.registration.id).toBe('019b0000-0000-7000-9000-000000000011');
    expect(result.items[0]?.attendee.publicHandle).toBe('hikari');
    expect(query.mock.calls[1]?.[0]).toContain('attendance_corrections');
  });

  it('allows an operator to inspect the queue but rejects an unrelated user', async () => {
    const eventId = '019b0000-0000-7000-8100-000000000001';
    const organizerId = '019b0000-0000-7000-8000-000000000002';
    const operatorQuery = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ organizer_id: organizerId }] })
      .mockResolvedValueOnce({ rows: [] });
    const operatorService = new RegistrationsService({ query: operatorQuery } as never, {} as never, {} as never);
    await expect(operatorService.corrections({
      id: '019b0000-0000-7000-8000-000000000003',
      sessionId: 'session',
      phoneVerified: true,
      restrictions: [],
      roles: ['operator'],
    }, eventId, undefined, 50)).resolves.toEqual({ items: [] });

    const unrelatedService = new RegistrationsService({
      query: vi.fn().mockResolvedValue({ rows: [{ organizer_id: organizerId }] }),
    } as never, {} as never, {} as never);
    await expect(unrelatedService.corrections({
      id: '019b0000-0000-7000-8000-000000000004',
      sessionId: 'session',
      phoneVerified: true,
      restrictions: [],
      roles: ['user'],
    }, eventId, undefined, 50)).rejects.toMatchObject({
      code: 'CHECKIN_CORRECTION_FORBIDDEN',
      status: 403,
    });
  });
});

describe('RegistrationsService offered capacity accounting', () => {
  const user = {
    id: '019b0000-0000-7000-8000-000000000003',
    sessionId: 'session',
    phoneVerified: true,
    restrictions: [],
    roles: ['verified'],
  };
  const eventId = '019b0000-0000-7000-8100-000000000001';
  const registrationId = '019b0000-0000-7000-8200-000000000001';
  const offered = {
    id: registrationId,
    event_id: eventId,
    user_id: user.id,
    status: 'offered',
    party_size: 3,
    attendee_note: null,
    version: '1',
    waitlist_joined_at: new Date('2026-07-15T00:00:00.000Z'),
    updated_at: new Date('2026-07-16T00:00:00.000Z'),
    offer_expires_at: new Date('2026-08-01T00:00:00.000Z'),
  };

  function idempotency() {
    return {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn(),
    };
  }

  it('moves all offered people to confirmed capacity when an offer is accepted', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('SELECT e.capacity')) {
          return { rows: [{ capacity: 10, confirmed_count: 4, offered_count: 3 }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const points = {
      configBigInt: vi.fn().mockResolvedValue(10n),
      spend: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RegistrationsService(database as never, idempotency() as never, points as never);
    Object.assign(service, {
      load: vi.fn()
        .mockResolvedValueOnce(offered)
        .mockResolvedValueOnce({ ...offered, status: 'confirmed', version: '2' }),
      recordChange: vi.fn(),
    });

    await service.acceptWaitlist(user, registrationId, '019b0000-0000-7000-9000-000000000001');

    const promotionLock = queries.findIndex(({ text }) => (
      text.includes('FROM events.waitlist_promotions') && text.includes('FOR UPDATE')
    ));
    const capacityLock = queries.findIndex(({ text }) => (
      text.includes('SELECT e.capacity') && text.includes('FOR UPDATE')
    ));
    expect(promotionLock).toBeGreaterThanOrEqual(0);
    expect(capacityLock).toBeGreaterThan(promotionLock);
    const update = queries.find(({ text }) => text.includes('UPDATE events.event_capacity'));
    expect(update?.text).toContain('offered_count = GREATEST(0, offered_count - $2)');
    expect(update?.values).toEqual([eventId, 3]);
  });

  it('releases all offered people when the registration is cancelled', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('SELECT starts_at')) {
          return { rows: [{ starts_at: new Date('2026-08-10T00:00:00.000Z') }] };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const points = {
      wallet: vi.fn().mockResolvedValue({ totalBalance: 0 }),
      configBigInt: vi.fn().mockResolvedValue(24n),
    };
    const service = new RegistrationsService(database as never, idempotency() as never, points as never);
    Object.assign(service, {
      load: vi.fn()
        .mockResolvedValueOnce(offered)
        .mockResolvedValueOnce({ ...offered, status: 'cancelled', version: '2' }),
      recordChange: vi.fn(),
    });

    await service.cancel(user, registrationId, '019b0000-0000-7000-9000-000000000002');

    const promotionLock = queries.findIndex(({ text }) => (
      text.includes('FROM events.waitlist_promotions') && text.includes('FOR UPDATE')
    ));
    const capacityLock = queries.findIndex(({ text }) => (
      text.includes('FROM events.event_capacity') && text.includes('FOR UPDATE')
    ));
    expect(promotionLock).toBeGreaterThanOrEqual(0);
    expect(capacityLock).toBeGreaterThan(promotionLock);
    const update = queries.find(({ text }) => text.includes('confirmed_count = GREATEST'));
    expect(update?.text).toContain("offered_count = GREATEST(0, offered_count - CASE WHEN $2 = 'offered' THEN $3 ELSE 0 END)");
    expect(update?.values).toEqual([eventId, 'offered', 3]);
    const promotion = queries.find(({ text }) => text.includes('UPDATE events.waitlist_promotions'));
    expect(promotion?.values).toEqual([registrationId]);
    expect(promotion?.text).toContain('accepted_at IS NULL AND expired_at IS NULL');
  });
});

const itineraryServerTime = new Date('2026-07-16T03:00:00.000Z');
const itineraryUpdatedAt = new Date('2026-07-16T02:00:00.000Z');

function itineraryRow(overrides: Record<string, unknown> = {}) {
  return {
    server_time: itineraryServerTime,
    id: '019b0000-0000-7000-8200-000000000003',
    event_id: '019b0000-0000-7000-8100-000000000001',
    user_id: '019b0000-0000-7000-8000-000000000001',
    status: 'confirmed',
    party_size: 2,
    attendee_note: null,
    version: '4',
    waitlist_joined_at: null,
    updated_at: itineraryUpdatedAt,
    offer_expires_at: null,
    itinerary_event_id: '019b0000-0000-7000-8100-000000000001',
    itinerary_public_slug: 'evening-walk',
    itinerary_status: 'published',
    itinerary_title: 'Evening walk',
    itinerary_starts_at: new Date('2026-07-20T09:00:00.000Z'),
    itinerary_ends_at: new Date('2026-07-20T11:00:00.000Z'),
    itinerary_display_time_zone: 'Asia/Tokyo',
    itinerary_region: 'tokyo',
    itinerary_public_area: 'Shibuya',
    itinerary_cover_url: 'https://cdn.spott.jp/events/evening-walk.webp',
    itinerary_format: 'in_person',
    itinerary_primary_locale: 'ja',
    itinerary_locale_confirmed_at: new Date('2026-07-01T00:00:00.000Z'),
    itinerary_version: '7',
    itinerary_updated_at: new Date('2026-07-15T02:00:00.000Z'),
    itinerary_checkin_eligible: false,
    ...overrides,
  };
}

describe('RegistrationsService privacy-safe itinerary pagination', () => {
  it('returns the exact itinerary page shape from one joined query and uses database server time', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [itineraryRow()] });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    const result = await service.mine('019b0000-0000-7000-8000-000000000001', undefined, 20) as {
      items: Array<{ registration: Record<string, unknown>; event: Record<string, unknown> | null }>;
      nextCursor: string | null;
      hasMore: boolean;
      serverTime: string;
    };

    expect(query).toHaveBeenCalledOnce();
    expect(result).toEqual({
      items: [{
        registration: {
          id: '019b0000-0000-7000-8200-000000000003',
          eventId: '019b0000-0000-7000-8100-000000000001',
          userId: '019b0000-0000-7000-8000-000000000001',
          status: 'confirmed',
          partySize: 2,
          attendeeNote: null,
          offerExpiresAt: null,
          availableActions: ['cancelRegistration', 'viewTicket'],
          version: 4,
          updatedAt: '2026-07-16T02:00:00.000Z',
        },
        event: {
          id: '019b0000-0000-7000-8100-000000000001',
          publicSlug: 'evening-walk',
          status: 'published',
          title: 'Evening walk',
          startsAt: '2026-07-20T09:00:00.000Z',
          endsAt: '2026-07-20T11:00:00.000Z',
          displayTimeZone: 'Asia/Tokyo',
          region: 'tokyo',
          publicArea: 'Shibuya',
          coverURL: 'https://cdn.spott.jp/events/evening-walk.webp',
          format: 'in_person',
          primaryLocale: 'ja',
          localeConfirmed: true,
          version: 7,
          updatedAt: '2026-07-15T02:00:00.000Z',
        },
      }],
      nextCursor: null,
      hasMore: false,
      serverTime: '2026-07-16T03:00:00.000Z',
    });

    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(values).toEqual([
      '019b0000-0000-7000-8000-000000000001',
      null,
      null,
      21,
    ]);
    expect(sql).toContain('LEFT JOIN events.events');
    expect(sql).toContain('AND r.deleted_at IS NULL');
    expect(sql).toContain('LEFT JOIN events.event_locations');
    expect(sql).toContain('FROM events.event_media');
    expect(sql).toContain("asset.state = 'ready'");
    expect(sql).toContain("asset.moderation_state = 'approved'");
    expect(sql).toContain('FROM events.waitlist_promotions');
    expect(sql).toContain('offer.expires_at > itinerary_clock.server_time');
    expect(sql).toContain('FROM admin.config_revisions');
    expect(sql).toContain("revision.state = 'active'");
    expect(sql).toContain('revision.effective_from <= itinerary_clock.server_time');
    expect(sql).toContain('revision.effective_to > itinerary_clock.server_time');
    expect(sql).toMatch(
      /COALESCE\([\s\S]*?checkin\.window\.before_minutes[\s\S]*?,\s*60\s*\) AS before_minutes/,
    );
    expect(sql).toMatch(
      /COALESCE\([\s\S]*?checkin\.window\.after_minutes[\s\S]*?,\s*120\s*\) AS after_minutes/,
    );
    expect(sql).toContain('itinerary_clock.server_time >= event.starts_at');
    expect(sql).toContain('itinerary_clock.server_time <= event.ends_at');
    expect(sql).toContain('AS itinerary_checkin_eligible');
  });

  it('includes checkIn only when the database marks a confirmed itinerary row inside the window', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [itineraryRow({
        itinerary_starts_at: new Date('2026-07-16T03:30:00.000Z'),
        itinerary_ends_at: new Date('2026-07-16T05:00:00.000Z'),
        itinerary_checkin_eligible: true,
      })],
    });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    const page = await service.mine('019b0000-0000-7000-8000-000000000001') as {
      items: Array<{ registration: { availableActions: string[] } }>;
    };

    expect(page.items[0]?.registration.availableActions).toEqual([
      'cancelRegistration',
      'viewTicket',
      'checkIn',
    ]);
    expect(query).toHaveBeenCalledOnce();
  });

  it('keeps a registration when its event is unavailable', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [itineraryRow({
        itinerary_event_id: null,
        itinerary_public_slug: null,
        itinerary_status: null,
        itinerary_title: null,
        itinerary_starts_at: null,
        itinerary_ends_at: null,
        itinerary_display_time_zone: null,
        itinerary_region: null,
        itinerary_public_area: null,
        itinerary_cover_url: null,
        itinerary_format: null,
        itinerary_primary_locale: null,
        itinerary_locale_confirmed_at: null,
        itinerary_version: null,
        itinerary_updated_at: null,
      })],
    });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    const page = await service.mine('019b0000-0000-7000-8000-000000000001') as {
      items: Array<{ registration: { id: string; availableActions: string[] }; event: unknown }>;
    };

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.registration.id).toBe('019b0000-0000-7000-8200-000000000003');
    expect(page.items[0]?.registration.availableActions).not.toContain('checkIn');
    expect(page.items[0]?.event).toBeNull();
  });

  it('never serializes detail, location-secret, coordinate, join, or question fields', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [itineraryRow({
        exact_address_cipher: Buffer.from('secret'),
        exact_latitude: 35.658,
        exact_longitude: 139.701,
        join_url: 'https://meet.example/secret',
        join_instructions: 'secret',
        registration_questions: [{ prompt: 'private' }],
        description: 'detail copy',
        organizer_id: '019b0000-0000-7000-8000-000000000099',
      })],
    });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    const page = await service.mine('019b0000-0000-7000-8000-000000000001') as {
      items: Array<{ event: Record<string, unknown> }>;
    };

    expect(Object.keys(page.items[0]!.event)).toEqual([
      'id',
      'publicSlug',
      'status',
      'title',
      'startsAt',
      'endsAt',
      'displayTimeZone',
      'region',
      'publicArea',
      'coverURL',
      'format',
      'primaryLocale',
      'localeConfirmed',
      'version',
      'updatedAt',
    ]);
    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).not.toContain('exact_address');
    expect(sql).not.toContain('ST_X');
    expect(sql).not.toContain('ST_Y');
    expect(sql).not.toContain('registration_questions');
    expect(sql).not.toContain('e.description');
  });

  it('uses updated_at and id together so equal timestamps cross pages without duplicates or skips', async () => {
    const registrationIds = [
      '019b0000-0000-7000-8200-000000000003',
      '019b0000-0000-7000-8200-000000000002',
      '019b0000-0000-7000-8200-000000000001',
    ];
    const query = vi.fn(async (_sql: string, values: unknown[]) => {
      if (values[1] === null) {
        return {
          rows: registrationIds.map((id) => itineraryRow({ id })),
        };
      }
      expect(values[1]).toBe('2026-07-16T02:00:00.000Z');
      expect(values[2]).toBe(registrationIds[1]);
      return { rows: [itineraryRow({ id: registrationIds[2] })] };
    });
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);

    const first = await service.mine('019b0000-0000-7000-8000-000000000001', undefined, 2) as {
      items: Array<{ registration: { id: string } }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    const decoded = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as unknown;
    const second = await service.mine(
      '019b0000-0000-7000-8000-000000000001',
      first.nextCursor!,
      2,
    ) as { items: Array<{ registration: { id: string } }>; hasMore: boolean };

    expect(decoded).toEqual({
      date: '2026-07-16T02:00:00.000Z',
      id: registrationIds[1],
    });
    expect(first.items.map((item) => item.registration.id)).toEqual(registrationIds.slice(0, 2));
    expect(second.items.map((item) => item.registration.id)).toEqual([registrationIds[2]]);
    expect(new Set([...first.items, ...second.items].map((item) => item.registration.id)).size).toBe(3);
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);

    const secondSQL = query.mock.calls[1]?.[0] as string;
    expect(secondSQL).toContain('(r.updated_at, r.id) < ($2::timestamptz, $3::uuid)');
    expect(secondSQL).toContain('ORDER BY r.updated_at DESC, r.id DESC');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('rejects a cursor that does not contain a canonical date and registration id', async () => {
    const query = vi.fn();
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);
    const invalid = Buffer.from(JSON.stringify({ date: '2026-07-16', id: 'not-a-uuid' })).toString('base64url');

    await expect(service.mine('019b0000-0000-7000-8000-000000000001', invalid)).rejects.toMatchObject({
      code: 'CURSOR_INVALID',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
