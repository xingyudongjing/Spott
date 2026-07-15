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
