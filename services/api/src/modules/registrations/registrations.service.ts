import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError, type AvailableAction, type RegistrationStatus } from '@spott/domain';
import type { PoolClient } from 'pg';
import { configuration } from '../../config.js';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';

const MAX_CHECKIN_WINDOW_MINUTES = 525_600;

const CHECKIN_WINDOW_CTES = `
checkin_clock AS (
  SELECT clock_timestamp() AS server_time
), active_checkin_config AS (
  SELECT DISTINCT ON (revision.key)
    revision.key, revision.value_json
  FROM admin.config_revisions revision
  CROSS JOIN checkin_clock
  WHERE revision.key IN (
      'checkin.window.before_minutes',
      'checkin.window.after_minutes'
    )
    AND revision.state = 'active'
    AND (revision.effective_from IS NULL
      OR revision.effective_from <= checkin_clock.server_time)
    AND (revision.effective_to IS NULL
      OR revision.effective_to > checkin_clock.server_time)
  ORDER BY revision.key, revision.version DESC
), parsed_checkin_config AS (
  SELECT config.key,
    CASE
      WHEN jsonb_typeof(config.value_json) IN ('number', 'string')
        AND (config.value_json #>> '{}') ~ '^[0-9]{1,6}$'
      THEN (config.value_json #>> '{}')::bigint
      ELSE NULL
    END AS minutes
  FROM active_checkin_config config
), checkin_window AS (
  SELECT
    COALESCE(
      MAX(CASE
        WHEN config.key = 'checkin.window.before_minutes'
          AND config.minutes BETWEEN 0 AND ${MAX_CHECKIN_WINDOW_MINUTES}
        THEN config.minutes
      END),
      60
    ) AS before_minutes,
    COALESCE(
      MAX(CASE
        WHEN config.key = 'checkin.window.after_minutes'
          AND config.minutes BETWEEN 0 AND ${MAX_CHECKIN_WINDOW_MINUTES}
        THEN config.minutes
      END),
      120
    ) AS after_minutes
  FROM parsed_checkin_config config
)`;

interface RegistrationRow {
  id: string;
  event_id: string;
  user_id: string;
  status: RegistrationStatus;
  party_size: number;
  attendee_note: string | null;
  ticket_type_id: string | null;
  version: string;
  waitlist_joined_at: Date | null;
  updated_at: Date;
  offer_expires_at: Date | null;
}

interface RegistrationItineraryRow extends RegistrationRow {
  server_time: Date;
  itinerary_event_id: string | null;
  itinerary_public_slug: string | null;
  itinerary_status: string | null;
  itinerary_title: string | null;
  itinerary_starts_at: Date | null;
  itinerary_ends_at: Date | null;
  itinerary_display_time_zone: string | null;
  itinerary_region: string | null;
  itinerary_public_area: string | null;
  itinerary_cover_url: string | null;
  itinerary_format: string | null;
  itinerary_primary_locale: string | null;
  itinerary_locale_confirmed_at: Date | null;
  itinerary_version: string | null;
  itinerary_updated_at: Date | null;
  itinerary_checkin_eligible: boolean;
}

interface RegistrationQuestionRow {
  id: string;
  kind: 'text' | 'single_choice' | 'boolean';
  prompt: string;
  required: boolean;
  options: unknown;
}

interface AttendeeRow extends RegistrationRow {
  nickname: string | null;
  public_handle: string;
  answers: Record<string, unknown>;
}

@Injectable()
export class RegistrationsService {
  constructor(
    private readonly database: Database,
    private readonly idempotency: IdempotencyService,
    private readonly points: PointsService,
  ) {}

