import { afterEach, describe, expect, it, vi } from 'vitest';
import { RegistrationsService } from './registrations.service.js';

const registrationUser = {
  id: '019b0000-0000-7000-8000-000000000010',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['verified'],
};

function registrationIdempotency() {
  return {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
    claim: vi.fn().mockResolvedValue(null),
    complete: vi.fn(),
  };
}

describe('RegistrationsService event registration authority', () => {
  const eventId = '019b0000-0000-7000-8100-000000000010';
  const input = {
    partySize: 1,
    quoteId: '019b0000-0000-7000-9100-000000000010',
    expectedEventVersion: 6,
    joinWaitlistIfFull: false,
    answers: {},
  };

  it('returns EVENT_CHANGED with the locked current version before writing registration state', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: eventId,
          status: 'published',
          capacity: 10,
          deadline_at: new Date('2099-07-20T00:00:00.000Z'),
          ends_at: new Date('2099-07-21T00:00:00.000Z'),
          registration_mode: 'automatic',
          waitlist_enabled: true,
          confirmed_count: 0,
          pending_count: 0,
          offered_count: 0,
          version: '7',
          server_time: new Date('2099-07-16T00:00:00.000Z'),
        }],
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new RegistrationsService(
      database as never,
      registrationIdempotency() as never,
      {} as never,
    );

    await expect(service.register(
      registrationUser as never,
      eventId,
      '019b0000-0000-7000-9000-000000000010',
      input,
    )).rejects.toMatchObject({
      code: 'EVENT_CHANGED',
      status: 409,
      meta: { currentVersion: 7 },
    });

    const [eventSQL] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(eventSQL).toContain('FOR UPDATE OF e, c');
    expect(client.query).toHaveBeenCalledOnce();
  });

  it('fails closed with INVITE_REQUIRED when no event invitation model can authorize the user', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          id: eventId,
          status: 'published',
          capacity: 10,
          deadline_at: new Date('2099-07-20T00:00:00.000Z'),
          ends_at: new Date('2099-07-21T00:00:00.000Z'),
          registration_mode: 'invite_only',
          waitlist_enabled: true,
          confirmed_count: 0,
          pending_count: 0,
          offered_count: 0,
          version: '6',
          server_time: new Date('2099-07-16T00:00:00.000Z'),
        }],
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new RegistrationsService(
      database as never,
      registrationIdempotency() as never,
      {} as never,
    );

    await expect(service.register(
      registrationUser as never,
      eventId,
      '019b0000-0000-7000-9000-000000000011',
      input,
    )).rejects.toMatchObject({
      code: 'INVITE_REQUIRED',
      status: 403,
    });
    expect(client.query).toHaveBeenCalledOnce();
  });
});

