import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { Database } from '../../platform/database.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';

@Injectable()
export class CommunityService {
  constructor(private readonly database: Database, private readonly points: PointsService) {}

  async feedback(userId: string, registrationId: string, input: { attendanceRating: number; tags: string[]; comment?: string | undefined; visibility: string }): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const registration = await client.query<{ event_id: string; status: string; ends_at: Date }>(
        `SELECT registration.event_id, registration.status, event.ends_at
         FROM events.registrations registration
         JOIN events.events event ON event.id = registration.event_id
         WHERE registration.id = $1 AND registration.user_id = $2`,
        [registrationId, userId],
      );
      const row = registration.rows[0];
      if (!row) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不存在。', 404);
      if (row.status !== 'checked_in') throw new DomainError('FEEDBACK_NOT_ALLOWED', '完成签到后才能提交反馈。', 422);
      if (!row.ends_at || row.ends_at > new Date() || row.ends_at.getTime() < Date.now() - 30 * 86_400_000) {
        throw new DomainError('FEEDBACK_WINDOW_CLOSED', '反馈需在活动结束后 30 天内提交。', 422);
      }
      const result = await client.query<{ id: string; created_at: Date; edit_count: number }>(
        `INSERT INTO community.feedback(registration_id, event_id, author_id, attendance_rating, tags, comment, visibility)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (registration_id) DO UPDATE SET attendance_rating = EXCLUDED.attendance_rating,
           tags = EXCLUDED.tags, comment = EXCLUDED.comment, visibility = EXCLUDED.visibility,
           moderation_state = 'pending', edit_count = community.feedback.edit_count + 1,
           last_edited_at = clock_timestamp(), updated_at = clock_timestamp()
         WHERE community.feedback.edit_count < 1
         RETURNING id, created_at, edit_count`,
        [registrationId, row.event_id, userId, input.attendanceRating, input.tags, input.comment ?? null, input.visibility],
      );
      const feedback = result.rows[0];
      if (!feedback) throw new DomainError('FEEDBACK_EDIT_LIMIT_REACHED', '反馈仅允许修改一次。', 409);
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('feedback', $1, 'feedback.submitted', $2)`,
        [feedback.id, { eventId: row.event_id, userId }],
      );
      let rewardPoints = 0;
      const weeklyLimit = await this.points.configBigInt(client, 'points.limit.feedback.weekly', 5n);
      const rewards = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM commerce.point_transactions
         WHERE user_id = $1 AND type = 'feedback_reward' AND status = 'posted'
           AND created_at >= date_trunc('week', clock_timestamp() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'`,
        [userId],
      );
      if (feedback.edit_count === 0 && BigInt(rewards.rows[0]?.count ?? '0') < weeklyLimit) {
        const reward = await this.points.configBigInt(client, 'points.reward.feedback', 20n);
        await this.points.credit(
          client,
          userId,
          reward,
          'free',
          'feedback_reward',
          `feedback:${registrationId}`,
          { metadata: { registrationId, eventId: row.event_id } },
        );
        rewardPoints = Number(reward);
      }
      return {
        id: feedback.id,
        eventId: row.event_id,
        status: 'pending_moderation',
        editCount: feedback.edit_count,
        rewardPoints,
        createdAt: feedback.created_at.toISOString(),
      };
    });
  }

  async feedbackSummary(eventId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const minimum = Number(await this.points.configBigInt(client, 'feedback.public_min_sample', 5n));
      const sample = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM community.feedback
         WHERE event_id = $1 AND moderation_state = 'approved' AND visibility = 'aggregate_only'`,
        [eventId],
      );
      const sampleSize = Number(sample.rows[0]?.count ?? 0);
      if (sampleSize < minimum) {
        return { sampleSize, minimumSampleSize: minimum, published: false, tags: [] };
      }
      const tags = await client.query<{ tag: string; count: string }>(
        `SELECT tag, count(*)::text AS count
         FROM community.feedback feedback, unnest(feedback.tags) AS tag
         WHERE feedback.event_id = $1 AND feedback.moderation_state = 'approved'
           AND feedback.visibility = 'aggregate_only'
         GROUP BY tag ORDER BY count(*) DESC, tag`,
        [eventId],
      );
      return {
        sampleSize,
        minimumSampleSize: minimum,
        published: true,
        tags: tags.rows.map((row) => ({
          tag: row.tag,
          count: Number(row.count),
          rate: Number(row.count) / sampleSize,
        })),
      };
    });
  }

  async privateFeedback(actor: AuthenticatedUser, eventId: string): Promise<unknown> {
    const event = await this.database.query<{ organizer_id: string }>(
      'SELECT organizer_id FROM events.events WHERE id = $1',
      [eventId],
    );
    if (!event.rows[0]) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    if (event.rows[0].organizer_id !== actor.id && !actor.roles.includes('operator')) {
      throw new DomainError('FEEDBACK_PRIVATE_FORBIDDEN', '只有局头可以查看私密改进建议。', 403);
    }
    const result = await this.database.query<{
      id: string;
      tags: string[];
      comment: string | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT id, tags, comment, created_at, updated_at FROM community.feedback
       WHERE event_id = $1 AND moderation_state <> 'rejected'
       ORDER BY created_at DESC`,
      [eventId],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        tags: row.tags,
        privateSuggestion: row.comment,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      })),
    };
  }

  async achievements(userId: string): Promise<unknown> {
    const result = await this.database.query<{
      id: string; code: string; audience: string; rule_version: number; visibility: string;
      awarded_at: Date; revoked_at: Date | null; evidence_ref: unknown;
    }>(
      `SELECT a.id, d.code, d.audience, d.rule_version, d.visibility,
         a.awarded_at, a.revoked_at, a.evidence_ref
       FROM community.achievement_awards a
       JOIN community.achievement_definitions d ON d.id = a.definition_id
       WHERE a.user_id = $1 ORDER BY a.awarded_at DESC`,
      [userId],
    );
    return { items: result.rows.map((row) => ({ id: row.id, code: row.code, audience: row.audience, ruleVersion: row.rule_version, visibility: row.visibility, awardedAt: row.awarded_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, evidence: row.evidence_ref })) };
  }

  async evaluateAchievements(userId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const metrics = await client.query<{ checked_in_count: string; hosted_ended_count: string; owned_group_members: string }>(
        `SELECT
          (SELECT count(*) FROM events.registrations WHERE user_id = $1 AND status = 'checked_in')::text AS checked_in_count,
          (SELECT count(*) FROM events.events WHERE organizer_id = $1 AND status IN ('ended','archived'))::text AS hosted_ended_count,
          (SELECT COALESCE(sum((SELECT count(*) FROM community.group_memberships m WHERE m.group_id = g.id AND m.status IN ('active','muted'))),0)
             FROM community.groups g WHERE g.owner_id = $1)::text AS owned_group_members`,
        [userId],
      );
      const values = metrics.rows[0]!;
      const mapping: Record<string, number> = { checked_in_count: Number(values.checked_in_count), hosted_ended_count: Number(values.hosted_ended_count), owned_group_members: Number(values.owned_group_members) };
      const definitions = await client.query<{ id: string; code: string; rule_json: { metric?: string; gte?: number } }>(
        `SELECT id, code, rule_json FROM community.achievement_definitions
         WHERE active_from <= clock_timestamp() AND (active_until IS NULL OR active_until > clock_timestamp())`,
      );
      const awarded: string[] = [];
      for (const definition of definitions.rows) {
        const metric = definition.rule_json.metric;
        const threshold = definition.rule_json.gte;
        if (!metric || threshold === undefined || (mapping[metric] ?? 0) < threshold) continue;
        const inserted = await client.query(
          `INSERT INTO community.achievement_awards(user_id, definition_id, evidence_ref)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
          [userId, definition.id, { metric, value: mapping[metric], threshold }],
        );
        if (inserted.rowCount) awarded.push(definition.code);
      }
      if (awarded.length) await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('user', $1, 'achievements.awarded', $2)`, [userId, { userId, codes: awarded }],
      );
      return { awarded, metrics: mapping };
    });
  }
}
