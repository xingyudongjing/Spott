import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';
import {
  attendanceBand,
  isRevocationReason,
  planEvaluation,
  type AchievementRule,
  type CurrentAwardInput,
  type DefinitionInput,
  type MetricSnapshot,
  type RevocationReason,
} from './achievement-rules.js';

interface Queryable {
  query<Row extends QueryResultRow>(text: string, values?: readonly unknown[]): Promise<QueryResult<Row>>;
}

@Injectable()
export class CommunityService {
  constructor(
    private readonly database: Database,
    private readonly points: PointsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async feedback(
    userId: string,
    registrationId: string,
    key: string,
    input: {
      attendanceRating: number;
      tags: string[];
      comment?: string | undefined;
      visibility: string;
    },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash(
        'POST',
        `/registrations/${registrationId}/feedback`,
        input,
      );
      const replay = await this.idempotency.claim<unknown>(client, userId, key, hash);
      if (replay) return replay.body;

      const registration = await client.query<{
        event_id: string;
        status: string;
        ends_at: Date | null;
        server_time: Date;
      }>(
        `SELECT registration.event_id, registration.status, event.ends_at,
           clock_timestamp() AS server_time
         FROM events.registrations registration
         JOIN events.events event ON event.id = registration.event_id
         WHERE registration.id = $1 AND registration.user_id = $2`,
        [registrationId, userId],
      );
      const row = registration.rows[0];
      if (!row) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不存在。', 404);
      if (row.status !== 'checked_in') throw new DomainError('FEEDBACK_NOT_ALLOWED', '完成签到后才能提交反馈。', 422);
      if (
        !row.ends_at
        || row.ends_at > row.server_time
        || row.ends_at.getTime() < row.server_time.getTime() - 30 * 86_400_000
      ) {
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
      const body = {
        id: feedback.id,
        eventId: row.event_id,
        status: 'pending_moderation',
        editCount: feedback.edit_count,
        rewardPoints,
        createdAt: feedback.created_at.toISOString(),
      };
      await this.idempotency.complete(client, userId, key, { status: 201, body }, {
        type: 'feedback',
        id: feedback.id,
      });
      return body;
    });
  }

  async ownFeedback(userId: string, registrationId: string): Promise<unknown> {
    const result = await this.database.query<{
      registration_id: string;
      event_id: string;
      registration_status: string;
      ends_at: Date | null;
      server_time: Date;
      feedback_id: string | null;
      attendance_rating: number | null;
      tags: string[] | null;
      comment: string | null;
      visibility: string | null;
      moderation_state: string | null;
      edit_count: number | null;
      created_at: Date | null;
      updated_at: Date | null;
    }>(
      `SELECT registration.id AS registration_id, registration.event_id,
         registration.status AS registration_status, event.ends_at,
         clock_timestamp() AS server_time,
         feedback.id AS feedback_id, feedback.attendance_rating, feedback.tags,
         feedback.comment, feedback.visibility, feedback.moderation_state,
         feedback.edit_count, feedback.created_at, feedback.updated_at
       FROM events.registrations registration
       JOIN events.events event ON event.id = registration.event_id
       LEFT JOIN community.feedback feedback
         ON feedback.registration_id = registration.id
        AND feedback.author_id = registration.user_id
       WHERE registration.id = $1 AND registration.user_id = $2`,
      [registrationId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不存在。', 404);

    const windowClosesAt = row.ends_at
      ? new Date(row.ends_at.getTime() + 30 * 86_400_000)
      : null;
    const inWindow = Boolean(
      row.registration_status === 'checked_in'
      && row.ends_at
      && row.ends_at <= row.server_time
      && windowClosesAt
      && row.server_time <= windowClosesAt,
    );
    const hasFeedback = row.feedback_id !== null;
    const canEdit = inWindow && hasFeedback && (row.edit_count ?? 0) < 1;
    const canSubmit = inWindow && (!hasFeedback || canEdit);
    const state = !inWindow
      ? row.registration_status === 'checked_in' && windowClosesAt && row.server_time > windowClosesAt
        ? 'window_closed'
        : 'not_eligible'
      : !hasFeedback
        ? 'not_submitted'
        : canEdit
          ? 'edit_available'
          : 'edit_limit_reached';

    return {
      registrationId: row.registration_id,
      eventId: row.event_id,
      state,
      canSubmit,
      canEdit,
      windowClosesAt: windowClosesAt?.toISOString() ?? null,
      feedback: hasFeedback
        ? {
            id: row.feedback_id,
            attendanceRating: row.attendance_rating,
            tags: row.tags ?? [],
            comment: row.comment,
            visibility: row.visibility,
            moderationState: row.moderation_state,
            editCount: row.edit_count ?? 0,
            createdAt: row.created_at?.toISOString() ?? null,
            updatedAt: row.updated_at?.toISOString() ?? null,
          }
        : null,
    };
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

  /**
   * The current user's own achievements, including hidden and revoked awards so
   * they can manage their own privacy and understand revocations. Never used for
   * viewing another member — see publicAchievements for the privacy-filtered view.
   */
  async achievements(userId: string): Promise<unknown> {
    const result = await this.database.query<{
      id: string; code: string; audience: string; rule_version: number; visibility: string;
      awarded_at: Date; revoked_at: Date | null; evidence_ref: AwardEvidence;
    }>(
      `SELECT a.id, d.code, d.audience, d.rule_version, d.visibility,
         a.awarded_at, a.revoked_at, a.evidence_ref
       FROM community.achievement_awards a
       JOIN community.achievement_definitions d ON d.id = a.definition_id
       WHERE a.user_id = $1 ORDER BY a.awarded_at DESC`,
      [userId],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        code: row.code,
        audience: row.audience,
        ruleVersion: row.rule_version,
        visibility: row.visibility,
        awardedAt: row.awarded_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        revocationReason: row.evidence_ref?.revocation?.reason ?? null,
        hidden: row.evidence_ref?.privacy?.hidden === true,
        evidence: row.evidence_ref,
      })),
    };
  }

