import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';

/**
 * Host → attendee broadcast (product doc K, "主办方通知参与者").
 *
 * An organizer publishes a short announcement to the people who committed to
 * their event. Fan-out is synchronous into the notification inbox — one row per
 * confirmed attendee — so the receipt is durable the moment the request returns
 * and provable without waiting on the async worker. The worker still promotes
 * those rows into push/e-mail deliveries through its generic delivery
 * materialization (`orchestrateNotifications`), and `event.host_announcement`
 * deep-links back to the event.
 *
 * No dedicated table is introduced: the notification rows are the durable record
 * of what was sent. Each announcement is stamped with a server-generated
 * `announcementId`, which lets the organizer list group the per-recipient rows
 * back into the announcements they published, and lets the daily cap count
 * distinct announcements rather than recipients.
 */
export const EVENT_ANNOUNCEMENT_DAILY_CAP = 5;

const NOTIFICATION_TYPE = 'event.host_announcement';

interface AnnouncementInput {
  title: string;
  body: string;
}

interface EventRow {
  id: string;
  organizer_id: string;
  title: string;
}

@Injectable()
export class EventAnnouncementsService {
  constructor(
    private readonly database: Database,
    private readonly idempotency: IdempotencyService,
  ) {}

  async send(
    actorId: string,
    identifier: string,
    key: string,
    input: AnnouncementInput,
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash(
        'POST',
        `/events/${identifier}/announcements`,
        input,
      );
      const replay = await this.idempotency.claim<unknown>(client, actorId, key, hash);
      if (replay) return replay.body;

      const event = await this.loadOrganizerEvent(client, identifier, actorId);
      const sentToday = await this.sentTodayCount(client, event.id);
      if (sentToday >= EVENT_ANNOUNCEMENT_DAILY_CAP) {
        throw new DomainError(
          'EVENT_ANNOUNCEMENT_RATE_LIMITED',
          `同一活动每天最多发送 ${EVENT_ANNOUNCEMENT_DAILY_CAP} 条通知。`,
          429,
          { meta: { dailyLimit: EVENT_ANNOUNCEMENT_DAILY_CAP, remainingToday: 0 } },
        );
      }

      const announcementId = randomUUID();
      const dedupeKey = `host_announcement:${announcementId}`;
      const payload = {
        announcementId,
        eventId: event.id,
        eventTitle: event.title,
        announcementTitle: input.title,
        body: input.body,
        dedupeKey,
      };

      // Fan out to confirmed attendees only, excluding the organizer. A single
      // INSERT…SELECT keeps the whole broadcast atomic inside the transaction.
      const fanout = await client.query<{ user_id: string }>(
        `INSERT INTO notification.notifications(
           user_id, type, template_version, payload_ref, resource_type, resource_public_id, dedupe_key
         )
         SELECT DISTINCT registration.user_id, $2,
           COALESCE((SELECT max(version) FROM notification.templates
                     WHERE type = $2 AND active), 1),
           $3::jsonb, 'event', $4, $5
         FROM events.registrations registration
         WHERE registration.event_id = $1 AND registration.status = 'confirmed'
           AND registration.user_id <> $6
         ON CONFLICT (user_id, type, dedupe_key) DO NOTHING
         RETURNING user_id`,
        [event.id, NOTIFICATION_TYPE, JSON.stringify(payload), event.id, dedupeKey, actorId],
      );

      const recipientCount = fanout.rowCount ?? 0;
      const sentAt = new Date().toISOString();
      const body = {
        announcementId,
        title: input.title,
        body: input.body,
        recipientCount,
        sentAt,
        dailyLimit: EVENT_ANNOUNCEMENT_DAILY_CAP,
        remainingToday: Math.max(0, EVENT_ANNOUNCEMENT_DAILY_CAP - (sentToday + 1)),
      };
      await this.idempotency.complete(
        client,
        actorId,
        key,
        { status: 201, body },
        { type: 'event_announcement', id: announcementId },
      );
      return body;
    });
  }

  async list(actorId: string, identifier: string): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      const event = await this.loadOrganizerEvent(client, identifier, actorId);
      const rows = await client.query<{
        announcement_id: string;
        title: string | null;
        body: string | null;
        sent_at: Date;
        recipient_count: number;
      }>(
        `SELECT payload_ref->>'announcementId' AS announcement_id,
           max(payload_ref->>'announcementTitle') AS title,
           max(payload_ref->>'body') AS body,
           min(created_at) AS sent_at,
           count(*)::int AS recipient_count
         FROM notification.notifications
         WHERE type = $1 AND resource_public_id = $2
           AND payload_ref->>'announcementId' IS NOT NULL
         GROUP BY payload_ref->>'announcementId'
         ORDER BY sent_at DESC
         LIMIT 50`,
        [NOTIFICATION_TYPE, event.id],
      );
      const sentToday = await this.sentTodayCount(client, event.id);
      return {
        items: rows.rows.map((row) => ({
          id: row.announcement_id,
          title: row.title ?? '',
          body: row.body ?? '',
          recipientCount: row.recipient_count,
          sentAt: row.sent_at.toISOString(),
        })),
        dailyLimit: EVENT_ANNOUNCEMENT_DAILY_CAP,
        remainingToday: Math.max(0, EVENT_ANNOUNCEMENT_DAILY_CAP - sentToday),
      };
    } finally {
      client.release();
    }
  }

  private async loadOrganizerEvent(
    client: PoolClient,
    identifier: string,
    actorId: string,
  ): Promise<EventRow> {
    const result = await client.query<EventRow>(
      `SELECT id, organizer_id, title FROM events.events
       WHERE (id::text = $1 OR public_slug = $1) AND deleted_at IS NULL`,
      [identifier],
    );
    const event = result.rows[0];
    if (!event) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    if (event.organizer_id !== actorId) {
      throw new DomainError('EVENT_ANNOUNCEMENT_FORBIDDEN', '只有活动主办方可以发送通知。', 403);
    }
    return event;
  }

  private async sentTodayCount(client: PoolClient, eventId: string): Promise<number> {
    const result = await client.query<{ count: string }>(
      `SELECT count(DISTINCT payload_ref->>'announcementId')::text AS count
       FROM notification.notifications
       WHERE type = $1 AND resource_public_id = $2
         AND created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Tokyo')
             AT TIME ZONE 'Asia/Tokyo'`,
      [NOTIFICATION_TYPE, eventId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
