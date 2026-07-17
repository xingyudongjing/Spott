import { describe, expect, it, vi } from 'vitest';
import { EventsService, serializeRegistrationQuestionOptions } from './events.service.js';

const publisher = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['host'],
};

function eventRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '019b0000-0000-7000-8100-000000000001',
    public_slug: 'event-contract',
    organizer_id: publisher.id,
    status: 'published',
    title: '活动标题',
    description: '活动介绍',
    category_id: 'walk',
    starts_at: new Date('2026-08-02T03:00:00.000Z'),
    ends_at: new Date('2026-08-02T05:00:00.000Z'),
    deadline_at: new Date('2026-08-01T03:00:00.000Z'),
    display_time_zone: 'Asia/Tokyo',
    capacity: 10,
    registration_mode: 'approval',
    waitlist_enabled: true,
    format: 'hybrid',
    primary_locale: 'ja',
    supported_locales: ['ja', 'en'],
    locale_confirmed_at: new Date('2026-07-15T00:00:00.000Z'),
    version: '3',
    created_at: new Date('2026-07-01T00:00:00.000Z'),
    updated_at: new Date('2026-07-15T00:00:00.000Z'),
    region_id: 'tokyo',
    public_area: '涩谷',
    exact_address_cipher: Buffer.from('cipher'),
    is_free: true,
    amount_jpy: null,
    collector_name: null,
    method: null,
    payment_deadline_text: null,
    refund_policy: null,
    confirmed_count: 2,
    pending_count: 3,
    offered_count: 2,
    available_capacity: 3,
    registration_id: '019b0000-0000-7000-8200-000000000001',
    registration_status: 'offered',
    registration_party_size: 2,
    offer_expires_at: new Date('2026-08-01T01:00:00.000Z'),
    organizer_name: '主办方',
    organizer_handle: 'host',
    phone_verified: true,
    completed_event_count: 8,
    attendance_rate_band: '90_plus',
    favorited: false,
    tags: [],
    attendee_requirements: null,
    risk_flags: [],
    risk_details: {},
    group_id: null,
    checkin_mode: 'dynamic_qr',
    comment_permission: 'participants',
    poster_enabled: true,
    exact_address_visibility: 'confirmed',
    latitude: 35.68,
    longitude: 139.77,
    exact_latitude: 35.681236,
    exact_longitude: 139.767125,
    registration_questions: [],
    media_count: '1',
    media_items: [],
    organizer_followed: false,
    ...overrides,
  };
}

describe('serializeRegistrationQuestionOptions', () => {
  it('serializes an empty option list as a JSON array instead of a PostgreSQL array', () => {
    const parameter = serializeRegistrationQuestionOptions([]);

    expect(parameter).toBe('[]');
    expect(JSON.parse(parameter)).toEqual([]);
  });

  it('preserves single-choice labels in JSON order', () => {
    const parameter = serializeRegistrationQuestionOptions(['第一次参加', '参加过']);

    expect(JSON.parse(parameter)).toEqual(['第一次参加', '参加过']);
  });
});

