import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  DomainError,
  availableEventActions,
  canReadExactAddress,
  transitionEvent,
  type EventStatus,
  type RestrictionFlag,
  type Role,
} from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';
import { FieldCrypto } from '../../platform/crypto.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';

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
  capacity: number | null;
  registration_mode: string;
  waitlist_enabled: boolean;
  version: string;
  created_at: Date;
  updated_at: Date;
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
  registration_status: string | null;
  organizer_name: string | null;
  organizer_handle: string;
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
    options: {
      region?: string | undefined;
      query?: string | undefined;
      category?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<unknown> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const cursor = this.decodeCursor(options.cursor);
    const values: unknown[] = [viewer?.id ?? null, options.region ?? null, options.query ?? null, options.category ?? null];
    const result = await this.database.query<EventRow>(
      `SELECT e.*, l.region_id, l.public_area, NULL::bytea AS exact_address_cipher,
         f.is_free, f.amount_jpy, f.collector_name, f.method, f.payment_deadline_text,
         f.refund_policy, COALESCE(c.confirmed_count, 0) AS confirmed_count,
         r.status::text AS registration_status, p.nickname AS organizer_name,
         u.public_handle AS organizer_handle,
         (fav.event_id IS NOT NULL) AS favorited,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $1 AND follow.target_type = 'user'
             AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL) AS organizer_followed,
         l.exact_address_visibility,
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
       LEFT JOIN events.registrations r ON r.event_id = e.id AND r.user_id = $1
         AND r.status IN ('pending','confirmed','waitlisted','offered','checked_in')
       LEFT JOIN events.event_favorites fav ON fav.event_id = e.id AND fav.user_id = $1
         AND fav.deleted_at IS NULL
       WHERE e.status IN ('published','registration_closed','in_progress')
         AND e.deleted_at IS NULL
         AND e.starts_at >= clock_timestamp() - interval '6 hours'
         AND ($2::text IS NULL OR l.region_id = $2)
         AND ($3::text IS NULL OR e.title ILIKE '%' || $3 || '%'
           OR e.description ILIKE '%' || $3 || '%' OR similarity(e.title, $3) > 0.15)
         AND ($4::text IS NULL OR e.category_id = $4)
         AND ($5::timestamptz IS NULL OR (e.starts_at, e.id) > ($5, $6::uuid))
       ORDER BY e.starts_at, e.id
       LIMIT $7`,
      [...values, cursor?.date ?? null, cursor?.id ?? null, limit + 1],
    );
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
      `SELECT e.*, l.region_id, l.public_area, NULL::bytea AS exact_address_cipher,
         f.is_free, f.amount_jpy, f.collector_name, f.method, f.payment_deadline_text,
         f.refund_policy, COALESCE(c.confirmed_count, 0) AS confirmed_count,
         NULL::text AS registration_status, p.nickname AS organizer_name,
         u.public_handle AS organizer_handle, false AS favorited,
         false AS organizer_followed,
         l.exact_address_visibility,
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
         f.refund_policy, COALESCE(c.confirmed_count, 0) AS confirmed_count,
         r.status::text AS registration_status, p.nickname AS organizer_name,
         u.public_handle AS organizer_handle, true AS favorited,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $1 AND follow.target_type = 'user'
             AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL) AS organizer_followed,
         l.exact_address_visibility,
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
         AND r.status IN ('pending','confirmed','waitlisted','offered','checked_in')
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
      await client.query(
        `INSERT INTO events.events(
           id, public_slug, organizer_id, title, description, category_id,
           starts_at, ends_at, deadline_at, capacity, registration_mode,
           waitlist_enabled, tags, attendee_requirements, risk_flags, risk_details,
           group_id, checkin_mode, comment_permission, poster_enabled, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$3,$3)`,
        [
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
        ],
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
      transitionEvent(event.status, 'pending_review');
      const amount = await this.points.consumeQuote(client, user.id, quoteId, 'event_publish', event.id);
      const holdId = await this.points.createHold(
        client,
        user.id,
        amount,
        `event_publish_hold:${event.id}:${event.version}`,
        '24 hours',
      );
      await client.query(
        `UPDATE events.events SET status = 'pending_review', updated_by = $2
         WHERE id = $1 AND version = $3`,
        [event.id, user.id, baseVersion],
      );
      const after = await this.loadEvent(client, event.id, user.id);
      await this.recordChange(client, user.id, event.id, Number(after.version), 'event.submitted', ['status']);
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('event', $1, 'event.review_requested', $2)`,
        [event.id, { eventId: event.id, holdId, version: Number(after.version) }],
      );
      const body = { ...this.toView(after, user, true), submissionId: event.id, holdId };
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, { type: 'event', id: event.id });
      return body;
    });
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
         f.refund_policy, COALESCE(c.confirmed_count, 0) AS confirmed_count,
         r.status::text AS registration_status, p.nickname AS organizer_name,
         u.public_handle AS organizer_handle,
         (fav.event_id IS NOT NULL) AS favorited,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $2 AND follow.target_type = 'user'
             AND follow.target_id = e.organizer_id AND follow.deleted_at IS NULL) AS organizer_followed,
         l.exact_address_visibility,
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
         AND r.status IN ('pending','confirmed','waitlisted','offered','checked_in')
       LEFT JOIN events.event_favorites fav ON fav.event_id = e.id AND fav.user_id = $2
         AND fav.deleted_at IS NULL
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
    const capacity = row.capacity ?? 0;
    const actions = availableEventActions(
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
        isFull: capacity > 0 && row.confirmed_count >= capacity,
        registrationStatus: row.registration_status,
      },
    );
    const canSeeAddress =
      viewer?.id === row.organizer_id || canReadExactAddress(row.registration_status ?? undefined, row.status);
    let exactAddress: string | null = null;
    if (includeDetail && canSeeAddress && row.exact_address_cipher) {
      try {
        exactAddress = this.fieldCrypto.decrypt(row.exact_address_cipher);
      } catch {
        exactAddress = null;
      }
    }
    const view: Record<string, unknown> = {
      id: row.id,
      publicSlug: row.public_slug,
      organizerId: row.organizer_id,
      status: row.status,
      title: row.title,
      description: row.description,
      category: row.category_id ?? 'other',
      categoryLabel: this.categoryLabel(row.category_id),
      startsAt: row.starts_at?.toISOString() ?? null,
      endsAt: row.ends_at?.toISOString() ?? null,
      deadlineAt: row.deadline_at?.toISOString() ?? null,
      displayTimeZone: 'Asia/Tokyo',
      region: row.region_id ?? 'tokyo',
      publicArea: row.public_area ?? '地点待定',
      capacity,
      confirmedCount: row.confirmed_count,
      priceLabel: row.is_free === false ? `¥${Number(row.amount_jpy ?? 0).toLocaleString('ja-JP')}` : '免费',
      coverURL: row.media_items.find((item) => item.sortOrder === 0)?.url ?? null,
      tags: row.tags.length ? row.tags : (row.category_id ? [row.category_id] : []),
      organizer: {
        id: row.organizer_id,
        name: row.organizer_name ?? `@${row.organizer_handle}`,
        handle: row.organizer_handle,
        reliability: '手机号已验证',
        viewerFollowing: row.organizer_followed,
      },
      favorited: row.favorited,
      registrationStatus: row.registration_status,
      registrationMode: row.registration_mode,
      waitlistEnabled: row.waitlist_enabled,
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
      availableActions: actions,
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
    if (includeDetail) {
      Object.assign(view, {
        exactAddress,
        fee: {
          isFree: row.is_free ?? true,
          amountJPY: row.amount_jpy ? Number(row.amount_jpy) : null,
          collectorName: row.collector_name,
          method: row.method,
          paymentDeadlineText: row.payment_deadline_text,
          refundPolicy: row.refund_policy,
          boundaryStatement:
            row.is_free === false ? '费用由组织者自行收取，Spott 不经手活动款。' : '本活动免费。',
        },
      });
    }
    return view;
  }

  private categoryLabel(category: string | null): string {
    const labels: Record<string, string> = {
      walk: '城市漫步',
      'city-walk': '城市探索',
      music: '音乐',
      outdoor: '户外',
      art: '创作',
      language: '语言交换',
      food: '美食与咖啡',
      sports: '运动',
      games: '桌游',
      learning: '学习',
      wellness: '身心健康',
      networking: '职业交流',
      volunteering: '志愿活动',
    };
    return category ? (labels[category] ?? category) : '其他';
  }

  private async upsertDetails(client: PoolClient, eventId: string, input: EventDraftInput): Promise<void> {
    if (input.regionId || input.publicArea || input.exactAddress !== undefined || input.exactAddressVisibility) {
      await client.query(
        `INSERT INTO events.event_locations(
           event_id, region_id, public_area, exact_address_cipher, exact_address_visibility
         ) VALUES ($1, COALESCE($2, 'tokyo'), COALESCE($3, '地点待定'), $4, COALESCE($5, 'confirmed'))
         ON CONFLICT (event_id) DO UPDATE SET
           region_id = COALESCE(EXCLUDED.region_id, events.event_locations.region_id),
           public_area = COALESCE(EXCLUDED.public_area, events.event_locations.public_area),
           exact_address_cipher = COALESCE(EXCLUDED.exact_address_cipher, events.event_locations.exact_address_cipher),
           exact_address_visibility = COALESCE(EXCLUDED.exact_address_visibility, events.event_locations.exact_address_visibility),
           updated_at = clock_timestamp()`,
        [
          eventId,
          input.regionId ?? null,
          input.publicArea ?? null,
          input.exactAddress ? this.fieldCrypto.encrypt(input.exactAddress) : null,
          input.exactAddressVisibility ?? null,
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
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
        date: string;
        id: string;
      };
      if (!parsed.date || !parsed.id) throw new Error('invalid');
      return parsed;
    } catch {
      throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    }
  }
}
