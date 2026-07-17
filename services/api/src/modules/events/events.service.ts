import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DomainError,
  assessEventRisk,
  availableEventActions,
  canReadExactAddress,
  parseRiskEngineConfig,
  riskReviewState,
  sampleRoll,
  transitionEvent,
  type EventStatus,
  type RestrictionFlag,
  type RiskAssessment,
  type RiskEngineConfig,
  type Role,
} from '@spott/domain';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Database } from '../../platform/database.js';
import { FieldCrypto } from '../../platform/crypto.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';
import type { DiscoveryQuery, EventFormat, EventLocale } from './events.discovery-query.js';
import { buildDiscoveryStatement } from './events.discovery-sql.js';

const discoveryCursorSchema = z.object({
  date: z.iso.datetime({ offset: true }),
  id: z.uuid(),
}).strict();

export interface EventDraftInput {
  title?: string | undefined;
  description?: string | undefined;
  categoryId?: string | undefined;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  deadlineAt?: string | undefined;
  regionId?: string | undefined;
  publicArea?: string | undefined;
  exactAddress?: string | undefined;
  capacity?: number | undefined;
  registrationMode?: 'automatic' | 'approval' | 'invite_only' | undefined;
  waitlistEnabled?: boolean | undefined;
  tags?: string[] | undefined;
  attendeeRequirements?: string | undefined;
  riskFlags?: string[] | undefined;
  riskDetails?: Record<string, string> | undefined;
  groupId?: string | null | undefined;
  checkinMode?: 'dynamic_qr' | 'six_digit' | 'manual' | undefined;
  commentPermission?: 'disabled' | 'participants' | 'group_members' | undefined;
  posterEnabled?: boolean | undefined;
  exactAddressVisibility?: 'public' | 'confirmed' | undefined;
  format?: EventFormat | undefined;
  primaryLocale?: EventLocale | undefined;
  supportedLocales?: EventLocale[] | undefined;
  coordinate?: {
    latitude: number;
    longitude: number;
  } | undefined;
  registrationQuestions?: Array<{
    id?: string | undefined;
    prompt: string;
    kind: 'text' | 'single_choice' | 'boolean';
    required: boolean;
    options: string[];
  }> | undefined;
  fee?: {
    isFree: boolean;
    amountJPY?: number | undefined;
    collectorName?: string | undefined;
    method?: string | undefined;
    paymentDeadlineText?: string | undefined;
    refundPolicy?: string | undefined;
  } | undefined;
}

interface EventRow {
  id: string;
  public_slug: string;
  organizer_id: string;
  status: EventStatus;
  title: string;
  description: string;
  category_id: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
  deadline_at: Date | null;
  display_time_zone: string;
  capacity: number | null;
  registration_mode: string;
  waitlist_enabled: boolean;
  version: string;
  created_at: Date;
  updated_at: Date;
  format: EventFormat;
  primary_locale: EventLocale;
  supported_locales: EventLocale[];
  locale_confirmed_at: Date | null;
  region_id: string | null;
  public_area: string | null;
  exact_address_cipher: Buffer | null;
  is_free: boolean | null;
  amount_jpy: string | null;
  collector_name: string | null;
  method: string | null;
  payment_deadline_text: string | null;
  refund_policy: string | null;
  confirmed_count: number;
  pending_count: number;
  offered_count: number;
  available_capacity: number | null;
  registration_id: string | null;
  registration_status: string | null;
  registration_party_size: number | null;
  offer_expires_at: Date | null;
  organizer_name: string | null;
  organizer_handle: string;
  phone_verified: boolean;
  completed_event_count: number;
  attendance_rate_band: 'unavailable' | 'under_70' | '70_89' | '90_plus';
  favorited: boolean;
  tags: string[];
  attendee_requirements: string | null;
  risk_flags: string[];
  risk_details: Record<string, string>;
  group_id: string | null;
  checkin_mode: string;
  comment_permission: string;
  poster_enabled: boolean;
  exact_address_visibility: string | null;
  latitude: number | null;
  longitude: number | null;
  exact_latitude: number | null;
  exact_longitude: number | null;
  registration_questions: Array<{
    id: string;
    prompt: string;
    kind: string;
    required: boolean;
    options: string[];
  }>;
  media_count: string;
  media_items: Array<{
    id: string;
    assetId: string;
    sortOrder: number;
    state: string;
    moderationState: string;
    url: string | null;
  }>;
  organizer_followed: boolean;
}

export function serializeRegistrationQuestionOptions(options: string[]): string {
  return JSON.stringify(options);
}

@Injectable()
export class EventsService {
  constructor(
    private readonly database: Database,
    private readonly fieldCrypto: FieldCrypto,
    private readonly idempotency: IdempotencyService,
    private readonly points: PointsService,
  ) {}