  async register(
    user: AuthenticatedUser,
    eventId: string,
    key: string,
    input: {
      partySize: number;
      quoteId: string;
      expectedEventVersion: number;
      joinWaitlistIfFull: boolean;
      answers: Record<string, unknown>;
      attendeeNote?: string | undefined;
      ticketTypeId?: string | undefined;
    },
  ): Promise<unknown> {
    this.requireRegistrant(user);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/events/${eventId}/registrations`, input);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const eventResult = await client.query<{
        id: string;
        status: string;
        capacity: number;
        deadline_at: Date | null;
        ends_at: Date | null;
        registration_mode: string;
        waitlist_enabled: boolean;
        confirmed_count: number;
        pending_count: number;
        offered_count: number;
        version: string;
        server_time: Date;
        active_ticket_type_count: string | null;
      }>(
        `SELECT e.id, e.status, e.capacity, e.deadline_at, e.ends_at, e.registration_mode,
           e.waitlist_enabled, c.confirmed_count, c.pending_count, c.offered_count,
           e.version::text AS version, clock_timestamp() AS server_time,
           (SELECT count(*) FROM events.ticket_types t
              WHERE t.event_id = e.id AND t.active)::text AS active_ticket_type_count
         FROM events.events e JOIN events.event_capacity c ON c.event_id = e.id
         WHERE e.id = $1 FOR UPDATE OF e, c`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      const currentVersion = Number(event.version);
      if (currentVersion !== input.expectedEventVersion) {
        throw new DomainError('EVENT_CHANGED', '活动内容已更新，请重新确认后报名。', 409, {
          meta: { currentVersion },
        });
      }
      if (event.registration_mode === 'invite_only') {
        throw new DomainError('INVITE_REQUIRED', '此活动仅限受邀用户报名。', 403);
      }
      if (
        event.status !== 'published'
        || !event.ends_at
        || event.ends_at <= event.server_time
        || (event.deadline_at && event.deadline_at <= event.server_time)
      ) {
        throw new DomainError('REGISTRATION_CLOSED', '活动报名已截止。', 422);
      }
      const duplicate = await client.query<RegistrationRow>(
        `SELECT r.*, NULL::timestamptz AS offer_expires_at FROM events.registrations r
         WHERE event_id = $1 AND user_id = $2
           AND status IN ('pending','confirmed','waitlisted','offered','checked_in')`,
        [eventId, user.id],
      );
      if (duplicate.rows[0]) {
        const body = this.toView(duplicate.rows[0]);
        await this.idempotency.complete(client, user.id, key, { status: 200, body }, {
          type: 'registration',
          id: duplicate.rows[0].id,
        });
        return body;
      }

      await this.validateAnswers(client, eventId, input.answers);

      // Ticketing shell (owner ruling 2026-07-17): when the event defines active tiers the
      // registrant must pick one, and the tier's own quota gates the seat independently of the
      // event capacity. Spott only records the selection and headcount here — the money is settled
      // off-platform, never through the platform.
      const activeTicketTypeCount = Number(event.active_ticket_type_count ?? 0);
      let ticketType: { id: string; quota: number | null; sold_count: number } | null = null;
      if (input.ticketTypeId) {
        const ticketResult = await client.query<{ id: string; quota: number | null; sold_count: number }>(
          `SELECT id, quota, sold_count FROM events.ticket_types
           WHERE id = $1 AND event_id = $2 AND active FOR UPDATE`,
          [input.ticketTypeId, eventId],
        );
        ticketType = ticketResult.rows[0] ?? null;
        if (!ticketType) {
          throw new DomainError('TICKET_TYPE_UNAVAILABLE', '所选票种不可用。', 409);
        }
        if (ticketType.quota !== null && ticketType.sold_count + input.partySize > ticketType.quota) {
          throw new DomainError('TICKET_SOLD_OUT', '所选票种名额已满。', 409, {
            meta: { remaining: Math.max(0, ticketType.quota - ticketType.sold_count) },
          });
        }
      } else if (activeTicketTypeCount > 0) {
        throw new DomainError('TICKET_SELECTION_REQUIRED', '请先选择票种。', 422);
      }

      const occupied = event.confirmed_count + event.pending_count + event.offered_count;
      const hasCapacity = occupied + input.partySize <= event.capacity;
      if (!hasCapacity && (!event.waitlist_enabled || !input.joinWaitlistIfFull)) {
        throw new DomainError('REGISTRATION_CAPACITY_FULL', '活动名额刚刚报满，可以加入候补。', 409, {
          actions: event.waitlist_enabled ? [{ type: 'joinWaitlist', label: '加入候补' }] : [],
          meta: { waitlistEnabled: event.waitlist_enabled },
        });
      }

      const idResult = await client.query<{ id: string }>('SELECT uuidv7() AS id');
      const registrationId = idResult.rows[0]!.id;
      let status: RegistrationStatus;
      if (!hasCapacity) status = 'waitlisted';
      else status = event.registration_mode === 'automatic' ? 'confirmed' : 'pending';
      await client.query(
        `INSERT INTO events.registrations(
         id, event_id, user_id, status, party_size, attendee_note, ticket_type_id,
         waitlist_joined_at, confirmed_at
         ) VALUES ($1,$2,$3,$4::events.registration_status,$5,$6,$7,
           CASE WHEN $4::text = 'waitlisted' THEN clock_timestamp() ELSE NULL END,
           CASE WHEN $4::text = 'confirmed' THEN clock_timestamp() ELSE NULL END)`,
        [registrationId, eventId, user.id, status, input.partySize, input.attendeeNote ?? null,
          ticketType?.id ?? null],
      );
      // A tier holder occupies its quota as soon as a seat is taken or held (confirmed / pending).
      // Waitlisted registrations do not, mirroring the event-level capacity accounting above.
      if (ticketType && (status === 'confirmed' || status === 'pending')) {
        await client.query(
          `UPDATE events.ticket_types SET sold_count = sold_count + $2, updated_at = clock_timestamp()
           WHERE id = $1`,
          [ticketType.id, input.partySize],
        );
      }

      if (status === 'confirmed') {
        const amount = await this.points.consumeQuote(client, user.id, input.quoteId, 'registration', eventId);
        await this.points.spend(
          client,
          user.id,
          amount,
          'registration_fee',
          `registration_fee:${registrationId}`,
          { registrationId, eventId },
        );
        await client.query(
          `UPDATE events.event_capacity SET confirmed_count = confirmed_count + $2,
             updated_at = clock_timestamp() WHERE event_id = $1`,
          [eventId, input.partySize],
        );
      } else if (status === 'pending') {
        const amount = await this.points.consumeQuote(client, user.id, input.quoteId, 'registration', eventId);
        await this.points.createHold(
          client,
          user.id,
          amount,
          `registration_hold:${registrationId}`,
          '15 minutes',
        );
        await client.query(
          `UPDATE events.event_capacity SET pending_count = pending_count + $2,
             updated_at = clock_timestamp() WHERE event_id = $1`,
          [eventId, input.partySize],
        );
      } else {
        await client.query(
          `UPDATE events.event_capacity SET waitlist_count = waitlist_count + 1,
             updated_at = clock_timestamp() WHERE event_id = $1`,
          [eventId],
        );
      }

      for (const [questionId, answer] of Object.entries(input.answers)) {
        await client.query(
          `INSERT INTO events.registration_answers(registration_id, question_id, answer_json)
           SELECT $1, q.id, $3::jsonb FROM events.registration_questions q WHERE q.id = $2 AND q.event_id = $4
           ON CONFLICT (registration_id, question_id) DO UPDATE SET answer_json = EXCLUDED.answer_json`,
          [registrationId, questionId, JSON.stringify(answer), eventId],
        );
      }
      await this.recordChange(client, user.id, registrationId, eventId, 1, status);
      const row = await this.load(client, registrationId, true);
      const body = this.toView(row);
      await this.idempotency.complete(client, user.id, key, { status: 201, body }, {
        type: 'registration',
        id: registrationId,
      });
      return body;
    });
  }

  async attendees(
    actor: AuthenticatedUser,
    eventId: string,
    status?: string,
    cursor?: string,
    limit = 50,
  ): Promise<unknown> {
    const event = await this.database.query<{ organizer_id: string }>(
      'SELECT organizer_id FROM events.events WHERE id = $1 AND deleted_at IS NULL',
      [eventId],
    );
    if (!event.rows[0]) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    if (event.rows[0].organizer_id !== actor.id && !actor.roles.includes('operator')) {
      throw new DomainError('ATTENDEE_LIST_FORBIDDEN', '只有局头可以查看报名名单。', 403);
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const date = cursor ? new Date(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
    if (date && Number.isNaN(date.getTime())) throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    const result = await this.database.query<AttendeeRow>(
      `SELECT registration.*, NULL::timestamptz AS offer_expires_at,
         profile.nickname, attendee.public_handle,
         COALESCE((SELECT jsonb_object_agg(answer.question_id::text, answer.answer_json)
           FROM events.registration_answers answer
           WHERE answer.registration_id = registration.id), '{}'::jsonb) AS answers
       FROM events.registrations registration
       JOIN identity.users attendee ON attendee.id = registration.user_id
       LEFT JOIN identity.profiles profile ON profile.user_id = registration.user_id
       WHERE registration.event_id = $1 AND registration.deleted_at IS NULL
         AND ($2::text IS NULL OR registration.status::text = $2)
         AND ($3::timestamptz IS NULL OR registration.updated_at < $3)
       ORDER BY registration.updated_at DESC, registration.id DESC LIMIT $4`,
      [eventId, status ?? null, date?.toISOString() ?? null, safeLimit + 1],
    );
    const hasMore = result.rows.length > safeLimit;
    const rows = result.rows.slice(0, safeLimit);
    return {
      items: rows.map((row) => ({
        ...this.toView(row),
        attendee: {
          id: row.user_id,
          nickname: row.nickname ?? `@${row.public_handle}`,
          publicHandle: row.public_handle,
        },
        attendeeNote: row.attendee_note,
        answers: row.answers,
      })),
      hasMore,
      nextCursor:
        hasMore && rows.at(-1)
          ? Buffer.from(rows.at(-1)!.updated_at.toISOString()).toString('base64url')
          : null,
    };
  }

  async corrections(
    actor: AuthenticatedUser,
    eventId: string,
    status?: 'pending' | 'approved' | 'rejected',
    limit = 50,
  ): Promise<unknown> {
    const event = await this.database.query<{ organizer_id: string }>(
      'SELECT organizer_id FROM events.events WHERE id = $1 AND deleted_at IS NULL',
      [eventId],
    );
    if (!event.rows[0]) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    if (event.rows[0].organizer_id !== actor.id && !actor.roles.includes('operator')) {
      throw new DomainError('CHECKIN_CORRECTION_FORBIDDEN', '只有局头可以查看补签申请。', 403);
    }
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.database.query<{
      id: string;
      registration_id: string;
      user_id: string;
      registration_status: string;
      party_size: number;
      reason: string;
      status: string;
      created_at: Date;
      decided_at: Date | null;
      nickname: string | null;
      public_handle: string;
    }>(
      `SELECT correction.id, correction.registration_id, registration.user_id,
         registration.status::text AS registration_status, registration.party_size,
         correction.reason, correction.status, correction.created_at, correction.decided_at,
         profile.nickname, attendee.public_handle
       FROM events.attendance_corrections correction
       JOIN events.registrations registration ON registration.id = correction.registration_id
       JOIN identity.users attendee ON attendee.id = registration.user_id
       LEFT JOIN identity.profiles profile ON profile.user_id = registration.user_id
       WHERE registration.event_id = $1 AND ($2::text IS NULL OR correction.status = $2)
       ORDER BY correction.created_at DESC, correction.id DESC
       LIMIT $3`,
      [eventId, status ?? null, safeLimit],
    );
    return {
      items: result.rows.map((row) => ({
        id: row.id,
        eventId,
        registration: {
          id: row.registration_id,
          userId: row.user_id,
          status: row.registration_status,
          partySize: row.party_size,
        },
        attendee: {
          id: row.user_id,
          nickname: row.nickname ?? `@${row.public_handle}`,
          publicHandle: row.public_handle,
        },
        reason: row.reason,
        status: row.status,
        createdAt: row.created_at.toISOString(),
        decidedAt: row.decided_at?.toISOString() ?? null,
      })),
    };
  }

  async decide(
    actor: AuthenticatedUser,
    registrationId: string,
    key: string,
    input: { decision: 'approve' | 'reject'; reason?: string | undefined },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/registrations/${registrationId}/decision`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const registration = await this.load(client, registrationId, true);
      const eventResult = await client.query<{
        organizer_id: string;
        capacity: number;
        confirmed_count: number;
        pending_count: number;
        offered_count: number;
      }>(
        `SELECT event.organizer_id, event.capacity, capacity.confirmed_count,
           capacity.pending_count, capacity.offered_count
         FROM events.events event
         JOIN events.event_capacity capacity ON capacity.event_id = event.id
         WHERE event.id = $1 FOR UPDATE OF event, capacity`,
        [registration.event_id],
      );
      const event = eventResult.rows[0];
      if (!event) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      if (event.organizer_id !== actor.id && !actor.roles.includes('operator')) {
        throw new DomainError('REGISTRATION_DECISION_FORBIDDEN', '只有局头可以审核报名。', 403);
      }
      if (registration.status !== 'pending') {
        const alreadyReached =
          (input.decision === 'approve' && registration.status === 'confirmed') ||
          (input.decision === 'reject' && registration.status === 'rejected');
        if (!alreadyReached) throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能审核。', 422);
        const body = this.toView(registration);
        await this.idempotency.complete(client, actor.id, key, { status: 200, body }, {
          type: 'registration', id: registration.id,
        });
        return body;
      }
      // Only an active hold may be locked here: a captured or released one is
      // already spent, and feeding it to captureHold would only raise a
      // confusing POINT_HOLD_EXPIRED on the host's decision.
      const hold = await client.query<{ id: string; capturable: boolean }>(
        `SELECT id, expires_at > clock_timestamp() AS capturable FROM commerce.point_holds
         WHERE user_id = $1 AND business_key = $2 AND state = 'active' FOR UPDATE`,
        [registration.user_id, `registration_hold:${registration.id}`],
      );
      if (input.decision === 'approve') {
        if (event.confirmed_count + event.offered_count + registration.party_size > event.capacity) {
          throw new DomainError('REGISTRATION_CAPACITY_FULL', '活动名额已满，无法确认此申请。', 409);
        }
        if (!hold.rows[0]) throw new DomainError('POINT_HOLD_NOT_FOUND', '报名积分预留不存在。', 409);
        // A hold past its deadline no longer reserves the applicant's points:
        // they may already be committed elsewhere, so capturing it now could
        // overdraw the wallet. The expiry job will release this seat shortly.
        if (!hold.rows[0].capturable) {
          throw new DomainError('POINT_HOLD_EXPIRED', '报名积分预留已过期，名额即将释放。', 409);
        }
        await this.points.captureHold(
          client,
          hold.rows[0].id,
          'registration_fee',
          `registration_fee:${registration.id}`,
        );
        await client.query(
          "UPDATE events.registrations SET status = 'confirmed', confirmed_at = clock_timestamp() WHERE id = $1",
          [registration.id],
        );
        await client.query(
          `UPDATE events.event_capacity SET pending_count = GREATEST(0, pending_count - $2),
             confirmed_count = confirmed_count + $2, updated_at = clock_timestamp()
           WHERE event_id = $1`,
          [registration.event_id, registration.party_size],
        );
      } else {
        if (hold.rows[0]) await this.points.releaseHold(client, hold.rows[0].id);
        await client.query("UPDATE events.registrations SET status = 'rejected' WHERE id = $1", [registration.id]);
        await client.query(
          `UPDATE events.event_capacity SET pending_count = GREATEST(0, pending_count - $2),
             updated_at = clock_timestamp() WHERE event_id = $1`,
          [registration.event_id, registration.party_size],
        );
        // A rejected applicant no longer holds the tier headcount it reserved while pending.
        if (registration.ticket_type_id) {
          await client.query(
            `UPDATE events.ticket_types SET sold_count = GREATEST(0, sold_count - $2),
               updated_at = clock_timestamp() WHERE id = $1`,
            [registration.ticket_type_id, registration.party_size],
          );
        }
        await client.query(
          `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
           VALUES ('event', $1, 'waitlist.promotion_requested', $2)`,
          [registration.event_id, { eventId: registration.event_id }],
        );
      }
      const row = await this.load(client, registration.id, false);
      await this.recordChange(client, registration.user_id, row.id, row.event_id, Number(row.version), row.status);
      await client.query(
        `INSERT INTO admin.audit_logs(actor_id, action, resource, resource_id, purpose, after_hash, trace_id)
         VALUES ($1,'registration.decision','registration',$2,$3,digest($4::text,'sha256'),$5)`,
        [actor.id, row.id, input.reason ?? null, JSON.stringify({ decision: input.decision, status: row.status }), `registration-${row.id}`],
      );
      const body = this.toView(row);
      await this.idempotency.complete(client, actor.id, key, { status: 200, body }, {
        type: 'registration', id: row.id,
      });
      return body;
    });
  }

  async acceptWaitlist(
    user: AuthenticatedUser,
    registrationId: string,
    key: string,
    input: {
      quoteId: string;
      expectedRegistrationVersion: number;
      expectedEventVersion: number;
    },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash(
        'POST',
        `/registrations/${registrationId}/waitlist-acceptance`,
        input,
      );
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const registration = await this.load(client, registrationId, true);
      if (registration.user_id !== user.id) throw new DomainError('REGISTRATION_FORBIDDEN', '无权操作此报名。', 403);
      const promotion = await this.lockActiveWaitlistPromotion(client, registration.id);
      const capacity = await client.query<{
        capacity: number;
        confirmed_count: number;
        offered_count: number;
        status: string;
        ends_at: Date | null;
        deadline_at: Date | null;
        version: string;
        server_time: Date;
      }>(
        `SELECT e.capacity, c.confirmed_count, c.offered_count, e.status,
           e.ends_at, e.deadline_at, e.version::text AS version,
           clock_timestamp() AS server_time
         FROM events.events e JOIN events.event_capacity c ON c.event_id = e.id
         WHERE e.id = $1 FOR UPDATE OF e, c`,
        [registration.event_id],
      );
      const event = capacity.rows[0];
      if (!event) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      const currentRegistrationVersion = Number(registration.version);
      if (currentRegistrationVersion !== input.expectedRegistrationVersion) {
        throw new DomainError('REGISTRATION_CHANGED', '候补状态已更新，请重新确认。', 409, {
          meta: { currentVersion: currentRegistrationVersion },
        });
      }
      const currentEventVersion = Number(event.version);
      if (currentEventVersion !== input.expectedEventVersion) {
        throw new DomainError('EVENT_CHANGED', '活动内容已更新，请重新确认候补名额。', 409, {
          meta: { currentVersion: currentEventVersion },
        });
      }
      if (
        event.status !== 'published'
        || !event.ends_at
        || event.ends_at <= event.server_time
        || (event.deadline_at && event.deadline_at <= event.server_time)
      ) {
        throw new DomainError('WAITLIST_ACCEPTANCE_CLOSED', '当前活动已不能确认候补名额。', 409);
      }
      if (
        registration.status !== 'offered'
        || !promotion
        || promotion.expires_at <= event.server_time
      ) {
        throw new DomainError('WAITLIST_OFFER_EXPIRED', '候补确认已过期。', 409);
      }
      if (event.confirmed_count + registration.party_size > event.capacity) {
        throw new DomainError('REGISTRATION_CAPACITY_FULL', '预留名额已不可用。', 409);
      }
      const cost = await this.points.consumeQuote(
        client,
        user.id,
        input.quoteId,
        'registration',
        registration.event_id,
      );
      await this.points.spend(
        client,
        user.id,
        cost,
        'registration_fee',
        `registration_fee:${registration.id}`,
        { registrationId: registration.id, eventId: registration.event_id },
      );
      await client.query(
        `UPDATE events.registrations SET status = 'confirmed', confirmed_at = clock_timestamp()
         WHERE id = $1`,
        [registration.id],
      );
      await client.query(
        `UPDATE events.waitlist_promotions SET accepted_at = clock_timestamp()
         WHERE registration_id = $1 AND accepted_at IS NULL AND expired_at IS NULL`,
        [registration.id],
      );
      await client.query(
        `UPDATE events.event_capacity SET confirmed_count = confirmed_count + $2,
           offered_count = GREATEST(0, offered_count - $2), updated_at = clock_timestamp()
         WHERE event_id = $1`,
        [registration.event_id, registration.party_size],
      );
      // A waitlisted holder was not counted against its tier; count it now that it is
      // confirmed. The tier may have filled while the user waited, so re-check the quota
      // under a row lock — otherwise sold_count + party_size can exceed quota and hit the
      // CHECK(sold_count <= quota) constraint as a 500 instead of a clean sold-out error.
      if (registration.ticket_type_id) {
        const tierResult = await client.query<{ quota: number | null; sold_count: number }>(
          `SELECT quota, sold_count FROM events.ticket_types WHERE id = $1 FOR UPDATE`,
          [registration.ticket_type_id],
        );
        const tier = tierResult.rows[0];
        if (tier && tier.quota !== null && tier.sold_count + registration.party_size > tier.quota) {
          throw new DomainError('TICKET_SOLD_OUT', '所选票种名额已满，无法完成候补递补。', 409, {
            meta: { remaining: Math.max(0, tier.quota - tier.sold_count) },
          });
        }
        await client.query(
          `UPDATE events.ticket_types SET sold_count = sold_count + $2, updated_at = clock_timestamp()
           WHERE id = $1`,
          [registration.ticket_type_id, registration.party_size],
        );
      }
      const row = await this.load(client, registration.id, false);
      await this.recordChange(client, user.id, row.id, row.event_id, Number(row.version), row.status);
      const body = this.toView(row);
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, {
        type: 'registration', id: row.id,
      });
      return body;
    });
  }

  async cancel(user: AuthenticatedUser, registrationId: string, key: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/registrations/${registrationId}/cancel`, {});
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const registration = await this.load(client, registrationId, true);
      if (registration.user_id !== user.id) throw new DomainError('REGISTRATION_FORBIDDEN', '无权取消此报名。', 403);
      if (!['pending', 'confirmed', 'waitlisted', 'offered'].includes(registration.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能取消。', 422);
      }
      await this.lockActiveWaitlistPromotion(client, registration.id);
      const eventResult = await client.query<{
        status: string;
        starts_at: Date | null;
        ends_at: Date | null;
        server_time: Date;
      }>(
        `SELECT e.status, e.starts_at, e.ends_at, clock_timestamp() AS server_time
         FROM events.events e JOIN events.event_capacity c ON c.event_id = e.id
         WHERE e.id = $1 FOR UPDATE OF e, c`,
        [registration.event_id],
      );
      const event = eventResult.rows[0];
      if (!event) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      if (
        !['published', 'registration_closed'].includes(event.status)
        || !event.starts_at
        || event.starts_at <= event.server_time
      ) {
        throw new DomainError('REGISTRATION_CANCELLATION_CLOSED', '活动已开始或结束，不能再取消报名。', 409);
      }
      await client.query(
        "UPDATE events.registrations SET status = 'cancelled', cancelled_at = clock_timestamp() WHERE id = $1",
        [registration.id],
      );
      await client.query(
        `UPDATE events.waitlist_promotions SET expired_at = clock_timestamp()
         WHERE registration_id = $1 AND accepted_at IS NULL AND expired_at IS NULL`,
        [registration.id],
      );
      await client.query(
        `UPDATE events.event_capacity SET
           confirmed_count = GREATEST(0, confirmed_count - CASE WHEN $2 = 'confirmed' THEN $3 ELSE 0 END),
           pending_count = GREATEST(0, pending_count - CASE WHEN $2 = 'pending' THEN $3 ELSE 0 END),
           waitlist_count = GREATEST(0, waitlist_count - CASE WHEN $2 = 'waitlisted' THEN 1 ELSE 0 END),
           offered_count = GREATEST(0, offered_count - CASE WHEN $2 = 'offered' THEN $3 ELSE 0 END),
           updated_at = clock_timestamp()
         WHERE event_id = $1`,
        [registration.event_id, registration.status, registration.party_size],
      );
      // Release the tier headcount this registration was holding (pending / confirmed only).
      if (registration.ticket_type_id && ['pending', 'confirmed'].includes(registration.status)) {
        await client.query(
          `UPDATE events.ticket_types SET sold_count = GREATEST(0, sold_count - $2),
             updated_at = clock_timestamp() WHERE id = $1`,
          [registration.ticket_type_id, registration.party_size],
        );
      }
      let refundedPoints = 0;
      let wallet = await this.points.wallet(user.id);
      const refundHours = await this.points.configBigInt(client, 'registration.cancel_refund_hours', 24n);
      const refundable = Boolean(
        event.starts_at.getTime() - event.server_time.getTime() >= Number(refundHours) * 3_600_000,
      );
      const transaction = await client.query<{ id: string }>(
        `SELECT id FROM commerce.point_transactions
         WHERE user_id = $1 AND business_key = $2 AND status = 'posted'`,
        [user.id, `registration_fee:${registration.id}`],
      );
      if (transaction.rows[0] && refundable) {
        const beforeTotal = wallet.totalBalance;
        const reversed = await this.points.reverse(
          client,
          user.id,
          transaction.rows[0].id,
          `registration_cancel_refund:${registration.id}`,
          'registration_cancel_refund',
        );
        wallet = reversed.wallet;
        refundedPoints = wallet.totalBalance - beforeTotal;
      }
      if (registration.status === 'pending') {
        const hold = await client.query<{ id: string }>(
          'SELECT id FROM commerce.point_holds WHERE user_id = $1 AND business_key = $2',
          [user.id, `registration_hold:${registration.id}`],
        );
        if (hold.rows[0]) await this.points.releaseHold(client, hold.rows[0].id);
      }
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('event', $1, 'waitlist.promotion_requested', $2)`,
        [registration.event_id, { eventId: registration.event_id }],
      );
      const row = await this.load(client, registration.id, false);
      await this.recordChange(client, user.id, row.id, row.event_id, Number(row.version), row.status);
      const body = { registration: this.toView(row), refundedPoints, wallet };
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, {
        type: 'registration', id: row.id,
      });
      return body;
    });
  }

  async mine(userId: string, cursor?: string, limit = 20): Promise<unknown> {
    const decodedCursor = this.decodeItineraryCursor(cursor);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.database.query<RegistrationItineraryRow>(
      `WITH ${CHECKIN_WINDOW_CTES}
       SELECT checkin_clock.server_time, r.*,
         promotion.expires_at AS offer_expires_at,
         event.id AS itinerary_event_id,
         event.public_slug::text AS itinerary_public_slug,
         event.status::text AS itinerary_status,
         event.title AS itinerary_title,
         event.starts_at AS itinerary_starts_at,
         event.ends_at AS itinerary_ends_at,
         event.display_time_zone AS itinerary_display_time_zone,
         location.region_id AS itinerary_region,
         location.public_area AS itinerary_public_area,
         cover.cover_url AS itinerary_cover_url,
         event.format AS itinerary_format,
         event.primary_locale AS itinerary_primary_locale,
         event.locale_confirmed_at AS itinerary_locale_confirmed_at,
         event.version::text AS itinerary_version,
         event.updated_at AS itinerary_updated_at,
         (
           r.status = 'confirmed'
           AND event.id IS NOT NULL
           AND checkin_clock.server_time >= event.starts_at
             - checkin_window.before_minutes * interval '1 minute'
           AND checkin_clock.server_time <= event.ends_at
             + checkin_window.after_minutes * interval '1 minute'
         ) AS itinerary_checkin_eligible
       FROM checkin_clock
       CROSS JOIN checkin_window
       LEFT JOIN events.registrations r
         ON r.user_id = $1
         AND r.deleted_at IS NULL
         AND ($2::timestamptz IS NULL
           OR (r.updated_at, r.id) < ($2::timestamptz, $3::uuid))
       LEFT JOIN LATERAL (
         SELECT offer.expires_at
         FROM events.waitlist_promotions offer
         WHERE offer.registration_id = r.id
           AND offer.accepted_at IS NULL
           AND offer.expired_at IS NULL
           AND offer.expires_at > checkin_clock.server_time
         ORDER BY offer.offered_at DESC, offer.id DESC
         LIMIT 1
       ) promotion ON true
       LEFT JOIN events.events event
         ON event.id = r.event_id
         AND event.deleted_at IS NULL
         AND event.status IN (
           'published', 'registration_closed', 'in_progress', 'ended', 'cancelled', 'archived'
         )
       LEFT JOIN events.event_locations location ON location.event_id = event.id
       LEFT JOIN LATERAL (
         SELECT asset.derivatives->'card'->>'url' AS cover_url
         FROM events.event_media media
         JOIN media.assets asset ON asset.id = media.media_asset_id
         WHERE media.event_id = event.id
           AND media.moderation_state = 'approved'
           AND asset.state = 'ready'
           AND asset.moderation_state = 'approved'
           AND asset.deleted_at IS NULL
           AND asset.derivatives->'card'->>'url' IS NOT NULL
         ORDER BY media.sort_order, media.id
         LIMIT 1
       ) cover ON true
       ORDER BY r.updated_at DESC, r.id DESC
       LIMIT $4`,
      [
        userId,
        decodedCursor?.date ?? null,
        decodedCursor?.id ?? null,
        safeLimit + 1,
      ],
    );
    const registrationRows = result.rows.filter((row) => Boolean(row.id));
    const hasMore = registrationRows.length > safeLimit;
    const page = registrationRows.slice(0, safeLimit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        registration: this.toView(row, row.itinerary_checkin_eligible),
        event: this.toItineraryEvent(row),
      })),
      hasMore,
      nextCursor:
        hasMore && last
          ? this.encodeItineraryCursor(last.updated_at, last.id)
          : null,
      serverTime: (result.rows[0]?.server_time ?? new Date()).toISOString(),
    };
  }

  async createCheckinCode(
    user: AuthenticatedUser,
    eventId: string,
    requestedMode?: 'dynamic_qr' | 'six_digit',
  ): Promise<unknown> {
    const event = await this.database.query<{
      organizer_id: string;
      status: string;
      starts_at: Date;
      ends_at: Date;
      checkin_mode: string;
      checkin_eligible: boolean;
    }>(
      `WITH ${CHECKIN_WINDOW_CTES}
       SELECT event.organizer_id, event.status, event.starts_at, event.ends_at, event.checkin_mode,
         checkin_clock.server_time >= event.starts_at
           - checkin_window.before_minutes * interval '1 minute'
         AND checkin_clock.server_time <= event.ends_at
           + checkin_window.after_minutes * interval '1 minute'
           AS checkin_eligible
       FROM checkin_clock
       CROSS JOIN checkin_window
       JOIN events.events event ON event.id = $1`,
      [eventId],
    );
    const row = event.rows[0];
    if (!row) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    if (row.organizer_id !== user.id && !user.roles.includes('operator')) {
      throw new DomainError('CHECKIN_FORBIDDEN', '只有局头可以生成签到码。', 403);
    }
    if (!['published', 'registration_closed', 'in_progress', 'ended'].includes(row.status)) {
      throw new DomainError('CHECKIN_NOT_AVAILABLE', '当前活动状态不能生成签到码。', 422);
    }
    if (!row.checkin_eligible) {
      throw new DomainError('CHECKIN_WINDOW_CLOSED', '当前不在签到时段内。', 422);
    }
    const mode = requestedMode ?? (row.checkin_mode === 'six_digit' ? 'six_digit' : 'dynamic_qr');
    const secret = randomBytes(24).toString('base64url');
    const sixDigitCode = mode === 'six_digit' ? randomInt(0, 1_000_000).toString().padStart(6, '0') : null;
    const tokenHash = this.tokenHash(secret);
    const result = await this.database.query<{ id: string; valid_from: Date; valid_until: Date }>(
      `INSERT INTO events.dynamic_checkin_codes(
         event_id, token_hash, mode, short_code_hash, valid_from, valid_until
       ) VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp() + interval '30 seconds')
       RETURNING id, valid_from, valid_until`,
      [eventId, tokenHash, mode, sixDigitCode ? this.tokenHash(`six:${sixDigitCode}`) : null],
    );
    const code = result.rows[0]!;
    return {
      mode,
      token: mode === 'dynamic_qr' ? `${code.id}.${secret}` : null,
      code: sixDigitCode,
      validFrom: code.valid_from.toISOString(),
      validUntil: code.valid_until.toISOString(),
    };
  }

  async checkIn(
    user: AuthenticatedUser,
    key: string,
    input: {
      registrationId: string;
      token?: string | undefined;
      code?: string | undefined;
      operationId: string;
      deviceRecordedAt?: string | undefined;
    },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', '/checkins', input);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const registration = await this.load(client, input.registrationId, true);
      if (registration.user_id !== user.id) throw new DomainError('CHECKIN_FORBIDDEN', '此票码不属于当前账号。', 403);
      if (registration.status === 'checked_in') {
        const body = this.toView(registration);
        await this.idempotency.complete(client, user.id, key, { status: 200, body }, {
          type: 'registration', id: registration.id,
        });
        return body;
      }
      if (registration.status !== 'confirmed') {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能签到。', 422);
      }
      await this.assertCheckinWindow(client, registration.event_id, false);
      let method: 'dynamic_qr' | 'six_digit';
      let codeValid = false;
      if (input.code) {
        method = 'six_digit';
        const code = await client.query<{ id: string }>(
          `SELECT id FROM events.dynamic_checkin_codes
           WHERE event_id = $1 AND mode = 'six_digit'
             AND short_code_hash = $2 AND revoked_at IS NULL
             AND valid_from <= clock_timestamp() AND valid_until > clock_timestamp()
           ORDER BY valid_from DESC LIMIT 1`,
          [registration.event_id, this.tokenHash(`six:${input.code}`)],
        );
        codeValid = Boolean(code.rows[0]);
      } else {
        method = 'dynamic_qr';
        const [codeId, secret] = input.token?.split('.') ?? [];
        if (codeId && secret) {
          const expectedHash = this.tokenHash(secret);
          const code = await client.query<{ token_hash: Buffer }>(
            `SELECT token_hash
             FROM events.dynamic_checkin_codes
             WHERE id = $1 AND event_id = $2 AND mode = 'dynamic_qr'
               AND revoked_at IS NULL
               AND valid_from <= clock_timestamp() AND valid_until > clock_timestamp()`,
            [codeId, registration.event_id],
          );
          const token = code.rows[0];
          codeValid = Boolean(
            token &&
            token.token_hash.length === expectedHash.length &&
            timingSafeEqual(token.token_hash, expectedHash),
          );
        }
      }
      if (!codeValid) {
        throw new DomainError('CHECKIN_CODE_INVALID', '签到码已失效，请扫描最新二维码。', 409);
      }
      try {
        await client.query(
          `INSERT INTO events.checkins(
             event_id, registration_id, user_id, method, checked_in_at,
             device_recorded_at, operation_id
           ) VALUES ($1,$2,$3,$4,clock_timestamp(),$5,$6)`,
          [
            registration.event_id,
            registration.id,
            user.id,
            method,
            input.deviceRecordedAt ?? null,
            input.operationId,
          ],
        );
      } catch (error) {
        if (this.pgCode(error) !== '23505') throw error;
      }
      await client.query("UPDATE events.registrations SET status = 'checked_in' WHERE id = $1", [
        registration.id,
      ]);
      const reward = await this.awardAttendance(client, user.id, registration);
      const row = await this.load(client, registration.id, false);
      await this.recordChange(client, user.id, row.id, row.event_id, Number(row.version), row.status);
      const body = { ...this.toView(row), rewardPoints: reward };
      await this.idempotency.complete(client, user.id, key, { status: 201, body }, {
        type: 'registration', id: row.id,
      });
      return body;
    });
  }

  async manualCheckIn(
    actor: AuthenticatedUser,
    eventId: string,
    key: string,
    input: { registrationId: string; operationId: string; deviceRecordedAt?: string | undefined },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/events/${eventId}/checkins/manual`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const registration = await this.load(client, input.registrationId, true);
      if (registration.event_id !== eventId) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不属于此活动。', 404);
      const event = await client.query<{ organizer_id: string }>(
        'SELECT organizer_id FROM events.events WHERE id = $1 FOR UPDATE',
        [eventId],
      );
      if (!event.rows[0]) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      if (event.rows[0].organizer_id !== actor.id && !actor.roles.includes('operator')) {
        throw new DomainError('CHECKIN_FORBIDDEN', '只有局头可以手动签到。', 403);
      }
      if (registration.status === 'checked_in') {
        const body = this.toView(registration);
        await this.idempotency.complete(client, actor.id, key, { status: 200, body }, {
          type: 'registration', id: registration.id,
        });
        return body;
      }
      if (!['confirmed', 'no_show', 'correction_pending', 'attendance_disputed'].includes(registration.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能手动签到。', 422);
      }
      const window = await this.assertCheckinWindow(client, eventId, true);
      const method = window === 'correction' ? 'correction' : 'host_manual';
      try {
        await client.query(
          `INSERT INTO events.checkins(
             event_id, registration_id, user_id, method, checked_in_at,
             device_recorded_at, operator_id, operation_id
           ) VALUES ($1,$2,$3,$4,clock_timestamp(),$5,$6,$7)`,
          [
            eventId,
            registration.id,
            registration.user_id,
            method,
            input.deviceRecordedAt ?? null,
            actor.id,
            input.operationId,
          ],
        );
      } catch (error) {
        if (this.pgCode(error) !== '23505') throw error;
      }
      await client.query("UPDATE events.registrations SET status = 'checked_in' WHERE id = $1", [registration.id]);
      const reward = await this.awardAttendance(client, registration.user_id, registration);
      const row = await this.load(client, registration.id, false);
      await this.recordChange(client, registration.user_id, row.id, row.event_id, Number(row.version), row.status);
      const body = { ...this.toView(row), rewardPoints: reward, checkinMethod: method };
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, {
        type: 'registration', id: row.id,
      });
      return body;
    });
  }

  async requestCorrection(user: AuthenticatedUser, registrationId: string, reason: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const registration = await this.load(client, registrationId, true);
      if (registration.user_id !== user.id) throw new DomainError('CHECKIN_CORRECTION_FORBIDDEN', '无权申请此签到纠错。', 403);
      if (!['confirmed', 'no_show', 'attendance_disputed'].includes(registration.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能申请补签。', 422);
      }
      await this.assertCheckinWindow(client, registration.event_id, true, true);
      const result = await client.query<{ id: string; created_at: Date }>(
        `INSERT INTO events.attendance_corrections(registration_id, requested_by, reason)
         VALUES ($1,$2,$3) RETURNING id, created_at`,
        [registration.id, user.id, reason],
      );
      await client.query("UPDATE events.registrations SET status = 'correction_pending' WHERE id = $1", [registration.id]);
      return {
        id: result.rows[0]!.id,
        registrationId: registration.id,
        status: 'pending',
        createdAt: result.rows[0]!.created_at.toISOString(),
      };
    });
  }

  async decideCorrection(
    actor: AuthenticatedUser,
    correctionId: string,
    input: { decision: 'approve' | 'reject'; reason?: string | undefined },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        registration_id: string;
        status: string;
        event_id: string;
        user_id: string;
        organizer_id: string;
      }>(
        `SELECT correction.id, correction.registration_id, correction.status,
           registration.event_id, registration.user_id, event.organizer_id
         FROM events.attendance_corrections correction
         JOIN events.registrations registration ON registration.id = correction.registration_id
         JOIN events.events event ON event.id = registration.event_id
         WHERE correction.id = $1 FOR UPDATE OF correction, registration, event`,
        [correctionId],
      );
      const correction = result.rows[0];
      if (!correction) throw new DomainError('CHECKIN_CORRECTION_NOT_FOUND', '补签申请不存在。', 404);
      if (correction.organizer_id !== actor.id && !actor.roles.includes('operator')) {
        throw new DomainError('CHECKIN_CORRECTION_FORBIDDEN', '只有局头可以处理补签。', 403);
      }
      if (correction.status !== 'pending') throw new DomainError('INVALID_STATE_TRANSITION', '补签申请已处理。', 409);
      await client.query(
        `UPDATE events.attendance_corrections SET status = $2, decided_by = $3, decided_at = clock_timestamp()
         WHERE id = $1`,
        [correction.id, input.decision === 'approve' ? 'approved' : 'rejected', actor.id],
      );
      let reward = 0;
      if (input.decision === 'approve') {
        const operation = await client.query<{ id: string }>('SELECT uuidv7() AS id');
        await client.query(
          `INSERT INTO events.checkins(
             event_id, registration_id, user_id, method, checked_in_at, operator_id, operation_id
           ) VALUES ($1,$2,$3,'correction',clock_timestamp(),$4,$5)
           ON CONFLICT (registration_id) DO NOTHING`,
          [correction.event_id, correction.registration_id, correction.user_id, actor.id, operation.rows[0]!.id],
        );
        await client.query("UPDATE events.registrations SET status = 'checked_in' WHERE id = $1", [
          correction.registration_id,
        ]);
        const registration = await this.load(client, correction.registration_id, false);
        reward = await this.awardAttendance(client, correction.user_id, registration);
      } else {
        await client.query("UPDATE events.registrations SET status = 'no_show' WHERE id = $1", [
          correction.registration_id,
        ]);
      }
      await client.query(
        `INSERT INTO admin.audit_logs(actor_id, action, resource, resource_id, purpose, trace_id)
         VALUES ($1,'checkin.correction.decided','attendance_correction',$2,$3,$4)`,
        [actor.id, correction.id, input.reason ?? null, `correction-${correction.id}`],
      );
      return {
        id: correction.id,
        registrationId: correction.registration_id,
        status: input.decision === 'approve' ? 'approved' : 'rejected',
        rewardPoints: reward,
      };
    });
  }

  private async validateAnswers(
    client: PoolClient,
    eventId: string,
    answers: Record<string, unknown>,
  ): Promise<void> {
    const questions = await client.query<RegistrationQuestionRow>(
      `SELECT id, kind, prompt, required, options
       FROM events.registration_questions WHERE event_id = $1 ORDER BY sort_order`,
      [eventId],
    );
    const byId = new Map(questions.rows.map((question) => [question.id, question]));
    const unknown = Object.keys(answers).filter((id) => !byId.has(id));
    const fieldErrors: Array<{ field: string; message: string }> = unknown.map((id) => ({
      field: `answers.${id}`,
      message: '报名问题不存在或不属于此活动。',
    }));
    for (const question of questions.rows) {
      const hasAnswer = Object.prototype.hasOwnProperty.call(answers, question.id);
      const answer = answers[question.id];
      const empty =
        answer === null ||
        answer === undefined ||
        (typeof answer === 'string' && answer.trim().length === 0);
      if (question.required && (!hasAnswer || empty)) {
        fieldErrors.push({ field: `answers.${question.id}`, message: `${question.prompt}为必填项。` });
        continue;
      }
      if (!hasAnswer || empty) continue;
      if (question.kind === 'text' && (typeof answer !== 'string' || answer.length > 1000)) {
        fieldErrors.push({ field: `answers.${question.id}`, message: '请输入 1000 字以内的文本。' });
      } else if (question.kind === 'boolean' && typeof answer !== 'boolean') {
        fieldErrors.push({ field: `answers.${question.id}`, message: '请选择是或否。' });
      } else if (question.kind === 'single_choice') {
        const options = Array.isArray(question.options) ? question.options : [];
        if (typeof answer !== 'string' || !options.includes(answer)) {
          fieldErrors.push({ field: `answers.${question.id}`, message: '请选择有效选项。' });
        }
      }
    }
    if (fieldErrors.length) {
      throw new DomainError('REGISTRATION_ANSWERS_INVALID', '请检查报名问题答案。', 400, { fieldErrors });
    }
  }

  private async assertCheckinWindow(
    client: PoolClient,
    eventId: string,
    allowCorrection: boolean,
    correctionOnly = false,
  ): Promise<'normal' | 'correction'> {
    const result = await client.query<{
      normal_eligible: boolean;
      correction_eligible: boolean;
    }>(
      `WITH ${CHECKIN_WINDOW_CTES}
       SELECT
         checkin_clock.server_time >= event.starts_at
           - checkin_window.before_minutes * interval '1 minute'
         AND checkin_clock.server_time <= event.ends_at
           + checkin_window.after_minutes * interval '1 minute'
           AS normal_eligible,
         checkin_clock.server_time >= event.ends_at
         AND checkin_clock.server_time <= event.ends_at + interval '48 hours'
           AS correction_eligible
       FROM checkin_clock
       CROSS JOIN checkin_window
       JOIN events.events event ON event.id = $1`,
      [eventId],
    );
    const eligibility = result.rows[0];
    if (!eligibility) throw new DomainError('EVENT_TIME_INVALID', '活动时间不完整。', 422);
    if (!correctionOnly && eligibility.normal_eligible) return 'normal';
    if (allowCorrection && eligibility.correction_eligible) return 'correction';
    throw new DomainError('CHECKIN_WINDOW_CLOSED', '当前不在签到或 48 小时补签时段内。', 422);
  }

  private async awardAttendance(
    client: PoolClient,
    userId: string,
    registration: Pick<RegistrationRow, 'id' | 'event_id'>,
  ): Promise<number> {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `attendance:${userId}:${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })}`,
    ]);
    const cap = await this.points.configBigInt(client, 'points.limit.attendance.daily', 3n);
    const awardedToday = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM commerce.point_transactions
       WHERE user_id = $1 AND type = 'attendance_reward' AND status = 'posted'
         AND created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'`,
      [userId],
    );
    if (BigInt(awardedToday.rows[0]?.count ?? '0') >= cap) return 0;
    const reward = await this.points.configBigInt(client, 'points.reward.attendance', 80n);
    await this.points.credit(
      client,
      userId,
      reward,
      'free',
      'attendance_reward',
      `attendance:${registration.id}`,
      { metadata: { registrationId: registration.id, eventId: registration.event_id } },
    );
    return Number(reward);
  }

  private async load(client: PoolClient, id: string, lock: boolean): Promise<RegistrationRow> {
    const result = await client.query<RegistrationRow>(
      `SELECT r.*, p.expires_at AS offer_expires_at
       FROM events.registrations r
       LEFT JOIN LATERAL (
         SELECT expires_at FROM events.waitlist_promotions p
         WHERE p.registration_id = r.id AND p.expired_at IS NULL AND p.accepted_at IS NULL
         ORDER BY p.offered_at DESC LIMIT 1
       ) p ON true
       WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不存在。', 404);
    return row;
  }

  private async lockActiveWaitlistPromotion(
    client: PoolClient,
    registrationId: string,
  ): Promise<{ id: string; expires_at: Date } | null> {
    const result = await client.query<{ id: string; expires_at: Date }>(
      `SELECT promotion.id, promotion.expires_at
       FROM events.waitlist_promotions promotion
       WHERE promotion.registration_id = $1
         AND promotion.accepted_at IS NULL AND promotion.expired_at IS NULL
       ORDER BY promotion.offered_at DESC, promotion.id DESC
       LIMIT 1 FOR UPDATE`,
      [registrationId],
    );
    return result.rows[0] ?? null;
  }

  private toView(row: RegistrationRow, checkInEligible = false): Record<string, unknown> {
    const actions: AvailableAction[] = [];
    const itinerary = row as Partial<RegistrationItineraryRow>;
    const hasItineraryAuthority = itinerary.server_time instanceof Date;
    const cancellationOpen = !hasItineraryAuthority || Boolean(
      itinerary.itinerary_event_id
      && ['published', 'registration_closed'].includes(itinerary.itinerary_status ?? '')
      && itinerary.itinerary_starts_at
      && itinerary.server_time
      && itinerary.itinerary_starts_at > itinerary.server_time,
    );
    if (
      cancellationOpen
      && ['pending', 'confirmed', 'waitlisted', 'offered'].includes(row.status)
    ) actions.push('cancelRegistration');
    if (row.status === 'offered') actions.push('register');
    if (row.status === 'confirmed') {
      actions.push('viewTicket');
      if (checkInEligible) actions.push('checkIn');
    }
    return {
      id: row.id,
      eventId: row.event_id,
      userId: row.user_id,
      status: row.status,
      partySize: row.party_size,
      attendeeNote: row.attendee_note,
      ticketTypeId: row.ticket_type_id ?? null,
      offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
      availableActions: actions,
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private toItineraryEvent(row: RegistrationItineraryRow): Record<string, unknown> | null {
    if (!row.itinerary_event_id) return null;
    return {
      id: row.itinerary_event_id,
      publicSlug: row.itinerary_public_slug,
      status: row.itinerary_status,
      title: row.itinerary_title,
      startsAt: row.itinerary_starts_at?.toISOString() ?? null,
      endsAt: row.itinerary_ends_at?.toISOString() ?? null,
      displayTimeZone: row.itinerary_display_time_zone,
      region: row.itinerary_region,
      publicArea: row.itinerary_public_area,
      coverURL: row.itinerary_cover_url,
      format: row.itinerary_format,
      primaryLocale: row.itinerary_primary_locale,
      localeConfirmed: row.itinerary_locale_confirmed_at !== null,
      version: Number(row.itinerary_version),
      updatedAt: row.itinerary_updated_at?.toISOString() ?? null,
    };
  }

  private encodeItineraryCursor(date: Date, id: string): string {
    return Buffer.from(JSON.stringify({ date: date.toISOString(), id })).toString('base64url');
  }

  private decodeItineraryCursor(cursor?: string): { date: string; id: string } | null {
    if (!cursor) return null;
    try {
      const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
      if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
      const candidate = decoded as Record<string, unknown>;
      if (Object.keys(candidate).sort().join(',') !== 'date,id') throw new Error('invalid');
      if (typeof candidate.date !== 'string' || typeof candidate.id !== 'string') throw new Error('invalid');
      const date = new Date(candidate.date);
      if (Number.isNaN(date.getTime()) || date.toISOString() !== candidate.date) throw new Error('invalid');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(candidate.id)) {
        throw new Error('invalid');
      }
      return { date: candidate.date, id: candidate.id };
    } catch {
      throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    }
  }

  private requireRegistrant(user: AuthenticatedUser): void {
    if (!user.phoneVerified) {
      throw new DomainError('PHONE_VERIFICATION_REQUIRED', '报名活动前需要验证日本手机号。', 403, {
        actions: [{ type: 'verifyPhone', label: '继续验证' }],
      });
    }
    if (user.restrictions.includes('registerBlocked')) {
      throw new DomainError('ACCOUNT_RESTRICTED', '当前账号暂不能报名活动。', 403);
    }
  }

  private async recordChange(
    client: PoolClient,
    userId: string,
    registrationId: string,
    eventId: string,
    version: number,
    status: string,
  ): Promise<void> {
    const payload = { registrationId, eventId, status };
    await client.query(
      `SELECT sync.record_change($1, 'registration.changed', 'registration', $2, 'upsert', $3,
         ARRAY['status'], $4)`,
      [userId, registrationId, version, payload],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('registration', $1, 'registration.changed', $2)`,
      [registrationId, payload],
    );
  }

  private tokenHash(secret: string): Buffer {
    return createHmac('sha256', configuration().ACCESS_TOKEN_SECRET).update(secret).digest();
  }

  private pgCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  }
}
