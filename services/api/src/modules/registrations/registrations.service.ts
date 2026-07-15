import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError, type AvailableAction, type RegistrationStatus } from '@spott/domain';
import type { PoolClient } from 'pg';
import { configuration } from '../../config.js';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';

interface RegistrationRow {
  id: string;
  event_id: string;
  user_id: string;
  status: RegistrationStatus;
  party_size: number;
  attendee_note: string | null;
  version: string;
  waitlist_joined_at: Date | null;
  updated_at: Date;
  offer_expires_at: Date | null;
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
      joinWaitlistIfFull: boolean;
      answers: Record<string, unknown>;
      attendeeNote?: string | undefined;
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
        registration_mode: string;
        waitlist_enabled: boolean;
        confirmed_count: number;
        pending_count: number;
        offered_count: number;
      }>(
        `SELECT e.id, e.status, e.capacity, e.deadline_at, e.registration_mode,
           e.waitlist_enabled, c.confirmed_count, c.pending_count, c.offered_count
         FROM events.events e JOIN events.event_capacity c ON c.event_id = e.id
         WHERE e.id = $1 FOR UPDATE OF e, c`,
        [eventId],
      );
      const event = eventResult.rows[0];
      if (!event) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
      if (event.status !== 'published' || (event.deadline_at && event.deadline_at <= new Date())) {
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
         id, event_id, user_id, status, party_size, attendee_note, waitlist_joined_at, confirmed_at
         ) VALUES ($1,$2,$3,$4::events.registration_status,$5,$6,
           CASE WHEN $4::text = 'waitlisted' THEN clock_timestamp() ELSE NULL END,
           CASE WHEN $4::text = 'confirmed' THEN clock_timestamp() ELSE NULL END)`,
        [registrationId, eventId, user.id, status, input.partySize, input.attendeeNote ?? null],
      );

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
      const hold = await client.query<{ id: string }>(
        `SELECT id FROM commerce.point_holds
         WHERE user_id = $1 AND business_key = $2 FOR UPDATE`,
        [registration.user_id, `registration_hold:${registration.id}`],
      );
      if (input.decision === 'approve') {
        if (event.confirmed_count + event.offered_count + registration.party_size > event.capacity) {
          throw new DomainError('REGISTRATION_CAPACITY_FULL', '活动名额已满，无法确认此申请。', 409);
        }
        if (!hold.rows[0]) throw new DomainError('POINT_HOLD_NOT_FOUND', '报名积分预留不存在。', 409);
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

  async acceptWaitlist(user: AuthenticatedUser, registrationId: string, key: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/registrations/${registrationId}/waitlist-acceptance`, {});
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const registration = await this.load(client, registrationId, true);
      if (registration.user_id !== user.id) throw new DomainError('REGISTRATION_FORBIDDEN', '无权操作此报名。', 403);
      if (registration.status !== 'offered' || !registration.offer_expires_at || registration.offer_expires_at <= new Date()) {
        throw new DomainError('WAITLIST_OFFER_EXPIRED', '候补确认已过期。', 409);
      }
      const capacity = await client.query<{ capacity: number; confirmed_count: number; offered_count: number }>(
        `SELECT e.capacity, c.confirmed_count, c.offered_count
         FROM events.events e JOIN events.event_capacity c ON c.event_id = e.id
         WHERE e.id = $1 FOR UPDATE OF e, c`,
        [registration.event_id],
      );
      const event = capacity.rows[0];
      if (!event || event.confirmed_count + registration.party_size > event.capacity) {
        throw new DomainError('REGISTRATION_CAPACITY_FULL', '预留名额已不可用。', 409);
      }
      const cost = await this.points.configBigInt(client, 'points.cost.registration', 10n);
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
      await client.query('SELECT event_id FROM events.event_capacity WHERE event_id = $1 FOR UPDATE', [
        registration.event_id,
      ]);
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
      let refundedPoints = 0;
      let wallet = await this.points.wallet(user.id);
      const refundPolicy = await client.query<{ starts_at: Date }>(
        'SELECT starts_at FROM events.events WHERE id = $1',
        [registration.event_id],
      );
      const refundHours = await this.points.configBigInt(client, 'registration.cancel_refund_hours', 24n);
      const refundable = Boolean(
        refundPolicy.rows[0]?.starts_at &&
        refundPolicy.rows[0].starts_at.getTime() - Date.now() >= Number(refundHours) * 3_600_000,
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
    const date = cursor ? new Date(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
    const result = await this.database.query<RegistrationRow>(
      `SELECT r.*, p.expires_at AS offer_expires_at
       FROM events.registrations r
       LEFT JOIN LATERAL (
         SELECT expires_at FROM events.waitlist_promotions p
         WHERE p.registration_id = r.id AND p.expired_at IS NULL
         ORDER BY p.offered_at DESC LIMIT 1
       ) p ON true
       WHERE r.user_id = $1 AND ($2::timestamptz IS NULL OR r.updated_at < $2)
       ORDER BY r.updated_at DESC, r.id DESC LIMIT $3`,
      [userId, date?.toISOString() ?? null, Math.min(Math.max(limit, 1), 100) + 1],
    );
    const hasMore = result.rows.length > limit;
    const items = result.rows.slice(0, limit);
    return {
      items: items.map((row) => this.toView(row)),
      hasMore,
      nextCursor:
        hasMore && items.at(-1)
          ? Buffer.from(items.at(-1)!.updated_at.toISOString()).toString('base64url')
          : null,
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
    }>(
      'SELECT organizer_id, status, starts_at, ends_at, checkin_mode FROM events.events WHERE id = $1',
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
          const code = await client.query<{
            event_id: string;
            token_hash: Buffer;
            valid_from: Date;
            valid_until: Date;
            revoked_at: Date | null;
          }>(
            `SELECT event_id, token_hash, valid_from, valid_until, revoked_at
             FROM events.dynamic_checkin_codes WHERE id = $1 AND mode = 'dynamic_qr'`,
            [codeId],
          );
          const token = code.rows[0];
          codeValid = Boolean(
            token &&
            token.event_id === registration.event_id &&
            !token.revoked_at &&
            token.valid_from <= new Date() &&
            token.valid_until > new Date() &&
            timingSafeEqual(token.token_hash, this.tokenHash(secret)),
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
    const result = await client.query<{ starts_at: Date; ends_at: Date }>(
      'SELECT starts_at, ends_at FROM events.events WHERE id = $1',
      [eventId],
    );
    const event = result.rows[0];
    if (!event?.starts_at || !event.ends_at) throw new DomainError('EVENT_TIME_INVALID', '活动时间不完整。', 422);
    const beforeMinutes = await this.points.configBigInt(client, 'checkin.window.before_minutes', 60n);
    const afterMinutes = await this.points.configBigInt(client, 'checkin.window.after_minutes', 120n);
    const now = Date.now();
    const normalStart = event.starts_at.getTime() - Number(beforeMinutes) * 60_000;
    const normalEnd = event.ends_at.getTime() + Number(afterMinutes) * 60_000;
    if (!correctionOnly && now >= normalStart && now <= normalEnd) return 'normal';
    if (allowCorrection && now >= event.ends_at.getTime() && now <= event.ends_at.getTime() + 48 * 3_600_000) {
      return 'correction';
    }
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

  private toView(row: RegistrationRow): Record<string, unknown> {
    const actions: AvailableAction[] = [];
    if (['pending', 'confirmed', 'waitlisted', 'offered'].includes(row.status)) actions.push('cancelRegistration');
    if (row.status === 'offered') actions.push('register');
    if (row.status === 'confirmed') actions.push('viewTicket', 'checkIn');
    return {
      id: row.id,
      eventId: row.event_id,
      userId: row.user_id,
      status: row.status,
      partySize: row.party_size,
      attendeeNote: row.attendee_note,
      offerExpiresAt: row.offer_expires_at?.toISOString() ?? null,
      availableActions: actions,
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
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