  /**
   * The publicly visible achievements for a member. Revoked, hidden and
   * private-visibility awards are excluded for everyone but the owner; the owner
   * additionally sees their hidden badges flagged as such. Host reputation is
   * disclosed only as coarse bands (公开区间), never exact behaviour.
   */
  async publicAchievements(targetUserId: string, viewerId: string | null): Promise<unknown> {
    const isOwner = viewerId === targetUserId;
    const result = await this.database.query<{
      id: string; code: string; audience: string; rule_version: number;
      awarded_at: Date; evidence_ref: AwardEvidence;
    }>(
      `SELECT a.id, d.code, d.audience, d.rule_version, a.awarded_at, a.evidence_ref
       FROM community.achievement_awards a
       JOIN community.achievement_definitions d ON d.id = a.definition_id
       WHERE a.user_id = $1
         AND a.revoked_at IS NULL
         AND ($2::boolean OR (d.visibility = 'public'
              AND COALESCE((a.evidence_ref -> 'privacy' ->> 'hidden'), 'false') <> 'true'))
       ORDER BY a.awarded_at DESC`,
      [targetUserId, isOwner],
    );
    const reputation = await this.hostReputation(targetUserId);
    return {
      userId: targetUserId,
      items: result.rows.map((row) => ({
        code: row.code,
        audience: row.audience,
        ruleVersion: row.rule_version,
        awardedAt: row.awarded_at.toISOString(),
        hidden: isOwner ? row.evidence_ref?.privacy?.hidden === true : undefined,
      })),
      hostReputation: reputation,
    };
  }

  private async hostReputation(userId: string): Promise<unknown> {
    const snapshot = await this.computeMetrics(this.database, userId);
    if (snapshot.hostedEndedCount === 0) return null;
    return {
      completedEvents: snapshot.hostedCompletedCount,
      attendanceBand: attendanceBand(snapshot.hostRecentAttendanceRate),
      continuousOrganizingMonths: snapshot.monthlyHostingStreak,
    };
  }