  async discovery(
    viewer: AuthenticatedUser | undefined,
    options: DiscoveryQuery,
  ): Promise<unknown> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const cursor = this.decodeCursor(options.cursor);
    const statement = buildDiscoveryStatement(viewer?.id ?? null, options, cursor);
    const result = await this.database.query<EventRow>(statement.text, statement.values);
    const hasMore = result.rows.length > limit;
    const page = result.rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => this.toView(row, viewer, false)),
      nextCursor: hasMore && last?.starts_at ? this.encodeCursor(last.starts_at, last.id) : null,
      hasMore,
      serverTime: new Date().toISOString(),
      queryExplanationId: `q_${randomBytes(8).toString('hex')}`,
    };
  }

  async get(identifier: string, viewer?: AuthenticatedUser): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      const row = await this.loadEvent(client, identifier, viewer?.id);
      return this.toView(row, viewer, true);
    } finally {
      client.release();
    }
  }

  async hosted(user: AuthenticatedUser): Promise<unknown> {
    const result = await this.database.query<EventRow>(
      `SELECT e.*, l.region_id, l.public_area, l.exact_address_cipher,
         f.is_free, f.amount_jpy, f.collector_name, f.method, f.payment_deadline_text,
         f.refund_policy, COALESCE(c.confirmed_count, 0)::int AS confirmed_count,
         COALESCE(c.pending_count, 0)::int AS pending_count,
         COALESCE(c.offered_count, 0)::int AS offered_count,
         GREATEST(0, COALESCE(e.capacity, 0) - COALESCE(c.confirmed_count, 0)
           - COALESCE(c.pending_count, 0) - COALESCE(c.offered_count, 0))::int AS available_capacity,
         NULL::uuid AS registration_id, NULL::text AS registration_status,
         NULL::int AS registration_party_size, NULL::timestamptz AS offer_expires_at,
         p.nickname AS organizer_name,
         u.public_handle AS organizer_handle, u.phone_verified_at IS NOT NULL AS phone_verified,
         COALESCE(trust.completed_event_count, 0)::int AS completed_event_count,
         CASE
           WHEN COALESCE(trust.attendance_sample, 0) < 5 THEN 'unavailable'
           WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.70 THEN 'under_70'
           WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.90 THEN '70_89'
           ELSE '90_plus'
         END AS attendance_rate_band,
         false AS favorited,
         false AS organizer_followed,
         l.exact_address_visibility,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(ST_SnapToGrid(l.point::geometry, 0.01)) END AS latitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(ST_SnapToGrid(l.point::geometry, 0.01)) END AS longitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(l.point::geometry) END AS exact_latitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(l.point::geometry) END AS exact_longitude,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'kind', q.kind,
           'required', q.required, 'options', q.options) ORDER BY q.sort_order)
           FROM events.registration_questions q WHERE q.event_id = e.id), '[]'::jsonb) AS registration_questions,
         (SELECT count(*)::text FROM events.event_media media WHERE media.event_id = e.id) AS media_count,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', media.id, 'assetId', media.media_asset_id,
           'sortOrder', media.sort_order, 'state', asset.state, 'moderationState', asset.moderation_state,
           'url', asset.derivatives->'card'->>'url')
           ORDER BY media.sort_order) FROM events.event_media media
           LEFT JOIN media.assets asset ON asset.id = media.media_asset_id
           WHERE media.event_id = e.id), '[]'::jsonb) AS media_items
       FROM events.events e
       JOIN identity.users u ON u.id = e.organizer_id
       LEFT JOIN identity.profiles p ON p.user_id = e.organizer_id AND p.deleted_at IS NULL
       LEFT JOIN events.event_locations l ON l.event_id = e.id
       LEFT JOIN events.event_fees f ON f.event_id = e.id
       LEFT JOIN events.event_capacity c ON c.event_id = e.id
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT completed.id)::int AS completed_event_count,
           COALESCE(sum(attendance.party_size) FILTER (WHERE attendance.status = 'checked_in'), 0)::int
             AS checked_in_party_count,
           COALESCE(sum(attendance.party_size) FILTER (
             WHERE attendance.status IN ('checked_in','no_show')
           ), 0)::int AS attendance_sample
         FROM events.events completed
         LEFT JOIN events.registrations attendance
           ON attendance.event_id = completed.id AND attendance.deleted_at IS NULL
         WHERE completed.organizer_id = e.organizer_id
           AND completed.completed_at IS NOT NULL AND completed.deleted_at IS NULL
       ) trust ON true
       WHERE e.organizer_id = $1 AND e.deleted_at IS NULL
       ORDER BY e.created_at DESC, e.id DESC`,
      [user.id],
    );
    return { items: result.rows.map((row) => this.toView(row, user, true)) };
  }

  async favorites(user: AuthenticatedUser): Promise<unknown> {
    const result = await this.database.query<EventRow>(
      `SELECT e.*, l.region_id, l.public_area, NULL::bytea AS exact_address_cipher,
         f.is_free, f.amount_jpy, f.collector_name, f.method, f.payment_deadline_text,
         f.refund_policy, COALESCE(c.confirmed_count, 0)::int AS confirmed_count,
         COALESCE(c.pending_count, 0)::int AS pending_count,
         COALESCE(c.offered_count, 0)::int AS offered_count,
         GREATEST(0, COALESCE(e.capacity, 0) - COALESCE(c.confirmed_count, 0)
           - COALESCE(c.pending_count, 0) - COALESCE(c.offered_count, 0))::int AS available_capacity,
         r.id AS registration_id, r.status::text AS registration_status,
         r.party_size::int AS registration_party_size, promotion.expires_at AS offer_expires_at,
         p.nickname AS organizer_name,
         u.public_handle AS organizer_handle, u.phone_verified_at IS NOT NULL AS phone_verified,
         COALESCE(trust.completed_event_count, 0)::int AS completed_event_count,
         CASE
           WHEN COALESCE(trust.attendance_sample, 0) < 5 THEN 'unavailable'
           WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.70 THEN 'under_70'
           WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.90 THEN '70_89'
           ELSE '90_plus'
         END AS attendance_rate_band,
         true AS favorited,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $1 AND follow.target_type = 'user'
             AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL) AS organizer_followed,
         l.exact_address_visibility,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(ST_SnapToGrid(l.point::geometry, 0.01)) END AS latitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(ST_SnapToGrid(l.point::geometry, 0.01)) END AS longitude,
         NULL::double precision AS exact_latitude,
         NULL::double precision AS exact_longitude,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'kind', q.kind,
           'required', q.required, 'options', q.options) ORDER BY q.sort_order)
           FROM events.registration_questions q WHERE q.event_id = e.id), '[]'::jsonb) AS registration_questions,
         (SELECT count(*)::text FROM events.event_media media WHERE media.event_id = e.id) AS media_count,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', media.id, 'assetId', media.media_asset_id,
           'sortOrder', media.sort_order, 'state', asset.state, 'moderationState', asset.moderation_state,
           'url', asset.derivatives->'card'->>'url')
           ORDER BY media.sort_order) FROM events.event_media media
           LEFT JOIN media.assets asset ON asset.id = media.media_asset_id
           WHERE media.event_id = e.id), '[]'::jsonb) AS media_items
       FROM events.event_favorites fav
       JOIN events.events e ON e.id = fav.event_id
       JOIN identity.users u ON u.id = e.organizer_id
       LEFT JOIN identity.profiles p ON p.user_id = e.organizer_id AND p.deleted_at IS NULL
       LEFT JOIN events.event_locations l ON l.event_id = e.id
       LEFT JOIN events.event_fees f ON f.event_id = e.id
       LEFT JOIN events.event_capacity c ON c.event_id = e.id
       LEFT JOIN events.registrations r ON r.event_id = e.id AND r.user_id = $1
         AND r.deleted_at IS NULL
         AND r.status IN ('pending','confirmed','waitlisted','offered','checked_in')
       LEFT JOIN LATERAL (
         SELECT offer.expires_at FROM events.waitlist_promotions offer
         WHERE offer.registration_id = r.id AND offer.accepted_at IS NULL AND offer.expired_at IS NULL
         ORDER BY offer.offered_at DESC, offer.id DESC LIMIT 1
       ) promotion ON true
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT completed.id)::int AS completed_event_count,
           COALESCE(sum(attendance.party_size) FILTER (WHERE attendance.status = 'checked_in'), 0)::int
             AS checked_in_party_count,
           COALESCE(sum(attendance.party_size) FILTER (
             WHERE attendance.status IN ('checked_in','no_show')
           ), 0)::int AS attendance_sample
         FROM events.events completed
         LEFT JOIN events.registrations attendance
           ON attendance.event_id = completed.id AND attendance.deleted_at IS NULL
         WHERE completed.organizer_id = e.organizer_id
           AND completed.completed_at IS NOT NULL AND completed.deleted_at IS NULL
       ) trust ON true
       WHERE fav.user_id = $1 AND fav.deleted_at IS NULL AND e.deleted_at IS NULL
       ORDER BY fav.created_at DESC`,
      [user.id],
    );
    return { items: result.rows.map((row) => this.toView(row, user, false)) };
  }

  async createDraft(
    user: AuthenticatedUser,
    key: string,
    input: EventDraftInput,
  ): Promise<unknown> {
    this.requirePublisher(user);
    const title = input.title?.trim() ?? '';
    return this.database.transaction(async (client) => {
      const requestHash = this.idempotency.requestHash('POST', '/events/drafts', input);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, requestHash);
      if (replay) return replay.body;
      const idResult = await client.query<{ id: string }>('SELECT uuidv7() AS id');
      const id = idResult.rows[0]!.id;
      const slug = `e-${id.replaceAll('-', '').slice(0, 18)}`;
      const eventColumns = [
        'id', 'public_slug', 'organizer_id', 'title', 'description', 'category_id',
        'starts_at', 'ends_at', 'deadline_at', 'capacity', 'registration_mode',
        'waitlist_enabled', 'tags', 'attendee_requirements', 'risk_flags', 'risk_details',
        'group_id', 'checkin_mode', 'comment_permission', 'poster_enabled', 'created_by', 'updated_by',
      ];
      const eventValues: unknown[] = [
        id,
        slug,
        user.id,
        title,
        input.description ?? '',
        input.categoryId ?? null,
        input.startsAt ?? null,
        input.endsAt ?? null,
        input.deadlineAt ?? null,
        input.capacity ?? null,
        input.registrationMode ?? 'automatic',
        input.waitlistEnabled ?? true,
        input.tags ?? [],
        input.attendeeRequirements ?? null,
        input.riskFlags ?? [],
        input.riskDetails ?? {},
        input.groupId ?? null,
        input.checkinMode ?? 'dynamic_qr',
        input.commentPermission ?? 'participants',
        input.posterEnabled ?? true,
      ];
      const eventExpressions = eventValues.map((_, index) => `$${index + 1}`);
      eventExpressions.push('$3', '$3');
      if (input.format !== undefined) {
        eventColumns.push('format');
        eventValues.push(input.format);
        eventExpressions.push(`$${eventValues.length}`);
      }
      if (input.primaryLocale !== undefined && input.supportedLocales !== undefined) {
        eventColumns.push('primary_locale');
        eventValues.push(input.primaryLocale);
        eventExpressions.push(`$${eventValues.length}`);
        eventColumns.push('supported_locales');
        eventValues.push(input.supportedLocales);
        eventExpressions.push(`$${eventValues.length}`);
        eventColumns.push('locale_confirmed_at');
        eventExpressions.push('clock_timestamp()');
      }
      await client.query(
        `INSERT INTO events.events(${eventColumns.join(', ')})
         VALUES (${eventExpressions.join(', ')})`,
        eventValues,
      );
      await client.query('INSERT INTO events.event_capacity(event_id) VALUES ($1)', [id]);
      await this.upsertDetails(client, id, input);
      await this.recordChange(client, user.id, id, 1, 'event.draft_created', Object.keys(input));
      const row = await this.loadEvent(client, id, user.id);
      const body = this.toView(row, user, true);
      await this.idempotency.complete(client, user.id, key, { status: 201, body }, { type: 'event', id });
      return body;
    });
  }

  async update(
    user: AuthenticatedUser,
    identifier: string,
    key: string,
    baseVersion: number,
    input: EventDraftInput,
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const requestHash = this.idempotency.requestHash('PATCH', `/events/${identifier}`, input);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, requestHash);
      if (replay) return replay.body;
      const before = await this.loadEvent(client, identifier, user.id, true);
      if (before.organizer_id !== user.id) throw new DomainError('EVENT_FORBIDDEN', '无权编辑此活动。', 403);
      if (!['draft', 'needs_changes', 'published'].includes(before.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前状态不能编辑。', 422);
      }
      if (Number(before.version) !== baseVersion) {
        throw new DomainError('VERSION_CONFLICT', '云端草稿已更新，请比较后再保存。', 409, {
          actions: [{ type: 'compareDraft', label: '查看差异' }],
          meta: { current: this.toView(before, user, true), attempted: input },
        });
      }
      const eventColumns: Record<keyof EventDraftInput, string> = {
        title: 'title',
        description: 'description',
        categoryId: 'category_id',
        startsAt: 'starts_at',
        endsAt: 'ends_at',
        deadlineAt: 'deadline_at',
        regionId: '',
        publicArea: '',
        exactAddress: '',
        capacity: 'capacity',
        registrationMode: 'registration_mode',
        waitlistEnabled: 'waitlist_enabled',
        tags: 'tags',
        attendeeRequirements: 'attendee_requirements',
        riskFlags: 'risk_flags',
        riskDetails: 'risk_details',
        groupId: 'group_id',
        checkinMode: 'checkin_mode',
        commentPermission: 'comment_permission',
        posterEnabled: 'poster_enabled',
        exactAddressVisibility: '',
        format: 'format',
        primaryLocale: '',
        supportedLocales: '',
        coordinate: '',
        registrationQuestions: '',
        fee: '',
      };
      const sets: string[] = [];
      const values: unknown[] = [];
      for (const [keyName, column] of Object.entries(eventColumns)) {
        const value = input[keyName as keyof EventDraftInput];
        if (column && value !== undefined) {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        }
      }
      if (input.primaryLocale !== undefined && input.supportedLocales !== undefined) {
        values.push(input.primaryLocale);
        sets.push(`primary_locale = $${values.length}`);
        values.push(input.supportedLocales);
        sets.push(`supported_locales = $${values.length}`);
        sets.push('locale_confirmed_at = clock_timestamp()');
      }
      values.push(user.id, before.id, baseVersion);
      if (sets.length > 0) {
        const updated = await client.query(
          `UPDATE events.events SET ${sets.join(', ')}, updated_by = $${values.length - 2}
           WHERE id = $${values.length - 1} AND version = $${values.length}`,
          values,
        );
        if (updated.rowCount !== 1) throw new DomainError('VERSION_CONFLICT', '活动已被其他设备更新。', 409);
      } else {
        // Details still belong to the aggregate and advance its public version.
        await client.query('UPDATE events.events SET updated_by = $1 WHERE id = $2 AND version = $3', [
          user.id,
          before.id,
          baseVersion,
        ]);
      }
      await this.upsertDetails(client, before.id, input);
      const after = await this.loadEvent(client, before.id, user.id);
      const changedFields = Object.keys(input);
      await client.query(
        `INSERT INTO events.event_revisions(
           event_id, base_version, new_version, changed_fields, before_json, after_json,
           impact_summary, created_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          before.id,
          baseVersion,
          after.version,
          changedFields,
          this.toView(before, user, true),
          this.toView(after, user, true),
          before.status === 'published' ? '已发布活动关键字段发生变化，需通知参与者。' : null,
          user.id,
        ],
      );
      await this.recordChange(client, user.id, before.id, Number(after.version), 'event.updated', changedFields);
      if (before.status === 'published' && changedFields.some((field) => ['startsAt', 'endsAt', 'publicArea', 'exactAddress', 'fee'].includes(field))) {
        await client.query(
          `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
           VALUES ('event', $1, 'event.key_fields_changed', $2)`,
          [before.id, { changedFields, version: Number(after.version) }],
        );
      }
      const body = this.toView(after, user, true);
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, { type: 'event', id: before.id });
      return body;
    });
  }

  async submit(
    user: AuthenticatedUser,
    identifier: string,
    key: string,
    baseVersion: number,
    quoteId: string,
  ): Promise<unknown> {
    this.requirePublisher(user);
    return this.database.transaction(async (client) => {
      const request = { baseVersion, quoteId };
      const hash = this.idempotency.requestHash('POST', `/events/${identifier}/submit`, request);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const event = await this.loadEvent(client, identifier, user.id, true);
      if (event.organizer_id !== user.id) throw new DomainError('EVENT_FORBIDDEN', '无权提交此活动。', 403);
      if (Number(event.version) !== baseVersion) throw new DomainError('VERSION_CONFLICT', '草稿版本已变化。', 409);
      this.validateSubmission(event);

      // 风险分流必须在扣积分之前：禁止类活动直接拒绝，不能先把局头的积分吃掉。
      const assessment = this.assessRisk(event, await this.riskConfig(client));
      if (assessment.route === 'prohibit') {
        // 抛错回滚整个事务，局头不扣分、活动留在 draft。判定只依赖内容，
        // 因此重试必然得到同一结论，不存在靠重试「摇」过审的空间。
        throw new DomainError('EVENT_RISK_PROHIBITED', '活动内容命中平台禁止发布的规则，无法提交。', 422, {
          meta: {
            riskTypes: assessment.riskTypes,
            explanations: assessment.explanations,
            score: assessment.score,
          },
        });
      }

      transitionEvent(event.status, 'pending_review');
      const autoApproved = assessment.route === 'auto_approve';
      if (autoApproved) transitionEvent('pending_review', 'published');
      const nextStatus: EventStatus = autoApproved ? 'published' : 'pending_review';

      const amount = await this.points.consumeQuote(client, user.id, quoteId, 'event_publish', event.id);
      const holdId = await this.points.createHold(
        client,
        user.id,
        amount,
        `event_publish_hold:${event.id}:${event.version}`,
        '24 hours',
      );
      await client.query(
        `UPDATE events.events SET status = $4, risk_flags = $5, updated_by = $2
         WHERE id = $1 AND version = $3`,
        [event.id, user.id, baseVersion, nextStatus, assessment.riskTypes],
      );
      await this.writeRisks(client, event.id, assessment);
      if (autoApproved) {
        // 自动通过没有后续人工决策来结算这笔 hold，这里就地兑现，
        // 保持与 ops 审核通过路径同样的账本语义。
        await this.points.captureHold(
          client,
          holdId,
          'event_publish',
          `event_publish:${event.id}:${event.version}`,
        );
      }
      const after = await this.loadEvent(client, event.id, user.id);
      await this.recordChange(client, user.id, event.id, Number(after.version), 'event.submitted', [
        'status',
        'riskFlags',
      ]);
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('event', $1, $3, $2)`,
        [
          event.id,
          {
            eventId: event.id,
            holdId,
            version: Number(after.version),
            riskRoute: assessment.route,
            riskScore: assessment.score,
            riskTypes: assessment.riskTypes,
          },
          autoApproved ? 'event.auto_approved' : 'event.review_requested',
        ],
      );
      const body = {
        ...this.toView(after, user, true),
        submissionId: event.id,
        holdId,
        riskRoute: assessment.route,
      };
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, { type: 'event', id: event.id });
      return body;
    });
  }

  /**
   * 规则与阈值全部来自运营后台的 config revision，服务端基线只是兜底。
   * 客户端既读不到也改不了。
   */
  private async riskConfig(client: PoolClient): Promise<RiskEngineConfig> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = 'events.risk.engine' AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
    );
    return parseRiskEngineConfig(result.rows[0]?.value_json);
  }

  private assessRisk(event: EventRow, config: RiskEngineConfig): RiskAssessment {
    return assessEventRisk(
      {
        title: event.title,
        description: event.description,
        tags: event.tags,
        attendeeRequirements: event.attendee_requirements,
        // 局头自报只是输入信号；服务端不会因为自报「无风险」就少判一条。
        declaredRiskFlags: event.risk_flags,
        isFree: event.is_free,
        amountJPY: event.amount_jpy === null ? null : Number(event.amount_jpy),
        startHourLocal: this.localHour(event.starts_at, event.display_time_zone),
      },
      config,
      // 抽样以活动 id 定种，重放与重试得到同一结论。
      sampleRoll(event.id),
    );
  }

  private localHour(startsAt: Date | null, timeZone: string): number | null {
    if (!startsAt) return null;
    try {
      const hour = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(startsAt);
      const parsed = Number(hour);
      return Number.isInteger(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  private async writeRisks(
    client: PoolClient,
    eventId: string,
    assessment: RiskAssessment,
  ): Promise<void> {
    // 重新提交时旧判定必须先失效，否则改稿去掉的风险会一直挂在审核队列上。
    await client.query('DELETE FROM events.event_risks WHERE event_id = $1', [eventId]);
    const reviewState = riskReviewState(assessment.route);
    for (const riskType of assessment.riskTypes) {
      const explanation = assessment.hits
        .filter((hit) => hit.riskType === riskType)
        .map((hit) => hit.explanation)
        .join(' ');
      await client.query(
        `INSERT INTO events.event_risks(event_id, risk_type, declaration, review_state)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (event_id, risk_type)
         DO UPDATE SET declaration = EXCLUDED.declaration, review_state = EXCLUDED.review_state`,
        [eventId, riskType, explanation, reviewState],
      );
    }
  }

  async cancel(user: AuthenticatedUser, identifier: string, key: string, reason: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/events/${identifier}/cancel`, { reason });
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const event = await this.loadEvent(client, identifier, user.id, true);
      if (event.organizer_id !== user.id && !user.roles.includes('operator')) {
        throw new DomainError('EVENT_FORBIDDEN', '无权取消此活动。', 403);
      }
      transitionEvent(event.status, 'cancelled');
      await client.query("UPDATE events.events SET status = 'cancelled', updated_by = $2 WHERE id = $1", [
        event.id,
        user.id,
      ]);
      await client.query(
        `UPDATE events.registrations SET status = 'event_cancelled'
         WHERE event_id = $1 AND status IN ('pending','confirmed','waitlisted','offered')`,
        [event.id],
      );
      const after = await this.loadEvent(client, event.id, user.id);
      await this.recordChange(client, user.id, event.id, Number(after.version), 'event.cancelled', ['status']);
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES
           ('event', $1, 'event.cancelled', $2),
           ('event', $1, 'event.cdn_purge_requested', $3),
           ('event', $1, 'event.registration_refunds_requested', $3)`,
        [event.id, { reason, cancelledBy: user.id }, { eventId: event.id }],
      );
      const body = this.toView(after, user, true);
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, { type: 'event', id: event.id });
      return body;
    });
  }

  async setFavorite(userId: string, eventId: string, favorited: boolean): Promise<void> {
    await this.database.transaction(async (client) => {
      if (favorited) {
        await client.query(
          `INSERT INTO events.event_favorites(user_id, event_id) VALUES ($1, $2)
           ON CONFLICT (user_id, event_id) DO UPDATE SET deleted_at = NULL, created_at = clock_timestamp()`,
          [userId, eventId],
        );
      } else {
        await client.query(
          `UPDATE events.event_favorites SET deleted_at = COALESCE(deleted_at, clock_timestamp())
           WHERE user_id = $1 AND event_id = $2`,
          [userId, eventId],
        );
      }
      const event = await this.loadEvent(client, eventId, userId);
      await this.recordChange(client, userId, event.id, Number(event.version), 'favorite.changed', ['favorited'], {
        favorited,
      });
    });
  }

  private async loadEvent(
    client: PoolClient,
    identifier: string,
    viewerId?: string,
    lock = false,
  ): Promise<EventRow> {
    const result = await client.query<EventRow>(
      `SELECT e.*, l.region_id, l.public_area, l.exact_address_cipher,
         f.is_free, f.amount_jpy, f.collector_name, f.method, f.payment_deadline_text,
         f.refund_policy, COALESCE(c.confirmed_count, 0)::int AS confirmed_count,
         COALESCE(c.pending_count, 0)::int AS pending_count,
         COALESCE(c.offered_count, 0)::int AS offered_count,
         GREATEST(0, COALESCE(e.capacity, 0) - COALESCE(c.confirmed_count, 0)
           - COALESCE(c.pending_count, 0) - COALESCE(c.offered_count, 0))::int AS available_capacity,
         r.id AS registration_id, r.status::text AS registration_status,
         r.party_size::int AS registration_party_size,
         promotion.expires_at AS offer_expires_at,
         p.nickname AS organizer_name,
         u.public_handle AS organizer_handle, u.phone_verified_at IS NOT NULL AS phone_verified,
         COALESCE(trust.completed_event_count, 0)::int AS completed_event_count,
         CASE
           WHEN COALESCE(trust.attendance_sample, 0) < 5 THEN 'unavailable'
           WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.70 THEN 'under_70'
           WHEN trust.checked_in_party_count::numeric / NULLIF(trust.attendance_sample, 0) < 0.90 THEN '70_89'
           ELSE '90_plus'
         END AS attendance_rate_band,
         (fav.event_id IS NOT NULL) AS favorited,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $2 AND follow.target_type = 'user'
             AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL) AS organizer_followed,
         l.exact_address_visibility,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(ST_SnapToGrid(l.point::geometry, 0.01)) END AS latitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(ST_SnapToGrid(l.point::geometry, 0.01)) END AS longitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_Y(l.point::geometry) END AS exact_latitude,
         CASE WHEN l.point IS NULL THEN NULL ELSE ST_X(l.point::geometry) END AS exact_longitude,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'prompt', q.prompt, 'kind', q.kind,
           'required', q.required, 'options', q.options) ORDER BY q.sort_order)
           FROM events.registration_questions q WHERE q.event_id = e.id), '[]'::jsonb) AS registration_questions,
         (SELECT count(*)::text FROM events.event_media media WHERE media.event_id = e.id) AS media_count,
         COALESCE((SELECT jsonb_agg(jsonb_build_object('id', media.id, 'assetId', media.media_asset_id,
           'sortOrder', media.sort_order, 'state', asset.state, 'moderationState', asset.moderation_state,
           'url', asset.derivatives->'card'->>'url')
           ORDER BY media.sort_order) FROM events.event_media media
           LEFT JOIN media.assets asset ON asset.id = media.media_asset_id
           WHERE media.event_id = e.id), '[]'::jsonb) AS media_items
       FROM events.events e
       JOIN identity.users u ON u.id = e.organizer_id
       LEFT JOIN identity.profiles p ON p.user_id = e.organizer_id AND p.deleted_at IS NULL
       LEFT JOIN events.event_locations l ON l.event_id = e.id
       LEFT JOIN events.event_fees f ON f.event_id = e.id
       LEFT JOIN events.event_capacity c ON c.event_id = e.id
       LEFT JOIN events.registrations r ON r.event_id = e.id AND r.user_id = $2
         AND r.deleted_at IS NULL
         AND r.status IN ('pending','confirmed','waitlisted','offered','checked_in')
       LEFT JOIN LATERAL (
         SELECT offer.expires_at FROM events.waitlist_promotions offer
         WHERE offer.registration_id = r.id AND offer.accepted_at IS NULL AND offer.expired_at IS NULL
         ORDER BY offer.offered_at DESC, offer.id DESC LIMIT 1
       ) promotion ON true
       LEFT JOIN events.event_favorites fav ON fav.event_id = e.id AND fav.user_id = $2
         AND fav.deleted_at IS NULL
       LEFT JOIN LATERAL (
         SELECT count(DISTINCT completed.id)::int AS completed_event_count,
           COALESCE(sum(attendance.party_size) FILTER (WHERE attendance.status = 'checked_in'), 0)::int
             AS checked_in_party_count,
           COALESCE(sum(attendance.party_size) FILTER (
             WHERE attendance.status IN ('checked_in','no_show')
           ), 0)::int AS attendance_sample
         FROM events.events completed
         LEFT JOIN events.registrations attendance
           ON attendance.event_id = completed.id AND attendance.deleted_at IS NULL
         WHERE completed.organizer_id = e.organizer_id
           AND completed.completed_at IS NOT NULL AND completed.deleted_at IS NULL
       ) trust ON true
       WHERE (e.id::text = $1 OR e.public_slug = $1) AND e.deleted_at IS NULL
       ${lock ? 'FOR UPDATE OF e' : ''}`,
      [identifier, viewerId ?? null],
    );
    const row = result.rows[0];
    if (!row || (row.status === 'removed' && !viewerId)) {
      throw new DomainError('EVENT_NOT_FOUND', '活动不存在或已不可见。', 404);
    }
    return row;
  }

  private toView(row: EventRow, viewer: AuthenticatedUser | undefined, includeDetail: boolean): Record<string, unknown> {
    if (
      ['published', 'registration_closed', 'in_progress'].includes(row.status)
      && (!row.region_id || !row.public_area || row.is_free === null || row.is_free === undefined)
    ) {
      throw new DomainError(
        'EVENT_DATA_INCOMPLETE',
        'Published event is missing required location or fee facts.',
        500,
      );
    }
    const capacity = row.capacity ?? 0;
    const occupied = row.confirmed_count + (row.pending_count ?? 0) + (row.offered_count ?? 0);
    const policyActions = availableEventActions(
      {
        authenticated: Boolean(viewer),
        phoneVerified: viewer?.phoneVerified ?? false,
        roles: (viewer?.roles ?? ['guest']) as Role[],
        restrictions: new Set((viewer?.restrictions ?? []) as RestrictionFlag[]),
        ...(viewer ? { userId: viewer.id } : {}),
      },
      {
        organizerId: row.organizer_id,
        status: row.status,
        registrationOpen:
          row.status === 'published' && (!row.deadline_at || row.deadline_at.getTime() > Date.now()),
        waitlistEnabled: row.waitlist_enabled,
        isFull: capacity > 0 && occupied >= capacity,
        registrationStatus: row.registration_status,
      },
    );
    const actions = row.registration_mode === 'invite_only'
      ? policyActions.filter((action) => action !== 'register' && action !== 'joinWaitlist')
      : policyActions;
    const canSeeAddress = canReadExactAddress({
      isOrganizer: viewer?.id === row.organizer_id,
      visibility: row.exact_address_visibility === 'public' ? 'public' : 'confirmed',
      registrationStatus: row.registration_status ?? undefined,
      eventStatus: row.status,
    });
    let exactAddress: string | null = null;
    if (includeDetail && canSeeAddress && row.exact_address_cipher) {
      try {
        exactAddress = this.fieldCrypto.decrypt(row.exact_address_cipher);
      } catch {
        exactAddress = null;
      }
    }
    const approximateCoordinate = row.latitude === null || row.latitude === undefined
      || row.longitude === null || row.longitude === undefined
      ? null
      : { latitude: row.latitude, longitude: row.longitude, precision: 'approximate' as const };
    const exactCoordinate = row.exact_latitude === null || row.exact_latitude === undefined
      || row.exact_longitude === null || row.exact_longitude === undefined
      ? null
      : { latitude: row.exact_latitude, longitude: row.exact_longitude, precision: 'exact' as const };
    const coordinate = includeDetail && canSeeAddress && exactCoordinate
      ? exactCoordinate
      : approximateCoordinate;
    const fee = row.is_free === null || row.is_free === undefined
      ? null
      : {
          isFree: row.is_free,
          amountJPY: row.amount_jpy ? Number(row.amount_jpy) : null,
          collectorName: row.collector_name,
          method: row.method,
          paymentDeadlineText: row.payment_deadline_text,
          refundPolicy: row.refund_policy,
        };
    const view: Record<string, unknown> = {
      id: row.id,
      publicSlug: row.public_slug,
      organizerId: row.organizer_id,
      status: row.status,
      title: row.title,
      description: row.description,
      category: row.category_id ?? 'other',
      startsAt: row.starts_at?.toISOString() ?? null,
      endsAt: row.ends_at?.toISOString() ?? null,
      deadlineAt: row.deadline_at?.toISOString() ?? null,
      displayTimeZone: row.display_time_zone ?? 'Asia/Tokyo',
      region: row.region_id,
      publicArea: row.public_area,
      capacity,
      confirmedCount: row.confirmed_count,
      availableCapacity: row.available_capacity ?? Math.max(0, capacity - occupied),
      fee,
      coordinate,
      coverURL: row.media_items.find((item) => item.sortOrder === 0)?.url ?? null,
      tags: row.tags.length ? row.tags : (row.category_id ? [row.category_id] : []),
      organizer: {
        id: row.organizer_id,
        name: row.organizer_name ?? `@${row.organizer_handle}`,
        handle: row.organizer_handle,
        viewerFollowing: row.organizer_followed,
        trust: {
          phoneVerified: row.phone_verified ?? false,
          completedEventCount: row.completed_event_count ?? 0,
          attendanceRateBand: row.attendance_rate_band ?? 'unavailable',
        },
      },
      favorited: row.favorited,
      registrationStatus: row.registration_status,
      viewerRegistration: row.registration_id && row.registration_status && row.registration_party_size
        ? {
            id: row.registration_id,
            status: row.registration_status,
            partySize: row.registration_party_size,
            offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
          }
        : null,
      registrationMode: row.registration_mode,
      waitlistEnabled: row.waitlist_enabled,
      format: row.format ?? 'in_person',
      primaryLocale: row.primary_locale ?? 'ja',
      supportedLocales: row.supported_locales ?? ['ja'],
      localeConfirmed: Boolean(row.locale_confirmed_at),
      availableActions: actions,
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
    if (includeDetail) {
      Object.assign(view, {
        exactAddress,
        attendeeRequirements: row.attendee_requirements,
        riskFlags: row.risk_flags,
        riskDetails: row.risk_details,
        groupId: row.group_id,
        checkinMode: row.checkin_mode,
        commentPermission: row.comment_permission,
        posterEnabled: row.poster_enabled,
        exactAddressVisibility: row.exact_address_visibility ?? 'confirmed',
        registrationQuestions: row.registration_questions,
        media: row.media_items,
        mediaCount: Number(row.media_count),
      });
    }
    return view;
  }

  private async upsertDetails(client: PoolClient, eventId: string, input: EventDraftInput): Promise<void> {
    if (
      input.regionId
      || input.publicArea
      || input.exactAddress !== undefined
      || input.exactAddressVisibility
      || input.coordinate
    ) {
      await client.query(
        `INSERT INTO events.event_locations(
           event_id, region_id, public_area, exact_address_cipher, exact_address_visibility, point
         ) VALUES (
           $1, $2, $3, $4, COALESCE($5, 'confirmed'),
           CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL THEN NULL
             ELSE ST_SetSRID(ST_MakePoint($6, $7), 4326)::geography END
         )
         ON CONFLICT (event_id) DO UPDATE SET
           region_id = COALESCE(EXCLUDED.region_id, events.event_locations.region_id),
           public_area = COALESCE(EXCLUDED.public_area, events.event_locations.public_area),
           exact_address_cipher = COALESCE(EXCLUDED.exact_address_cipher, events.event_locations.exact_address_cipher),
           exact_address_visibility = COALESCE(EXCLUDED.exact_address_visibility, events.event_locations.exact_address_visibility),
           point = CASE WHEN $6::double precision IS NULL OR $7::double precision IS NULL
             THEN events.event_locations.point ELSE EXCLUDED.point END,
           updated_at = clock_timestamp()`,
        [
          eventId,
          input.regionId ?? null,
          input.publicArea ?? null,
          input.exactAddress ? this.fieldCrypto.encrypt(input.exactAddress) : null,
          input.exactAddressVisibility ?? null,
          input.coordinate?.longitude ?? null,
          input.coordinate?.latitude ?? null,
        ],
      );
    }
    if (input.registrationQuestions) {
      await this.reconcileRegistrationQuestions(client, eventId, input.registrationQuestions);
    }
    if (input.fee) {
      const fee = input.fee;
      await client.query(
        `INSERT INTO events.event_fees(
           event_id, is_free, amount_jpy, collector_name, method,
           payment_deadline_text, refund_policy
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (event_id) DO UPDATE SET
           is_free = EXCLUDED.is_free, amount_jpy = EXCLUDED.amount_jpy,
           collector_name = EXCLUDED.collector_name, method = EXCLUDED.method,
           payment_deadline_text = EXCLUDED.payment_deadline_text,
           refund_policy = EXCLUDED.refund_policy, updated_at = clock_timestamp()`,
        [
          eventId,
          fee.isFree,
          fee.isFree ? null : fee.amountJPY ?? null,
          fee.isFree ? null : fee.collectorName ?? null,
          fee.isFree ? null : fee.method ?? null,
          fee.isFree ? null : fee.paymentDeadlineText ?? null,
          fee.isFree ? null : fee.refundPolicy ?? null,
        ],
      );
    }
  }

  private async reconcileRegistrationQuestions(
    client: PoolClient,
    eventId: string,
    questions: NonNullable<EventDraftInput['registrationQuestions']>,
  ): Promise<void> {
    const existingResult = await client.query<{
      id: string;
      kind: 'text' | 'single_choice' | 'boolean';
      required: boolean;
      options: unknown;
      sort_order: number;
      answer_count: string;
    }>(
      `SELECT question.id, question.kind, question.required, question.options,
         question.sort_order,
         (SELECT count(*)::text FROM events.registration_answers answer
          WHERE answer.question_id = question.id) AS answer_count
       FROM events.registration_questions question
       WHERE question.event_id = $1
       ORDER BY question.sort_order
       FOR UPDATE OF question`,
      [eventId],
    );
    const existingById = new Map(existingResult.rows.map((question) => [question.id, question]));
    const suppliedIds = questions.flatMap((question) => (question.id ? [question.id] : []));
    if (new Set(suppliedIds).size !== suppliedIds.length) {
      throw new DomainError('REGISTRATION_QUESTIONS_INVALID', '报名问题 ID 不能重复。', 400);
    }
    const unknownIds = suppliedIds.filter((id) => !existingById.has(id));
    if (unknownIds.length > 0) {
      throw new DomainError('REGISTRATION_QUESTIONS_INVALID', '报名问题不存在或不属于此活动。', 400, {
        fieldErrors: unknownIds.map((id) => ({ field: `registrationQuestions.${id}`, message: '问题 ID 无效。' })),
      });
    }
    const incomingIds = new Set(suppliedIds);
    const removed = existingResult.rows.filter((question) => !incomingIds.has(question.id));
    const answeredRemoved = removed.filter((question) => BigInt(question.answer_count) > 0n);
    if (answeredRemoved.length > 0) {
      throw new DomainError('REGISTRATION_QUESTIONS_LOCKED', '已有用户回答的问题不能删除。', 409, {
        fieldErrors: answeredRemoved.map((question) => ({
          field: `registrationQuestions.${question.id}`,
          message: '该问题已有报名答案，请保留问题 ID。',
        })),
      });
    }
    for (const question of questions) {
      if (!question.id) continue;
      const current = existingById.get(question.id)!;
      const optionsChanged = JSON.stringify(current.options) !== JSON.stringify(question.options);
      if (BigInt(current.answer_count) > 0n && (current.kind !== question.kind || optionsChanged)) {
        throw new DomainError('REGISTRATION_QUESTIONS_LOCKED', '已有答案的问题不能修改类型或选项。', 409, {
          fieldErrors: [{
            field: `registrationQuestions.${question.id}`,
            message: '可以修改题目文案，但不能改变已有答案的类型或选项。',
          }],
        });
      }
    }
    if (removed.length > 0) {
      await client.query(
        'DELETE FROM events.registration_questions WHERE event_id = $1 AND id = ANY($2::uuid[])',
        [eventId, removed.map((question) => question.id)],
      );
    }
    if (existingResult.rows.length - removed.length > 0) {
      await client.query(
        `WITH ordered AS (
           SELECT id, row_number() OVER (ORDER BY sort_order, id)::int AS position
           FROM events.registration_questions WHERE event_id = $1
         )
         UPDATE events.registration_questions question
         SET sort_order = 10 + ordered.position, updated_at = clock_timestamp()
         FROM ordered WHERE question.id = ordered.id`,
        [eventId],
      );
    }
    for (const [index, question] of questions.entries()) {
      if (question.id) {
        await client.query(
          `UPDATE events.registration_questions
           SET prompt = $3, kind = $4, required = $5, options = $6::jsonb,
             sort_order = $7, updated_at = clock_timestamp()
           WHERE id = $1 AND event_id = $2`,
          [
            question.id,
            eventId,
            question.prompt,
            question.kind,
            question.required,
            serializeRegistrationQuestionOptions(question.options),
            index,
          ],
        );
      } else {
        await client.query(
          `INSERT INTO events.registration_questions(
             id, event_id, prompt, kind, required, options, sort_order
           ) VALUES (uuidv7(),$1,$2,$3,$4,$5::jsonb,$6)`,
          [
            eventId,
            question.prompt,
            question.kind,
            question.required,
            serializeRegistrationQuestionOptions(question.options),
            index,
          ],
        );
      }
    }
  }

  private validateSubmission(event: EventRow): void {
    const missing: string[] = [];
    if (event.title.trim().length < 4 || event.title.trim().length > 40) missing.push('title');
    if (event.description.trim().length < 50 || event.description.trim().length > 3000) missing.push('description');
    if (!event.category_id) missing.push('categoryId');
    if (!event.starts_at || !event.ends_at || event.starts_at >= event.ends_at) missing.push('time');
    if (!event.region_id || !event.public_area) missing.push('location');
    if (!event.capacity) missing.push('capacity');
    if (event.is_free === null) missing.push('fee');
    if (event.risk_flags.length > 0 && Object.keys(event.risk_details).length === 0) missing.push('riskDetails');
    const mediaCount = Number(event.media_count);
    if (mediaCount < 1 || mediaCount > 6) missing.push('media');
    if (
      event.is_free === false &&
      (!event.amount_jpy || !event.collector_name || !event.method || !event.refund_policy)
    ) {
      missing.push('paidFeeDetails');
    }
    if (missing.length > 0) {
      throw new DomainError('VALIDATION_FAILED', '提交前请补全活动信息。', 400, {
        fieldErrors: missing.map((field) => ({ field, message: '此项为提交审核必填项。' })),
      });
    }
  }

  private requirePublisher(user: AuthenticatedUser): void {
    if (!user.phoneVerified) {
      throw new DomainError('PHONE_VERIFICATION_REQUIRED', '发布活动前需要验证日本手机号。', 403, {
        actions: [{ type: 'verifyPhone', label: '继续验证' }],
      });
    }
    if (user.restrictions.includes('publishBlocked')) {
      throw new DomainError('ACCOUNT_RESTRICTED', '当前账号暂不能发布活动。', 403);
    }
  }

  private async recordChange(
    client: PoolClient,
    userId: string,
    eventId: string,
    version: number,
    topic: string,
    fields: string[],
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    const changePayload = { eventId, version, ...payload };
    await client.query(
      "SELECT sync.record_change($1, $2, 'event', $3, 'upsert', $4, $5, $6)",
      [userId, topic, eventId, version, fields, changePayload],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('event', $1, $2, $3)`,
      [eventId, topic, changePayload],
    );
  }

  private encodeCursor(date: Date, id: string): string {
    return Buffer.from(JSON.stringify({ date: date.toISOString(), id })).toString('base64url');
  }

  private decodeCursor(cursor?: string): { date: string; id: string } | null {
    if (!cursor) return null;
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      const candidate = discoveryCursorSchema.parse(parsed);
      const canonicalDate = new Date(candidate.date).toISOString();
      if (candidate.date !== canonicalDate) throw new Error('invalid');
      return { date: canonicalDate, id: candidate.id };
    } catch {
      throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    }
  }
}
