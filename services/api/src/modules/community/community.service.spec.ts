import { describe, expect, it, vi } from 'vitest';
import { CommunityService } from './community.service.js';

const userId = '019b0000-0000-7000-8000-000000000001';
const registrationId = '019b0000-0000-7000-8100-000000000001';
const eventId = '019b0000-0000-7000-8200-000000000001';
const feedbackId = '019b0000-0000-7000-8300-000000000001';
const idempotencyKey = '019b0000-0000-7000-9000-000000000001';

const input = {
  attendanceRating: 5,
  tags: ['friendly'],
  comment: 'A thoughtful event.',
  visibility: 'aggregate_only',
};

function idempotency(replay: unknown = null) {
  return {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32, 7)),
    claim: vi.fn().mockResolvedValue(replay),
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CommunityService feedback reliability', () => {
  it('replays a completed response before feedback, points, or outbox writes', async () => {
    const replayed = {
      id: feedbackId,
      eventId,
      status: 'pending_moderation',
      editCount: 0,
      rewardPoints: 20,
      createdAt: '2026-07-16T00:00:00.000Z',
    };
    const client = { query: vi.fn() };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const requestIdempotency = idempotency({ status: 201, body: replayed });
    const points = {
      configBigInt: vi.fn(),
      credit: vi.fn(),
    };
    const service = new CommunityService(
      database as never,
      points as never,
      requestIdempotency as never,
    );

    await expect(service.feedback(userId, registrationId, idempotencyKey, input)).resolves.toEqual(replayed);

    expect(requestIdempotency.requestHash).toHaveBeenCalledWith(
      'POST',
      `/registrations/${registrationId}/feedback`,
      input,
    );
    expect(requestIdempotency.claim).toHaveBeenCalledWith(
      client,
      userId,
      idempotencyKey,
      Buffer.alloc(32, 7),
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(points.configBigInt).not.toHaveBeenCalled();
    expect(points.credit).not.toHaveBeenCalled();
    expect(requestIdempotency.complete).not.toHaveBeenCalled();
  });

  it('claims and completes the first submission in the same transaction', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM events.registrations registration')) {
          return {
            rows: [{
              event_id: eventId,
              status: 'checked_in',
              ends_at: new Date('2026-07-15T00:00:00.000Z'),
              server_time: new Date('2026-07-16T00:00:00.000Z'),
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO community.feedback')) {
          return {
            rows: [{
              id: feedbackId,
              created_at: new Date('2026-07-16T00:00:00.000Z'),
              edit_count: 0,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('count(*)::text AS count')) return { rows: [{ count: '0' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const requestIdempotency = idempotency();
    const points = {
      configBigInt: vi.fn(async (_client: unknown, key: string) => key.includes('limit') ? 5n : 20n),
      credit: vi.fn().mockResolvedValue(undefined),
    };
    const service = new CommunityService(
      database as never,
      points as never,
      requestIdempotency as never,
    );

    const response = await service.feedback(userId, registrationId, idempotencyKey, input);

    expect(requestIdempotency.claim).toHaveBeenCalledWith(
      client,
      userId,
      idempotencyKey,
      Buffer.alloc(32, 7),
    );
    expect(requestIdempotency.complete).toHaveBeenCalledWith(
      client,
      userId,
      idempotencyKey,
      { status: 201, body: response },
      { type: 'feedback', id: feedbackId },
    );
    expect(points.credit).toHaveBeenCalledOnce();
    expect(client.query.mock.calls.filter(([sql]) => sql.includes('feedback.submitted'))).toHaveLength(1);
  });
});

describe('CommunityService own feedback', () => {
  it('loads feedback only through a registration owned by the current user', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        registration_id: registrationId,
        event_id: eventId,
        registration_status: 'checked_in',
        ends_at: new Date('2026-07-15T00:00:00.000Z'),
        server_time: new Date('2026-07-16T00:00:00.000Z'),
        feedback_id: feedbackId,
        attendance_rating: 4,
        tags: ['safe', 'friendly'],
        comment: 'Thank you.',
        visibility: 'private',
        moderation_state: 'pending',
        edit_count: 0,
        created_at: new Date('2026-07-15T01:00:00.000Z'),
        updated_at: new Date('2026-07-15T01:00:00.000Z'),
      }],
      rowCount: 1,
    });
    const service = new CommunityService(
      { query } as never,
      {} as never,
      {} as never,
    );

    await expect(service.ownFeedback(userId, registrationId)).resolves.toEqual({
      registrationId,
      eventId,
      state: 'edit_available',
      canSubmit: true,
      canEdit: true,
      windowClosesAt: '2026-08-14T00:00:00.000Z',
      feedback: {
        id: feedbackId,
        attendanceRating: 4,
        tags: ['safe', 'friendly'],
        comment: 'Thank you.',
        visibility: 'private',
        moderationState: 'pending',
        editCount: 0,
        createdAt: '2026-07-15T01:00:00.000Z',
        updatedAt: '2026-07-15T01:00:00.000Z',
      },
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('registration.user_id = $2'),
      [registrationId, userId],
    );
  });

  it('does not reveal feedback for a registration the current user does not own', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const service = new CommunityService({ query } as never, {} as never, {} as never);

    await expect(service.ownFeedback(userId, registrationId)).rejects.toMatchObject({
      code: 'REGISTRATION_NOT_FOUND',
      status: 404,
    });
  });
});