  /**
   * Re-evaluate every active achievement for a user: award newly satisfied
   * achievements, revoke ones whose conditions no longer hold, and supersede
   * awards granted under an older rule version. Idempotent — safe to run after
   * check-in, attendance correction (补签纠正), moderation or event delisting.
   */
  async evaluateAchievements(userId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const snapshot = await this.computeMetrics(client, userId);
      const definitions = await this.activeDefinitions(client);
      const currentAwards = await client.query<{
        definition_id: string; code: string; rule_version: number;
      }>(
        `SELECT a.definition_id, d.code, d.rule_version
         FROM community.achievement_awards a
         JOIN community.achievement_definitions d ON d.id = a.definition_id
         WHERE a.user_id = $1 AND a.revoked_at IS NULL`,
        [userId],
      );
      const held: CurrentAwardInput[] = currentAwards.rows.map((row) => ({
        definitionId: row.definition_id,
        code: row.code,
        ruleVersion: row.rule_version,
      }));
      const overrides = await this.thresholdOverrides(client, definitions.map((d) => d.code));

      const plan = planEvaluation(definitions, held, snapshot, overrides);

      const awarded: string[] = [];
      for (const decision of plan.toAward) {
        const inserted = await client.query(
          `INSERT INTO community.achievement_awards(user_id, definition_id, evidence_ref)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
          [userId, decision.definitionId, {
            ruleVersion: decision.ruleVersion,
            evaluatedAt: new Date().toISOString(),
          }],
        );
        if (inserted.rowCount) awarded.push(decision.code);
      }

      const revoked: { code: string; reason: RevocationReason }[] = [];
      for (const decision of plan.toRevoke) {
        const updated = await this.revokeAward(client, userId, decision.definitionId, decision.reason);
        if (updated) revoked.push({ code: decision.code, reason: decision.reason });
      }

      if (awarded.length) {
        await client.query(
          `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
           VALUES ('user', $1, 'achievements.awarded', $2)`,
          [userId, { userId, codes: awarded }],
        );
      }
      if (revoked.length) {
        await client.query(
          `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
           VALUES ('user', $1, 'achievements.revoked', $2)`,
          [userId, { userId, revoked }],
        );
      }
      return { awarded, revoked, metrics: snapshot };
    });
  }

  /**
   * Explicitly revoke a member's achievement with a recorded reason — used by
   * moderation for cheating, upheld complaints or event delisting. The reason is
   * persisted on the award for auditability.
   */
  async revokeAchievement(userId: string, code: string, reason: string): Promise<unknown> {
    if (!isRevocationReason(reason)) {
      throw new DomainError('INVALID_REVOCATION_REASON', '撤回原因无效。', 422);
    }
    return this.database.transaction(async (client) => {
      const target = await client.query<{ definition_id: string }>(
        `SELECT a.definition_id
         FROM community.achievement_awards a
         JOIN community.achievement_definitions d ON d.id = a.definition_id
         WHERE a.user_id = $1 AND d.code = $2 AND a.revoked_at IS NULL
         ORDER BY d.rule_version DESC LIMIT 1`,
        [userId, code],
      );
      const row = target.rows[0];
      if (!row) return { revoked: false, code, reason };
      await this.revokeAward(client, userId, row.definition_id, reason);
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('user', $1, 'achievements.revoked', $2)`,
        [userId, { userId, revoked: [{ code, reason }] }],
      );
      return { revoked: true, code, reason };
    });
  }

  private async revokeAward(
    client: PoolClient,
    userId: string,
    definitionId: string,
    reason: RevocationReason,
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE community.achievement_awards
       SET revoked_at = clock_timestamp(),
           evidence_ref = evidence_ref || jsonb_build_object(
             'revocation', jsonb_build_object('reason', $3::text, 'at', clock_timestamp()))
       WHERE user_id = $1 AND definition_id = $2 AND revoked_at IS NULL`,
      [userId, definitionId, reason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Hide or reveal a single badge. Privacy is stored on the award itself so the
   * owner controls exactly what appears on their public profile.
   */
  async setAchievementVisibility(userId: string, awardId: string, hidden: boolean): Promise<unknown> {
    const result = await this.database.query(
      `UPDATE community.achievement_awards
       SET evidence_ref = evidence_ref || jsonb_build_object(
             'privacy', jsonb_build_object('hidden', $3::boolean, 'at', clock_timestamp()))
       WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [awardId, userId, hidden],
    );
    if ((result.rowCount ?? 0) === 0) {
      throw new DomainError('ACHIEVEMENT_NOT_FOUND', '成就不存在或无法修改。', 404);
    }
    return { awardId, hidden };
  }

  /** Hide or reveal every currently-held badge in one action (隐藏全部成就). */
  async setAllAchievementsHidden(userId: string, hidden: boolean): Promise<unknown> {
    const result = await this.database.query(
      `UPDATE community.achievement_awards
       SET evidence_ref = evidence_ref || jsonb_build_object(
             'privacy', jsonb_build_object('hidden', $2::boolean, 'at', clock_timestamp()))
       WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, hidden],
    );
    return { hidden, affected: result.rowCount ?? 0 };
  }

  /**
   * Data for an achievement share card: nickname, achievement, a coarse real
   * data range, the Spott brand and an attributable link. Only awarded,
   * non-revoked, non-hidden achievements are shareable, and no exact behavioural
   * figure is exposed (产品文档 H: 昵称、成就、真实数据范围、可归因链接；精确行为数据不公开).
   */
  async achievementShareCard(userId: string, awardId: string): Promise<unknown> {
    const result = await this.database.query<{
      code: string; audience: string; rule_version: number; awarded_at: Date;
      evidence_ref: AwardEvidence; nickname: string | null;
    }>(
      `SELECT d.code, d.audience, d.rule_version, a.awarded_at, a.evidence_ref, p.nickname
       FROM community.achievement_awards a
       JOIN community.achievement_definitions d ON d.id = a.definition_id
       LEFT JOIN identity.profiles p ON p.user_id = a.user_id
       WHERE a.id = $1 AND a.user_id = $2 AND a.revoked_at IS NULL`,
      [awardId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('ACHIEVEMENT_NOT_FOUND', '成就不存在或已撤回。', 404);
    if (row.evidence_ref?.privacy?.hidden === true) {
      throw new DomainError('ACHIEVEMENT_HIDDEN', '隐藏的成就无法分享。', 422);
    }
    const snapshot = await this.computeMetrics(this.database, userId);
    const baseUrl = await this.configText(this.database, 'share.base_url', 'https://spott.app');
    return {
      brand: 'Spott',
      nickname: row.nickname ?? '',
      achievement: {
        code: row.code,
        audience: row.audience,
        ruleVersion: row.rule_version,
        awardedAt: row.awarded_at.toISOString(),
      },
      dataRange: this.shareDataRange(row.code, row.audience, snapshot),
      link: `${baseUrl}/u/${userId}/achievements/${row.code}`,
    };
  }

  private shareDataRange(code: string, audience: string, snapshot: MetricSnapshot): unknown {
    if (audience === 'host') {
      return {
        completedEvents: snapshot.hostedCompletedCount,
        attendanceBand: attendanceBand(snapshot.hostRecentAttendanceRate),
      };
    }
    return {
      eventsAttended: snapshot.checkedInCount,
      attendanceBand: attendanceBand(snapshot.recentAttendanceRate),
    };
  }

  private async activeDefinitions(runner: Queryable): Promise<DefinitionInput[]> {
    const result = await runner.query<{
      id: string; code: string; rule_version: number; rule_json: AchievementRule;
    }>(
      `SELECT id, code, rule_version, rule_json
       FROM community.achievement_definitions
       WHERE active_from <= clock_timestamp()
         AND (active_until IS NULL OR active_until > clock_timestamp())`,
    );
    return result.rows.map((row) => ({
      id: row.id,
      code: row.code,
      ruleVersion: row.rule_version,
      ruleJson: row.rule_json,
    }));
  }

  private async thresholdOverrides(
    runner: Queryable,
    codes: string[],
  ): Promise<Record<string, number>> {
    if (codes.length === 0) return {};
    const keys = codes.map((code) => `achievement.${code}.threshold`);
    const result = await runner.query<{ key: string; value_json: unknown }>(
      `SELECT DISTINCT ON (key) key, value_json
       FROM admin.config_revisions
       WHERE key = ANY($1) AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY key, version DESC`,
      [keys],
    );
    const overrides: Record<string, number> = {};
    for (const row of result.rows) {
      const code = row.key.slice('achievement.'.length, -'.threshold'.length);
      const parsed = this.asNumber(row.value_json);
      if (parsed !== null) overrides[code] = parsed;
    }
    return overrides;
  }

  private async configNumber(runner: Queryable, key: string, fallback: number): Promise<number> {
    const result = await runner.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = $1 AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
      [key],
    );
    return this.asNumber(result.rows[0]?.value_json) ?? fallback;
  }

  private async configText(runner: Queryable, key: string, fallback: string): Promise<string> {
    const result = await runner.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = $1 AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
      [key],
    );
    const value = result.rows[0]?.value_json;
    return typeof value === 'string' ? value : fallback;
  }

  private asNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return null;
  }

  private async computeMetrics(runner: Queryable, userId: string): Promise<MetricSnapshot> {
    const minAttendees = await this.configNumber(runner, 'achievement.completed.min_attendees', 3);
    const recentWindow = await this.configNumber(runner, 'achievement.attendance.recent_window', 10);
    const hostWindow = await this.configNumber(runner, 'achievement.host.attendance_window', 10);

    const result = await runner.query<MetricRow>(
      `SELECT
        (SELECT count(*) FROM events.registrations WHERE user_id = $1 AND status = 'checked_in')::int AS checked_in_count,
        (SELECT count(*) FROM events.events WHERE organizer_id = $1 AND status IN ('ended','archived'))::int AS hosted_ended_count,
        (SELECT count(*) FROM events.events e WHERE e.organizer_id = $1 AND e.status IN ('ended','archived')
           AND (SELECT count(*) FROM events.registrations r WHERE r.event_id = e.id AND r.status = 'checked_in') >= $2)::int AS hosted_completed_count,
        (SELECT COALESCE(sum((SELECT count(*) FROM community.group_memberships m WHERE m.group_id = g.id AND m.status IN ('active','muted'))),0)
           FROM community.groups g WHERE g.owner_id = $1)::int AS owned_group_members,
        (SELECT count(*) FROM community.feedback f WHERE f.author_id = $1 AND f.moderation_state = 'approved')::int AS valid_feedback_count,
        (SELECT CASE WHEN count(*) = 0 THEN NULL
           ELSE round(count(*) FILTER (WHERE status = 'checked_in')::numeric / count(*), 4) END
         FROM (SELECT status FROM events.registrations
               WHERE user_id = $1 AND status IN ('checked_in','no_show')
               ORDER BY created_at DESC LIMIT $3) recent) AS recent_attendance_rate,
        (SELECT count(*) FROM (SELECT 1 FROM events.registrations
               WHERE user_id = $1 AND status IN ('checked_in','no_show')
               ORDER BY created_at DESC LIMIT $3) s)::int AS recent_attendance_sample,
        (SELECT CASE WHEN COALESCE(sum(conf),0) = 0 THEN NULL ELSE round(sum(ci)::numeric / sum(conf), 4) END
         FROM (SELECT
                 (SELECT count(*) FROM events.registrations r WHERE r.event_id = e.id AND r.status = 'checked_in') AS ci,
                 (SELECT count(*) FROM events.registrations r WHERE r.event_id = e.id AND r.status IN ('checked_in','no_show','confirmed')) AS conf
               FROM events.events e WHERE e.organizer_id = $1 AND e.status IN ('ended','archived')
               ORDER BY e.ends_at DESC NULLS LAST LIMIT $4) he) AS host_recent_attendance_rate,
        (SELECT count(*) FROM (SELECT 1 FROM events.events e WHERE e.organizer_id = $1 AND e.status IN ('ended','archived')
               ORDER BY e.ends_at DESC NULLS LAST LIMIT $4) s)::int AS host_recent_attendance_sample,
        (SELECT COALESCE(jsonb_object_agg(category_id, cnt), '{}'::jsonb) FROM (
           SELECT e.category_id, count(*) AS cnt FROM events.registrations r JOIN events.events e ON e.id = r.event_id
           WHERE r.user_id = $1 AND r.status = 'checked_in' AND e.category_id IS NOT NULL GROUP BY e.category_id) c) AS category_checkins,
        (SELECT COALESCE(jsonb_object_agg(category_id, cnt), '{}'::jsonb) FROM (
           SELECT e.category_id, count(*) AS cnt FROM events.events e
           WHERE e.organizer_id = $1 AND e.status IN ('ended','archived') AND e.category_id IS NOT NULL
             AND (SELECT count(*) FROM events.registrations r WHERE r.event_id = e.id AND r.status = 'checked_in') >= $2
           GROUP BY e.category_id) c) AS category_completions,
        (SELECT COALESCE(array_agg(DISTINCT m), '{}') FROM (
           SELECT date_trunc('month', e.ends_at) AS m FROM events.registrations r JOIN events.events e ON e.id = r.event_id
           WHERE r.user_id = $1 AND r.status = 'checked_in' AND e.ends_at IS NOT NULL) months) AS checkin_months,
        (SELECT COALESCE(array_agg(DISTINCT m), '{}') FROM (
           SELECT date_trunc('month', e.ends_at) AS m FROM events.events e
           WHERE e.organizer_id = $1 AND e.status IN ('ended','archived') AND e.ends_at IS NOT NULL
             AND (SELECT count(*) FROM events.registrations r WHERE r.event_id = e.id AND r.status = 'checked_in') >= $2) months) AS hosting_months,
        (SELECT (phone_verified_at IS NOT NULL) FROM identity.users WHERE id = $1) AS certified,
        (NOT EXISTS(SELECT 1 FROM safety.reports WHERE target_type = 'user' AND target_id = $1
           AND severity = 'p0' AND status IN ('decided','closed'))) AS no_severe_complaint,
        (WITH att AS (
           SELECT r.user_id AS attendee, e.ends_at FROM events.registrations r JOIN events.events e ON e.id = r.event_id
           WHERE e.organizer_id = $1 AND r.status = 'checked_in' AND e.ends_at IS NOT NULL)
         SELECT CASE WHEN count(DISTINCT a1.attendee) = 0 THEN NULL
           ELSE round(count(DISTINCT a1.attendee) FILTER (WHERE EXISTS(
             SELECT 1 FROM att a2 WHERE a2.attendee = a1.attendee AND a2.ends_at > a1.ends_at
               AND a2.ends_at <= a1.ends_at + interval '60 days'))::numeric
             / count(DISTINCT a1.attendee), 4) END
         FROM att a1) AS member_repeat_rate`,
      [userId, minAttendees, recentWindow, hostWindow],
    );
    const row = result.rows[0]!;
    return {
      checkedInCount: row.checked_in_count,
      hostedEndedCount: row.hosted_ended_count,
      hostedCompletedCount: row.hosted_completed_count,
      ownedGroupMembers: row.owned_group_members,
      validFeedbackCount: row.valid_feedback_count,
      recentAttendanceRate: row.recent_attendance_rate === null ? null : Number(row.recent_attendance_rate),
      recentAttendanceSample: row.recent_attendance_sample,
      hostRecentAttendanceRate: row.host_recent_attendance_rate === null ? null : Number(row.host_recent_attendance_rate),
      hostRecentAttendanceSample: row.host_recent_attendance_sample,
      monthlyCheckinStreak: trailingMonthlyStreak(row.checkin_months),
      monthlyHostingStreak: trailingMonthlyStreak(row.hosting_months),
      memberRepeatRate: row.member_repeat_rate === null ? null : Number(row.member_repeat_rate),
      categoryCheckins: normaliseCounts(row.category_checkins),
      categoryCompletions: normaliseCounts(row.category_completions),
      certified: row.certified === true,
      noSevereComplaint: row.no_severe_complaint === true,
    };
  }
}

interface AwardEvidence {
  ruleVersion?: number;
  privacy?: { hidden?: boolean; at?: string };
  revocation?: { reason?: string; at?: string };
  [key: string]: unknown;
}

interface MetricRow extends QueryResultRow {
  checked_in_count: number;
  hosted_ended_count: number;
  hosted_completed_count: number;
  owned_group_members: number;
  valid_feedback_count: number;
  recent_attendance_rate: string | number | null;
  recent_attendance_sample: number;
  host_recent_attendance_rate: string | number | null;
  host_recent_attendance_sample: number;
  category_checkins: Record<string, unknown>;
  category_completions: Record<string, unknown>;
  checkin_months: (Date | string)[];
  hosting_months: (Date | string)[];
  certified: boolean | null;
  no_severe_complaint: boolean | null;
  member_repeat_rate: string | number | null;
}

function normaliseCounts(value: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value ?? {})) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) out[key] = parsed;
  }
  return out;
}

/**
 * Count of consecutive months, ending with the current month, that appear in
 * the supplied set of active months. Used for the "持续参与"/"连续组织" streaks so
 * the streak logic is unit-testable independently of PostgreSQL.
 */
export function trailingMonthlyStreak(months: (Date | string)[]): number {
  const active = new Set(
    (months ?? []).map((month) => {
      const date = month instanceof Date ? month : new Date(month);
      return `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
    }),
  );
  let streak = 0;
  const cursor = new Date();
  cursor.setUTCDate(1);
  cursor.setUTCHours(0, 0, 0, 0);
  for (let index = 0; index < 240; index += 1) {
    const key = `${cursor.getUTCFullYear()}-${cursor.getUTCMonth()}`;
    if (!active.has(key)) break;
    streak += 1;
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return streak;
}
