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

const targetUserId = '019b0000-0000-7000-8000-000000000042';
const awardId = '019b0000-0000-7000-a000-000000000001';
const definitionId = '019b0000-0000-7000-b000-000000000001';

function metricRow(overrides: Record<string, unknown> = {}) {
  return {
    checked_in_count: 0,
    hosted_ended_count: 0,
    hosted_completed_count: 0,
    owned_group_members: 0,
    valid_feedback_count: 0,
    recent_attendance_rate: null,
    recent_attendance_sample: 0,
    host_recent_attendance_rate: null,
    host_recent_attendance_sample: 0,
    category_checkins: {},
    category_completions: {},
    checkin_months: [],
    hosting_months: [],
    certified: false,
    no_severe_complaint: true,
    member_repeat_rate: null,
    ...overrides,
  };
}

// A query router that dispatches on distinctive SQL fragments so the achievement
// lifecycle can be exercised without a live PostgreSQL.
function achievementRouter(options: {
  metrics?: Record<string, unknown>;
  overrides?: { key: string; value_json: unknown }[];
  definitions?: { id: string; code: string; rule_version: number; rule_json: unknown }[];
  currentAwards?: { definition_id: string; code: string; rule_version: number }[];
  insertReturns?: boolean;
  updateRowCount?: number;
  shareRow?: Record<string, unknown> | null;
  awardsRows?: Record<string, unknown>[];
  configText?: Record<string, unknown> | null;
}) {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes('checked_in_count') && sql.includes('category_checkins')) {
      return { rows: [metricRow(options.metrics)], rowCount: 1 };
    }
    if (sql.includes('key = ANY($1)')) {
      return { rows: options.overrides ?? [], rowCount: (options.overrides ?? []).length };
    }
    if (sql.includes('FROM admin.config_revisions')) {
      return { rows: options.configText ? [options.configText] : [], rowCount: options.configText ? 1 : 0 };
    }
    if (sql.includes('FROM community.achievement_definitions')) {
      return { rows: options.definitions ?? [], rowCount: (options.definitions ?? []).length };
    }
    if (sql.includes('a.definition_id, d.code, d.rule_version')) {
      return { rows: options.currentAwards ?? [], rowCount: (options.currentAwards ?? []).length };
    }
    if (sql.includes('SELECT a.definition_id')) {
      return { rows: options.currentAwards?.length ? [{ definition_id: options.currentAwards[0]!.definition_id }] : [], rowCount: options.currentAwards?.length ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO community.achievement_awards')) {
      return { rows: options.insertReturns === false ? [] : [{ id: awardId }], rowCount: options.insertReturns === false ? 0 : 1 };
    }
    if (sql.includes('UPDATE community.achievement_awards')) {
      return { rows: [], rowCount: options.updateRowCount ?? 1 };
    }
    if (sql.includes('JOIN identity.profiles') || sql.includes('LEFT JOIN identity.profiles')) {
      return { rows: options.shareRow ? [options.shareRow] : [], rowCount: options.shareRow ? 1 : 0 };
    }
    if (sql.includes('FROM community.achievement_awards')) {
      return { rows: options.awardsRows ?? [], rowCount: (options.awardsRows ?? []).length };
    }
    if (sql.includes('outbox_events')) {
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  return { query, calls };
}

function transactional(router: ReturnType<typeof achievementRouter>) {
  return {
    query: router.query,
    transaction: vi.fn(async (work: (client: { query: typeof router.query }) => Promise<unknown>) => work({ query: router.query })),
  };
}

describe('CommunityService achievement evaluation', () => {
  const firstDef = { id: definitionId, code: 'first_checkin', rule_version: 1, rule_json: { metric: 'checked_in_count', gte: 1 } };

  it('awards a newly satisfied achievement and emits an award event', async () => {
    const router = achievementRouter({
      metrics: { checked_in_count: 1 },
      definitions: [firstDef],
      currentAwards: [],
    });
    const service = new CommunityService(transactional(router) as never, {} as never, {} as never);

    const result = await service.evaluateAchievements(targetUserId) as { awarded: string[]; revoked: unknown[] };

    expect(result.awarded).toEqual(['first_checkin']);
    expect(result.revoked).toEqual([]);
    expect(router.calls.some((c) => c.sql.includes('INSERT INTO community.achievement_awards'))).toBe(true);
    expect(router.calls.some((c) => c.sql.includes("'achievements.awarded'"))).toBe(true);
  });

  it('does not award when a configuration override raises the threshold (no hard-coding)', async () => {
    const router = achievementRouter({
      metrics: { checked_in_count: 1 },
      definitions: [firstDef],
      currentAwards: [],
      overrides: [{ key: 'achievement.first_checkin.threshold', value_json: 5 }],
    });
    const service = new CommunityService(transactional(router) as never, {} as never, {} as never);

    const result = await service.evaluateAchievements(targetUserId) as { awarded: string[] };

    expect(result.awarded).toEqual([]);
    expect(router.calls.some((c) => c.sql.includes('INSERT INTO community.achievement_awards'))).toBe(false);
  });

  it('revokes a held award whose condition no longer holds and emits a revoke event', async () => {
    const router = achievementRouter({
      metrics: { checked_in_count: 0 },
      definitions: [firstDef],
      currentAwards: [{ definition_id: definitionId, code: 'first_checkin', rule_version: 1 }],
    });
    const service = new CommunityService(transactional(router) as never, {} as never, {} as never);

    const result = await service.evaluateAchievements(targetUserId) as { awarded: string[]; revoked: { code: string; reason: string }[] };

    expect(result.awarded).toEqual([]);
    expect(result.revoked).toEqual([{ code: 'first_checkin', reason: 'condition_no_longer_met' }]);
    const revokeCall = router.calls.find((c) => c.sql.includes('UPDATE community.achievement_awards') && c.sql.includes('revoked_at = clock_timestamp()'));
    expect(revokeCall?.values).toEqual([targetUserId, definitionId, 'condition_no_longer_met']);
    expect(router.calls.some((c) => c.sql.includes("'achievements.revoked'"))).toBe(true);
  });
});

describe('CommunityService achievement revocation', () => {
  it('rejects an unknown revocation reason before touching the database', async () => {
    const router = achievementRouter({});
    const db = transactional(router);
    const service = new CommunityService(db as never, {} as never, {} as never);

    await expect(service.revokeAchievement(targetUserId, 'first_checkin', 'because')).rejects.toMatchObject({
      code: 'INVALID_REVOCATION_REASON',
      status: 422,
    });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('records the reason when revoking an active award', async () => {
    const router = achievementRouter({
      currentAwards: [{ definition_id: definitionId, code: 'first_checkin', rule_version: 1 }],
    });
    const service = new CommunityService(transactional(router) as never, {} as never, {} as never);

    const result = await service.revokeAchievement(targetUserId, 'first_checkin', 'cheating') as { revoked: boolean };

    expect(result.revoked).toBe(true);
    const revokeCall = router.calls.find((c) => c.sql.includes('UPDATE community.achievement_awards'));
    expect(revokeCall?.values).toEqual([targetUserId, definitionId, 'cheating']);
  });

  it('reports no revocation when the user holds no active award for the code', async () => {
    const router = achievementRouter({ currentAwards: [] });
    const service = new CommunityService(transactional(router) as never, {} as never, {} as never);

    const result = await service.revokeAchievement(targetUserId, 'first_checkin', 'valid_complaint') as { revoked: boolean };

    expect(result.revoked).toBe(false);
    expect(router.calls.some((c) => c.sql.includes('UPDATE community.achievement_awards'))).toBe(false);
  });
});

describe('CommunityService achievement privacy', () => {
  it('hides a single owned badge', async () => {
    const router = achievementRouter({ updateRowCount: 1 });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    const result = await service.setAchievementVisibility(targetUserId, awardId, true) as { hidden: boolean };

    expect(result.hidden).toBe(true);
    const call = router.calls.find((c) => c.sql.includes('UPDATE community.achievement_awards'));
    expect(call?.sql).toContain('user_id = $2');
    expect(call?.values).toEqual([awardId, targetUserId, true]);
  });

  it('rejects hiding a badge the user does not own', async () => {
    const router = achievementRouter({ updateRowCount: 0 });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    await expect(service.setAchievementVisibility(targetUserId, awardId, true)).rejects.toMatchObject({
      code: 'ACHIEVEMENT_NOT_FOUND',
    });
  });

  it('hides all currently-held badges in one action', async () => {
    const router = achievementRouter({ updateRowCount: 4 });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    const result = await service.setAllAchievementsHidden(targetUserId, true) as { affected: number };

    expect(result.affected).toBe(4);
  });
});

describe('CommunityService public achievements', () => {
  it('applies the privacy filter for a non-owner viewer', async () => {
    const router = achievementRouter({
      awardsRows: [{ id: awardId, code: 'first_checkin', audience: 'participant', rule_version: 1, awarded_at: new Date('2026-07-16T00:00:00.000Z'), evidence_ref: {} }],
      metrics: { hosted_ended_count: 0 },
    });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    const result = await service.publicAchievements(targetUserId, 'someone-else') as { items: { code: string; hidden?: boolean }[]; hostReputation: unknown };

    const awardsCall = router.calls.find((c) => c.sql.includes('FROM community.achievement_awards') && c.sql.includes('d.visibility'));
    expect(awardsCall?.sql).toContain("'public'");
    expect(awardsCall?.values).toEqual([targetUserId, false]);
    expect(result.items).toEqual([{ code: 'first_checkin', audience: 'participant', ruleVersion: 1, awardedAt: '2026-07-16T00:00:00.000Z', hidden: undefined }]);
    expect(result.hostReputation).toBeNull();
  });

  it('passes owner=true so the owner can see hidden badges', async () => {
    const router = achievementRouter({ awardsRows: [], metrics: {} });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    await service.publicAchievements(targetUserId, targetUserId);

    const awardsCall = router.calls.find((c) => c.sql.includes('FROM community.achievement_awards') && c.sql.includes('d.visibility'));
    expect(awardsCall?.values).toEqual([targetUserId, true]);
  });
});

describe('CommunityService achievement share card', () => {
  it('builds a share card with a coarse data range and attributable link', async () => {
    const router = achievementRouter({
      shareRow: { code: 'reliable_attendee', audience: 'participant', rule_version: 1, awarded_at: new Date('2026-07-16T00:00:00.000Z'), evidence_ref: {}, nickname: 'Kai' },
      metrics: { checked_in_count: 12, recent_attendance_rate: '0.95', recent_attendance_sample: 10 },
    });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    const card = await service.achievementShareCard(targetUserId, awardId) as {
      brand: string; nickname: string; achievement: { code: string }; dataRange: { attendanceBand: string }; link: string;
    };

    expect(card.brand).toBe('Spott');
    expect(card.nickname).toBe('Kai');
    expect(card.achievement.code).toBe('reliable_attendee');
    expect(card.dataRange.attendanceBand).toBe('≥90%');
    expect(card.link).toContain(`/u/${targetUserId}/achievements/reliable_attendee`);
  });

  it('refuses to share a hidden achievement', async () => {
    const router = achievementRouter({
      shareRow: { code: 'first_checkin', audience: 'participant', rule_version: 1, awarded_at: new Date(), evidence_ref: { privacy: { hidden: true } }, nickname: 'Kai' },
    });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    await expect(service.achievementShareCard(targetUserId, awardId)).rejects.toMatchObject({
      code: 'ACHIEVEMENT_HIDDEN',
    });
  });

  it('returns not-found for a missing or revoked award', async () => {
    const router = achievementRouter({ shareRow: null });
    const service = new CommunityService({ query: router.query } as never, {} as never, {} as never);

    await expect(service.achievementShareCard(targetUserId, awardId)).rejects.toMatchObject({
      code: 'ACHIEVEMENT_NOT_FOUND',
    });
  });
});
