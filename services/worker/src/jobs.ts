import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { WorkerConfig } from './config.js';
import type { WorkerDatabase } from './database.js';
import { DeliveryFailure, NotificationAdapters, resolveCopy, type PushTarget } from './delivery.js';
import { FieldDecryptor } from './field-crypto.js';
import { MediaProcessor } from './media.js';

export interface JobResult { processed: number; metadata?: Record<string, unknown> }

interface OutboxRow {
  event_id: string;
  aggregate: string;
  aggregate_id: string;
  type: string;
  payload: Record<string, unknown>;
  attempt_count: number;
}

interface DeliveryRow {
  id: string;
  channel: 'in_app' | 'push' | 'email' | 'sms';
  notification_id: string;
  attempts: number;
  user_id: string;
  type: string;
  template_version: number;
  payload_ref: Record<string, unknown>;
  resource_public_id: string | null;
}

type NotificationChannel = 'in_app' | 'push' | 'email';

/**
 * Server-decided deep link for a notification tap. The client only renders the
 * target; the type -> route mapping lives here so it stays in one place. Types
 * without a canonical destination (e.g. moderation.decided) return null and the
 * client simply opens the app without navigating.
 */
export function notificationDeepLink(type: string, resourcePublicId: string | null): string | null {
  if (!resourcePublicId) return null;
  switch (type) {
    case 'event.cancelled':
    case 'waitlist.offered':
    case 'event.host_announcement':
      return `spott://e/${encodeURIComponent(resourcePublicId)}`;
    case 'group.announcement':
    case 'group.dissolution_scheduled':
      return `spott://g/${encodeURIComponent(resourcePublicId)}`;
    default:
      return null;
  }
}

/**
 * Delivery policy for a semantic notification type (product doc K).
 * - `push`/`email`: whether the channel is part of the type's default fan-out.
 *   The in-app channel is always retained ("站内通知始终保留") and is not modelled here.
 * - `closable`: whether the user may switch the push/email channels off. Non-closable
 *   service notices keep their channels regardless of stored preferences.
 * - `bypassQuiet`: whether push ignores the quiet window (cancel / waitlist / safety).
 * - `frequencyCapped`: whether push obeys the per-resource daily announcement cap.
 */
interface NotificationTypePolicy {
  push: boolean;
  email: boolean;
  closable: boolean;
  bypassQuiet: boolean;
  frequencyCapped: boolean;
}

const DEFAULT_NOTIFICATION_TYPE_POLICY: NotificationTypePolicy = {
  push: true,
  email: false,
  closable: true,
  bypassQuiet: false,
  frequencyCapped: false,
};

// Product doc K trigger matrix. These are safe defaults; each field is overridable at
// runtime through the `notification.type_policies` config key so nothing is hardcoded.
const NOTIFICATION_TYPE_POLICIES: Record<string, Partial<NotificationTypePolicy>> = {
  // 报名成功/待确认/被拒绝 — service notice, cannot be fully switched off.
  'registration.changed': { push: true, closable: false },
  'registration.hold_expired': { push: true, closable: true },
  // 候补递补 — cannot be disabled and is exempt from the quiet window.
  'waitlist.offered': { push: true, closable: false, bypassQuiet: true },
  // 活动开始前 24h/2h — adjustable reminders.
  'event.reminder.24h': { push: true, closable: true },
  'event.reminder.2h': { push: true, closable: true },
  // 关键字段变更/活动取消 — mandatory, exempt from quiet, add email.
  'event.key_fields_changed': { push: true, email: true, closable: false, bypassQuiet: true },
  'event.cancelled': { push: true, email: true, closable: false, bypassQuiet: true },
  // 审核/紧急下架 — 站内 + 邮件, mandatory.
  'event.reviewed': { push: false, email: true, closable: false },
  'event.removed': { push: false, email: true, closable: false, bypassQuiet: true },
  // 审核、投诉和账号限制 — safety notices, mandatory, exempt from quiet.
  'moderation.decided': { push: false, email: true, closable: false, bypassQuiet: true },
  'account.restricted': { push: false, email: true, closable: false, bypassQuiet: true },
  // 主办方通知参与者 — closable push, subject to the per-event daily cap.
  'event.host_announcement': { push: true, closable: true, frequencyCapped: true },
  // 群组公告/新活动 — closable and subject to the daily frequency cap.
  'group.announcement': { push: true, closable: true, frequencyCapped: true },
  'group.dissolution_scheduled': { push: true, closable: false },
  // 成就/普通积分获得 — 站内 by default, closable.
  'achievements.awarded': { push: false, closable: true },
};

const DEFAULT_QUIET_START = '22:00';
const DEFAULT_QUIET_END = '08:00';
const DEFAULT_ANNOUNCEMENT_DAILY_CAP = 2;

interface NotificationRuntimeConfig {
  quietStart: string;
  quietEnd: string;
  announcementDailyCap: number;
  typePolicies: Record<string, Partial<NotificationTypePolicy>>;
}

const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeTimeOfDay(value: unknown, fallback: string): string {
  return typeof value === 'string' && TIME_OF_DAY.test(value.trim()) ? value.trim() : fallback;
}

/** True when `now` (HH:MM, JST) falls inside the [start, end) window, honouring midnight wrap. */
export function isWithinQuietWindow(now: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? now >= start && now < end : now >= start || now < end;
}

export class WorkerJobs {
  private readonly adapters: NotificationAdapters;
  private readonly decryptor: FieldDecryptor;
  private readonly media: MediaProcessor;

  constructor(private readonly database: WorkerDatabase, private readonly config: WorkerConfig) {
    this.adapters = new NotificationAdapters(config);
    this.decryptor = new FieldDecryptor(config.FIELD_ENCRYPTION_KEY_BASE64);
    this.media = new MediaProcessor(database, config);
  }

  async dispatchOutbox(): Promise<JobResult> {
    let processed = 0;
    for (let index = 0; index < this.config.WORKER_BATCH_SIZE; index += 1) {
      const handled = await this.database.transaction(async (client) => {
        const claimed = await client.query<OutboxRow>(
          `SELECT event_id, aggregate, aggregate_id, type, payload, attempt_count
           FROM sync.outbox_events
           WHERE published_at IS NULL AND available_at <= clock_timestamp()
             AND (locked_at IS NULL OR locked_at < clock_timestamp() - interval '5 minutes')
           ORDER BY created_at, event_id
           FOR UPDATE SKIP LOCKED LIMIT 1`,
        );
        const event = claimed.rows[0];
        if (!event) return false;
        await client.query(
          `UPDATE sync.outbox_events SET locked_at = clock_timestamp(), locked_by = $2,
             attempt_count = attempt_count + 1 WHERE event_id = $1`,
          [event.event_id, this.config.WORKER_ID],
        );
        try {
          await this.handleOutboxEvent(client, event);
          await client.query(
            `UPDATE sync.outbox_events SET published_at = clock_timestamp(), locked_at = NULL,
               locked_by = NULL, last_error = NULL WHERE event_id = $1`,
            [event.event_id],
          );
        } catch (error) {
          const message = error instanceof Error ? error.message.slice(0, 1_000) : 'unknown worker error';
          const attempts = event.attempt_count + 1;
          if (attempts >= this.config.OUTBOX_MAX_ATTEMPTS) {
            await client.query(
              `INSERT INTO sync.dead_letter_events(
                 outbox_event_id, aggregate, aggregate_id, type, payload, attempt_count, last_error
               ) VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (outbox_event_id) DO UPDATE SET
                 attempt_count = EXCLUDED.attempt_count, last_error = EXCLUDED.last_error,
                 failed_at = clock_timestamp()`,
              [event.event_id, event.aggregate, event.aggregate_id, event.type, event.payload, attempts, message],
            );
            await client.query(
              `UPDATE sync.outbox_events SET published_at = clock_timestamp(), locked_at = NULL,
                 locked_by = NULL, last_error = $2 WHERE event_id = $1`,
              [event.event_id, `DLQ: ${message}`],
            );
          } else {
            const delay = Math.min(3_600, 2 ** Math.min(attempts, 11));
            await client.query(
              `UPDATE sync.outbox_events SET locked_at = NULL, locked_by = NULL, last_error = $2,
                 available_at = clock_timestamp() + make_interval(secs => $3)
               WHERE event_id = $1`,
              [event.event_id, message, delay],
            );
          }
        }
        return true;
      });
      if (!handled) break;
      processed += 1;
    }
    return { processed };
  }

