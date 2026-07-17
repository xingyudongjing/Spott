import { createHmac, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError, transitionEvent, type EventStatus } from '@spott/domain';
import type { PoolClient } from 'pg';
import { configuration } from '../../config.js';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';

interface AdminContext {
  id: string;
  label: string;
  roles: string[];
  data_scopes: string[];
  mfa_enrolled_at: Date;
}

type PgInteger = string | number | bigint;

interface PageRow {
  id: string;
  created_at: Date;
}

interface PageResult<Item> {
  items: Item[];
  hasMore: boolean;
  nextCursor: string | null;
}

interface UserListRow extends PageRow {
  public_handle: string;
  nickname: string;
  status: string;
  restriction_flags: string[];
  phone_verified_at: Date | null;
  device_risk: string;
  hosted_count: PgInteger;
  registration_count: PgInteger;
  complaint_count: PgInteger;
  updated_at: Date;
  version: PgInteger;
}

interface OrganizerListRow extends PageRow {
  public_handle: string;
  nickname: string;
  status: string;
  restriction_flags: string[];
  phone_verified_at: Date | null;
  hosted_count: PgInteger;
  upcoming_count: PgInteger;
  completed_count: PgInteger;
  checked_in_count: PgInteger;
  eligible_count: PgInteger;
  participants_60d: PgInteger;
  repeat_participants_60d: PgInteger;
  complaint_count: PgInteger;
  version: PgInteger;
}

interface EventListRow extends PageRow {
  public_slug: string;
  title: string;
  status: string;
  category_id: string | null;
  starts_at: Date | null;
  submitted_at: Date;
  version: PgInteger;
  organizer_id: string;
  organizer_handle: string;
  organizer_nickname: string;
  public_area: string | null;
  region_id: string | null;
  is_free: boolean | null;
  amount_jpy: PgInteger | null;
  risk_score: PgInteger;
  risk_reasons: string[];
}

interface GroupListRow extends PageRow {
  slug: string;
  name: string;
  status: string;
  join_mode: string;
  capacity: PgInteger;
  version: PgInteger;
  owner_id: string;
  owner_handle: string;
  owner_nickname: string;
  member_count: PgInteger;
  open_event_count: PgInteger;
  report_count: PgInteger;
  active_transfer_state: string | null;
  closing_at: Date | null;
}

interface ModerationCaseListRow extends PageRow {
  public_reference: string;
  target_type: string;
  target_id: string;
  reason: string;
  severity: string;
  status: string;
  sla_due_at: Date;
  version: PgInteger;
  assignee_id: string | null;
  assignee_label: string | null;
}

interface PointAdjustmentRow extends PageRow {
  bucket: string;
  amount: PgInteger;
  reason: string;
  state: string;
  points_transaction_id: string | null;
  decided_at: Date | null;
  executed_at: Date | null;
  required_approvals: PgInteger;
  approval_count: PgInteger;
  version: PgInteger;
  target_id: string;
  target_handle: string;
  target_nickname: string;
  requester_id: string;
  requester_label: string;
  approver_id: string | null;
  approver_label: string | null;
}

interface ConfigRevisionRow extends PageRow {
  key: string;
  value_json: unknown;
  version: PgInteger;
  audience: Record<string, unknown>;
  region: string | null;
  min_app_version: string | null;
  effective_from: Date | null;
  effective_to: Date | null;
  state: string;
  reason: string;
  submitter_id: string;
  submitter_label: string;
  approver_id: string | null;
  approver_label: string | null;
}

interface ExportRow extends PageRow {
  dataset: string;
  purpose: string;
  state: string;
  watermark: string;
  expires_at: Date;
  max_downloads: PgInteger;
  download_count: PgInteger;
  requester_id: string;
  requester_label: string;
  approver_id: string | null;
  approver_label: string | null;
}

interface AuditLogRow extends PageRow {
  actor_id: string | null;
  actor_label: string | null;
  action: string;
  resource: string;
  resource_id: string | null;
  purpose: string | null;
  trace_id: string;
}

interface AdminUserRow {
  id: string;
  identity_user_id: string;
  roles: string[];
  data_scopes: string[];
  mfa_enrolled_at: Date;
  disabled_at: Date | null;
  label: string;
}

interface RestrictionRow {
  id: string;
  status: string;
  restriction_flags: string[];
  version: PgInteger;
}

interface GroupLifecycleRow {
  id: string;
  owner_id: string;
  status: string;
  version: PgInteger;
}

interface VersionRow {
  version: PgInteger;
}

interface ModerationCaseDetailRow extends ModerationCaseListRow {
  report_id: string;
  reporter_id: string | null;
}

interface EvidenceRow {
  id: string;
  asset_id: string;
  retention_until: Date;
  created_at: Date;
  mime_type: string | null;
  byte_size: PgInteger | null;
}

interface ModerationActionRow {
  id: string;
  action_type: string;
  reason: string;
  expires_at: Date | null;
  created_at: Date;
}

interface AppealRow {
  id: string;
  status: string;
  created_at: Date;
  decided_at: Date | null;
}

interface ModerationClaimRow {
  id: string;
  assignee_id: string | null;
  status: string;
  version: PgInteger;
}

interface ModerationClaimUpdateRow {
  id: string;
  status: string;
  version: PgInteger;
  updated_at: Date;
}

interface ModerationDecisionRow {
  id: string;
  report_id: string;
  version: PgInteger;
  status: string;
  target_type: string;
  target_id: string;
}

interface EventReviewRow {
  organizer_id: string;
  status: EventStatus;
  version: PgInteger;
  poster_enabled: boolean;
  preferred_locale: string | null;
}

interface PointApprovalRow {
  id: string;
  requested_by: string;
  state: string;
  required_approvals: PgInteger;
  approval_count: PgInteger;
}

interface PointExecutionRow {
  id: string;
  target_user_id: string;
  bucket: 'paid' | 'free';
  amount: PgInteger;
  state: string;
}

interface WalletBalanceRow {
  paid_balance: PgInteger;
  free_balance: PgInteger;
}

interface ConfigApprovalRow {
  id: string;
  version: PgInteger;
  state: string;
  submitted_by: string;
}

interface ConfigImpactRow {
  id: string;
  key: string;
  region: string | null;
  audience: unknown;
  effective_from: Date | null;
}

interface ConfigActivationRow {
  id: string;
  key: string;
  version: PgInteger;
  state: string;
}

interface ConfigRollbackRow {
  key: string;
  value_json: unknown;
  audience: Record<string, unknown>;
  region: string | null;
  min_app_version: string | null;
}

interface ExportApprovalRow {
  id: string;
  requested_by: string;
  state: string;
}

interface ExportDownloadRow {
  id: string;
  object_key: string | null;
  expires_at: Date;
  download_count: PgInteger;
  max_downloads: PgInteger;
}

interface CursorValue {
  at: string;
  id: string;
}

interface OpsFilter {
  q?: string | undefined;
  status?: string | undefined;
}

interface CaseFilter extends OpsFilter {
  severity?: string | undefined;
  assignee?: string | undefined;
  targetType?: string | undefined;
}