describe('RegistrationsService correction window', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('uses one database clock and one active-config snapshot with inclusive normal boundaries', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          normal_eligible: true,
          correction_eligible: false,
        }],
      }),
    };
    const points = { configBigInt: vi.fn().mockRejectedValue(new Error('must not load separately')) };
    const service = new RegistrationsService({} as never, {} as never, points as never);
    const checkinWindow = service as unknown as {
      assertCheckinWindow: (
        transactionClient: typeof client,
        eventId: string,
        allowCorrection: boolean,
        correctionOnly: boolean,
      ) => Promise<'normal' | 'correction'>;
    };

    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('application clock must not determine the check-in window');
    });

    await expect(checkinWindow.assertCheckinWindow(
      client,
      '019b0000-0000-7000-8100-000000000001',
      false,
      false,
    )).resolves.toBe('normal');

    expect(client.query).toHaveBeenCalledOnce();
    expect(points.configBigInt).not.toHaveBeenCalled();
    const [sql, values] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual(['019b0000-0000-7000-8100-000000000001']);
    expect(sql).toContain('SELECT clock_timestamp() AS server_time');
    expect(sql).toContain('revision.effective_from <= checkin_clock.server_time');
    expect(sql).toContain('revision.effective_to > checkin_clock.server_time');
    expect(sql).toContain('checkin_clock.server_time >= event.starts_at');
    expect(sql).toContain('checkin_clock.server_time <= event.ends_at');
  });

  it('keeps correction closed while running even if the normal window is open', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          normal_eligible: true,
          correction_eligible: false,
        }],
      }),
    };
    const service = new RegistrationsService({} as never, {} as never, {} as never);
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

  it('accepts the exact event-end boundary as a correction when requested', async () => {
    const client = {
      query: vi.fn().mockResolvedValue({
        rows: [{
          normal_eligible: true,
          correction_eligible: true,
        }],
      }),
    };
    const service = new RegistrationsService({} as never, {} as never, {} as never);
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

describe('RegistrationsService dynamic QR validation', () => {
  it('lets PostgreSQL validate event ownership and validity time before the constant-time hash check', async () => {
    const user = {
      id: '019b0000-0000-7000-8000-000000000003',
      sessionId: 'session',
      phoneVerified: true,
      restrictions: [],
      roles: ['verified'],
    };
    const eventId = '019b0000-0000-7000-8100-000000000001';
    const registrationId = '019b0000-0000-7000-8200-000000000001';
    const codeId = '019b0000-0000-7000-8300-000000000001';
    const secret = 'dynamic-secret';
    const tokenHash = Buffer.alloc(32, 7);
    const confirmed = {
      id: registrationId,
      event_id: eventId,
      user_id: user.id,
      status: 'confirmed',
      party_size: 1,
      attendee_note: null,
      version: '1',
      waitlist_joined_at: null,
      updated_at: new Date('2026-07-16T00:00:00.000Z'),
      offer_expires_at: null,
    };
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('FROM events.dynamic_checkin_codes')) {
          return {
            rows: [{
              event_id: eventId,
              token_hash: tokenHash,
              valid_from: new Date('2000-01-01T00:00:00.000Z'),
              valid_until: new Date('2100-01-01T00:00:00.000Z'),
              revoked_at: null,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn(),
    };
    const service = new RegistrationsService(database as never, idempotency as never, {} as never);
    Object.assign(service, {
      tokenHash: vi.fn().mockReturnValue(tokenHash),
      load: vi.fn()
        .mockResolvedValueOnce(confirmed)
        .mockResolvedValueOnce({ ...confirmed, status: 'checked_in', version: '2' }),
      assertCheckinWindow: vi.fn().mockResolvedValue('normal'),
      awardAttendance: vi.fn().mockResolvedValue(0),
      recordChange: vi.fn(),
    });

    await service.checkIn(user, '019b0000-0000-7000-9000-000000000001', {
      registrationId,
      token: `${codeId}.${secret}`,
      operationId: '019b0000-0000-7000-9000-000000000002',
    });

    const validation = queries.find(({ text }) => text.includes('FROM events.dynamic_checkin_codes'))!;
    expect(validation.values).toEqual([codeId, eventId]);
    expect(validation.text).toMatch(/SELECT token_hash\s+FROM events\.dynamic_checkin_codes/);
    expect(validation.text).toContain('event_id = $2');
    expect(validation.text).toContain('revoked_at IS NULL');
    expect(validation.text).toContain('valid_from <= clock_timestamp()');
    expect(validation.text).toContain('valid_until > clock_timestamp()');
  });
});

describe('RegistrationsService check-in code window', () => {
  it('does not mint a code outside the same authoritative normal window', async () => {
    const host = {
      id: '019b0000-0000-7000-8000-000000000002',
      sessionId: 'session',
      phoneVerified: true,
      restrictions: [],
      roles: ['host'],
    };
    const eventId = '019b0000-0000-7000-8100-000000000001';
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          organizer_id: host.id,
          status: 'published',
          starts_at: new Date('2026-08-01T10:00:00.000Z'),
          ends_at: new Date('2026-08-01T12:00:00.000Z'),
          checkin_mode: 'dynamic_qr',
          checkin_eligible: false,
        }],
      })
      .mockRejectedValueOnce(new Error('mint attempted outside the authoritative window'));
    const service = new RegistrationsService({ query } as never, {} as never, {} as never);
    Object.assign(service, { tokenHash: vi.fn().mockReturnValue(Buffer.alloc(32, 3)) });

    await expect(service.createCheckinCode(host, eventId)).rejects.toMatchObject({
      code: 'CHECKIN_WINDOW_CLOSED',
      status: 422,
    });
    expect(query).toHaveBeenCalledOnce();
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual([eventId]);
    expect(sql).toMatch(/WITH\s+checkin_clock AS/);
    expect(sql).toContain('AS checkin_eligible');
    expect(sql).toContain('checkin_clock.server_time >= event.starts_at');
    expect(sql).toContain('checkin_clock.server_time <= event.ends_at');
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
  const acceptanceInput = {
    quoteId: '019b0000-0000-7000-9100-000000000001',
    expectedRegistrationVersion: 1,
    expectedEventVersion: 8,
  };
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

  function acceptanceHarness(options: {
    registration?: typeof offered;
    eventVersion?: string;
    replay?: { status: number; body: unknown };
    quoteError?: { code: string; status: number };
    spendError?: { code: string; status: number };
  } = {}) {
    const registration = options.registration ?? offered;
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    let registrationLoads = 0;
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('FROM events.registrations r')) {
          registrationLoads += 1;
          return {
            rows: [registrationLoads === 1
              ? registration
              : { ...registration, status: 'confirmed', version: String(Number(registration.version) + 1) }],
          };
        }
        if (text.includes('FROM events.waitlist_promotions') && text.includes('FOR UPDATE')) {
          return {
            rows: [{
              id: '019b0000-0000-7000-8300-000000000001',
              expires_at: new Date('2099-08-01T00:00:00.000Z'),
            }],
          };
        }
        if (text.includes('SELECT e.capacity')) {
          return {
            rows: [{
              capacity: 10,
              confirmed_count: 4,
              offered_count: 3,
              status: 'published',
              ends_at: new Date('2099-08-02T00:00:00.000Z'),
              deadline_at: new Date('2099-08-01T12:00:00.000Z'),
              version: options.eventVersion ?? '8',
              server_time: new Date('2099-07-16T00:00:00.000Z'),
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const idempotencyService = idempotency();
    if (options.replay) idempotencyService.claim.mockResolvedValue(options.replay);
    const points = {
      configBigInt: vi.fn().mockResolvedValue(10n),
      consumeQuote: options.quoteError
        ? vi.fn().mockRejectedValue(options.quoteError)
        : vi.fn().mockResolvedValue(37n),
      spend: options.spendError
        ? vi.fn().mockRejectedValue(options.spendError)
        : vi.fn().mockResolvedValue(undefined),
    };
    const service = new RegistrationsService(
      database as never,
      idempotencyService as never,
      points as never,
    );
    Object.assign(service, { recordChange: vi.fn() });
    return { service, client, idempotencyService, points, queries };
  }

  it('moves all offered people to confirmed capacity when an offer is accepted', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('FROM events.waitlist_promotions') && text.includes('FOR UPDATE')) {
          return {
            rows: [{
              id: '019b0000-0000-7000-8300-000000000001',
              expires_at: new Date('2026-08-01T00:00:00.000Z'),
            }],
          };
        }
        if (text.includes('SELECT e.capacity')) {
          return {
            rows: [{
              capacity: 10,
              confirmed_count: 4,
              offered_count: 3,
              status: 'published',
              ends_at: new Date('2026-08-02T00:00:00.000Z'),
              deadline_at: new Date('2026-08-01T12:00:00.000Z'),
              version: '8',
              server_time: new Date('2026-07-16T00:00:00.000Z'),
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const points = {
      configBigInt: vi.fn().mockResolvedValue(10n),
      consumeQuote: vi.fn().mockResolvedValue(37n),
      spend: vi.fn().mockResolvedValue(undefined),
    };
    const idempotencyService = idempotency();
    const service = new RegistrationsService(database as never, idempotencyService as never, points as never);
    Object.assign(service, {
      load: vi.fn()
        .mockResolvedValueOnce(offered)
        .mockResolvedValueOnce({ ...offered, status: 'confirmed', version: '2' }),
      recordChange: vi.fn(),
    });

    await service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000001',
      acceptanceInput,
    );

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
    expect(points.consumeQuote).toHaveBeenCalledWith(
      client,
      user.id,
      acceptanceInput.quoteId,
      'registration',
      eventId,
    );
    expect(points.configBigInt).not.toHaveBeenCalled();
    expect(points.spend).toHaveBeenCalledWith(
      client,
      user.id,
      37n,
      'registration_fee',
      `registration_fee:${registrationId}`,
      { registrationId, eventId },
    );
    expect(idempotencyService.requestHash).toHaveBeenCalledWith(
      'POST',
      `/registrations/${registrationId}/waitlist-acceptance`,
      acceptanceInput,
    );
    expect(idempotencyService.complete).toHaveBeenCalledWith(
      client,
      user.id,
      '019b0000-0000-7000-9000-000000000001',
      expect.objectContaining({ status: 200 }),
      { type: 'registration', id: registrationId },
    );
  });

  it.each([
    {
      label: 'the event is no longer published',
      event: {
        status: 'registration_closed',
        ends_at: new Date('2099-07-21T00:00:00.000Z'),
        deadline_at: new Date('2099-07-20T00:00:00.000Z'),
      },
    },
    {
      label: 'the event end is exactly the database time',
      event: {
        status: 'published',
        ends_at: new Date('2099-07-16T00:00:00.000Z'),
        deadline_at: new Date('2099-07-20T00:00:00.000Z'),
      },
    },
    {
      label: 'the registration deadline is exactly the database time',
      event: {
        status: 'published',
        ends_at: new Date('2099-07-21T00:00:00.000Z'),
        deadline_at: new Date('2099-07-16T00:00:00.000Z'),
      },
    },
  ])('rejects waitlist acceptance when $label', async ({ event }) => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('FROM events.registrations r')) {
          return {
            rows: [{
              ...offered,
              offer_expires_at: new Date('2099-07-20T00:00:00.000Z'),
            }],
          };
        }
        if (text.includes('SELECT e.capacity')) {
          return {
            rows: [{
              capacity: 10,
              confirmed_count: 4,
              offered_count: 3,
              version: '8',
              server_time: new Date('2099-07-16T00:00:00.000Z'),
              ...event,
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const points = {
      configBigInt: vi.fn().mockResolvedValue(10n),
      consumeQuote: vi.fn().mockResolvedValue(10n),
      spend: vi.fn().mockResolvedValue(undefined),
    };
    const service = new RegistrationsService(database as never, idempotency() as never, points as never);

    await expect(service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000009',
      acceptanceInput,
    )).rejects.toMatchObject({
      code: 'WAITLIST_ACCEPTANCE_CLOSED',
      status: 409,
    });

    expect(points.spend).not.toHaveBeenCalled();
    expect(queries.some(({ text }) => text.includes("SET status = 'confirmed'"))).toBe(false);
  });

  it('rejects a stale reviewed registration version after locking all acceptance state', async () => {
    const { service, points, queries } = acceptanceHarness({
      registration: { ...offered, version: '2' },
    });

    await expect(service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000011',
      acceptanceInput,
    )).rejects.toMatchObject({
      code: 'REGISTRATION_CHANGED',
      status: 409,
      meta: { currentVersion: 2 },
    });

    expect(queries.findIndex(({ text }) => text.includes('FOR UPDATE OF r'))).toBeGreaterThanOrEqual(0);
    expect(queries.findIndex(({ text }) => text.includes('FROM events.waitlist_promotions'))).toBeGreaterThanOrEqual(0);
    expect(queries.findIndex(({ text }) => text.includes('FOR UPDATE OF e, c'))).toBeGreaterThanOrEqual(0);
    expect(points.consumeQuote).not.toHaveBeenCalled();
    expect(points.spend).not.toHaveBeenCalled();
  });

  it('rejects a stale reviewed event version after locking capacity', async () => {
    const { service, points, queries } = acceptanceHarness({ eventVersion: '9' });

    await expect(service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000012',
      acceptanceInput,
    )).rejects.toMatchObject({
      code: 'EVENT_CHANGED',
      status: 409,
      meta: { currentVersion: 9 },
    });

    expect(queries.some(({ text }) => text.includes('FOR UPDATE OF e, c'))).toBe(true);
    expect(points.consumeQuote).not.toHaveBeenCalled();
    expect(points.spend).not.toHaveBeenCalled();
  });

  it.each([
    ['has expired', { code: 'QUOTE_EXPIRED', status: 409 }],
    ['belongs to a different event', { code: 'QUOTE_EXPIRED', status: 409 }],
  ])('does not mutate acceptance state when the quote %s', async (_label, quoteError) => {
    const { service, points, queries } = acceptanceHarness({ quoteError });

    await expect(service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000013',
      acceptanceInput,
    )).rejects.toMatchObject(quoteError);

    expect(points.consumeQuote).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      acceptanceInput.quoteId,
      'registration',
      eventId,
    );
    expect(points.spend).not.toHaveBeenCalled();
    expect(queries.some(({ text }) => text.includes("SET status = 'confirmed'"))).toBe(false);
    expect(queries.some(({ text }) => text.includes('SET accepted_at'))).toBe(false);
  });

  it('does not mutate acceptance state when the locked quote exceeds the available points', async () => {
    const pointsError = { code: 'POINTS_INSUFFICIENT', status: 409 };
    const { service, points, queries } = acceptanceHarness({ spendError: pointsError });

    await expect(service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000014',
      acceptanceInput,
    )).rejects.toMatchObject(pointsError);

    expect(points.consumeQuote).toHaveBeenCalledOnce();
    expect(points.configBigInt).not.toHaveBeenCalled();
    expect(points.spend).toHaveBeenCalledWith(
      expect.anything(),
      user.id,
      37n,
      'registration_fee',
      `registration_fee:${registrationId}`,
      { registrationId, eventId },
    );
    expect(queries.some(({ text }) => text.includes("SET status = 'confirmed'"))).toBe(false);
    expect(queries.some(({ text }) => text.includes('SET accepted_at'))).toBe(false);
  });

  it('replays a completed response without consuming the quote or charging points again', async () => {
    const replayed = {
      id: registrationId,
      eventId,
      status: 'confirmed',
      version: 2,
    };
    const { service, client, idempotencyService, points } = acceptanceHarness({
      replay: { status: 200, body: replayed },
    });

    await expect(service.acceptWaitlist(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000015',
      acceptanceInput,
    )).resolves.toEqual(replayed);

    expect(idempotencyService.requestHash).toHaveBeenCalledWith(
      'POST',
      `/registrations/${registrationId}/waitlist-acceptance`,
      acceptanceInput,
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(points.consumeQuote).not.toHaveBeenCalled();
    expect(points.spend).not.toHaveBeenCalled();
  });

  it('releases all offered people when the registration is cancelled', async () => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('FROM events.events e JOIN events.event_capacity')) {
          return {
            rows: [{
              status: 'published',
              starts_at: new Date('2026-08-10T00:00:00.000Z'),
              ends_at: new Date('2026-08-10T02:00:00.000Z'),
              server_time: new Date('2026-07-16T00:00:00.000Z'),
            }],
          };
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
      text.includes('JOIN events.event_capacity') && text.includes('FOR UPDATE OF e, c')
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

  it.each([
    {
      label: 'the published event reaches its exact start boundary',
      status: 'published',
      startsAt: new Date('2099-07-16T00:00:00.000Z'),
    },
    {
      label: 'the event is in progress',
      status: 'in_progress',
      startsAt: new Date('2099-07-17T00:00:00.000Z'),
    },
    {
      label: 'the event has ended',
      status: 'ended',
      startsAt: new Date('2099-07-17T00:00:00.000Z'),
    },
    {
      label: 'the event is cancelled',
      status: 'cancelled',
      startsAt: new Date('2099-07-17T00:00:00.000Z'),
    },
  ])('locks event capacity and rejects cancellation when $label', async ({ status, startsAt }) => {
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
        queries.push({ text, values });
        if (text.includes('FROM events.events e JOIN events.event_capacity')) {
          return {
            rows: [{
              status,
              starts_at: startsAt,
              ends_at: new Date('2099-07-18T00:00:00.000Z'),
              server_time: new Date('2099-07-16T00:00:00.000Z'),
            }],
          };
        }
        if (text.includes('SELECT starts_at FROM events.events')) {
          return { rows: [{ starts_at: startsAt }] };
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

    await expect(service.cancel(
      user,
      registrationId,
      '019b0000-0000-7000-9000-000000000010',
    )).rejects.toMatchObject({
      code: 'REGISTRATION_CANCELLATION_CLOSED',
      status: 409,
    });

    const eventLock = queries.find(({ text }) => text.includes('FROM events.events e JOIN events.event_capacity'));
    expect(eventLock?.text).toContain('FOR UPDATE OF e, c');
    expect(queries.some(({ text }) => text.includes("SET status = 'cancelled'"))).toBe(false);
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

describe('RegistrationsService registration action authority', () => {
  it('does not advertise checkIn unless an authoritative window result explicitly enables it', () => {
    const service = new RegistrationsService({} as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (row: ReturnType<typeof itineraryRow>, checkInEligible?: boolean) => {
        availableActions: string[];
      };
    };

    expect(mapper.toView(itineraryRow()).availableActions).toEqual([
      'cancelRegistration',
      'viewTicket',
    ]);
    expect(mapper.toView(itineraryRow(), true).availableActions).toEqual([
      'cancelRegistration',
      'viewTicket',
      'checkIn',
    ]);
  });

  it.each([
    {
      label: 'the database time reaches the exact event start',
      overrides: {
        itinerary_status: 'published',
        itinerary_starts_at: itineraryServerTime,
      },
    },
    {
      label: 'the event is in progress',
      overrides: {
        itinerary_status: 'in_progress',
        itinerary_starts_at: new Date('2026-07-20T09:00:00.000Z'),
      },
    },
    {
      label: 'the event has ended',
      overrides: {
        itinerary_status: 'ended',
        itinerary_starts_at: new Date('2026-07-20T09:00:00.000Z'),
      },
    },
    {
      label: 'the event was cancelled',
      overrides: {
        itinerary_status: 'cancelled',
        itinerary_starts_at: new Date('2026-07-20T09:00:00.000Z'),
      },
    },
  ])('does not advertise cancellation when $label', ({ overrides }) => {
    const service = new RegistrationsService({} as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (row: ReturnType<typeof itineraryRow>, checkInEligible?: boolean) => {
        availableActions: string[];
      };
    };

    expect(mapper.toView(itineraryRow(overrides)).availableActions).not.toContain('cancelRegistration');
  });
});

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
          ticketTypeId: null,
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
    expect(sql).toContain('offer.expires_at > checkin_clock.server_time');
    expect(sql).toContain('FROM admin.config_revisions');
    expect(sql).toContain("revision.state = 'active'");
    expect(sql).toContain('revision.effective_from <= checkin_clock.server_time');
    expect(sql).toContain('revision.effective_to > checkin_clock.server_time');
    expect(sql).toContain("jsonb_typeof(config.value_json) IN ('number', 'string')");
    expect(sql).toContain("~ '^[0-9]{1,6}$'");
    expect(sql).toContain('config.minutes BETWEEN 0 AND 525600');
    expect(sql).toMatch(
      /COALESCE\([\s\S]*?checkin\.window\.before_minutes[\s\S]*?,\s*60\s*\) AS before_minutes/,
    );
    expect(sql).toMatch(
      /COALESCE\([\s\S]*?checkin\.window\.after_minutes[\s\S]*?,\s*120\s*\) AS after_minutes/,
    );
    expect(sql).toContain('checkin_clock.server_time >= event.starts_at');
    expect(sql).toContain('checkin_clock.server_time <= event.ends_at');
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

describe('RegistrationsService approval decision point hold authority', () => {
  const hostUser = {
    id: '019b0000-0000-7000-8000-000000000099',
    sessionId: 'session',
    phoneVerified: true,
    restrictions: [],
    roles: ['verified'],
  };
  const registrationId = '019b0000-0000-7000-8200-000000000010';

  function decideClient(holdRows: Array<{ id: string; capturable: boolean }>) {
    const seen: string[] = [];
    const client = {
      query: vi.fn(async (text: string) => {
        seen.push(text);
        if (text.includes('FROM events.registrations r')) {
          return {
            rows: [{
              id: registrationId,
              event_id: '019b0000-0000-7000-8100-000000000010',
              user_id: '019b0000-0000-7000-8000-000000000010',
              status: 'pending',
              party_size: 1,
              attendee_note: null,
              version: '1',
              waitlist_joined_at: null,
              updated_at: new Date('2026-07-16T00:00:00.000Z'),
              offer_expires_at: null,
            }],
          };
        }
        if (text.includes('FROM events.events event')) {
          return {
            rows: [{
              organizer_id: hostUser.id,
              capacity: 10,
              confirmed_count: 0,
              pending_count: 1,
              offered_count: 0,
            }],
          };
        }
        if (text.includes('FROM commerce.point_holds')) return { rows: holdRows };
        return { rows: [] };
      }),
    };
    return { client, seen };
  }

  it('only locks an active hold so a dead hold never reaches the capture', async () => {
    const { client, seen } = decideClient([{ id: 'hold-1', capturable: true }]);
    const database = {
      transaction: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const captureHold = vi.fn().mockResolvedValue({ transactionId: 'tx-1', wallet: {} });
    const service = new RegistrationsService(
      database as never,
      registrationIdempotency() as never,
      { captureHold, releaseHold: vi.fn() } as never,
    );

    await service.decide(hostUser as never, registrationId, 'key-1', { decision: 'approve' }).catch(() => undefined);

    const holdSQL = seen.find((text) => text.includes('FROM commerce.point_holds'));
    expect(holdSQL).toContain("state = 'active'");
    expect(holdSQL).toContain('FOR UPDATE');
  });

  it('refuses to approve against a hold whose deadline already passed', async () => {
    // The hold row can still read `active` between its deadline and the sweep,
    // but its points are already spendable again, so capture must not run.
    const { client } = decideClient([{ id: 'hold-1', capturable: false }]);
    const database = {
      transaction: vi.fn(async (work: (value: typeof client) => Promise<unknown>) => work(client)),
    };
    const captureHold = vi.fn();
    const service = new RegistrationsService(
      database as never,
      registrationIdempotency() as never,
      { captureHold, releaseHold: vi.fn() } as never,
    );

    await expect(
      service.decide(hostUser as never, registrationId, 'key-2', { decision: 'approve' }),
    ).rejects.toMatchObject({ code: 'POINT_HOLD_EXPIRED', status: 409 });
    expect(captureHold).not.toHaveBeenCalled();
  });
});
