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
      const rows = await client.query<{ id: string; user_id: string; type: string }>(
        `SELECT n.id, n.user_id, n.type FROM notification.notifications n
         WHERE NOT EXISTS (SELECT 1 FROM notification.deliveries d WHERE d.notification_id = n.id)
         ORDER BY n.created_at FOR UPDATE OF n SKIP LOCKED LIMIT $1`,
        [this.config.WORKER_BATCH_SIZE],
      );
      for (const row of rows.rows) {
        const preferences = await client.query<{ in_app: boolean; push: boolean; email: boolean; quiet: boolean }>(
          `SELECT COALESCE(p.in_app, true) AS in_app, COALESCE(p.push, true) AS push,
             COALESCE(p.email, false) AS email,
             COALESCE(CASE
               WHEN p.quiet_hours IS NULL THEN false
               WHEN lower(p.quiet_hours)::time < upper(p.quiet_hours)::time THEN
                 (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::time >= lower(p.quiet_hours)::time
                 AND (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::time < upper(p.quiet_hours)::time
               ELSE
                 (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::time >= lower(p.quiet_hours)::time
                 OR (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::time < upper(p.quiet_hours)::time
             END, false) AS quiet
           FROM (SELECT 1) seed
           LEFT JOIN notification.preferences p ON p.user_id = $1 AND p.notification_type = $2`,
          [row.user_id, row.type],
        );
        const preference = preferences.rows[0] ?? { in_app: true, push: true, email: false, quiet: false };
        const critical = /cancelled|safety|account_restricted/.test(row.type);
        const channels = [
          ...(preference.in_app ? ['in_app'] : []),
          ...(preference.push && (!preference.quiet || critical) ? ['push'] : []),
          ...(preference.email && (!preference.quiet || critical) ? ['email'] : []),
        ];
        for (const channel of channels) {
          await client.query(
            `INSERT INTO notification.deliveries(notification_id, channel)
             VALUES ($1,$2) ON CONFLICT (notification_id, channel) DO NOTHING`,
            [row.id, channel],
          );
        }
        if (channels.length === 0) {
          await client.query(
            `INSERT INTO notification.deliveries(notification_id, channel, state, last_error_code)
             VALUES ($1,'in_app','suppressed','USER_PREFERENCES')
             ON CONFLICT (notification_id, channel) DO NOTHING`,
            [row.id],
          );
        }
      }
      return rows.rowCount ?? 0;
    });
    return { processed: result };
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
           ORDER BY p.expires_at FOR UPDATE OF p, r SKIP LOCKED LIMIT $1
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
    const result = await this.database.query(
      `WITH holds AS (
         UPDATE commerce.point_holds SET state = 'expired', updated_at = clock_timestamp()
         WHERE state = 'active' AND expires_at <= clock_timestamp() RETURNING id
       ), quotes AS (
         DELETE FROM commerce.quotes WHERE consumed_at IS NULL AND expires_at < clock_timestamp() - interval '24 hours'
         RETURNING id
       ) SELECT (SELECT count(*) FROM holds)::int + (SELECT count(*) FROM quotes)::int AS processed`,
    );
    return { processed: Number((result.rows[0] as { processed?: number } | undefined)?.processed ?? 0) };
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
           n.template_version, n.payload_ref
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
        outcome = await this.adapters.push(delivery.id, targets, copy, {
          notificationId: delivery.notification_id,
          type: delivery.type,
          ...delivery.payload_ref,
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
  'activateConfiguration',
  'anonymizeDeletedAccounts',
  'reconcileLedger',
] as const;

export type JobName = (typeof jobNames)[number];