interface AuditFilter {
  q?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  resource?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

@Injectable()
export class OpsService {
  constructor(
    private readonly database: Database,
    private readonly points: PointsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async overview(actor: AuthenticatedUser): Promise<unknown> {
    await this.requireOperator(actor);
    const result = await this.database.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM safety.moderation_cases c JOIN safety.reports r ON r.id = c.report_id
           WHERE r.severity = 'p0' AND c.status NOT IN ('decided','closed'))::text AS p0_open,
         (SELECT count(*) FROM safety.moderation_cases WHERE status NOT IN ('decided','closed'))::text AS moderation_open,
         (SELECT count(*) FROM events.events WHERE status = 'pending_review' AND deleted_at IS NULL)::text AS event_review_pending,
         (SELECT count(*) FROM admin.point_adjustment_requests WHERE state = 'pending')::text AS point_approvals_pending,
         (SELECT count(*) FROM safety.appeals WHERE status = 'pending')::text AS appeals_pending,
         (SELECT count(*) FROM sync.outbox_events WHERE published_at IS NULL)::text AS outbox_backlog,
         (SELECT count(*) FROM notification.deliveries WHERE state = 'delivered'
           AND created_at >= clock_timestamp() - interval '1 hour')::text AS delivered_1h,
         (SELECT count(*) FROM notification.deliveries
           WHERE created_at >= clock_timestamp() - interval '1 hour')::text AS delivery_total_1h,
         COALESCE((SELECT sum(entry.amount) FROM commerce.point_entries entry
           JOIN commerce.point_transactions tx ON tx.id = entry.transaction_id
           WHERE tx.status = 'posted' AND entry.bucket = 'paid'), 0)::text AS ledger_delta_paid,
         COALESCE((SELECT sum(entry.amount) FROM commerce.point_entries entry
           JOIN commerce.point_transactions tx ON tx.id = entry.transaction_id
           WHERE tx.status = 'posted' AND entry.bucket = 'free'), 0)::text AS ledger_delta_free,
         (SELECT count(DISTINCT user_id) FROM identity.sessions
           WHERE created_at >= clock_timestamp() - interval '30 days')::text AS active_users_30d,
         (SELECT count(*) FROM community.groups WHERE status = 'active' AND deleted_at IS NULL)::text AS active_groups,
         (SELECT count(*) FROM events.events WHERE status IN ('published','registration_closed','in_progress')
           AND deleted_at IS NULL)::text AS events_open,
         (SELECT count(*) FROM events.registrations WHERE status = 'checked_in'
           AND updated_at >= clock_timestamp() - interval '30 days')::text AS checked_in_30d,
         (SELECT count(*) FROM events.registrations WHERE status IN ('checked_in','no_show','final')
           AND updated_at >= clock_timestamp() - interval '30 days')::text AS eligible_checkins_30d,
         (SELECT count(*) FROM (SELECT user_id FROM events.registrations
           WHERE created_at >= clock_timestamp() - interval '60 days'
           GROUP BY user_id HAVING count(DISTINCT event_id) >= 2) repeated)::text AS repeat_users_60d,
         (SELECT count(DISTINCT user_id) FROM events.registrations
           WHERE created_at >= clock_timestamp() - interval '60 days')::text AS participants_60d`,
    );
    const row = result.rows[0] ?? {};
    return {
      generatedAt: new Date().toISOString(),
      queues: {
        p0Open: this.integer(row.p0_open),
        moderationOpen: this.integer(row.moderation_open),
        eventReviewPending: this.integer(row.event_review_pending),
        pointApprovalsPending: this.integer(row.point_approvals_pending),
        appealsPending: this.integer(row.appeals_pending),
        outboxBacklog: this.integer(row.outbox_backlog),
      },
      health: {
        deliverySuccessRate1h: this.ratio(row.delivered_1h, row.delivery_total_1h),
        ledgerDeltaPaid: this.integer(row.ledger_delta_paid),
        ledgerDeltaFree: this.integer(row.ledger_delta_free),
      },
      growth: {
        activeUsers30d: this.integer(row.active_users_30d),
        activeGroups: this.integer(row.active_groups),
        eventsOpen: this.integer(row.events_open),
        checkinRate30d: this.ratio(row.checked_in_30d, row.eligible_checkins_30d),
        repeatRate60d: this.ratio(row.repeat_users_60d, row.participants_60d),
      },
    };
  }

  async users(
    actor: AuthenticatedUser,
    filters: OpsFilter & { restriction?: string | undefined; deviceRisk?: string | undefined },
    cursor?: string,
    limit = 20,
  ): Promise<unknown> {
    await this.requireOperator(actor, ['support', 'securityLead', 'moderator', 'analyst']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<UserListRow>(
      `SELECT user_record.id, user_record.public_handle, profile.nickname, user_record.status,
         user_record.restriction_flags, user_record.phone_verified_at,
         COALESCE((SELECT CASE max(CASE device.risk_state WHEN 'blocked' THEN 3 WHEN 'elevated' THEN 2 ELSE 1 END)
           WHEN 3 THEN 'blocked' WHEN 2 THEN 'elevated' ELSE 'normal' END
           FROM identity.devices device WHERE device.user_id = user_record.id), 'normal') AS device_risk,
         (SELECT count(*) FROM events.events event_record WHERE event_record.organizer_id = user_record.id
           AND event_record.deleted_at IS NULL)::text AS hosted_count,
         (SELECT count(*) FROM events.registrations registration WHERE registration.user_id = user_record.id
           AND registration.deleted_at IS NULL)::text AS registration_count,
         (SELECT count(*) FROM safety.reports report WHERE report.target_type = 'user'
           AND report.target_id = user_record.id)::text AS complaint_count,
         user_record.created_at, user_record.updated_at, user_record.version
       FROM identity.users user_record
       JOIN identity.profiles profile ON profile.user_id = user_record.id
       WHERE user_record.deleted_at IS NULL
         AND ($1::text IS NULL OR user_record.public_handle ILIKE '%' || $1 || '%'
           OR profile.nickname ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR user_record.status::text = $2)
         AND ($3::text IS NULL OR $3 = ANY(user_record.restriction_flags))
         AND ($4::text IS NULL OR COALESCE((SELECT CASE max(CASE device.risk_state
           WHEN 'blocked' THEN 3 WHEN 'elevated' THEN 2 ELSE 1 END)
           WHEN 3 THEN 'blocked' WHEN 2 THEN 'elevated' ELSE 'normal' END
           FROM identity.devices device WHERE device.user_id = user_record.id), 'normal') = $4)
         AND ($5::timestamptz IS NULL OR (user_record.created_at, user_record.id) < ($5, $6::uuid))
       ORDER BY user_record.created_at DESC, user_record.id DESC LIMIT $7`,
      [filters.q || null, filters.status || null, filters.restriction || null, filters.deviceRisk || null,
        page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => ({
      id: row.id,
      handle: row.public_handle,
      nickname: row.nickname,
      status: row.status,
      restrictions: row.restriction_flags,
      phoneVerified: row.phone_verified_at !== null,
      deviceRisk: row.device_risk,
      hostedCount: this.integer(row.hosted_count),
      registrationCount: this.integer(row.registration_count),
      complaintCount: this.integer(row.complaint_count),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      version: this.integer(row.version),
    }));
  }

  async restrictionDecision(
    actor: AuthenticatedUser,
    userId: string,
    baseVersion: number,
    key: string,
    input: { status?: string | undefined; restrictions: string[]; expiresAt?: string | undefined; reason: string },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['support', 'securityLead']);
    const sensitive = input.status === 'suspended' || input.restrictions.includes('loginBlocked');
    if (sensitive && !admin.roles.includes('securityLead') && !admin.roles.includes('superAdmin')) {
      throw new DomainError('OPS_ROLE_FORBIDDEN', '登录或永久封禁需要安全负责人权限。', 403);
    }
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/users/${userId}/restriction-decisions`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const current = await client.query<RestrictionRow>(
        `SELECT id, status, restriction_flags, version FROM identity.users
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [userId],
      );
      const row = current.rows[0];
      if (!row) throw new DomainError('USER_NOT_FOUND', '用户不存在。', 404);
      this.assertVersion(row.version, baseVersion, '用户');
      if (sensitive) {
        const approval = await client.query<{ id: string }>(
          `INSERT INTO admin.approvals(resource_type, resource_id, submitted_by, purpose)
           VALUES ('user_restriction',$1,$2,$3) RETURNING id`,
          [userId, admin.id, input.reason],
        );
        const body = {
          id: userId,
          status: row.status,
          restrictions: row.restriction_flags,
          version: this.integer(row.version),
          decisionState: 'pending_approval',
          approvalId: approval.rows[0]!.id,
          requestId: traceId,
        };
        await this.audit(client, admin, 'user.restriction.submitted', 'user', userId, traceId, 'account_safety', input);
        await this.outbox(client, 'user', userId, 'user.restriction_approval_requested', body);
        await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'user', id: userId });
        return body;
      }
      const updated = await client.query<RestrictionRow>(
        `UPDATE identity.users SET status = COALESCE($2::identity.user_status, status),
           restriction_flags = $3::text[] WHERE id = $1
         RETURNING id, status, restriction_flags, version`,
        [userId, input.status ?? null, input.restrictions],
      );
      const updatedRow = updated.rows[0]!;
      const body = {
        id: userId,
        status: updatedRow.status,
        restrictions: updatedRow.restriction_flags,
        version: this.integer(updatedRow.version),
        expiresAt: input.expiresAt ?? null,
        requestId: traceId,
      };
      await this.audit(client, admin, 'user.restriction.decided', 'user', userId, traceId, 'account_safety', input);
      await this.outbox(client, 'user', userId, 'user.restriction.updated', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'user', id: userId });
      return body;
    });
  }

  async organizers(actor: AuthenticatedUser, filters: OpsFilter, cursor?: string, limit = 20): Promise<unknown> {
    await this.requireOperator(actor, ['moderator', 'analyst', 'eventReviewer']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<OrganizerListRow>(
      `SELECT user_record.id, user_record.public_handle, profile.nickname, user_record.status,
         user_record.restriction_flags, user_record.phone_verified_at, user_record.version,
         user_record.created_at,
         count(DISTINCT event_record.id)::text AS hosted_count,
         count(DISTINCT event_record.id) FILTER (WHERE event_record.status IN ('published','registration_closed','in_progress'))::text AS upcoming_count,
         count(DISTINCT event_record.id) FILTER (WHERE event_record.status IN ('ended','archived'))::text AS completed_count,
         count(DISTINCT registration.id) FILTER (WHERE registration.status = 'checked_in')::text AS checked_in_count,
         count(DISTINCT registration.id) FILTER (WHERE registration.status IN ('checked_in','no_show','final'))::text AS eligible_count,
         count(DISTINCT registration.user_id) FILTER (
           WHERE registration.created_at >= clock_timestamp() - interval '60 days'
             AND registration.status IN ('confirmed','checked_in','no_show','final')
         )::text AS participants_60d,
         (SELECT count(*)::text FROM (
           SELECT repeat_registration.user_id
           FROM events.registrations repeat_registration
           JOIN events.events repeat_event ON repeat_event.id = repeat_registration.event_id
           WHERE repeat_event.organizer_id = user_record.id
             AND repeat_event.deleted_at IS NULL AND repeat_registration.deleted_at IS NULL
             AND repeat_registration.created_at >= clock_timestamp() - interval '60 days'
             AND repeat_registration.status IN ('confirmed','checked_in','no_show','final')
           GROUP BY repeat_registration.user_id
           HAVING count(DISTINCT repeat_registration.event_id) >= 2
         ) repeat_participant) AS repeat_participants_60d,
         count(DISTINCT report.id)::text AS complaint_count
       FROM identity.users user_record
       JOIN identity.profiles profile ON profile.user_id = user_record.id
       JOIN events.events event_record ON event_record.organizer_id = user_record.id AND event_record.deleted_at IS NULL
       LEFT JOIN events.registrations registration ON registration.event_id = event_record.id AND registration.deleted_at IS NULL
       LEFT JOIN safety.reports report ON report.target_type = 'user' AND report.target_id = user_record.id
       WHERE user_record.deleted_at IS NULL
         AND ($1::text IS NULL OR user_record.public_handle ILIKE '%' || $1 || '%' OR profile.nickname ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR user_record.status::text = $2)
         AND ($3::timestamptz IS NULL OR (user_record.created_at, user_record.id) < ($3, $4::uuid))
       GROUP BY user_record.id, profile.nickname
       ORDER BY user_record.created_at DESC, user_record.id DESC LIMIT $5`,
      [filters.q || null, filters.status || null, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => {
      const hosted = this.integer(row.hosted_count);
      const participants = this.integer(row.participants_60d);
      return {
        id: row.id,
        handle: row.public_handle,
        nickname: row.nickname,
        status: row.status,
        verificationState: row.phone_verified_at ? 'phone_verified' : 'unverified',
        hostedCount: hosted,
        upcomingCount: this.integer(row.upcoming_count),
        completionRate: hosted ? this.integer(row.completed_count) / hosted : 0,
        checkinRate: this.ratio(row.checked_in_count, row.eligible_count),
        repeatRate60d: participants >= 5 ? this.ratio(row.repeat_participants_60d, row.participants_60d) : 0,
        complaintRate: hosted ? this.integer(row.complaint_count) / hosted : 0,
        restrictionFlags: row.restriction_flags,
        version: this.integer(row.version),
      };
    });
  }

  async events(
    actor: AuthenticatedUser,
    filters: OpsFilter & { riskMin?: number | undefined; region?: string | undefined },
    cursor?: string,
    limit = 20,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['moderator', 'eventReviewer', 'analyst']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const scopedRegions = this.scopedRegions(admin, filters.region);
    const result = await this.database.query<EventListRow>(
      `SELECT event_record.id, event_record.public_slug, event_record.title, event_record.status,
         event_record.category_id, event_record.starts_at, event_record.updated_at AS submitted_at,
         event_record.version, event_record.created_at,
         organizer.id AS organizer_id, organizer.public_handle AS organizer_handle,
         profile.nickname AS organizer_nickname, location.public_area, location.region_id,
         fee.is_free, fee.amount_jpy,
         LEAST(100, count(DISTINCT risk.risk_type) * 20)::int AS risk_score,
         COALESCE(array_agg(DISTINCT risk.risk_type) FILTER (WHERE risk.risk_type IS NOT NULL), '{}') AS risk_reasons
       FROM events.events event_record
       JOIN identity.users organizer ON organizer.id = event_record.organizer_id
       JOIN identity.profiles profile ON profile.user_id = organizer.id
       LEFT JOIN events.event_locations location ON location.event_id = event_record.id
       LEFT JOIN events.event_fees fee ON fee.event_id = event_record.id
       LEFT JOIN events.event_risks risk ON risk.event_id = event_record.id
       WHERE event_record.deleted_at IS NULL
         AND ($1::text IS NULL OR event_record.status::text = $1)
         AND ($2::text IS NULL OR event_record.title ILIKE '%' || $2 || '%'
           OR event_record.public_slug ILIKE '%' || $2 || '%' OR profile.nickname ILIKE '%' || $2 || '%')
         AND ($3::text[] IS NULL OR location.region_id = ANY($3))
         AND ($4::timestamptz IS NULL OR (event_record.created_at, event_record.id) < ($4, $5::uuid))
       GROUP BY event_record.id, organizer.id, profile.nickname, location.public_area,
         location.region_id, fee.is_free, fee.amount_jpy
       HAVING LEAST(100, count(DISTINCT risk.risk_type) * 20) >= $6
       ORDER BY event_record.created_at DESC, event_record.id DESC LIMIT $7`,
      [filters.status || null, filters.q || null, scopedRegions, page?.at ?? null, page?.id ?? null,
        filters.riskMin ?? 0, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => this.mapEvent(row));
  }

  async groups(actor: AuthenticatedUser, filters: OpsFilter, cursor?: string, limit = 20): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['moderator', 'groupReviewer', 'analyst']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const scopedRegions = this.scopedRegions(admin);
    const result = await this.database.query<GroupListRow>(
      `SELECT group_record.id, group_record.slug, group_record.name, group_record.status,
         group_record.join_mode, group_record.capacity, group_record.version, group_record.created_at,
         owner.id AS owner_id, owner.public_handle AS owner_handle, profile.nickname AS owner_nickname,
         count(DISTINCT membership.id) FILTER (WHERE membership.status IN ('active','muted'))::text AS member_count,
         count(DISTINCT event_record.id) FILTER (WHERE event_record.status IN ('published','registration_closed','in_progress'))::text AS open_event_count,
         count(DISTINCT report.id)::text AS report_count,
         max(transfer.state) FILTER (WHERE transfer.state IN ('awaiting_target','cooling_off')) AS active_transfer_state,
         max(dissolution.scheduled_for) FILTER (WHERE dissolution.cancelled_at IS NULL AND dissolution.completed_at IS NULL) AS closing_at
       FROM community.groups group_record
       JOIN identity.users owner ON owner.id = group_record.owner_id
       JOIN identity.profiles profile ON profile.user_id = owner.id
       LEFT JOIN community.group_memberships membership ON membership.group_id = group_record.id
       LEFT JOIN events.events event_record ON event_record.group_id = group_record.id AND event_record.deleted_at IS NULL
       LEFT JOIN safety.reports report ON report.target_type = 'group' AND report.target_id = group_record.id
       LEFT JOIN community.group_transfers transfer ON transfer.group_id = group_record.id
       LEFT JOIN community.group_dissolutions dissolution ON dissolution.group_id = group_record.id
       WHERE group_record.deleted_at IS NULL
         AND ($1::text IS NULL OR group_record.name ILIKE '%' || $1 || '%' OR group_record.slug ILIKE '%' || $1 || '%')
         AND ($2::text IS NULL OR group_record.status::text = $2)
         AND ($3::text[] IS NULL OR group_record.region_id = ANY($3))
         AND ($4::timestamptz IS NULL OR (group_record.created_at, group_record.id) < ($4, $5::uuid))
       GROUP BY group_record.id, owner.id, profile.nickname
       ORDER BY group_record.created_at DESC, group_record.id DESC LIMIT $6`,
      [filters.q || null, filters.status || null, scopedRegions, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      owner: { id: row.owner_id, handle: row.owner_handle, nickname: row.owner_nickname },
      status: row.status,
      joinMode: row.join_mode,
      memberCount: this.integer(row.member_count),
      capacity: this.integer(row.capacity),
      openEventCount: this.integer(row.open_event_count),
      reportCount: this.integer(row.report_count),
      activeTransferState: row.active_transfer_state ?? null,
      closingAt: row.closing_at?.toISOString() ?? null,
      version: this.integer(row.version),
    }));
  }

  async groupLifecycleDecision(
    actor: AuthenticatedUser,
    groupId: string,
    baseVersion: number,
    key: string,
    input: { decision: 'restore' | 'start_closing' | 'cancel_closing' | 'remove'; reason: string },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['groupReviewer', 'securityLead']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/groups/${groupId}/lifecycle-decision`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<GroupLifecycleRow>('SELECT id, owner_id, status, version FROM community.groups WHERE id = $1 FOR UPDATE', [groupId]);
      const group = found.rows[0];
      if (!group) throw new DomainError('GROUP_NOT_FOUND', '群组不存在。', 404);
      this.assertVersion(group.version, baseVersion, '群组');
      let status = group.status;
      if (input.decision === 'remove') status = 'removed';
      if (input.decision === 'restore') status = 'active';
      if (input.decision === 'start_closing') status = 'closing';
      if (input.decision === 'cancel_closing') status = 'active';
      if (input.decision === 'start_closing') {
        await client.query(
          `INSERT INTO community.group_dissolutions(group_id,requested_by,reason,scheduled_for)
           VALUES ($1,$2,$3,clock_timestamp()+interval '7 days')
           ON CONFLICT (group_id) WHERE cancelled_at IS NULL AND completed_at IS NULL DO NOTHING`,
          [groupId, group.owner_id, input.reason],
        );
      }
      if (input.decision === 'cancel_closing') {
        await client.query(
          `UPDATE community.group_dissolutions SET cancelled_at = clock_timestamp(), cancelled_by = $2
           WHERE group_id = $1 AND cancelled_at IS NULL AND completed_at IS NULL`,
          [groupId, actor.id],
        );
      }
      const updated = await client.query<VersionRow>('UPDATE community.groups SET status = $2 WHERE id = $1 RETURNING version', [groupId, status]);
      const updatedRow = updated.rows[0]!;
      const body = { id: groupId, status, version: this.integer(updatedRow.version), requestId: traceId };
      await this.audit(client, admin, `group.lifecycle.${input.decision}`, 'group', groupId, traceId, 'community_safety', input);
      await this.outbox(client, 'group', groupId, 'group.lifecycle.updated', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'group', id: groupId });
      return body;
    });
  }

  async cases(actor: AuthenticatedUser, filters: CaseFilter = {}, cursor?: string, limit = 20): Promise<unknown> {
    await this.requireOperator(actor, ['moderator', 'securityLead', 'support']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<ModerationCaseListRow>(
      `SELECT moderation_case.id, report.public_reference, report.target_type, report.target_id,
         report.reason, report.severity, moderation_case.status, moderation_case.sla_due_at,
         moderation_case.version, moderation_case.created_at,
         assignee.id AS assignee_id, COALESCE(profile.nickname, assignee_identity.public_handle::text) AS assignee_label
       FROM safety.moderation_cases moderation_case
       JOIN safety.reports report ON report.id = moderation_case.report_id
       LEFT JOIN admin.admin_users assignee ON assignee.id = moderation_case.assignee_id
       LEFT JOIN identity.users assignee_identity ON assignee_identity.id = assignee.identity_user_id
       LEFT JOIN identity.profiles profile ON profile.user_id = assignee.identity_user_id
       WHERE ($1::text IS NULL OR report.severity::text = $1)
         AND ($2::text IS NULL OR moderation_case.status::text = $2)
         AND ($3::uuid IS NULL OR moderation_case.assignee_id = $3)
         AND ($4::text IS NULL OR report.target_type = $4)
         AND ($5::text IS NULL OR report.public_reference ILIKE '%' || $5 || '%' OR report.reason ILIKE '%' || $5 || '%')
         AND ($6::timestamptz IS NULL OR (moderation_case.created_at, moderation_case.id) < ($6, $7::uuid))
       ORDER BY moderation_case.created_at DESC, moderation_case.id DESC LIMIT $8`,
      [filters.severity || null, filters.status || null, filters.assignee || null, filters.targetType || null,
        filters.q || null, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => this.mapCase(row));
  }

  async moderationCase(actor: AuthenticatedUser, caseId: string, purpose?: string): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['moderator', 'securityLead', 'support']);
    const result = await this.database.query<ModerationCaseDetailRow>(
      `SELECT moderation_case.id, moderation_case.report_id, report.public_reference,
         report.target_type, report.target_id, report.reason, report.severity,
         moderation_case.status, moderation_case.sla_due_at, moderation_case.version,
         moderation_case.created_at, report.reporter_id,
         assignee.id AS assignee_id, COALESCE(profile.nickname, assignee_identity.public_handle::text) AS assignee_label
       FROM safety.moderation_cases moderation_case
       JOIN safety.reports report ON report.id = moderation_case.report_id
       LEFT JOIN admin.admin_users assignee ON assignee.id = moderation_case.assignee_id
       LEFT JOIN identity.users assignee_identity ON assignee_identity.id = assignee.identity_user_id
       LEFT JOIN identity.profiles profile ON profile.user_id = assignee.identity_user_id
       WHERE moderation_case.id = $1`,
      [caseId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('CASE_NOT_FOUND', '审核案件不存在。', 404);
    const [evidence, actions, appeals] = await Promise.all([
      this.database.query<EvidenceRow>(
        `SELECT evidence.id, evidence.asset_id, evidence.retention_until, evidence.created_at,
           asset.mime_type, asset.byte_size
         FROM safety.evidence_assets evidence
         LEFT JOIN media.assets asset ON asset.id = evidence.asset_id
         WHERE evidence.report_id = $1 AND evidence.deleted_at IS NULL ORDER BY evidence.created_at`,
        [row.report_id],
      ),
      this.database.query<ModerationActionRow>(
        `SELECT id, action_type, reason, expires_at, created_at FROM safety.moderation_actions
         WHERE case_id = $1 ORDER BY created_at`,
        [caseId],
      ),
      this.database.query<AppealRow>(
        `SELECT id, status, created_at, decided_at FROM safety.appeals
         WHERE case_id = $1 ORDER BY created_at`,
        [caseId],
      ),
    ]);
    if (purpose) {
      await this.database.query(
        `INSERT INTO admin.sensitive_access_logs(admin_user_id,resource_type,resource_id,field_names,purpose,trace_id)
         VALUES ($1,'moderation_case',$2,ARRAY['evidence'], $3, $4)`,
        [admin.id, caseId, purpose, `case-evidence-${randomUUID()}`],
      );
    }
    return {
      ...this.mapCase(row),
      target: { type: row.target_type, idMasked: this.mask(row.target_id) },
      reporter: { present: row.reporter_id !== null },
      evidence: evidence.rows.map((item) => ({
        id: item.id,
        assetId: item.asset_id,
        mimeType: item.mime_type,
        byteSize: this.integer(item.byte_size),
        retentionUntil: item.retention_until.toISOString(),
        signedUrl: purpose ? this.signedUrl('evidence', item.asset_id, 300) : null,
      })),
      actions: actions.rows.map((item) => ({
        id: item.id,
        type: item.action_type,
        reason: item.reason,
        expiresAt: item.expires_at?.toISOString() ?? null,
        createdAt: item.created_at.toISOString(),
      })),
      appeals: appeals.rows.map((item) => ({
        id: item.id,
        status: item.status,
        createdAt: item.created_at.toISOString(),
        decidedAt: item.decided_at?.toISOString() ?? null,
      })),
    };
  }

  async claimCase(
    actor: AuthenticatedUser,
    caseId: string,
    baseVersion: number,
    key: string,
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['moderator', 'securityLead']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/moderation/cases/${caseId}/claim`, {});
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<ModerationClaimRow>(
        `SELECT id, assignee_id, status, version FROM safety.moderation_cases WHERE id = $1 FOR UPDATE`,
        [caseId],
      );
      const row = found.rows[0];
      if (!row) throw new DomainError('CASE_NOT_FOUND', '审核案件不存在。', 404);
      this.assertVersion(row.version, baseVersion, '案件');
      if (row.assignee_id && row.assignee_id !== admin.id) throw new DomainError('CASE_ALREADY_CLAIMED', '案件已由其他运营认领。', 409);
      const updated = await client.query<ModerationClaimUpdateRow>(
        `UPDATE safety.moderation_cases SET assignee_id = $2, status = CASE WHEN status = 'open' THEN 'claimed' ELSE status END
         WHERE id = $1 RETURNING id, status, version, updated_at`,
        [caseId, admin.id],
      );
      const updatedRow = updated.rows[0]!;
      const body = {
        id: caseId,
        status: updatedRow.status,
        assignee: { id: admin.id, label: admin.label },
        version: this.integer(updatedRow.version),
        requestId: traceId,
      };
      await this.audit(client, admin, 'moderation.case.claimed', 'moderation_case', caseId, traceId, 'moderation', body);
      await this.outbox(client, 'safety.case', caseId, 'moderation.claimed', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'moderation_case', id: caseId });
      return body;
    });
  }

  async decide(
    actor: AuthenticatedUser,
    caseId: string,
    baseVersion: number,
    key: string,
    input: {
      decision: 'no_action' | 'hide' | 'remove' | 'restrict';
      reason: string;
      durationHours?: number | undefined;
    },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['moderator', 'securityLead']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/moderation/cases/${caseId}/decision`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const result = await client.query<ModerationDecisionRow>(
        `SELECT moderation_case.id, moderation_case.report_id, moderation_case.version,
           moderation_case.status, report.target_type, report.target_id
         FROM safety.moderation_cases moderation_case
         JOIN safety.reports report ON report.id = moderation_case.report_id
         WHERE moderation_case.id = $1 FOR UPDATE OF moderation_case, report`,
        [caseId],
      );
      const moderationCase = result.rows[0];
      if (!moderationCase) throw new DomainError('CASE_NOT_FOUND', '审核案件不存在。', 404);
      this.assertVersion(moderationCase.version, baseVersion, '案件');
      if (moderationCase.status === 'decided' || moderationCase.status === 'closed') {
        throw new DomainError('CASE_ALREADY_DECIDED', '案件已经处理。', 409);
      }
      const updated = await client.query<VersionRow>(
        `UPDATE safety.moderation_cases SET status = 'decided', decision = $2
         WHERE id = $1 RETURNING version`,
        [caseId, input.decision],
      );
      const updatedRow = updated.rows[0]!;
      await client.query("UPDATE safety.reports SET status = 'decided', updated_at = clock_timestamp() WHERE id = $1", [moderationCase.report_id]);
      if (moderationCase.target_type === 'event' && ['hide', 'remove'].includes(input.decision)) {
        await client.query("UPDATE events.events SET status = 'removed' WHERE id = $1 AND status <> 'removed'", [moderationCase.target_id]);
      }
      if (moderationCase.target_type === 'group' && ['hide', 'remove'].includes(input.decision)) {
        await client.query("UPDATE community.groups SET status = 'removed' WHERE id = $1 AND status <> 'removed'", [moderationCase.target_id]);
      }
      if (moderationCase.target_type === 'user' && input.decision === 'restrict') {
        await client.query(
          `UPDATE identity.users SET status = 'restricted',
             restriction_flags = ARRAY(SELECT DISTINCT flag FROM unnest(restriction_flags || ARRAY['publishBlocked','commentBlocked']) flag)
           WHERE id = $1`,
          [moderationCase.target_id],
        );
      }
      const decisionPayload = {
        decision: input.decision,
        targetType: moderationCase.target_type,
        targetId: moderationCase.target_id,
      };
      await client.query(
        `INSERT INTO safety.moderation_actions(case_id,actor_id,action_type,subject_id,reason,before_json,after_json,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,
           CASE WHEN $8::int IS NULL THEN NULL ELSE clock_timestamp() + make_interval(hours => $8) END)`,
        [caseId, admin.id, input.decision, moderationCase.target_id, input.reason,
          { status: moderationCase.status }, decisionPayload, input.durationHours ?? null],
      );
      const body = {
        id: caseId,
        status: 'decided',
        decision: input.decision,
        version: this.integer(updatedRow.version),
        requestId: traceId,
      };
      await this.audit(client, admin, 'moderation.decision', 'moderation_case', caseId, traceId, 'moderation', decisionPayload);
      await this.outbox(client, 'safety.case', caseId, 'moderation.decided', decisionPayload);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'moderation_case', id: caseId });
      return body;
    });
  }

  async reviewEvent(
    actor: AuthenticatedUser,
    eventId: string,
    baseVersion: number,
    key: string,
    decision: 'published' | 'needs_changes' | 'rejected',
    reason: string,
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['eventReviewer', 'moderator']);
    return this.database.transaction(async (client) => {
      const request = { decision, reason, baseVersion };
      const hash = this.idempotency.requestHash('POST', `/ops/events/${eventId}/review`, request);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const event = await client.query<EventReviewRow>(
        `SELECT event_record.organizer_id,event_record.status,event_record.version,
           event_record.poster_enabled,profile.preferred_locale
         FROM events.events event_record
         JOIN identity.profiles profile ON profile.user_id=event_record.organizer_id
         WHERE event_record.id=$1 FOR UPDATE OF event_record`,
        [eventId],
      );
      const row = event.rows[0];
      if (!row || row.status !== 'pending_review') throw new DomainError('EVENT_REVIEW_NOT_PENDING', '活动不在待审核状态。', 409);
      this.assertVersion(row.version, baseVersion, '活动');
      transitionEvent(row.status, decision);
      const hold = await client.query<{ id: string }>(
        `SELECT id FROM commerce.point_holds WHERE user_id = $1
         AND business_key LIKE $2 AND state = 'active'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [row.organizer_id, `event_publish_hold:${eventId}:%`],
      );
      if (hold.rows[0]) {
        if (decision === 'published') {
          await this.points.captureHold(client, hold.rows[0].id, 'event_publish', `event_publish:${eventId}:${row.version}`);
        } else {
          await this.points.releaseHold(client, hold.rows[0].id);
        }
      }
      const updated = await client.query<{ version: string }>(
        'UPDATE events.events SET status = $2, updated_by = $3 WHERE id = $1 RETURNING version',
        [eventId, decision, actor.id],
      );
      let posterJobId: string | null = null;
      if (decision === 'published' && row.poster_enabled) {
        const poster = await client.query<{ id: string; state: string }>(
          `INSERT INTO growth.poster_jobs(user_id,resource_type,resource_id,template,locale)
           VALUES ($1,'event',$2,'event_approved',$3)
           ON CONFLICT (resource_id) WHERE resource_type='event' AND template='event_approved'
           DO NOTHING RETURNING id,state`,
          [row.organizer_id, eventId, row.preferred_locale ?? 'zh-Hans'],
        );
        let posterJob = poster.rows[0];
        posterJob ??= (await client.query<{ id: string; state: string }>(
          `SELECT id,state FROM growth.poster_jobs
           WHERE resource_type='event' AND resource_id=$1 AND template='event_approved'`,
          [eventId],
        )).rows[0];
        posterJobId = posterJob?.id ?? null;
        if (poster.rows[0]) {
          await this.outbox(client, 'poster', poster.rows[0].id, 'poster.render_requested', {
            posterJobId: poster.rows[0].id,
            resourceType: 'event',
            resourceId: eventId,
            template: 'event_approved',
            locale: row.preferred_locale ?? 'zh-Hans',
          });
        }
      }
      const body = {
        id: eventId,
        eventId,
        status: decision,
        reason,
        version: this.integer(updated.rows[0]!.version),
        posterJobId,
        requestId: traceId,
      };
      await client.query(
        `SELECT sync.record_change($1, 'event.reviewed', 'event', $2, 'upsert', $3, ARRAY['status'], $4)`,
        [row.organizer_id, eventId, updated.rows[0]!.version, body],
      );
      await this.audit(client, admin, 'event.reviewed', 'event', eventId, traceId, 'event_review', body);
      await this.outbox(client, 'event', eventId, 'event.reviewed', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'event', id: eventId });
      return body;
    });
  }

  async pointAdjustments(actor: AuthenticatedUser, state?: string, cursor?: string, limit = 20): Promise<unknown> {
    await this.requireOperator(actor, ['pointsRequester', 'pointsApprover', 'financeRead', 'financeLead']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<PointAdjustmentRow>(
      `${this.pointAdjustmentSelect()}
       WHERE ($1::text IS NULL OR request.state = $1)
         AND ($2::timestamptz IS NULL OR (request.created_at, request.id) < ($2, $3::uuid))
       ORDER BY request.created_at DESC, request.id DESC LIMIT $4`,
      [state || null, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => this.mapPointAdjustment(row));
  }

  async createPointAdjustment(
    actor: AuthenticatedUser,
    key: string,
    input: { targetUserId: string; bucket: 'paid' | 'free'; amount: number; reason: string; evidenceRef?: string | undefined },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['pointsRequester', 'financeLead']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', '/ops/points/adjustments', input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const target = await client.query('SELECT id FROM identity.users WHERE id = $1 AND deleted_at IS NULL', [input.targetUserId]);
      if (!target.rowCount) throw new DomainError('USER_NOT_FOUND', '积分调整目标用户不存在。', 404);
      const requiredApprovals = input.bucket === 'paid' || Math.abs(input.amount) >= 10_000 ? 2 : 1;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admin.point_adjustment_requests(
           target_user_id,bucket,amount,reason,evidence_ref,requested_by,required_approvals
         ) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [input.targetUserId, input.bucket, input.amount, input.reason, input.evidenceRef ?? null, admin.id, requiredApprovals],
      );
      const body = await this.loadPointAdjustment(client, inserted.rows[0]!.id);
      await this.audit(client, admin, 'points.adjustment.requested', 'point_adjustment', inserted.rows[0]!.id, traceId, 'ledger_adjustment', input);
      await this.outbox(client, 'point_adjustment', inserted.rows[0]!.id, 'points.adjustment.requested', body);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, { type: 'point_adjustment', id: inserted.rows[0]!.id });
      return body;
    });
  }

  async decidePointAdjustment(
    actor: AuthenticatedUser,
    adjustmentId: string,
    key: string,
    input: { decision: 'approve' | 'reject'; reason: string },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['pointsApprover', 'financeLead']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/points/adjustments/${adjustmentId}/decision`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<PointApprovalRow>(
        `SELECT id,requested_by,state,required_approvals,approval_count
         FROM admin.point_adjustment_requests WHERE id = $1 FOR UPDATE`,
        [adjustmentId],
      );
      const row = found.rows[0];
      if (!row) throw new DomainError('POINT_ADJUSTMENT_NOT_FOUND', '积分调整申请不存在。', 404);
      if (row.requested_by === admin.id) throw new DomainError('APPROVAL_SEPARATION_REQUIRED', '申请人与审批人必须分离。', 409);
      if (row.state !== 'pending') throw new DomainError('POINT_ADJUSTMENT_NOT_PENDING', '积分调整申请已处理。', 409);
      try {
        await client.query(
          `INSERT INTO admin.point_adjustment_approvals(request_id,approver_id,decision,reason)
           VALUES ($1,$2,$3,$4)`,
          [adjustmentId, admin.id, input.decision, input.reason],
        );
      } catch (error) {
        if (this.pgCode(error) === '23505') throw new DomainError('APPROVAL_ALREADY_RECORDED', '同一审批人不能重复审批。', 409);
        throw error;
      }
      const nextCount = this.integer(row.approval_count) + (input.decision === 'approve' ? 1 : 0);
      const nextState = input.decision === 'reject'
        ? 'rejected'
        : nextCount >= this.integer(row.required_approvals) ? 'approved' : 'pending';
      await client.query(
        `UPDATE admin.point_adjustment_requests SET state = $2, approval_count = $3,
           approved_by = CASE WHEN $2 = 'approved' THEN $4 ELSE approved_by END,
           decision_reason = $5, decided_at = CASE WHEN $2 <> 'pending' THEN clock_timestamp() ELSE decided_at END
         WHERE id = $1`,
        [adjustmentId, nextState, nextCount, admin.id, input.reason],
      );
      const body = await this.loadPointAdjustment(client, adjustmentId);
      await this.audit(client, admin, `points.adjustment.${input.decision}`, 'point_adjustment', adjustmentId, traceId, 'ledger_adjustment', body);
      await this.outbox(client, 'point_adjustment', adjustmentId, 'points.adjustment.decided', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'point_adjustment', id: adjustmentId });
      return body;
    });
  }

  async executePointAdjustment(actor: AuthenticatedUser, adjustmentId: string, key: string, traceId: string): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['pointsApprover', 'financeLead']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/points/adjustments/${adjustmentId}/execute`, {});
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<PointExecutionRow>(
        `SELECT id,target_user_id,bucket,amount,state FROM admin.point_adjustment_requests
         WHERE id = $1 FOR UPDATE`,
        [adjustmentId],
      );
      const row = found.rows[0];
      if (!row) throw new DomainError('POINT_ADJUSTMENT_NOT_FOUND', '积分调整申请不存在。', 404);
      if (row.state !== 'approved') throw new DomainError('POINT_ADJUSTMENT_NOT_APPROVED', '积分调整尚未完成审批。', 409);
      await client.query(
        `INSERT INTO commerce.wallets(user_id,paid_balance,free_balance) VALUES ($1,0,0)
         ON CONFLICT (user_id) DO NOTHING`,
        [row.target_user_id],
      );
      const wallet = await client.query<WalletBalanceRow>('SELECT paid_balance,free_balance FROM commerce.wallets WHERE user_id = $1 FOR UPDATE', [row.target_user_id]);
      const balance = BigInt(row.bucket === 'paid'
        ? wallet.rows[0]!.paid_balance
        : wallet.rows[0]!.free_balance);
      const amount = BigInt(row.amount);
      if (amount < 0n && balance + amount < 0n) throw new DomainError('POINT_ADJUSTMENT_INSUFFICIENT', '扣减后钱包余额不能为负。', 409);
      const transaction = await client.query<{ id: string }>(
        `INSERT INTO commerce.point_transactions(user_id,type,business_key,status,metadata,posted_at)
         VALUES ($1,'ops_adjustment',$2,'posted',$3,clock_timestamp()) RETURNING id`,
        [row.target_user_id, `ops_adjustment:${adjustmentId}`, { adjustmentId, actorId: admin.id }],
      );
      await client.query(
        `INSERT INTO commerce.point_entries(transaction_id,account_code,bucket,amount)
         VALUES ($1,'user:' || $2::text,$3,$4),($1,'platform:ops_adjustment',$3,$5)`,
        [transaction.rows[0]!.id, row.target_user_id, row.bucket, amount.toString(), (-amount).toString()],
      );
      await client.query(
        `UPDATE commerce.wallets SET
           paid_balance = paid_balance + CASE WHEN $2 = 'paid' THEN $3::bigint ELSE 0 END,
           free_balance = free_balance + CASE WHEN $2 = 'free' THEN $3::bigint ELSE 0 END
         WHERE user_id = $1`,
        [row.target_user_id, row.bucket, amount.toString()],
      );
      await client.query(
        `UPDATE admin.point_adjustment_requests SET state = 'executed', points_transaction_id = $2,
           executed_at = clock_timestamp() WHERE id = $1`,
        [adjustmentId, transaction.rows[0]!.id],
      );
      const body = await this.loadPointAdjustment(client, adjustmentId);
      await this.audit(client, admin, 'points.adjustment.executed', 'point_adjustment', adjustmentId, traceId, 'ledger_adjustment', body);
      await this.outbox(client, 'point_adjustment', adjustmentId, 'points.adjustment.executed', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'point_adjustment', id: adjustmentId });
      return body;
    });
  }

  async ledgerHealth(actor: AuthenticatedUser): Promise<unknown> {
    await this.requireOperator(actor, ['pointsApprover', 'financeRead', 'financeLead']);
    const result = await this.database.query<Record<string, string>>(
      `SELECT
         COALESCE(sum(entry.amount) FILTER (WHERE entry.bucket = 'paid'),0)::text AS paid_delta,
         COALESCE(sum(entry.amount) FILTER (WHERE entry.bucket = 'free'),0)::text AS free_delta,
         (SELECT count(*) FROM commerce.wallets WHERE paid_balance < 0)::text AS negative_paid_wallets,
         (SELECT count(*) FROM commerce.store_orders WHERE state IN ('verified','failed'))::text AS pending_store_reconciliations,
         (SELECT count(*) FROM commerce.point_entries WHERE bucket = 'free' AND amount > 0
           AND expires_at BETWEEN clock_timestamp() AND clock_timestamp() + interval '30 days')::text AS expiring_lots
       FROM commerce.point_entries entry
       JOIN commerce.point_transactions transaction_record ON transaction_record.id = entry.transaction_id
       WHERE transaction_record.status = 'posted'`,
    );
    const row = result.rows[0] ?? {};
    const paid = this.integer(row.paid_delta);
    const free = this.integer(row.free_delta);
    return {
      checkedAt: new Date().toISOString(),
      balanced: paid === 0 && free === 0 && this.integer(row.negative_paid_wallets) === 0,
      paidDelta: paid,
      freeDelta: free,
      negativePaidWallets: this.integer(row.negative_paid_wallets),
      pendingStoreReconciliations: this.integer(row.pending_store_reconciliations),
      expiringLots: this.integer(row.expiring_lots),
    };
  }

  async configRevisions(actor: AuthenticatedUser, filters: OpsFilter & { key?: string | undefined }, cursor?: string, limit = 20): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['configEditor', 'configApprover', 'analyst']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<ConfigRevisionRow>(
      `${this.configRevisionSelect()}
       WHERE ($1::text IS NULL OR revision.state = $1)
         AND ($2::text IS NULL OR revision.key ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL OR (revision.created_at, revision.id) < ($3, $4::uuid))
       ORDER BY revision.created_at DESC, revision.id DESC LIMIT $5`,
      [filters.status || null, filters.key || null, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => this.mapConfigRevision(row, admin));
  }

  async createConfigRevision(
    actor: AuthenticatedUser,
    key: string,
    input: {
      value: unknown; audience: Record<string, unknown>; region?: string | undefined; minAppVersion?: string | undefined;
      effectiveFrom?: string | undefined; effectiveTo?: string | undefined; reason: string;
    },
    idempotencyKey: string,
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['configEditor']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', '/ops/config-revisions', { key, ...input });
      const replay = await this.idempotency.claim<unknown>(client, actor.id, idempotencyKey, hash);
      if (replay) return replay.body;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admin.config_revisions(
           key,value_json,version,audience,region,min_app_version,effective_from,effective_to,submitted_by,reason
         ) VALUES ($1,$2,COALESCE((SELECT max(version)+1 FROM admin.config_revisions WHERE key=$1),1),
           $3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [key, input.value, input.audience, input.region ?? null, input.minAppVersion ?? null,
          input.effectiveFrom ?? null, input.effectiveTo ?? null, admin.id, input.reason],
      );
      const body = await this.loadConfigRevision(client, inserted.rows[0]!.id, admin);
      await this.audit(client, admin, 'config.revision.created', 'config_revision', inserted.rows[0]!.id, traceId, 'change_control', body);
      await this.outbox(client, 'config_revision', inserted.rows[0]!.id, 'config.revision.created', body);
      await this.idempotency.complete(client, actor.id, idempotencyKey, { status: 201, body }, { type: 'config_revision', id: inserted.rows[0]!.id });
      return body;
    });
  }

  async configImpact(actor: AuthenticatedUser, revisionId: string): Promise<unknown> {
    await this.requireOperator(actor, ['configEditor', 'configApprover', 'analyst']);
    const result = await this.database.query<ConfigImpactRow>(
      `SELECT id,key,region,audience,effective_from FROM admin.config_revisions WHERE id = $1`,
      [revisionId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('CONFIG_REVISION_NOT_FOUND', '配置修订不存在。', 404);
    const affected = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM identity.profiles profile
       WHERE profile.deleted_at IS NULL AND ($1::text IS NULL OR profile.region_id = $1)`,
      [row.region],
    );
    return {
      affectedUsers: this.integer(affected.rows[0]?.count),
      affectedRegions: row.region ? [row.region] : ['jp'],
      warnings: row.key.startsWith('points.') ? ['积分配置会保护已生成且未过期的报价。'] : [],
      quoteProtection: row.key.startsWith('points.'),
    };
  }

  async approveConfig(
    actor: AuthenticatedUser,
    revisionId: string,
    baseVersion: number,
    key: string,
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['configApprover']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/config-revisions/${revisionId}/approve`, { baseVersion });
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<ConfigApprovalRow>('SELECT id,version,state,submitted_by FROM admin.config_revisions WHERE id = $1 FOR UPDATE', [revisionId]);
      const row = found.rows[0];
      if (!row) throw new DomainError('CONFIG_REVISION_NOT_FOUND', '配置修订不存在。', 404);
      this.assertVersion(row.version, baseVersion, '配置修订');
      if (row.submitted_by === admin.id || row.state !== 'draft') {
        throw new DomainError('APPROVAL_SEPARATION_REQUIRED', '提交人与审批人必须分离，且修订需处于草稿状态。', 409);
      }
      await client.query("UPDATE admin.config_revisions SET state = 'approved', approved_by = $2, updated_at = clock_timestamp() WHERE id = $1", [revisionId, admin.id]);
      const body = await this.loadConfigRevision(client, revisionId, admin);
      await this.audit(client, admin, 'config.approved', 'config_revision', revisionId, traceId, 'change_control', body);
      await this.outbox(client, 'config_revision', revisionId, 'config.revision.approved', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'config_revision', id: revisionId });
      return body;
    });
  }

  async activateConfig(actor: AuthenticatedUser, revisionId: string, key: string, traceId: string): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['configApprover']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/config-revisions/${revisionId}/activate`, {});
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<ConfigActivationRow>('SELECT id,key,version,state FROM admin.config_revisions WHERE id=$1 FOR UPDATE', [revisionId]);
      const row = found.rows[0];
      if (!row) throw new DomainError('CONFIG_REVISION_NOT_FOUND', '配置修订不存在。', 404);
      if (row.state !== 'approved') throw new DomainError('CONFIG_REVISION_NOT_APPROVED', '配置修订尚未审批。', 409);
      await client.query("UPDATE admin.config_revisions SET state='superseded',updated_at=clock_timestamp() WHERE key=$1 AND state='active'", [row.key]);
      await client.query("UPDATE admin.config_revisions SET state='active',effective_from=COALESCE(effective_from,clock_timestamp()),updated_at=clock_timestamp() WHERE id=$1", [revisionId]);
      const body = await this.loadConfigRevision(client, revisionId, admin);
      await this.audit(client, admin, 'config.activated', 'config_revision', revisionId, traceId, 'change_control', body);
      await this.outbox(client, 'config_revision', revisionId, 'config.revision.activated', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'config_revision', id: revisionId });
      return body;
    });
  }

  async rollbackConfig(actor: AuthenticatedUser, revisionId: string, key: string, reason: string, traceId: string): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['configEditor', 'configApprover']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/config-revisions/${revisionId}/rollback`, { reason });
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const source = await client.query<ConfigRollbackRow>(
        `SELECT key,value_json,audience,region,min_app_version
         FROM admin.config_revisions WHERE id=$1`,
        [revisionId],
      );
      const row = source.rows[0];
      if (!row) throw new DomainError('CONFIG_REVISION_NOT_FOUND', '配置修订不存在。', 404);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admin.config_revisions(key,value_json,version,audience,region,min_app_version,
           effective_from,effective_to,submitted_by,reason)
         VALUES ($1,$2,(SELECT max(version)+1 FROM admin.config_revisions WHERE key=$1),$3,$4,$5,NULL,NULL,$6,$7)
         RETURNING id`,
        [row.key, row.value_json, row.audience, row.region, row.min_app_version, admin.id, reason],
      );
      const body = await this.loadConfigRevision(client, inserted.rows[0]!.id, admin);
      await this.audit(client, admin, 'config.rollback.created', 'config_revision', inserted.rows[0]!.id, traceId, 'change_control', { sourceRevisionId: revisionId, reason });
      await this.outbox(client, 'config_revision', inserted.rows[0]!.id, 'config.rollback.created', body);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, { type: 'config_revision', id: inserted.rows[0]!.id });
      return body;
    });
  }

  async analyticsOverview(actor: AuthenticatedUser, from?: string, to?: string, region?: string): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['analyst', 'financeRead', 'securityLead']);
    const scoped = this.scopedRegions(admin, region);
    const start = from ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
    const end = to ?? new Date().toISOString();
    const result = await this.database.query<Record<string, string>>(
      `SELECT
         (SELECT count(*) FROM identity.users WHERE created_at BETWEEN $1 AND $2)::text AS users_created,
         (SELECT count(*) FROM events.registrations registration
           JOIN events.events event_record ON event_record.id=registration.event_id
           LEFT JOIN events.event_locations location ON location.event_id=event_record.id
           WHERE registration.created_at BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR location.region_id=ANY($3)))::text AS registrations,
         (SELECT count(*) FROM events.registrations registration
           JOIN events.events event_record ON event_record.id=registration.event_id
           LEFT JOIN events.event_locations location ON location.event_id=event_record.id
           WHERE registration.status='checked_in' AND registration.updated_at BETWEEN $1 AND $2
             AND ($3::text[] IS NULL OR location.region_id=ANY($3)))::text AS checkins,
         (SELECT count(*) FROM events.events event_record LEFT JOIN events.event_locations location ON location.event_id=event_record.id
           WHERE event_record.created_at BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR location.region_id=ANY($3)))::text AS events_created,
         (SELECT count(*) FROM events.events event_record LEFT JOIN events.event_locations location ON location.event_id=event_record.id
           WHERE event_record.status IN ('published','registration_closed','in_progress','ended','archived')
             AND event_record.created_at BETWEEN $1 AND $2 AND ($3::text[] IS NULL OR location.region_id=ANY($3)))::text AS events_approved,
         (SELECT count(*) FROM community.groups WHERE created_at BETWEEN $1 AND $2)::text AS groups_created,
         (SELECT count(*) FROM community.group_memberships WHERE joined_at BETWEEN $1 AND $2 AND status IN ('active','muted'))::text AS group_members,
         COALESCE((SELECT sum(entry.amount) FROM commerce.point_entries entry JOIN commerce.point_transactions tx ON tx.id=entry.transaction_id
           WHERE entry.bucket='free' AND entry.amount>0 AND tx.created_at BETWEEN $1 AND $2),0)::text AS free_issued,
         COALESCE((SELECT sum(entry.amount) FROM commerce.point_entries entry JOIN commerce.point_transactions tx ON tx.id=entry.transaction_id
           WHERE entry.bucket='paid' AND entry.amount>0 AND tx.created_at BETWEEN $1 AND $2),0)::text AS paid_issued,
         COALESCE((SELECT -sum(entry.amount) FROM commerce.point_entries entry JOIN commerce.point_transactions tx ON tx.id=entry.transaction_id
           WHERE entry.account_code LIKE 'user:%' AND entry.amount<0 AND tx.created_at BETWEEN $1 AND $2),0)::text AS consumed,
         COALESCE((SELECT sum(entry.amount) FROM commerce.point_entries entry WHERE entry.bucket='free' AND entry.amount>0
           AND entry.expires_at BETWEEN $1 AND $2),0)::text AS expired,
         (SELECT count(*) FROM commerce.refunds WHERE created_at BETWEEN $1 AND $2)::text AS refunds,
         (SELECT count(*) FROM commerce.store_orders WHERE created_at BETWEEN $1 AND $2)::text AS store_orders,
         (SELECT count(*) FROM safety.reports WHERE created_at BETWEEN $1 AND $2)::text AS reports,
         (SELECT count(*) FROM safety.reports WHERE severity IN ('p0','p1') AND created_at BETWEEN $1 AND $2)::text AS severe_incidents,
         (SELECT count(*) FROM events.events WHERE status IN ('published','registration_closed','in_progress'))::text AS open_events,
         (SELECT count(DISTINCT category_id) FROM events.events WHERE status IN ('published','registration_closed','in_progress'))::text AS category_coverage,
         (SELECT count(DISTINCT location.region_id) FROM events.events event_record JOIN events.event_locations location ON location.event_id=event_record.id
           WHERE event_record.status IN ('published','registration_closed','in_progress'))::text AS region_coverage`,
      [start, end, scoped],
    );
    const row = result.rows[0] ?? {};
    const users = this.integer(row.users_created);
    const registrations = this.integer(row.registrations);
    const eventsCreated = this.integer(row.events_created);
    const groupsCreated = this.integer(row.groups_created);
    return {
      generatedAt: new Date().toISOString(),
      participantFunnel: [
        { stage: 'registered_users', value: users, rate: users ? 1 : 0 },
        { stage: 'registrations', value: registrations, rate: this.ratio(registrations, users) },
        { stage: 'checkins', value: this.integer(row.checkins), rate: this.ratio(row.checkins, row.registrations) },
      ],
      hostFunnel: [
        { stage: 'events_created', value: eventsCreated, rate: eventsCreated ? 1 : 0 },
        { stage: 'events_approved', value: this.integer(row.events_approved), rate: this.ratio(row.events_approved, row.events_created) },
      ],
      groupFunnel: [
        { stage: 'groups_created', value: groupsCreated, rate: groupsCreated ? 1 : 0 },
        { stage: 'members_joined', value: this.integer(row.group_members), rate: this.ratio(row.group_members, row.groups_created) },
      ],
      points: {
        freeIssued: this.integer(row.free_issued),
        paidIssued: this.integer(row.paid_issued),
        consumed: this.integer(row.consumed),
        expired: this.integer(row.expired),
        refundRate: this.ratio(row.refunds, row.store_orders),
      },
      safety: {
        reports: this.integer(row.reports),
        severeIncidents: this.integer(row.severe_incidents),
        complaintRate: registrations >= 5 ? this.ratio(row.reports, row.registrations) : 0,
      },
      supply: {
        openEvents: this.integer(row.open_events),
        categoryCoverage: this.integer(row.category_coverage),
        regionCoverage: this.integer(row.region_coverage),
      },
    };
  }

  async auditLogs(actor: AuthenticatedUser, filters: AuditFilter, cursor?: string, limit = 20): Promise<unknown> {
    await this.requireOperator(actor, ['auditReader', 'securityLead']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<AuditLogRow>(
      `SELECT audit.id,audit.created_at,audit.actor_id,audit.action,audit.resource,audit.resource_id,
         audit.purpose,audit.trace_id,COALESCE(profile.nickname,actor_user.public_handle::text) AS actor_label
       FROM admin.audit_logs audit
       LEFT JOIN admin.admin_users admin_user ON admin_user.id=audit.actor_id
       LEFT JOIN identity.users actor_user ON actor_user.id=COALESCE(admin_user.identity_user_id,audit.actor_id)
       LEFT JOIN identity.profiles profile ON profile.user_id=actor_user.id
       WHERE ($1::text IS NULL OR audit.action ILIKE '%'||$1||'%' OR audit.resource ILIKE '%'||$1||'%'
         OR audit.trace_id ILIKE '%'||$1||'%')
         AND ($2::uuid IS NULL OR audit.actor_id=$2)
         AND ($3::text IS NULL OR audit.action=$3)
         AND ($4::text IS NULL OR audit.resource=$4)
         AND ($5::timestamptz IS NULL OR audit.created_at >= $5)
         AND ($6::timestamptz IS NULL OR audit.created_at <= $6)
         AND ($7::timestamptz IS NULL OR (audit.created_at,audit.id)<($7,$8::uuid))
       ORDER BY audit.created_at DESC,audit.id DESC LIMIT $9`,
      [filters.q || null, filters.actorId || null, filters.action || null, filters.resource || null,
        filters.from || null, filters.to || null, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => ({
      id: row.id,
      createdAt: row.created_at.toISOString(),
      actor: row.actor_id ? { id: row.actor_id, label: row.actor_label ?? 'operator' } : null,
      action: row.action,
      resource: row.resource,
      resourceIdMasked: row.resource_id ? this.mask(row.resource_id) : null,
      purpose: row.purpose,
      traceId: row.trace_id,
    }));
  }

  async adminUsers(actor: AuthenticatedUser): Promise<unknown> {
    await this.requireOperator(actor, ['auditReader', 'securityLead']);
    const result = await this.database.query<AdminUserRow>(
      `SELECT admin_user.id,admin_user.identity_user_id,admin_user.roles,admin_user.data_scopes,
         admin_user.mfa_enrolled_at,admin_user.disabled_at,
         COALESCE(profile.nickname,user_record.public_handle::text) AS label
       FROM admin.admin_users admin_user JOIN identity.users user_record ON user_record.id=admin_user.identity_user_id
       LEFT JOIN identity.profiles profile ON profile.user_id=user_record.id ORDER BY admin_user.created_at`,
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        identityUserId: row.identity_user_id,
        label: row.label,
        roles: row.roles,
        dataScopes: row.data_scopes,
        mfaEnrolledAt: row.mfa_enrolled_at.toISOString(),
        disabledAt: row.disabled_at?.toISOString() ?? null,
      })),
    };
  }

  async session(actor: AuthenticatedUser): Promise<unknown> {
    const admin = await this.requireOperator(actor);
    let age = 0;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(actor.sessionId)) {
      const session = await this.database.query<{ created_at: Date }>(
        'SELECT created_at FROM identity.sessions WHERE id=$1',
        [actor.sessionId],
      );
      age = session.rows[0]
        ? Math.max(0, Math.floor((Date.now() - session.rows[0].created_at.getTime()) / 1000))
        : 0;
    }
    return {
      operatorId: admin.id,
      label: admin.label,
      roles: admin.roles,
      dataScopes: admin.data_scopes,
      mfaEnrolled: true,
      mfaAgeSeconds: age,
      reauthRequiredFor: age > 900 ? ['export.download', 'user.login_block', 'points.paid_adjustment'] : [],
    };
  }

  async exports(actor: AuthenticatedUser, state?: string, cursor?: string, limit = 20): Promise<unknown> {
    await this.requireOperator(actor, ['auditReader', 'securityLead', 'financeRead', 'moderator']);
    const page = this.decodeCursor(cursor);
    const safeLimit = this.safeLimit(limit);
    const result = await this.database.query<ExportRow>(
      `${this.exportSelect()} WHERE ($1::text IS NULL OR export_record.state=$1)
       AND ($2::timestamptz IS NULL OR (export_record.created_at,export_record.id)<($2,$3::uuid))
       ORDER BY export_record.created_at DESC,export_record.id DESC LIMIT $4`,
      [state || null, page?.at ?? null, page?.id ?? null, safeLimit + 1],
    );
    return this.page(result.rows, safeLimit, (row) => this.mapExport(row));
  }

  async createExport(
    actor: AuthenticatedUser,
    key: string,
    input: { dataset: string; filters: Record<string, unknown>; purpose: string; expiresInHours: number; maxDownloads: number },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['auditReader', 'securityLead', 'financeRead', 'moderator']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', '/ops/exports', input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO admin.exports(requested_by,dataset,filters_json,purpose,watermark,expires_at,max_downloads,state)
         VALUES ($1,$2,$3,$4,$5,clock_timestamp()+make_interval(hours=>$6),$7,'pending') RETURNING id`,
        [admin.id, input.dataset, input.filters, input.purpose,
          `SPOTT-${admin.id.slice(0, 8)}-${Date.now()}`, input.expiresInHours, input.maxDownloads],
      );
      const body = await this.loadExport(client, inserted.rows[0]!.id);
      await this.audit(client, admin, 'export.requested', 'export', inserted.rows[0]!.id, traceId, input.purpose, { dataset: input.dataset, filters: input.filters });
      await this.outbox(client, 'export', inserted.rows[0]!.id, 'export.approval_requested', body);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, { type: 'export', id: inserted.rows[0]!.id });
      return body;
    });
  }

  async approveExport(
    actor: AuthenticatedUser,
    exportId: string,
    key: string,
    input: { decision: 'approve' | 'reject'; reason: string },
    traceId: string,
  ): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['securityLead', 'financeRead', 'auditReader']);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/ops/exports/${exportId}/approve`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const found = await client.query<ExportApprovalRow>('SELECT id,requested_by,state FROM admin.exports WHERE id=$1 FOR UPDATE', [exportId]);
      const row = found.rows[0];
      if (!row) throw new DomainError('EXPORT_NOT_FOUND', '导出任务不存在。', 404);
      if (row.requested_by === admin.id) throw new DomainError('APPROVAL_SEPARATION_REQUIRED', '导出申请人与审批人必须分离。', 409);
      if (row.state !== 'pending') throw new DomainError('EXPORT_NOT_PENDING', '导出任务已处理。', 409);
      const state = input.decision === 'approve' ? 'ready' : 'rejected';
      await client.query(
        `UPDATE admin.exports SET state=$2,approved_by=CASE WHEN $2='ready' THEN $3::uuid ELSE NULL END,
           decision_reason=$4,object_key=CASE WHEN $2='ready' THEN 'secure/exports/'||id::text||'.json' ELSE NULL END,
           updated_at=clock_timestamp() WHERE id=$1`,
        [exportId, state, admin.id, input.reason],
      );
      const body = await this.loadExport(client, exportId);
      await this.audit(client, admin, `export.${input.decision}`, 'export', exportId, traceId, 'data_export', body);
      await this.outbox(client, 'export', exportId, 'export.decided', body);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, { type: 'export', id: exportId });
      return body;
    });
  }

  async exportDownloadTicket(actor: AuthenticatedUser, exportId: string, purpose: string, traceId: string): Promise<unknown> {
    const admin = await this.requireOperator(actor, ['securityLead', 'financeRead', 'auditReader']);
    return this.database.transaction(async (client) => {
      const result = await client.query<ExportDownloadRow>(
        `UPDATE admin.exports SET download_count=download_count+1,updated_at=clock_timestamp()
         WHERE id=$1 AND state='ready' AND expires_at>clock_timestamp()
           AND download_count<max_downloads
         RETURNING id,object_key,expires_at,download_count,max_downloads`,
        [exportId],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('EXPORT_DOWNLOAD_UNAVAILABLE', '导出未就绪、已过期或达到下载次数上限。', 409);
      const ticketExpiresAt = new Date(Date.now() + 5 * 60_000);
      const body = {
        url: this.signedUrl('export', exportId, 300),
        expiresAt: ticketExpiresAt.toISOString(),
        downloadCount: this.integer(row.download_count),
        maxDownloads: this.integer(row.max_downloads),
      };
      await this.audit(client, admin, 'export.download_ticket.created', 'export', exportId, traceId, purpose, body);
      return body;
    });
  }

  private pointAdjustmentSelect(): string {
    return `SELECT request.id,request.bucket,request.amount,request.reason,request.state,
      request.points_transaction_id,request.created_at,request.decided_at,request.executed_at,
      request.required_approvals,request.approval_count,request.version,
      target.id AS target_id,target.public_handle AS target_handle,target_profile.nickname AS target_nickname,
      requester.id AS requester_id,COALESCE(requester_profile.nickname,requester_user.public_handle::text) AS requester_label,
      approver.id AS approver_id,COALESCE(approver_profile.nickname,approver_user.public_handle::text) AS approver_label
      FROM admin.point_adjustment_requests request
      JOIN identity.users target ON target.id=request.target_user_id
      JOIN identity.profiles target_profile ON target_profile.user_id=target.id
      JOIN admin.admin_users requester ON requester.id=request.requested_by
      JOIN identity.users requester_user ON requester_user.id=requester.identity_user_id
      LEFT JOIN identity.profiles requester_profile ON requester_profile.user_id=requester.identity_user_id
      LEFT JOIN admin.admin_users approver ON approver.id=request.approved_by
      LEFT JOIN identity.users approver_user ON approver_user.id=approver.identity_user_id
      LEFT JOIN identity.profiles approver_profile ON approver_profile.user_id=approver.identity_user_id`;
  }

  private async loadPointAdjustment(client: PoolClient, id: string): Promise<unknown> {
    const result = await client.query<PointAdjustmentRow>(`${this.pointAdjustmentSelect()} WHERE request.id=$1`, [id]);
    if (!result.rows[0]) throw new DomainError('POINT_ADJUSTMENT_NOT_FOUND', '积分调整申请不存在。', 404);
    return this.mapPointAdjustment(result.rows[0]);
  }

  private mapPointAdjustment(row: PointAdjustmentRow): unknown {
    return {
      id: row.id,
      target: { id: row.target_id, handle: row.target_handle, nickname: row.target_nickname },
      bucket: row.bucket,
      amount: this.integer(row.amount),
      reason: row.reason,
      state: row.state,
      requester: { id: row.requester_id, label: row.requester_label },
      approver: row.approver_id ? { id: row.approver_id, label: row.approver_label } : null,
      transactionId: row.points_transaction_id ?? null,
      requiredApprovals: this.integer(row.required_approvals),
      approvalCount: this.integer(row.approval_count),
      version: this.integer(row.version),
      createdAt: row.created_at.toISOString(),
      decidedAt: row.decided_at?.toISOString() ?? null,
      executedAt: row.executed_at?.toISOString() ?? null,
    };
  }

  private configRevisionSelect(): string {
    return `SELECT revision.id,revision.key,revision.value_json,revision.version,revision.audience,
      revision.region,revision.min_app_version,revision.effective_from,revision.effective_to,
      revision.state,revision.created_at,revision.reason,
      submitter.id AS submitter_id,COALESCE(submitter_profile.nickname,submitter_user.public_handle::text) AS submitter_label,
      approver.id AS approver_id,COALESCE(approver_profile.nickname,approver_user.public_handle::text) AS approver_label
      FROM admin.config_revisions revision
      JOIN admin.admin_users submitter ON submitter.id=revision.submitted_by
      JOIN identity.users submitter_user ON submitter_user.id=submitter.identity_user_id
      LEFT JOIN identity.profiles submitter_profile ON submitter_profile.user_id=submitter.identity_user_id
      LEFT JOIN admin.admin_users approver ON approver.id=revision.approved_by
      LEFT JOIN identity.users approver_user ON approver_user.id=approver.identity_user_id
      LEFT JOIN identity.profiles approver_profile ON approver_profile.user_id=approver.identity_user_id`;
  }

  private async loadConfigRevision(client: PoolClient, id: string, actor: AdminContext): Promise<unknown> {
    const result = await client.query<ConfigRevisionRow>(`${this.configRevisionSelect()} WHERE revision.id=$1`, [id]);
    if (!result.rows[0]) throw new DomainError('CONFIG_REVISION_NOT_FOUND', '配置修订不存在。', 404);
    return this.mapConfigRevision(result.rows[0], actor);
  }

  private mapConfigRevision(row: ConfigRevisionRow, actor: AdminContext): unknown {
    return {
      id: row.id,
      key: row.key,
      value: row.value_json,
      version: this.integer(row.version),
      audience: row.audience,
      region: row.region,
      minAppVersion: row.min_app_version,
      effectiveFrom: row.effective_from?.toISOString() ?? null,
      effectiveTo: row.effective_to?.toISOString() ?? null,
      state: row.state,
      reason: row.reason,
      submittedBy: { id: row.submitter_id, label: row.submitter_label },
      approvedBy: row.approver_id ? { id: row.approver_id, label: row.approver_label } : null,
      createdAt: row.created_at.toISOString(),
      canApprove: row.state === 'draft' && row.submitter_id !== actor.id
        && (actor.roles.includes('configApprover') || actor.roles.includes('superAdmin')),
    };
  }

  private exportSelect(): string {
    return `SELECT export_record.id,export_record.dataset,export_record.purpose,export_record.state,
      export_record.watermark,export_record.expires_at,export_record.max_downloads,
      export_record.download_count,export_record.created_at,
      requester.id AS requester_id,COALESCE(requester_profile.nickname,requester_user.public_handle::text) AS requester_label,
      approver.id AS approver_id,COALESCE(approver_profile.nickname,approver_user.public_handle::text) AS approver_label
      FROM admin.exports export_record
      JOIN admin.admin_users requester ON requester.id=export_record.requested_by
      JOIN identity.users requester_user ON requester_user.id=requester.identity_user_id
      LEFT JOIN identity.profiles requester_profile ON requester_profile.user_id=requester.identity_user_id
      LEFT JOIN admin.admin_users approver ON approver.id=export_record.approved_by
      LEFT JOIN identity.users approver_user ON approver_user.id=approver.identity_user_id
      LEFT JOIN identity.profiles approver_profile ON approver_profile.user_id=approver.identity_user_id`;
  }

  private async loadExport(client: PoolClient, id: string): Promise<unknown> {
    const result = await client.query<ExportRow>(`${this.exportSelect()} WHERE export_record.id=$1`, [id]);
    if (!result.rows[0]) throw new DomainError('EXPORT_NOT_FOUND', '导出任务不存在。', 404);
    return this.mapExport(result.rows[0]);
  }

  private mapExport(row: ExportRow): unknown {
    return {
      id: row.id,
      dataset: row.dataset,
      purpose: row.purpose,
      state: row.state,
      requester: { id: row.requester_id, label: row.requester_label },
      approver: row.approver_id ? { id: row.approver_id, label: row.approver_label } : null,
      watermark: row.watermark,
      expiresAt: row.expires_at.toISOString(),
      maxDownloads: this.integer(row.max_downloads),
      downloadCount: this.integer(row.download_count),
      createdAt: row.created_at.toISOString(),
    };
  }

  private mapEvent(row: EventListRow): unknown {
    return {
      id: row.id,
      slug: row.public_slug,
      title: row.title,
      organizer: { id: row.organizer_id, handle: row.organizer_handle, nickname: row.organizer_nickname },
      status: row.status,
      categoryId: row.category_id,
      startsAt: row.starts_at?.toISOString() ?? null,
      publicArea: row.public_area,
      isFree: row.is_free,
      amountJpy: row.amount_jpy === null ? null : this.integer(row.amount_jpy),
      riskScore: this.integer(row.risk_score),
      riskReasons: row.risk_reasons ?? [],
      submittedAt: row.submitted_at.toISOString(),
      version: this.integer(row.version),
    };
  }

  private mapCase(row: ModerationCaseListRow): Record<string, unknown> {
    return {
      id: row.id,
      reference: row.public_reference,
      targetType: row.target_type,
      targetId: this.mask(row.target_id),
      reason: row.reason,
      severity: row.severity,
      status: row.status,
      assignee: row.assignee_id ? { id: row.assignee_id, label: row.assignee_label } : null,
      slaDueAt: row.sla_due_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      version: this.integer(row.version),
    };
  }

  private async requireOperator(user: AuthenticatedUser, allowedRoles: string[] = []): Promise<AdminContext> {
    const result = await this.database.query<AdminContext>(
      `SELECT admin_user.id,admin_user.roles,admin_user.data_scopes,admin_user.mfa_enrolled_at,
         COALESCE(profile.nickname,user_record.public_handle::text) AS label
       FROM admin.admin_users admin_user
       JOIN identity.users user_record ON user_record.id=admin_user.identity_user_id
       LEFT JOIN identity.profiles profile ON profile.user_id=admin_user.identity_user_id
       WHERE admin_user.identity_user_id=$1 AND admin_user.disabled_at IS NULL
         AND admin_user.mfa_enrolled_at IS NOT NULL
         AND ($2::text = 'development-session' OR EXISTS(
           SELECT 1 FROM identity.sessions session_record
           WHERE session_record.id::text=$2 AND session_record.user_id=$1
             AND session_record.revoked_at IS NULL AND session_record.expires_at>clock_timestamp()
         ))`,
      [user.id, user.sessionId],
    );
    let admin = result.rows[0];
    if (!admin && configuration().NODE_ENV !== 'production' && user.roles.includes('operator')) {
      admin = {
        id: user.id,
        label: 'Development operator',
        roles: ['superAdmin', ...user.roles],
        data_scopes: ['*'],
        mfa_enrolled_at: new Date(),
      };
    }
    if (!admin) throw new DomainError('OPS_FORBIDDEN', '需要有效的运营权限与 MFA。', 403);
    if (allowedRoles.length && !admin.roles.includes('superAdmin')
      && !allowedRoles.some((role) => admin.roles.includes(role))) {
      throw new DomainError('OPS_ROLE_FORBIDDEN', '当前运营角色无权执行此操作。', 403);
    }
    return admin;
  }

  private scopedRegions(admin: AdminContext, requested?: string): string[] | null {
    if (admin.data_scopes.includes('*') || admin.data_scopes.includes('jp')) return requested ? [requested] : null;
    if (requested && !admin.data_scopes.includes(requested)) {
      throw new DomainError('OPS_SCOPE_FORBIDDEN', '请求区域超出数据权限范围。', 403);
    }
    return requested ? [requested] : admin.data_scopes;
  }

  private async audit(
    client: PoolClient,
    actor: AdminContext,
    action: string,
    resource: string,
    resourceId: string,
    traceId: string,
    purpose: string,
    payload: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO admin.audit_logs(actor_id,action,resource,resource_id,purpose,after_hash,trace_id)
       VALUES ($1,$2,$3,$4,$5,digest($6::text,'sha256'),$7)`,
      [actor.id, action, resource, resourceId, purpose, JSON.stringify(payload), traceId],
    );
  }

  private async outbox(client: PoolClient, aggregate: string, aggregateId: string, type: string, payload: unknown): Promise<void> {
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate,aggregate_id,type,payload) VALUES ($1,$2,$3,$4)`,
      [aggregate, aggregateId, type, payload],
    );
  }

  private page<Row extends PageRow, Item>(
    rows: readonly Row[],
    limit: number,
    map: (row: Row) => Item,
  ): PageResult<Item> {
    const hasMore = rows.length > limit;
    const visible = rows.slice(0, limit);
    const last = visible.at(-1);
    return {
      items: visible.map(map),
      hasMore,
      nextCursor: hasMore && last ? this.encodeCursor(last.created_at, last.id) : null,
    };
  }

  private encodeCursor(at: Date, id: string): string {
    return Buffer.from(JSON.stringify({ at: at.toISOString(), id })).toString('base64url');
  }

  private decodeCursor(cursor?: string): CursorValue | null {
    if (!cursor) return null;
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorValue;
      if (!value.at || !value.id || Number.isNaN(new Date(value.at).getTime())) throw new Error('invalid');
      return value;
    } catch {
      throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    }
  }

  private safeLimit(limit: number): number {
    return Math.min(Math.max(Number.isFinite(limit) ? Math.floor(limit) : 20, 1), 100);
  }

  private assertVersion(actual: PgInteger, expected: number, label: string): void {
    if (this.integer(actual) !== expected) {
      throw new DomainError('VERSION_CONFLICT', `${label}已被其他运营更新。`, 409);
    }
  }

  private integer(value: unknown): number {
    const number = Number(value ?? 0);
    return Number.isFinite(number) ? number : 0;
  }

  private ratio(numerator: unknown, denominator: unknown): number {
    const bottom = this.integer(denominator);
    return bottom > 0
      ? Math.min(1, Math.round((this.integer(numerator) / bottom) * 10_000) / 10_000)
      : 0;
  }

  private mask(value: string): string {
    return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : '••••';
  }

  private signedUrl(kind: string, id: string, ttlSeconds: number): string {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = createHmac('sha256', configuration().ACCESS_TOKEN_SECRET)
      .update(`${kind}:${id}:${expires}`)
      .digest('base64url');
    return `https://media.spott.jp/secure/${kind}/${id}?expires=${expires}&signature=${signature}`;
  }

  private pgCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code)
      : undefined;
  }
}
