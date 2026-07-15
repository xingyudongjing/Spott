import { describe, expect, it, vi } from 'vitest';
import { EventsService, serializeRegistrationQuestionOptions } from './events.service.js';

const publisher = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['host'],
};

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
    const row = {
      id: '019b0000-0000-7000-8100-000000000001',
      public_slug: 'event-contract',
      organizer_id: '019b0000-0000-7000-8000-000000000002',
      status: 'published',
      title: '活动标题',
      description: '活动介绍',
      category_id: 'walk',
      starts_at: new Date('2026-08-02T03:00:00.000Z'),
      ends_at: new Date('2026-08-02T05:00:00.000Z'),
      deadline_at: deadline,
      capacity: 20,
      registration_mode: 'approval',
      waitlist_enabled: true,
      version: '3',
      created_at: new Date('2026-07-01T00:00:00.000Z'),
      updated_at: new Date('2026-07-15T00:00:00.000Z'),
      region_id: 'tokyo',
      public_area: '涩谷',
      exact_address_cipher: null,
      is_free: true,
      amount_jpy: null,
      collector_name: null,
      method: null,
      payment_deadline_text: null,
      refund_policy: null,
      confirmed_count: 2,
      registration_status: null,
      organizer_name: '主办方',
      organizer_handle: 'host',
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
      registration_questions: [],
      media_count: '1',
      media_items: [],
      organizer_followed: false,
    };
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
});