describe('EventsService event contract', () => {
  it('allows an untitled cloud draft to be saved before submission validation', async () => {
    const replayedDraft = { id: '019b0000-0000-7000-8100-000000000001', title: '', status: 'draft' };
    const client = { query: vi.fn() };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue({ status: 201, body: replayedDraft }),
      complete: vi.fn(),
    };
    const service = new EventsService(database as never, {} as never, idempotency as never, {} as never);

    await expect(service.createDraft(
      publisher,
      '019b0000-0000-7000-9000-000000000001',
      {},
    )).resolves.toEqual(replayedDraft);
    expect(database.transaction).toHaveBeenCalledOnce();
  });

  it('returns registration controls required by web and iOS clients', async () => {
    const deadline = new Date('2026-08-01T03:00:00.000Z');
    const row = eventRow({
      deadline_at: deadline,
      capacity: 20,
      exact_address_cipher: null,
      registration_id: null,
      registration_status: null,
      registration_party_size: null,
      offer_expires_at: null,
    });
    const release = vi.fn();
    const database = {
      pool: {
        connect: vi.fn().mockResolvedValue({
          query: vi.fn().mockResolvedValue({ rows: [row] }),
          release,
        }),
      },
    };
    const service = new EventsService(database as never, {} as never, {} as never, {} as never);

    const view = await service.get(row.id);

    expect(view).toMatchObject({
      registrationMode: 'approval',
      waitlistEnabled: true,
      deadlineAt: deadline.toISOString(),
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it('maps real capacity, coordinate, registration and organizer trust facts without display copy', () => {
    const service = new EventsService({} as never, { decrypt: vi.fn() } as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (row: ReturnType<typeof eventRow>, viewer: undefined, includeDetail: boolean) => Record<string, unknown>;
    };

    const view = mapper.toView(eventRow(), undefined, false);

    expect(view).toMatchObject({
      availableCapacity: 3,
      coordinate: { latitude: 35.68, longitude: 139.77, precision: 'approximate' },
      fee: { isFree: true },
      format: 'hybrid',
      primaryLocale: 'ja',
      supportedLocales: ['ja', 'en'],
      localeConfirmed: true,
      viewerRegistration: {
        id: '019b0000-0000-7000-8200-000000000001',
        status: 'offered',
        partySize: 2,
        offerExpiresAt: '2026-08-01T01:00:00.000Z',
      },
      organizer: {
        trust: {
          phoneVerified: true,
          completedEventCount: 8,
          attendanceRateBand: '90_plus',
        },
      },
    });
    expect(view).not.toHaveProperty('categoryLabel');
    expect(view).not.toHaveProperty('priceLabel');
    expect(view).not.toHaveProperty('registrationQuestions');
    expect(view).not.toHaveProperty('riskFlags');
    expect(view).not.toHaveProperty('riskDetails');
    expect(view).not.toHaveProperty('media');
    expect(view).not.toHaveProperty('mediaCount');
    expect(view).not.toHaveProperty('checkinMode');
    expect(view).not.toHaveProperty('commentPermission');
    expect(JSON.stringify(view)).not.toContain('手机号已验证');
    expect(JSON.stringify(view)).not.toContain('本活动免费');
  });

  it('returns exact detail coordinates and address only when the explicit policy permits them', () => {
    const fieldCrypto = { decrypt: vi.fn().mockReturnValue('東京都渋谷区1-2-3') };
    const service = new EventsService({} as never, fieldCrypto as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (
        row: ReturnType<typeof eventRow>,
        viewer: typeof publisher | undefined,
        includeDetail: boolean,
      ) => Record<string, unknown>;
    };
    const unrelated = { ...publisher, id: '019b0000-0000-7000-8000-000000000099' };

    expect(mapper.toView(eventRow({ registration_status: null }), unrelated, true)).toMatchObject({
      coordinate: { latitude: 35.68, longitude: 139.77, precision: 'approximate' },
      exactAddress: null,
    });
    expect(mapper.toView(eventRow({ registration_status: 'confirmed' }), unrelated, true)).toMatchObject({
      coordinate: { latitude: 35.681236, longitude: 139.767125, precision: 'exact' },
      exactAddress: '東京都渋谷区1-2-3',
    });
    expect(mapper.toView(eventRow({
      registration_status: null,
      exact_address_visibility: 'public',
    }), unrelated, true)).toMatchObject({
      coordinate: { latitude: 35.681236, longitude: 139.767125, precision: 'exact' },
      exactAddress: '東京都渋谷区1-2-3',
    });
    expect(mapper.toView(eventRow({ status: 'cancelled' }), unrelated, true)).toMatchObject({
      coordinate: { latitude: 35.68, longitude: 139.77, precision: 'approximate' },
      exactAddress: null,
    });
    expect(mapper.toView(eventRow({ status: 'cancelled', registration_status: null }), publisher, true)).toMatchObject({
      coordinate: { latitude: 35.681236, longitude: 139.767125, precision: 'exact' },
      exactAddress: '東京都渋谷区1-2-3',
    });
  });

  it('returns null rather than fabricating a coordinate when an event has no point', () => {
    const service = new EventsService({} as never, {} as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (row: ReturnType<typeof eventRow>, viewer: undefined, includeDetail: boolean) => Record<string, unknown>;
    };

    expect(mapper.toView(eventRow({
      latitude: null,
      longitude: null,
      exact_latitude: null,
      exact_longitude: null,
    }), undefined, false)).toMatchObject({ coordinate: null });
  });

  it('treats pending and offered party sizes as occupied when choosing the CTA', () => {
    const service = new EventsService({} as never, {} as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (
        row: ReturnType<typeof eventRow>,
        viewer: typeof publisher,
        includeDetail: boolean,
      ) => Record<string, unknown>;
    };
    const unrelated = { ...publisher, id: '019b0000-0000-7000-8000-000000000099' };

    const view = mapper.toView(eventRow({
      registration_id: null,
      registration_status: null,
      registration_party_size: null,
      confirmed_count: 2,
      pending_count: 5,
      offered_count: 3,
      available_capacity: 0,
    }), unrelated, false) as { availableActions: string[] };

    expect(view.availableActions).toContain('joinWaitlist');
    expect(view.availableActions).not.toContain('register');
  });

  it('does not expose registration actions when an invite-only event has no invitation authority', () => {
    const service = new EventsService({} as never, {} as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (
        row: ReturnType<typeof eventRow>,
        viewer: typeof publisher,
        includeDetail: boolean,
      ) => Record<string, unknown>;
    };
    const unrelated = { ...publisher, id: '019b0000-0000-7000-8000-000000000099' };

    const view = mapper.toView(eventRow({
      registration_mode: 'invite_only',
      registration_id: null,
      registration_status: null,
      registration_party_size: null,
      confirmed_count: 1,
      pending_count: 0,
      offered_count: 0,
      available_capacity: 9,
    }), unrelated, false) as { availableActions: string[] };

    expect(view.availableActions).not.toContain('register');
    expect(view.availableActions).not.toContain('joinWaitlist');
  });

  it('writes draft coordinates to PostGIS with longitude before latitude', async () => {
    const client = {
      query: vi.fn(async (_sql: string, _values: readonly unknown[] = []) => {
        void _sql;
        void _values;
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new EventsService({} as never, {} as never, {} as never, {} as never);
    const details = service as unknown as {
      upsertDetails: (
        transactionClient: typeof client,
        eventId: string,
        input: { coordinate: { latitude: number; longitude: number } },
      ) => Promise<void>;
    };

    await details.upsertDetails(client, '019b0000-0000-7000-8100-000000000001', {
      coordinate: { latitude: 35.681236, longitude: 139.767125 },
    });

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('ST_SetSRID(ST_MakePoint'),
      expect.arrayContaining([139.767125, 35.681236]),
    );
    const locationCall = client.query.mock.calls[0];
    const values = locationCall?.[1] ?? [];
    expect(values.indexOf(139.767125)).toBeLessThan(values.indexOf(35.681236));
    expect(locationCall?.[0]).toContain('events.event_locations.point');
    expect(locationCall?.[0]).not.toContain("COALESCE($2, 'tokyo')");
    expect(locationCall?.[0]).not.toContain("COALESCE($3, '地点待定')");
  });

  it('keeps incomplete draft facts null and rejects incomplete published views', () => {
    const service = new EventsService({} as never, {} as never, {} as never, {} as never);
    const mapper = service as unknown as {
      toView: (
        row: ReturnType<typeof eventRow>,
        viewer: typeof publisher,
        includeDetail: boolean,
      ) => Record<string, unknown>;
    };
    const missingFacts = {
      region_id: null,
      public_area: null,
      is_free: null,
      amount_jpy: null,
      collector_name: null,
      method: null,
      payment_deadline_text: null,
      refund_policy: null,
    };

    expect(mapper.toView(eventRow({ status: 'draft', ...missingFacts }), publisher, true)).toMatchObject({
      region: null,
      publicArea: null,
      fee: null,
    });
    let publishedError: unknown;
    try {
      mapper.toView(eventRow({ status: 'published', ...missingFacts }), publisher, true);
    } catch (error) {
      publishedError = error;
    }
    expect(publishedError).toMatchObject({ code: 'EVENT_DATA_INCOMPLETE', status: 500 });
  });

  it.each([
    Buffer.from(JSON.stringify({
      date: 'not-a-date',
      id: '019b0000-0000-7000-8100-000000000001',
    })).toString('base64url'),
    Buffer.from(JSON.stringify({
      date: '2030-08-10T03:00:00.000Z',
      id: 'not-a-uuid',
    })).toString('base64url'),
    Buffer.from(JSON.stringify({ date: 123, id: null })).toString('base64url'),
    Buffer.from(JSON.stringify({
      date: '-100000-01-01T00:00:00.000Z',
      id: '019b0000-0000-7000-8100-000000000001',
    })).toString('base64url'),
  ])('rejects an invalid cursor before querying PostgreSQL', async (cursor) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new EventsService({ query } as never, {} as never, {} as never, {} as never);

    await expect(service.discovery(undefined, { cursor, limit: 20 })).rejects.toMatchObject({
      code: 'CURSOR_INVALID',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('preserves an answered registration question id when the host edits its prompt', async () => {
    const questionId = '019b0000-0000-7000-8200-000000000001';
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes('FROM events.registration_questions question')) {
          return {
            rows: [{
              id: questionId,
              kind: 'text',
              required: true,
              options: [],
              sort_order: 0,
              answer_count: '1',
            }],
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new EventsService({} as never, {} as never, {} as never, {} as never);
    const details = service as unknown as {
      upsertDetails: (
        transactionClient: typeof client,
        eventId: string,
        input: {
          registrationQuestions: Array<{
            id: string;
            prompt: string;
            kind: 'text';
            required: boolean;
            options: string[];
          }>;
        },
      ) => Promise<void>;
    };

    await details.upsertDetails(client, '019b0000-0000-7000-8100-000000000001', {
      registrationQuestions: [{
        id: questionId,
        prompt: '请补充说明为什么想参加？',
        kind: 'text',
        required: true,
        options: [],
      }],
    });

    expect(queries).not.toContain('DELETE FROM events.registration_questions WHERE event_id = $1');
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE events.registration_questions'),
      expect.arrayContaining([questionId, '019b0000-0000-7000-8100-000000000001']),
    );
  });

  it('only confirms locale fields supplied when creating a draft', async () => {
    const id = '019b0000-0000-7000-8100-000000000001';
    const client = {
      query: vi.fn(async (...args: [sql: string, values?: readonly unknown[]]) => (
        args[0].includes('SELECT uuidv7()')
          ? { rows: [{ id }] }
          : { rows: [], rowCount: 1 }
      )),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue(null),
      complete: vi.fn(),
    };
    const service = new EventsService(database as never, {} as never, idempotency as never, {} as never);
    Object.assign(service, {
      upsertDetails: vi.fn(),
      recordChange: vi.fn(),
      loadEvent: vi.fn().mockResolvedValue({ id }),
      toView: vi.fn().mockReturnValue({ id }),
    });

    await service.createDraft(
      publisher,
      '019b0000-0000-7000-9000-000000000001',
      {
        format: 'hybrid',
        primaryLocale: 'ja',
        supportedLocales: ['ja', 'en'],
      } as never,
    );

    const insert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO events.events('));
    expect(insert?.[0]).toContain('format');
    expect(insert?.[0]).toContain('primary_locale');
    expect(insert?.[0]).toContain('supported_locales');
    expect(insert?.[0]).toContain('locale_confirmed_at');
    expect(insert?.[0]).toContain('clock_timestamp()');
    expect(insert?.[1]).toEqual(expect.arrayContaining(['hybrid', 'ja', ['ja', 'en']]));

    client.query.mockClear();
    await service.createDraft(
      publisher,
      '019b0000-0000-7000-9000-000000000002',
      {},
    );

    const defaultInsert = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO events.events('));
    expect(defaultInsert?.[0]).not.toContain('format');
    expect(defaultInsert?.[0]).not.toContain('primary_locale');
    expect(defaultInsert?.[0]).not.toContain('supported_locales');
    expect(defaultInsert?.[0]).not.toContain('locale_confirmed_at');
  });

  it('atomically confirms supplied locale fields when updating a draft', async () => {
    const id = '019b0000-0000-7000-8100-000000000001';
    const before = {
      id,
      organizer_id: publisher.id,
      status: 'draft',
      version: '1',
    };
    const after = { ...before, version: '2' };
    const client = {
      query: vi.fn(async (...args: [sql: string, values?: readonly unknown[]]) => {
        void args;
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
    const service = new EventsService(database as never, {} as never, idempotency as never, {} as never);
    const loadEvent = vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    Object.assign(service, {
      upsertDetails: vi.fn(),
      recordChange: vi.fn(),
      loadEvent,
      toView: vi.fn().mockReturnValue({ id }),
    });

    await service.update(
      publisher,
      id,
      '019b0000-0000-7000-9000-000000000001',
      1,
      { primaryLocale: 'ja', supportedLocales: ['ja', 'en'] } as never,
    );

    const update = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE events.events SET'));
    expect(update?.[0]).toContain('primary_locale =');
    expect(update?.[0]).toContain('supported_locales =');
    expect(update?.[0]).toContain('locale_confirmed_at = clock_timestamp()');
    expect(update?.[1]).toEqual(expect.arrayContaining(['ja', ['ja', 'en']]));

    client.query.mockClear();
    loadEvent.mockReset().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await service.update(
      publisher,
      id,
      '019b0000-0000-7000-9000-000000000002',
      1,
      { format: 'online' },
    );

    const formatOnlyUpdate = client.query.mock.calls.find(([sql]) => sql.startsWith('UPDATE events.events SET'));
    expect(formatOnlyUpdate?.[0]).toContain('format =');
    expect(formatOnlyUpdate?.[0]).not.toContain('primary_locale =');
    expect(formatOnlyUpdate?.[0]).not.toContain('supported_locales =');
    expect(formatOnlyUpdate?.[0]).not.toContain('locale_confirmed_at =');
  });
});

const commenter = {
  id: '019b0000-0000-7000-8000-000000000055',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [] as string[],
  roles: ['member'],
};

function eventCommentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '019b0000-0000-7000-8400-000000000001',
    target_id: '019b0000-0000-7000-8100-000000000001',
    author_id: commenter.id,
    author_name: '参加者',
    body: '很期待这次活动，谢谢组织！',
    parent_id: null,
    source_language: 'zh-Hans',
    version: '1',
    created_at: new Date('2026-07-16T00:00:00.000Z'),
    updated_at: new Date('2026-07-16T00:00:00.000Z'),
    ...overrides,
  };
}

function commentClient(handlers: (sql: string, values: readonly unknown[]) => unknown) {
  const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    calls.push({ sql, values });
    const result = handlers(sql, values);
    return result ?? { rows: [], rowCount: 0 };
  });
  return { client: { query }, calls };
}

function commentService(client: { query: ReturnType<typeof vi.fn> }, event: Record<string, unknown>) {
  const database = {
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
  };
  const idempotency = {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
    claim: vi.fn().mockResolvedValue(null),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new EventsService(database as never, {} as never, idempotency as never, {} as never);
  Object.assign(service, {
    loadEvent: vi.fn().mockResolvedValue(event),
    recordChange: vi.fn(),
  });
  return { service, idempotency };
}

describe('EventsService controlled event comments', () => {
  it('persists a comment with target_type event when a confirmed participant comments', async () => {
    const event = eventRow({
      organizer_id: publisher.id,
      comment_permission: 'participants',
      registration_status: 'confirmed',
    });
    const { client, calls } = commentClient((sql) => {
      if (sql.includes('INSERT INTO community.comments')) {
        return { rows: [eventCommentRow()], rowCount: 1 };
      }
      if (sql.includes('identity.blocks')) return { rows: [], rowCount: 0 };
      if (sql.includes('admin.config_revisions')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const { service } = commentService(client, event);

    const created = await (service as unknown as {
      createComment: (
        actor: typeof commenter,
        eventId: string,
        key: string,
        input: { body: string; parentId?: string; locale: 'zh-Hans' | 'ja' | 'en' },
      ) => Promise<{ eventId: string; body: string }>;
    }).createComment(commenter, event.id, '019b0000-0000-7000-9000-000000000010', {
      body: '很期待这次活动，谢谢组织！',
      locale: 'zh-Hans',
    });

    const insert = calls.find((call) => call.sql.includes('INSERT INTO community.comments'));
    expect(insert?.sql).toContain("'event'");
    expect(insert?.values).toEqual(expect.arrayContaining([event.id, commenter.id]));
    expect(created).toMatchObject({ eventId: event.id, body: '很期待这次活动，谢谢组织！' });
  });

  it('rejects a comment when the organizer disabled the comment section', async () => {
    const event = eventRow({ comment_permission: 'disabled', registration_status: 'confirmed' });
    const { client } = commentClient(() => ({ rows: [], rowCount: 1 }));
    const { service } = commentService(client, event);

    await expect((service as unknown as {
      createComment: (a: typeof commenter, id: string, k: string, i: unknown) => Promise<unknown>;
    }).createComment(commenter, event.id, '019b0000-0000-7000-9000-000000000011', {
      body: '你好',
      locale: 'zh-Hans',
    })).rejects.toMatchObject({ code: 'EVENT_COMMENTS_DISABLED', status: 422 });
  });

  it('refuses a stranger who is neither the organizer nor a confirmed participant', async () => {
    const event = eventRow({
      organizer_id: publisher.id,
      comment_permission: 'participants',
      registration_status: null,
    });
    const { client } = commentClient((sql) => {
      if (sql.includes('identity.blocks')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const { service } = commentService(client, event);

    await expect((service as unknown as {
      createComment: (a: typeof commenter, id: string, k: string, i: unknown) => Promise<unknown>;
    }).createComment(commenter, event.id, '019b0000-0000-7000-9000-000000000012', {
      body: '让我进来评论',
      locale: 'zh-Hans',
    })).rejects.toMatchObject({ code: 'EVENT_COMMENT_FORBIDDEN', status: 403 });
  });

  it('only lets active members comment when permission is limited to the linked group', async () => {
    const event = eventRow({
      organizer_id: publisher.id,
      comment_permission: 'group_members',
      group_id: '019b0000-0000-7000-8300-000000000001',
      registration_status: null,
    });
    const { client } = commentClient((sql) => {
      if (sql.includes('identity.blocks')) return { rows: [], rowCount: 0 };
      if (sql.includes('community.group_memberships')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const { service } = commentService(client, event);

    await expect((service as unknown as {
      createComment: (a: typeof commenter, id: string, k: string, i: unknown) => Promise<unknown>;
    }).createComment(commenter, event.id, '019b0000-0000-7000-9000-000000000013', {
      body: '群成员评论',
      locale: 'zh-Hans',
    })).rejects.toMatchObject({ code: 'EVENT_COMMENT_FORBIDDEN', status: 403 });
  });

  it('blocks offensive content using the configurable blocklist', async () => {
    const event = eventRow({
      organizer_id: publisher.id,
      comment_permission: 'participants',
      registration_status: 'checked_in',
    });
    const { client } = commentClient((sql) => {
      if (sql.includes('identity.blocks')) return { rows: [], rowCount: 0 };
      if (sql.includes('admin.config_revisions')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const { service } = commentService(client, event);

    await expect((service as unknown as {
      createComment: (a: typeof commenter, id: string, k: string, i: unknown) => Promise<unknown>;
    }).createComment(commenter, event.id, '019b0000-0000-7000-9000-000000000014', {
      body: '你这个傻逼组织者',
      locale: 'zh-Hans',
    })).rejects.toMatchObject({ code: 'COMMENT_CONTENT_BLOCKED', status: 422 });
  });

  it('rejects a comment from an account with the commentBlocked restriction', async () => {
    const event = eventRow({
      organizer_id: publisher.id,
      comment_permission: 'participants',
      registration_status: 'confirmed',
    });
    const { client } = commentClient(() => ({ rows: [], rowCount: 1 }));
    const { service } = commentService(client, event);

    await expect((service as unknown as {
      createComment: (a: typeof commenter, id: string, k: string, i: unknown) => Promise<unknown>;
    }).createComment(
      { ...commenter, restrictions: ['commentBlocked'] },
      event.id,
      '019b0000-0000-7000-9000-000000000015',
      { body: '被限制的评论', locale: 'zh-Hans' },
    )).rejects.toMatchObject({ code: 'ACCOUNT_RESTRICTED', status: 403 });
  });

  it('lists only visible event comments for the event page', async () => {
    const event = eventRow({ id: '019b0000-0000-7000-8100-000000000001' });
    const release = vi.fn();
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('community.comments')) {
        return { rows: [eventCommentRow()], rowCount: 1 };
      }
      return { rows: [event], rowCount: 1 };
    });
    const database = { pool: { connect: vi.fn().mockResolvedValue({ query, release }) } };
    const service = new EventsService(database as never, {} as never, {} as never, {} as never);
    Object.assign(service, { loadEvent: vi.fn().mockResolvedValue(event) });

    const listed = await (service as unknown as {
      comments: (eventId: string, viewerId?: string) => Promise<{ items: Array<{ eventId: string }> }>;
    }).comments(event.id, commenter.id);

    const commentQuery = query.mock.calls.find(([sql]) => sql.includes('community.comments'));
    expect(commentQuery?.[0]).toContain("target_type = 'event'");
    expect(commentQuery?.[0]).toContain("status = 'visible'");
    expect(listed.items[0]).toMatchObject({ eventId: event.id });
    expect(release).toHaveBeenCalledOnce();
  });
});