  async orchestrateNotifications(): Promise<JobResult> {
    const result = await this.database.transaction(async (client) => {
      const runtime = await this.loadNotificationConfig(client);
      const rows = await client.query<{ id: string; user_id: string; type: string; resource_public_id: string | null }>(
        `SELECT n.id, n.user_id, n.type, n.resource_public_id FROM notification.notifications n
         WHERE NOT EXISTS (SELECT 1 FROM notification.deliveries d WHERE d.notification_id = n.id)
         ORDER BY n.created_at FOR UPDATE OF n SKIP LOCKED LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const row of rows.rows) {
        const policy: NotificationTypePolicy = {
          ...DEFAULT_NOTIFICATION_TYPE_POLICY,
          ...NOTIFICATION_TYPE_POLICIES[row.type],
          ...runtime.typePolicies[row.type],
        };
        const preference = await client.query<{
          in_app: boolean; push: boolean; email: boolean;
          quiet_start: string | null; quiet_end: string | null; now_jst: string;
        }>(
          `SELECT COALESCE(p.in_app, true) AS in_app, COALESCE(p.push, true) AS push,
             COALESCE(p.email, false) AS email,
             to_char(lower(p.quiet_hours) AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') AS quiet_start,
             to_char(upper(p.quiet_hours) AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') AS quiet_end,
             to_char(clock_timestamp() AT TIME ZONE 'Asia/Tokyo', 'HH24:MI') AS now_jst
           FROM (SELECT 1) seed
           LEFT JOIN notification.preferences p ON p.user_id = $1 AND p.notification_type = $2`,
          [row.user_id, row.type],
        );
        const pref = preference.rows[0] ?? {
          in_app: true, push: true, email: false, quiet_start: null, quiet_end: null, now_jst: '',
        };
        const quietStart = pref.quiet_start ?? runtime.quietStart;
        const quietEnd = pref.quiet_end ?? runtime.quietEnd;
        const quietNow = isWithinQuietWindow(pref.now_jst, quietStart, quietEnd);

        // 站内通知始终保留 — the in-app channel is always delivered.
        const queued: NotificationChannel[] = ['in_app'];
        const suppressed: Array<{ channel: NotificationChannel; reason: string }> = [];

        if (policy.push) {
          const pushAllowed = policy.closable ? pref.push : true;
          if (!pushAllowed) {
            // User opted out of a closable push type; in-app already retains the notice.
          } else if (quietNow && !policy.bypassQuiet) {
            suppressed.push({ channel: 'push', reason: 'QUIET_HOURS' });
          } else if (
            policy.frequencyCapped &&
            (await this.overAnnouncementCap(client, row, runtime.announcementDailyCap))
          ) {
            suppressed.push({ channel: 'push', reason: 'FREQUENCY_CAPPED' });
          } else {
            queued.push('push');
          }
        }

        if (policy.email) {
          // Email carries important service notices and is not gated by the quiet window.
          const emailAllowed = policy.closable ? pref.email : true;
          if (emailAllowed) queued.push('email');
        }

        for (const channel of queued) {
          await client.query(
            `INSERT INTO notification.deliveries(notification_id, channel)
             VALUES ($1,$2) ON CONFLICT (notification_id, channel) DO NOTHING`,
            [row.id, channel],
          );
        }
        for (const entry of suppressed) {
          await client.query(
            `INSERT INTO notification.deliveries(notification_id, channel, state, last_error_code)
             VALUES ($1,$2,'suppressed',$3)
             ON CONFLICT (notification_id, channel) DO NOTHING`,
            [row.id, entry.channel, entry.reason],
          );
        }
      }
      return rows.rowCount ?? 0;
    });
    return { processed: result };
  }

  private async loadNotificationConfig(client: PoolClient): Promise<NotificationRuntimeConfig> {
    const rows = await client.query<{ key: string; value_json: unknown }>(
      `SELECT key, value_json FROM admin.config_revisions
       WHERE key = ANY($1::text[]) AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY key, version DESC`,
      [['notification.quiet_hours', 'notification.frequency.announcement_daily', 'notification.type_policies']],
    );
    const values = new Map<string, unknown>();
    for (const row of rows.rows) if (!values.has(row.key)) values.set(row.key, row.value_json);

    const [rawStart, rawEnd] = this.parseQuietWindow(values.get('notification.quiet_hours'));
    const capValue = values.get('notification.frequency.announcement_daily');
    const cap = typeof capValue === 'number' && Number.isInteger(capValue) && capValue >= 0
      ? capValue
      : DEFAULT_ANNOUNCEMENT_DAILY_CAP;
    const overrides = values.get('notification.type_policies');
    const typePolicies = overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? (overrides as Record<string, Partial<NotificationTypePolicy>>)
      : {};

    return { quietStart: rawStart, quietEnd: rawEnd, announcementDailyCap: cap, typePolicies };
  }

  private parseQuietWindow(value: unknown): [string, string] {
    if (typeof value === 'string') {
      const [start, end] = value.replace(/[‒-―−]/g, '-').split('-');
      return [
        normalizeTimeOfDay(start, DEFAULT_QUIET_START),
        normalizeTimeOfDay(end, DEFAULT_QUIET_END),
      ];
    }
    return [DEFAULT_QUIET_START, DEFAULT_QUIET_END];
  }

  private async overAnnouncementCap(
    client: PoolClient,
    row: { user_id: string; type: string; resource_public_id: string | null },
    cap: number,
  ): Promise<boolean> {
    if (!row.resource_public_id) return false;
    const result = await client.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM notification.notifications n
       WHERE n.user_id = $1 AND n.type = $2 AND n.resource_public_id = $3
         AND (n.created_at AT TIME ZONE 'Asia/Tokyo')::date
             = (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date`,
      [row.user_id, row.type, row.resource_public_id],
    );
    return Number(result.rows[0]?.c ?? 0) > cap;
  }

  async deliverNotifications(): Promise<JobResult> {
    let processed = 0;
    for (let index = 0; index < this.config.WORKER_BATCH_SIZE; index += 1) {
      const delivery = await this.claimDelivery();
      if (!delivery) break;
      await this.deliverOne(delivery);
      processed += 1;
    }
    return { processed };
  }

  async processMediaAssets(): Promise<JobResult> {
    const result = await this.media.processAssets(this.config.WORKER_BATCH_SIZE);
    return { processed: result.processed, metadata: { ready: result.ready, rejected: result.rejected } };
  }

  async renderPosterJobs(): Promise<JobResult> {
    const result = await this.media.renderPosters(this.config.WORKER_BATCH_SIZE);
    return { processed: result.processed, metadata: { ready: result.ready, failed: result.failed } };
  }

  async fanoutAnnouncements(): Promise<JobResult> {
    return this.database.transaction(async (client) => {
      const announcement = await client.query<{
        id: string; group_id: string; author_id: string; title: string; body: string; group_name: string;
      }>(
        `SELECT a.id, a.group_id, a.author_id, a.title, a.body, g.name AS group_name
         FROM community.announcements a JOIN community.groups g ON g.id = a.group_id
         WHERE a.deleted_at IS NULL AND g.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM notification.fanout_receipts f
             WHERE f.source_type = 'group.announcement' AND f.source_id = a.id)
         ORDER BY a.created_at, a.id FOR UPDATE OF a SKIP LOCKED LIMIT 1`,
      );
      const row = announcement.rows[0];
      if (!row) return { processed: 0 };
      const recipients = await client.query<{ user_id: string }>(
        `SELECT user_id FROM community.group_memberships
         WHERE group_id = $1 AND status = 'active' AND user_id <> $2`,
        [row.group_id, row.author_id],
      );
      let inserted = 0;
      for (const recipient of recipients.rows) {
        if (await this.createNotification(
          client,
          recipient.user_id,
          'group.announcement',
          'group',
          row.group_id,
          {
            groupId: row.group_id,
            announcementId: row.id,
            groupName: row.group_name,
            announcementTitle: row.title,
            body: row.body,
          },
          `announcement:${row.id}`,
        )) inserted += 1;
      }
      await client.query(
        `INSERT INTO notification.fanout_receipts(source_type,source_id,recipient_count)
         VALUES ('group.announcement',$1,$2) ON CONFLICT DO NOTHING`,
        [row.id, inserted],
      );
      return { processed: 1, metadata: { notifications: inserted } };
    });
  }

  async scheduleEventReminders(): Promise<JobResult> {
    return this.database.transaction(async (client) => {
      const due = await client.query<{
        registration_id: string; user_id: string; event_id: string; title: string;
        starts_at: Date; public_area: string | null; phase: '24h' | '2h';
      }>(
        `SELECT r.id AS registration_id, r.user_id, e.id AS event_id, e.title, e.starts_at,
           l.public_area, reminder_window.phase
         FROM events.registrations r JOIN events.events e ON e.id = r.event_id
         LEFT JOIN events.event_locations l ON l.event_id = e.id
         CROSS JOIN LATERAL (VALUES
           ('2h'::text, interval '2 hours', interval '0 minutes'),
           ('24h'::text, interval '24 hours', interval '2 hours')
         ) AS reminder_window(phase, upper_bound, lower_bound)
         WHERE r.status = 'confirmed' AND e.status IN ('published','registration_closed')
           AND e.starts_at <= clock_timestamp() + reminder_window.upper_bound
           AND e.starts_at > clock_timestamp() + reminder_window.lower_bound
           AND NOT EXISTS (SELECT 1 FROM notification.notifications n
             WHERE n.user_id = r.user_id AND n.type = 'event.reminder.' || reminder_window.phase
               AND n.dedupe_key = 'reminder:' || r.id::text || ':' || reminder_window.phase)
         ORDER BY e.starts_at, r.id, reminder_window.upper_bound
         FOR UPDATE OF r SKIP LOCKED LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      let inserted = 0;
      for (const row of due.rows) {
        if (await this.createNotification(
          client,
          row.user_id,
          `event.reminder.${row.phase}`,
          'event',
          row.event_id,
          {
            eventId: row.event_id,
            registrationId: row.registration_id,
            title: row.title,
            startsAt: row.starts_at.toISOString(),
            publicArea: row.public_area ?? '',
          },
          `reminder:${row.registration_id}:${row.phase}`,
        )) inserted += 1;
      }
      return { processed: inserted, metadata: { due: due.rows.length } };
    });
  }

  async expireAndPromoteWaitlist(): Promise<JobResult> {
    return this.database.transaction(async (client) => {
      const expired = await client.query<{ registration_id: string; event_id: string; party_size: number }>(
        `WITH due AS (
           SELECT p.id, p.registration_id, r.event_id, r.party_size
           FROM events.waitlist_promotions p JOIN events.registrations r ON r.id = p.registration_id
           WHERE p.accepted_at IS NULL AND p.expired_at IS NULL
             AND p.expires_at <= clock_timestamp() AND r.status = 'offered'
           ORDER BY p.expires_at FOR UPDATE OF r SKIP LOCKED LIMIT $1
         ), marked AS (
           UPDATE events.waitlist_promotions p SET expired_at = clock_timestamp()
           FROM due WHERE p.id = due.id
           RETURNING due.registration_id, due.event_id, due.party_size
         )
         UPDATE events.registrations r SET status = 'waitlisted', waitlist_joined_at = COALESCE(waitlist_joined_at, clock_timestamp())
         FROM marked WHERE r.id = marked.registration_id
         RETURNING r.id AS registration_id, r.event_id, marked.party_size`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const row of expired.rows) {
        await client.query(
          `UPDATE events.event_capacity SET offered_count = GREATEST(0, offered_count - $2),
             waitlist_count = waitlist_count + 1, updated_at = clock_timestamp() WHERE event_id = $1`,
          [row.event_id, row.party_size],
        );
      }

      const events = await client.query<{ event_id: string; title: string }>(
        `SELECT c.event_id, e.title FROM events.event_capacity c JOIN events.events e ON e.id = c.event_id
         WHERE e.status = 'published' AND c.confirmed_count + c.pending_count + c.offered_count < e.capacity
           AND EXISTS (SELECT 1 FROM events.registrations r WHERE r.event_id = c.event_id AND r.status = 'waitlisted')
         ORDER BY c.updated_at LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      let promoted = 0;
      for (const event of events.rows) {
        const registration = await client.query<{ id: string; user_id: string; party_size: number }>(
          `SELECT r.id, r.user_id, r.party_size FROM events.registrations r
           JOIN events.events e ON e.id = r.event_id
           JOIN events.event_capacity c ON c.event_id = r.event_id
           WHERE r.event_id = $1 AND r.status = 'waitlisted'
             AND c.confirmed_count + c.pending_count + c.offered_count + r.party_size <= e.capacity
           ORDER BY r.waitlist_joined_at, r.id FOR UPDATE OF r SKIP LOCKED LIMIT 1`,
          [event.event_id],
        );
        const row = registration.rows[0];
        if (!row) continue;
        const capacity = await client.query<{
          capacity: number;
          confirmed_count: number;
          pending_count: number;
          offered_count: number;
        }>(
          `SELECT e.capacity, c.confirmed_count, c.pending_count, c.offered_count
           FROM events.events e JOIN events.event_capacity c ON c.event_id = e.id
           WHERE e.id = $1 AND e.status = 'published' FOR UPDATE OF c`,
          [event.event_id],
        );
        const lockedCapacity = capacity.rows[0];
        if (
          !lockedCapacity
          || lockedCapacity.confirmed_count + lockedCapacity.pending_count
            + lockedCapacity.offered_count + row.party_size > lockedCapacity.capacity
        ) continue;
        await client.query("UPDATE events.registrations SET status = 'offered' WHERE id = $1", [row.id]);
        const promotion = await client.query<{ id: string; expires_at: Date }>(
          `INSERT INTO events.waitlist_promotions(registration_id, expires_at)
           VALUES ($1, clock_timestamp() + interval '2 hours') RETURNING id, expires_at`,
          [row.id],
        );
        await client.query(
          `UPDATE events.event_capacity SET waitlist_count = GREATEST(0, waitlist_count - 1),
             offered_count = offered_count + $2, updated_at = clock_timestamp() WHERE event_id = $1`,
          [event.event_id, row.party_size],
        );
        await this.createNotification(client, row.user_id, 'waitlist.offered', 'event', event.event_id, {
          eventId: event.event_id,
          registrationId: row.id,
          eventTitle: event.title,
          title: event.title,
          expiresAt: promotion.rows[0]!.expires_at.toISOString(),
          expiresInSeconds: 7_200,
        }, `waitlist-offer:${promotion.rows[0]!.id}`);
        promoted += 1;
      }
      return { processed: expired.rows.length + promoted, metadata: { expired: expired.rows.length, promoted } };
    });
  }

  async expireHoldsAndQuotes(): Promise<JobResult> {
    // A pending registration occupies a seat through `pending_count`, and that
    // seat is only backed by its point hold. Expiring the hold on its own would
    // strand the registration in `pending` forever: the seat would stay inside
    // `occupied = confirmed + pending + offered`, new registrations would hit
    // CAPACITY_FULL, the waitlist could never advance, and the host could not
    // approve because the capture would reject the dead hold. So each lapsed
    // seat is released transactionally before the bulk sweep runs.
    let releasedSeats = 0;
    for (let index = 0; index < this.config.WORKER_BATCH_SIZE; index += 1) {
      const released = await this.database.transaction(
        async (client) => this.releaseLapsedPendingRegistration(client),
      );
      if (!released) break;
      releasedSeats += 1;
    }
    const result = await this.database.query(
      `WITH holds AS (
         UPDATE commerce.point_holds hold SET state = 'expired', updated_at = clock_timestamp()
         WHERE hold.state = 'active' AND hold.expires_at <= clock_timestamp()
           AND NOT EXISTS (
             SELECT 1 FROM events.registrations registration
             WHERE registration.status = 'pending'
               AND registration.user_id = hold.user_id
               AND hold.business_key = 'registration_hold:' || registration.id::text
           )
         RETURNING id
       ), quotes AS (
         DELETE FROM commerce.quotes WHERE consumed_at IS NULL AND expires_at < clock_timestamp() - interval '24 hours'
         RETURNING id
       ) SELECT (SELECT count(*) FROM holds)::int + (SELECT count(*) FROM quotes)::int AS processed`,
    );
    const swept = Number((result.rows[0] as { processed?: number } | undefined)?.processed ?? 0);
    return { processed: swept + releasedSeats, metadata: { releasedSeats, swept } };
  }

  /**
   * Releases a single seat whose pending registration hold has lapsed, or
   * returns false when nothing is due.
   *
   * Locks are taken registration -> event/capacity -> hold, matching the order
   * used by the approval path, so the job can never deadlock against a host
   * decision. Exactly-once progress comes from the database itself: the hold
   * and the registration both move through conditional updates, so a second
   * worker racing the same row updates nothing and leaves the counter alone.
   */
  private async releaseLapsedPendingRegistration(client: PoolClient): Promise<boolean> {
    const due = await client.query<{
      registration_id: string;
      event_id: string;
      user_id: string;
      party_size: number;
      hold_id: string;
      title: string;
    }>(
      `SELECT registration.id AS registration_id, registration.event_id, registration.user_id,
         registration.party_size, hold.id AS hold_id, event.title
       FROM events.registrations registration
       JOIN commerce.point_holds hold ON hold.user_id = registration.user_id
         AND hold.business_key = 'registration_hold:' || registration.id::text
       JOIN events.events event ON event.id = registration.event_id
       WHERE registration.status = 'pending'
         AND hold.state = 'active' AND hold.expires_at <= clock_timestamp()
       ORDER BY hold.expires_at, registration.id
       FOR UPDATE OF registration SKIP LOCKED LIMIT 1`,
    );
    const row = due.rows[0];
    if (!row) return false;
    await client.query(
      `SELECT capacity.event_id FROM events.events event
       JOIN events.event_capacity capacity ON capacity.event_id = event.id
       WHERE event.id = $1 FOR UPDATE OF event, capacity`,
      [row.event_id],
    );
    const claimedHold = await client.query(
      `UPDATE commerce.point_holds SET state = 'expired', updated_at = clock_timestamp()
       WHERE id = $1 AND state = 'active' RETURNING id`,
      [row.hold_id],
    );
    if (!claimedHold.rowCount) return false;
    // `cancelled` is the terminal state the 12.2 machine allows out of pending
    // for a seat nobody decided on: `rejected` would falsely record a host
    // decision, and it is the same state a user cancellation of a pending
    // registration produces, so the capacity accounting stays identical.
    const claimedRegistration = await client.query(
      `UPDATE events.registrations SET status = 'cancelled', cancelled_at = clock_timestamp()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [row.registration_id],
    );
    if (!claimedRegistration.rowCount) return false;
    await client.query(
      `UPDATE events.event_capacity SET pending_count = GREATEST(0, pending_count - $2),
         updated_at = clock_timestamp() WHERE event_id = $1`,
      [row.event_id, row.party_size],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('event', $1, 'waitlist.promotion_requested', $2)`,
      [row.event_id, { eventId: row.event_id }],
    );
    // The hold only reserved points, it never spent them, so the applicant has
    // nothing to refund: the seat simply went back to the event.
    await this.createNotification(client, row.user_id, 'registration.hold_expired', 'event', row.event_id, {
      eventId: row.event_id,
      registrationId: row.registration_id,
      eventTitle: row.title,
      title: row.title,
    }, `registration-hold-expired:${row.registration_id}`);
    return true;
  }

  async expireFreePointLots(): Promise<JobResult> {
    let processed = 0;
    for (let index = 0; index < this.config.WORKER_BATCH_SIZE; index += 1) {
      const didExpire = await this.database.transaction(async (client) => {
        const lotResult = await client.query<{ id: string; user_id: string; remaining: string }>(
          `SELECT entry.id, tx.user_id,
             (entry.amount + COALESCE((SELECT sum(spend.amount) FROM commerce.point_entries spend
               WHERE spend.source_lot_id = entry.id),0))::text AS remaining
           FROM commerce.point_entries entry
           JOIN commerce.point_transactions tx ON tx.id = entry.transaction_id
           WHERE entry.bucket = 'free' AND entry.amount > 0 AND entry.expires_at <= clock_timestamp()
             AND entry.amount + COALESCE((SELECT sum(spend.amount) FROM commerce.point_entries spend
               WHERE spend.source_lot_id = entry.id),0) > 0
             AND NOT EXISTS (SELECT 1 FROM commerce.point_transactions expiry
               WHERE expiry.user_id = tx.user_id AND expiry.business_key = 'free_expiry:' || entry.id::text)
           ORDER BY entry.expires_at, entry.id FOR UPDATE OF entry SKIP LOCKED LIMIT 1`,
        );
        const lot = lotResult.rows[0];
        if (!lot) return false;
        await client.query('SELECT user_id FROM commerce.wallets WHERE user_id = $1 FOR UPDATE', [lot.user_id]);
        const transaction = await client.query<{ id: string }>(
          `INSERT INTO commerce.point_transactions(user_id, type, business_key, status, metadata, posted_at)
           VALUES ($1,'free_points_expired',$2,'posted',$3,clock_timestamp()) RETURNING id`,
          [lot.user_id, `free_expiry:${lot.id}`, { sourceLotId: lot.id }],
        );
        const transactionId = transaction.rows[0]!.id;
        await client.query(
          `INSERT INTO commerce.point_entries(transaction_id, account_code, bucket, amount, source_lot_id)
           VALUES ($1,$2,'free',$3,$4),($1,'platform:expired_points','free',$5,NULL)`,
          [transactionId, `user:${lot.user_id}`, `-${lot.remaining}`, lot.id, lot.remaining],
        );
        await client.query('UPDATE commerce.wallets SET free_balance = free_balance - $2 WHERE user_id = $1', [
          lot.user_id,
          lot.remaining,
        ]);
        return true;
      });
      if (!didExpire) break;
      processed += 1;
    }
    return { processed };
  }

  /**
   * Takes expired activity promotions offline. Reaching the paid window's end is
   * normal completion, not a fault, so no ledger movement happens here — only a
   * takedown or platform fault refunds points (handled on the API side). The
   * partial unique index guarantees at most one active promotion per event, so
   * flipping the row to `expired` frees the event to be promoted again.
   */
  async expireEventPromotions(): Promise<JobResult> {
    const result = await this.database.query(
      `UPDATE commerce.event_promotions
       SET state = 'expired', updated_at = clock_timestamp()
       WHERE state = 'active' AND expires_at <= clock_timestamp()`,
    );
    const expired = result.rowCount ?? 0;
    return { processed: expired, metadata: { expired } };
  }

  async activateConfiguration(): Promise<JobResult> {
    return this.database.transaction(async (client) => {
      const ready = await client.query<{ id: string; key: string }>(
        `SELECT id, key FROM admin.config_revisions
         WHERE state = 'approved' AND (effective_from IS NULL OR effective_from <= clock_timestamp())
           AND (effective_to IS NULL OR effective_to > clock_timestamp())
         ORDER BY key, version FOR UPDATE SKIP LOCKED LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const revision of ready.rows) {
        await client.query(
          `UPDATE admin.config_revisions SET state = 'superseded'
           WHERE key = $1 AND state = 'active' AND id <> $2`,
          [revision.key, revision.id],
        );
        await client.query("UPDATE admin.config_revisions SET state = 'active' WHERE id = $1", [revision.id]);
      }
      await client.query(
        `UPDATE admin.config_revisions SET state = 'superseded'
         WHERE state = 'active' AND effective_to IS NOT NULL AND effective_to <= clock_timestamp()`,
      );
      return { processed: ready.rows.length };
    });
  }

  async anonymizeDeletedAccounts(): Promise<JobResult> {
    const result = await this.database.transaction(async (client) => {
      const users = await client.query<{ id: string }>(
        `SELECT id FROM identity.users
         WHERE status = 'deletion_pending' AND deletion_execute_after <= clock_timestamp()
           AND NOT EXISTS (SELECT 1 FROM events.events e WHERE e.organizer_id = identity.users.id
             AND e.status IN ('draft','pending_review','needs_changes','published','registration_closed','in_progress'))
           AND NOT EXISTS (SELECT 1 FROM community.groups g WHERE g.owner_id = identity.users.id AND g.deleted_at IS NULL)
           AND NOT EXISTS (SELECT 1 FROM safety.reports r WHERE r.reporter_id = identity.users.id AND r.status IN ('open','claimed','appealed'))
           AND COALESCE((SELECT paid_balance FROM commerce.wallets w WHERE w.user_id = identity.users.id),0) >= 0
         ORDER BY deletion_execute_after FOR UPDATE SKIP LOCKED LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const user of users.rows) {
        await client.query('DELETE FROM identity.auth_identities WHERE user_id = $1', [user.id]);
        await client.query('DELETE FROM identity.phone_bindings WHERE user_id = $1', [user.id]);
        await client.query(
          `UPDATE identity.profiles SET nickname = '已注销用户', bio = '', avatar_asset_id = NULL,
             region_id = NULL WHERE user_id = $1`,
          [user.id],
        );
        await client.query(
          `UPDATE identity.users SET status = 'anonymized', public_handle = 'deleted_' || replace(id::text,'-',''),
             phone_verified_at = NULL, deleted_at = clock_timestamp(), restriction_flags = '{}' WHERE id = $1`,
          [user.id],
        );
      }
      return users.rowCount ?? 0;
    });
    return { processed: result };
  }

  async reconcileLedger(): Promise<JobResult> {
    return this.database.transaction(async (client) => {
      const imbalances = await client.query<{ id: string; imbalance: string }>(
        `SELECT tx.id, sum(entry.amount)::text AS imbalance
         FROM commerce.point_transactions tx JOIN commerce.point_entries entry ON entry.transaction_id = tx.id
         GROUP BY tx.id HAVING sum(entry.amount) <> 0 LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const row of imbalances.rows) {
        await this.upsertReconciliation(client, 'ledger_imbalance', 'p0', row.id, row);
      }
      const wallets = await client.query<{ user_id: string; paid_balance: string; free_balance: string; expected_paid: string; expected_free: string }>(
        `SELECT w.user_id, w.paid_balance::text, w.free_balance::text,
           COALESCE(sum(e.amount) FILTER (WHERE e.bucket = 'paid' AND e.account_code = 'user:' || w.user_id::text),0)::text AS expected_paid,
           COALESCE(sum(e.amount) FILTER (WHERE e.bucket = 'free' AND e.account_code = 'user:' || w.user_id::text),0)::text AS expected_free
         FROM commerce.wallets w LEFT JOIN commerce.point_transactions tx ON tx.user_id = w.user_id AND tx.status = 'posted'
         LEFT JOIN commerce.point_entries e ON e.transaction_id = tx.id
         GROUP BY w.user_id, w.paid_balance, w.free_balance
         HAVING w.paid_balance <> COALESCE(sum(e.amount) FILTER (WHERE e.bucket = 'paid' AND e.account_code = 'user:' || w.user_id::text),0)
           OR w.free_balance <> COALESCE(sum(e.amount) FILTER (WHERE e.bucket = 'free' AND e.account_code = 'user:' || w.user_id::text),0)
         LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const row of wallets.rows) {
        await this.upsertReconciliation(client, 'wallet_mismatch', 'p0', row.user_id, row);
      }
      const deliveries = await client.query<{ channel: string; backlog: string; oldest: Date }>(
        `SELECT channel, count(*)::text AS backlog, min(created_at) AS oldest
         FROM notification.deliveries
         WHERE (state = 'failed' AND attempts >= 8)
           OR (state IN ('queued','sending') AND created_at < clock_timestamp() - interval '15 minutes')
         GROUP BY channel LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const row of deliveries.rows) {
        await this.upsertReconciliation(client, 'delivery_backlog', 'p1', row.channel, {
          channel: row.channel,
          backlog: Number(row.backlog),
          oldest: row.oldest.toISOString(),
        });
      }
      return {
        processed: imbalances.rows.length + wallets.rows.length + deliveries.rows.length,
        metadata: {
          imbalances: imbalances.rows.length,
          walletMismatches: wallets.rows.length,
          deliveryBacklogs: deliveries.rows.length,
        },
      };
    });
  }

  private async claimDelivery(): Promise<DeliveryRow | null> {
    return this.database.transaction(async (client) => {
      const result = await client.query<DeliveryRow>(
        `SELECT d.id, d.channel, d.notification_id, d.attempts, n.user_id, n.type,
           n.template_version, n.payload_ref, n.resource_public_id
         FROM notification.deliveries d JOIN notification.notifications n ON n.id = d.notification_id
         WHERE d.state IN ('queued','failed','sending') AND d.available_at <= clock_timestamp()
           AND d.attempts < 8
         ORDER BY d.available_at, d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query(
        `UPDATE notification.deliveries SET state = 'sending', attempts = attempts + 1,
           available_at = clock_timestamp() + interval '5 minutes' WHERE id = $1`,
        [row.id],
      );
      return row;
    });
  }

  private async deliverOne(delivery: DeliveryRow): Promise<void> {
    if (delivery.channel === 'in_app') {
      await this.database.query(
        `UPDATE notification.deliveries SET state = 'delivered', provider_id = $2,
           delivered_at = clock_timestamp(), last_error_code = NULL WHERE id = $1`,
        [delivery.id, `in_app:${delivery.notification_id}`],
      );
      return;
    }
    if (delivery.channel === 'sms') {
      await this.suppressDelivery(delivery.id, 'SMS_PROVIDER_NOT_CONFIGURED');
      return;
    }

    try {
      const localeResult = await this.database.query<{ locale: string }>(
        `SELECT COALESCE(
           (SELECT locale FROM notification.preferences WHERE user_id = $1 AND notification_type = $2),
           (SELECT source_language FROM identity.profiles WHERE user_id = $1), 'zh-Hans'
         ) AS locale`,
        [delivery.user_id, delivery.type],
      );
      const locale = localeResult.rows[0]?.locale ?? 'zh-Hans';
      const templateResult = await this.database.query<{ title_template: string; body_template: string }>(
        `SELECT title_template, body_template FROM notification.templates
         WHERE type = $1 AND locale = $2 AND version = $3 AND active LIMIT 1`,
        [delivery.type, locale, delivery.template_version],
      );
      const template = templateResult.rows[0];
      const copy = resolveCopy(
        delivery.type,
        locale,
        delivery.payload_ref,
        template ? { title: template.title_template, body: template.body_template } : undefined,
      );
      let outcome;
      if (delivery.channel === 'email') {
        const email = await this.database.query<{ email_cipher: Buffer }>(
          `SELECT email_cipher FROM identity.auth_identities
           WHERE user_id = $1 AND email_cipher IS NOT NULL ORDER BY last_used_at DESC LIMIT 1`,
          [delivery.user_id],
        );
        const recipient = email.rows[0] ? this.decryptor.decrypt(email.rows[0].email_cipher) : undefined;
        outcome = await this.adapters.email(delivery.id, recipient, copy);
      } else {
        const tokens = await this.database.query<{ id: string; token_cipher: Buffer; environment: 'sandbox' | 'production' }>(
          `SELECT id, token_cipher, environment FROM notification.device_tokens
           WHERE user_id = $1 AND platform = 'ios' AND disabled_at IS NULL ORDER BY last_seen_at DESC`,
          [delivery.user_id],
        );
        const targets: PushTarget[] = tokens.rows.flatMap((row) => {
          try { return [{ id: row.id, token: this.decryptor.decrypt(row.token_cipher), environment: row.environment }]; }
          catch { return []; }
        });
        const deepLink = notificationDeepLink(delivery.type, delivery.resource_public_id);
        outcome = await this.adapters.push(delivery.id, targets, copy, {
          notificationId: delivery.notification_id,
          type: delivery.type,
          ...delivery.payload_ref,
          ...(deepLink ? { deepLink } : {}),
        });
      }
      if (outcome.invalidTargetIds?.length) await this.disableDeviceTargets(outcome.invalidTargetIds, 'provider_rejected');
      if (outcome.suppressedCode) {
        await this.suppressDelivery(delivery.id, outcome.suppressedCode);
        return;
      }
      if (!outcome.providerId) throw new DeliveryFailure('PROVIDER_ID_MISSING', true);
      await this.database.query(
        `UPDATE notification.deliveries SET state = 'delivered', provider_id = $2,
           delivered_at = clock_timestamp(), last_error_code = NULL WHERE id = $1`,
        [delivery.id, outcome.providerId],
      );
    } catch (error) {
      const failure = error instanceof DeliveryFailure
        ? error
        : new DeliveryFailure(error instanceof Error ? error.name.toUpperCase() : 'DELIVERY_FAILED', true);
      if (failure.invalidTargetIds.length) await this.disableDeviceTargets(failure.invalidTargetIds, failure.code);
      const attempts = delivery.attempts + 1;
      if (!failure.retryable) {
        await this.suppressDelivery(delivery.id, failure.code);
      } else {
        const delay = Math.min(3_600, 2 ** Math.min(attempts, 11));
        await this.database.query(
          `UPDATE notification.deliveries SET state = 'failed', last_error_code = $2,
             available_at = clock_timestamp() + make_interval(secs => $3) WHERE id = $1`,
          [delivery.id, failure.code.slice(0, 120), delay],
        );
      }
    }
  }

  private suppressDelivery(id: string, code: string): Promise<unknown> {
    return this.database.query(
      `UPDATE notification.deliveries SET state = 'suppressed', last_error_code = $2 WHERE id = $1`,
      [id, code.slice(0, 120)],
    );
  }

  private disableDeviceTargets(ids: string[], reason: string): Promise<unknown> {
    return this.database.query(
      `UPDATE notification.device_tokens SET disabled_at = clock_timestamp(), disable_reason = $2
       WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL`,
      [ids, reason.slice(0, 120)],
    );
  }

  private async handleOutboxEvent(client: PoolClient, event: OutboxRow): Promise<void> {
    if (event.type === 'event.registration_refunds_requested') {
      await this.refundCancelledEvent(client, event.aggregate_id);
      return;
    }
    const notificationTypes = new Set([
      'event.cancelled', 'event.key_fields_changed', 'event.reviewed', 'event.removed',
      'registration.changed', 'moderation.decided', 'account.restricted',
      'group.dissolution_scheduled', 'achievements.awarded',
    ]);
    if (notificationTypes.has(event.type)) {
      const users = await this.notificationRecipients(client, event);
      const payload = await this.enrichNotificationPayload(client, event);
      for (const userId of users) {
        await this.createNotification(
          client,
          userId,
          event.type,
          event.aggregate,
          event.aggregate_id,
          payload,
          `outbox:${event.event_id}`,
        );
      }
    }
    // CDN purge, analytics and realtime publication are provider adapters in production.
    // Persisting published_at is the durable handoff boundary for those idempotent adapters.
  }

  private async notificationRecipients(client: PoolClient, event: OutboxRow): Promise<string[]> {
    if (event.aggregate === 'event') {
      const result = await client.query<{ user_id: string }>(
        `SELECT organizer_id AS user_id FROM events.events WHERE id = $1
         UNION SELECT user_id FROM events.registrations WHERE event_id = $1
           AND status IN ('pending','confirmed','waitlisted','offered','checked_in','event_cancelled')`,
        [event.aggregate_id],
      );
      return result.rows.map((row) => row.user_id);
    }
    if (event.aggregate === 'registration') {
      const result = await client.query<{ user_id: string }>(
        'SELECT user_id FROM events.registrations WHERE id = $1',
        [event.aggregate_id],
      );
      return result.rows.map((row) => row.user_id);
    }
    if (event.aggregate === 'group') {
      const result = await client.query<{ user_id: string }>(
        `SELECT user_id FROM community.group_memberships
         WHERE group_id = $1 AND status = 'active'`,
        [event.aggregate_id],
      );
      return result.rows.map((row) => row.user_id);
    }
    if (event.aggregate === 'user') return [event.aggregate_id];
    if (event.aggregate === 'safety.case') {
      const result = await client.query<{ user_id: string }>(
        `SELECT r.reporter_id AS user_id FROM safety.moderation_cases c
         JOIN safety.reports r ON r.id = c.report_id WHERE c.id = $1
         UNION
         SELECT r.target_id AS user_id FROM safety.moderation_cases c
         JOIN safety.reports r ON r.id = c.report_id
         WHERE c.id = $1 AND r.target_type = 'user'`,
        [event.aggregate_id],
      );
      return result.rows.map((row) => row.user_id);
    }
    return [];
  }

  private async enrichNotificationPayload(
    client: PoolClient,
    event: OutboxRow,
  ): Promise<Record<string, unknown>> {
    if (event.aggregate === 'event') {
      const resource = await client.query<{ title: string }>('SELECT title FROM events.events WHERE id = $1', [event.aggregate_id]);
      const title = resource.rows[0]?.title;
      return title ? { ...event.payload, eventTitle: title, title } : event.payload;
    }
    if (event.aggregate === 'registration') {
      const resource = await client.query<{ title: string; event_id: string }>(
        `SELECT e.title, e.id AS event_id FROM events.registrations r
         JOIN events.events e ON e.id = r.event_id WHERE r.id = $1`,
        [event.aggregate_id],
      );
      const row = resource.rows[0];
      return row ? { ...event.payload, eventId: row.event_id, eventTitle: row.title, title: row.title } : event.payload;
    }
    if (event.aggregate === 'group') {
      const resource = await client.query<{ name: string }>('SELECT name FROM community.groups WHERE id = $1', [event.aggregate_id]);
      const name = resource.rows[0]?.name;
      return name ? { ...event.payload, groupName: name } : event.payload;
    }
    return event.payload;
  }

  private async createNotification(
    client: PoolClient,
    userId: string,
    type: string,
    resourceType: string,
    publicId: string,
    payload: Record<string, unknown>,
    dedupeKey = `${type}:${publicId}`,
  ): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO notification.notifications(
         user_id, type, template_version, payload_ref, resource_type, resource_public_id, dedupe_key
       ) VALUES ($1,$2,COALESCE((SELECT max(version) FROM notification.templates WHERE type = $2 AND active),1),$3,$4,$5,$6)
       ON CONFLICT (user_id,type,dedupe_key) DO NOTHING`,
      [userId, type, { ...payload, dedupeKey }, resourceType, publicId, dedupeKey],
    );
    return Boolean(result.rowCount);
  }

  private async refundCancelledEvent(client: PoolClient, eventId: string): Promise<void> {
    const charges = await client.query<{ transaction_id: string; user_id: string; registration_id: string }>(
      `SELECT tx.id AS transaction_id, tx.user_id, r.id AS registration_id
       FROM events.registrations r JOIN commerce.point_transactions tx
         ON tx.user_id = r.user_id AND tx.business_key = 'registration_fee:' || r.id::text
       WHERE r.event_id = $1 AND r.status = 'event_cancelled' AND tx.status = 'posted'
         AND NOT EXISTS (SELECT 1 FROM commerce.point_transactions refund
           WHERE refund.user_id = tx.user_id AND refund.business_key = 'event_cancel_refund:' || r.id::text)
       FOR UPDATE OF tx SKIP LOCKED`,
      [eventId],
    );
    for (const charge of charges.rows) {
      await client.query('SELECT user_id FROM commerce.wallets WHERE user_id = $1 FOR UPDATE', [charge.user_id]);
      const refund = await client.query<{ id: string }>(
        `INSERT INTO commerce.point_transactions(user_id,type,business_key,status,reversal_of,metadata,posted_at)
         VALUES ($1,'event_cancel_refund',$2,'posted',$3,$4,clock_timestamp()) RETURNING id`,
        [charge.user_id, `event_cancel_refund:${charge.registration_id}`, charge.transaction_id, { eventId }],
      );
      const transactionId = refund.rows[0]!.id;
      const allocations = await client.query<{ bucket: string; amount: string; source_lot_id: string | null }>(
        `SELECT bucket::text, (-sum(amount))::text AS amount, source_lot_id
         FROM commerce.point_entries WHERE transaction_id = $1 AND account_code = 'user:' || $2::text
         GROUP BY bucket, source_lot_id HAVING sum(amount) < 0`,
        [charge.transaction_id, charge.user_id],
      );
      let free = 0n;
      let paid = 0n;
      for (const allocation of allocations.rows) {
        const amount = BigInt(allocation.amount);
        if (allocation.bucket === 'free') free += amount; else paid += amount;
        await client.query(
          `INSERT INTO commerce.point_entries(transaction_id,account_code,bucket,amount,source_lot_id)
           VALUES ($1,$2,$3,$4,$5),($1,'platform:event_refunds',$3,$6,NULL)`,
          [transactionId, `user:${charge.user_id}`, allocation.bucket, amount.toString(), allocation.source_lot_id, (-amount).toString()],
        );
      }
      await client.query(
        `UPDATE commerce.wallets SET free_balance = free_balance + $2, paid_balance = paid_balance + $3 WHERE user_id = $1`,
        [charge.user_id, free.toString(), paid.toString()],
      );
    }
  }

  // Server-authoritative product analytics (docs 15.1-15.3 / product §P). Clients
  // can only self-report the top of each funnel; the trustworthy floor — confirmed
  // registrations, attendance, the North Star and the business-invariant counters —
  // is derived here from the authoritative tables and written back as `server`
  // platform events so the P2 metrics have a real, non-spoofable data source.
  async deriveAnalyticsMetrics(): Promise<JobResult> {
    return this.database.transaction(async (client) => {
      const sessionId = randomUUID();
      const windowDays = await this.activeConfigInt(client, 'analytics.northstar.window_days', 60);
      const outboxDelaySeconds = await this.activeConfigInt(client, 'analytics.invariant.outbox_delay_seconds', 60);

      // This is a periodic snapshot, not an event-driven job. Emitting every worker
      // cycle would make processed always non-zero (the loop never idles) and pile up
      // duplicate snapshot rows. Only run when the configured interval has elapsed
      // since the last snapshot; otherwise report no work so the worker can sleep.
      const snapshotIntervalSeconds = await this.activeConfigInt(
        client,
        'analytics.snapshot_interval_seconds',
        3600,
      );
      const due = await client.query<{ due: boolean }>(
        `SELECT COALESCE(max(occurred_at), 'epoch'::timestamptz)
                  < clock_timestamp() - make_interval(secs => $1) AS due
         FROM analytics.product_events WHERE event_name = 'metrics_northstar_recorded'`,
        [snapshotIntervalSeconds],
      );
      if (!due.rows[0]?.due) return { processed: 0 };
      let emitted = 0;

      // North Star: real users who, after completing an offline activity (a check-in
      // to an event that has ended), participate in or organise another activity
      // within the configured retention window.
      const northStar = await client.query<{ requalified_users: string }>(
        `/* metric:northstar */
         WITH completed AS (
           SELECT c.user_id, e.ends_at
           FROM events.checkins c
           JOIN events.events e ON e.id = c.event_id
           WHERE e.ends_at IS NOT NULL AND e.ends_at < clock_timestamp()
         )
         SELECT count(DISTINCT completed.user_id)::text AS requalified_users
         FROM completed
         WHERE EXISTS (
             SELECT 1 FROM events.registrations later
             WHERE later.user_id = completed.user_id
               AND later.confirmed_at IS NOT NULL
               AND later.confirmed_at > completed.ends_at
               AND later.confirmed_at <= completed.ends_at + make_interval(days => $1)
           )
           OR EXISTS (
             SELECT 1 FROM events.events organised
             WHERE organised.organizer_id = completed.user_id
               AND organised.created_at > completed.ends_at
               AND organised.created_at <= completed.ends_at + make_interval(days => $1)
               AND organised.status IN ('published','registration_closed','in_progress','ended')
           )`,
        [windowDays],
      );
      const requalifiedUsers = Number(northStar.rows[0]?.requalified_users ?? '0');
      await this.emitServerMetric(client, sessionId, 'metrics_northstar_recorded', {
        window_days: windowDays,
        requalified_users: requalifiedUsers,
      });
      emitted += 1;

      // Participant funnel (product §P1): submit → confirm → attend → feedback.
      // Aggregate counters only; no identifiers ride along on server metrics.
      const funnel = await client.query<{
        registrations_submitted: string;
        registrations_confirmed: string;
        attendance_checked_in: string;
        feedback_submitted: string;
      }>(
        `/* metric:funnel_participant */
         SELECT
           count(*) FILTER (
             WHERE status IN ('pending','confirmed','waitlisted','offered','checked_in','no_show','cancelled')
           )::text AS registrations_submitted,
           count(*) FILTER (WHERE confirmed_at IS NOT NULL)::text AS registrations_confirmed,
           count(*) FILTER (WHERE status = 'checked_in')::text AS attendance_checked_in,
           (SELECT count(*) FROM community.feedback)::text AS feedback_submitted
         FROM events.registrations`,
      );
      const funnelRow = funnel.rows[0];
      await this.emitServerMetric(client, sessionId, 'funnel_participant_recorded', {
        registrations_submitted: Number(funnelRow?.registrations_submitted ?? '0'),
        registrations_confirmed: Number(funnelRow?.registrations_confirmed ?? '0'),
        attendance_checked_in: Number(funnelRow?.attendance_checked_in ?? '0'),
        feedback_submitted: Number(funnelRow?.feedback_submitted ?? '0'),
      });
      emitted += 1;

      // Host funnel (product §P1): draft → submit → publish → first registration →
      // completed → repeat host. Aggregate counters only.
      const hostFunnel = await client.query<{
        drafts: string; submitted: string; published: string;
        with_registration: string; completed: string; repeat_hosts: string;
      }>(
        `/* metric:funnel_host */
         SELECT
           count(*) FILTER (WHERE status = 'draft')::text AS drafts,
           count(*) FILTER (WHERE status IN ('pending_review','needs_changes'))::text AS submitted,
           count(*) FILTER (WHERE status IN ('published','registration_closed','in_progress','ended','archived'))::text AS published,
           count(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM events.registrations r WHERE r.event_id = e.id
               AND r.status IN ('confirmed','checked_in')))::text AS with_registration,
           count(*) FILTER (WHERE status IN ('ended','archived'))::text AS completed,
           (SELECT count(*)::text FROM (
             SELECT organizer_id FROM events.events
             WHERE status IN ('published','registration_closed','in_progress','ended','archived')
             GROUP BY organizer_id HAVING count(*) >= 2) repeat) AS repeat_hosts
         FROM events.events e`,
      );
      const hostRow = hostFunnel.rows[0];
      await this.emitServerMetric(client, sessionId, 'funnel_host_recorded', {
        drafts: Number(hostRow?.drafts ?? '0'),
        submitted: Number(hostRow?.submitted ?? '0'),
        published: Number(hostRow?.published ?? '0'),
        with_registration: Number(hostRow?.with_registration ?? '0'),
        completed: Number(hostRow?.completed ?? '0'),
        repeat_hosts: Number(hostRow?.repeat_hosts ?? '0'),
      });
      emitted += 1;

      // Group funnel (product §P1): view → join → active → exit. Views are not
      // server-persisted, so this tracks the joined→active→left lifecycle counts.
      const groupFunnel = await client.query<{
        groups: string; members_joined: string; members_active: string; members_left: string;
      }>(
        `/* metric:funnel_group */
         SELECT
           (SELECT count(*)::text FROM community.groups WHERE status = 'active') AS groups,
           count(*) FILTER (WHERE status = 'active')::text AS members_joined,
           count(*) FILTER (WHERE status = 'active'
             AND joined_at > clock_timestamp() - interval '30 days')::text AS members_active,
           count(*) FILTER (WHERE status IN ('left','removed'))::text AS members_left
         FROM community.group_memberships`,
      );
      const groupRow = groupFunnel.rows[0];
      await this.emitServerMetric(client, sessionId, 'funnel_group_recorded', {
        groups: Number(groupRow?.groups ?? '0'),
        members_joined: Number(groupRow?.members_joined ?? '0'),
        members_active: Number(groupRow?.members_active ?? '0'),
        members_left: Number(groupRow?.members_left ?? '0'),
      });
      emitted += 1;

      // Spread funnel (product §P1): share created → external open → detail →
      // register → check-in. Opens and conversions come from attribution rows.
      const spreadFunnel = await client.query<{
        shares_created: string; opens: string; registered: string; attended: string;
      }>(
        `/* metric:funnel_spread */
         SELECT
           (SELECT count(*)::text FROM growth.share_links) AS shares_created,
           count(*) FILTER (WHERE action = 'opened')::text AS opens,
           count(*) FILTER (WHERE action = 'registered')::text AS registered,
           count(*) FILTER (WHERE action = 'checked_in')::text AS attended
         FROM growth.attributions`,
      );
      const spreadRow = spreadFunnel.rows[0];
      await this.emitServerMetric(client, sessionId, 'funnel_spread_recorded', {
        shares_created: Number(spreadRow?.shares_created ?? '0'),
        opens: Number(spreadRow?.opens ?? '0'),
        registered: Number(spreadRow?.registered ?? '0'),
        attended: Number(spreadRow?.attended ?? '0'),
      });
      emitted += 1;

      // Business invariants (doc 15.3). P0 breaches (oversell, ledger/balance) must be
      // impossible under the DB constraints; a non-zero count means defence-in-depth
      // has caught drift and the value is surfaced as an anomaly for alerting.
      const invariants: Array<{ name: string; severity: 'p0' | 'p1'; sql: string; params: unknown[] }> = [
        {
          name: 'oversell',
          severity: 'p0',
          sql: `/* invariant:oversell */
                SELECT count(*)::text AS count
                FROM events.event_capacity cap
                JOIN events.events e ON e.id = cap.event_id
                WHERE e.capacity IS NOT NULL AND cap.confirmed_count > e.capacity`,
          params: [],
        },
        {
          name: 'duplicate_checkin',
          severity: 'p0',
          sql: `/* invariant:duplicate_checkin */
                SELECT count(*)::text AS count FROM (
                  SELECT event_id, user_id FROM events.checkins
                  GROUP BY event_id, user_id HAVING count(*) > 1
                ) duplicates`,
          params: [],
        },
        {
          name: 'negative_total_balance',
          severity: 'p0',
          sql: `/* invariant:negative_total_balance */
                SELECT count(*)::text AS count FROM commerce.wallets
                WHERE paid_balance + free_balance < 0`,
          params: [],
        },
        {
          name: 'expired_offer',
          severity: 'p1',
          sql: `/* invariant:expired_offer */
                SELECT count(*)::text AS count FROM events.waitlist_promotions
                WHERE accepted_at IS NULL AND expired_at IS NULL
                  AND expires_at < clock_timestamp()`,
          params: [],
        },
        {
          name: 'outbox_delay',
          severity: 'p1',
          sql: `/* invariant:outbox_delay */
                SELECT count(*)::text AS count FROM sync.outbox_events
                WHERE published_at IS NULL
                  AND available_at < clock_timestamp() - make_interval(secs => $1)`,
          params: [outboxDelaySeconds],
        },
        {
          name: 'sync_cursor_error',
          severity: 'p1',
          sql: `/* invariant:sync_cursor_error */
                SELECT count(*)::text AS count FROM sync.device_cursors dc
                WHERE dc.cursor > (SELECT COALESCE(max(seq), 0) FROM sync.change_log)`,
          params: [],
        },
      ];

      let invariantsFlagged = 0;
      let p0Breaches = 0;
      for (const invariant of invariants) {
        const row = await client.query<{ count: string }>(invariant.sql, invariant.params);
        const count = Number(row.rows[0]?.count ?? '0');
        if (count > 0) {
          invariantsFlagged += 1;
          if (invariant.severity === 'p0') p0Breaches += 1;
        }
        await this.emitServerMetric(client, sessionId, 'invariant_metric_recorded', {
          invariant: invariant.name,
          severity: invariant.severity,
          count,
        });
        emitted += 1;
      }

      return {
        processed: emitted,
        metadata: { requalifiedUsers, windowDays, invariantsFlagged, p0Breaches },
      };
    });
  }

  private async emitServerMetric(
    client: PoolClient,
    sessionId: string,
    eventName: string,
    properties: Record<string, number | string | boolean>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO analytics.product_events(
         event_name, schema_version, anonymous_id, user_id, session_id,
         platform, properties, trace_id, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,clock_timestamp())`,
      [eventName, 1, null, null, sessionId, 'server', properties, `worker:${sessionId}`],
    );
  }

  private async activeConfigInt(client: PoolClient, key: string, fallback: number): Promise<number> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = $1 AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
      [key],
    );
    const value = result.rows[0]?.value_json;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    if (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) return Number(value);
    return fallback;
  }

  private async upsertReconciliation(
    client: PoolClient,
    kind: string,
    severity: string,
    fingerprint: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO admin.reconciliation_cases(kind,severity,fingerprint,details)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (kind,fingerprint) DO UPDATE SET details = EXCLUDED.details,
         last_detected_at = clock_timestamp(), state = 'open', resolved_at = NULL`,
      [kind, severity, fingerprint, details],
    );
  }
}

export const jobNames = [
  'dispatchOutbox',
  'processMediaAssets',
  'renderPosterJobs',
  'fanoutAnnouncements',
  'scheduleEventReminders',
  'orchestrateNotifications',
  'deliverNotifications',
  'expireAndPromoteWaitlist',
  'expireHoldsAndQuotes',
  'expireFreePointLots',
  'expireEventPromotions',
  'activateConfiguration',
  'anonymizeDeletedAccounts',
  'reconcileLedger',
  'deriveAnalyticsMetrics',
] as const;

export type JobName = (typeof jobNames)[number];
