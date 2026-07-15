import { Injectable } from '@nestjs/common';
import { Database } from '../../platform/database.js';
import { DomainError } from '@spott/domain';
import { FieldCrypto } from '../../platform/crypto.js';

@Injectable()
export class NotificationsService {
  constructor(private readonly database: Database, private readonly crypto: FieldCrypto) {}

  async list(
    userId: string,
    cursor?: string,
    limit = 20,
    requestedLocale?: 'zh-Hans' | 'ja' | 'en',
  ): Promise<unknown> {
    const date = cursor ? new Date(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const result = await this.database.query<{
      id: string;
      type: string;
      payload_ref: Record<string, unknown>;
      resource_type: string | null;
      resource_public_id: string | null;
      created_at: Date;
      read_at: Date | null;
      locale: string;
      template_version: number;
      title_template: string | null;
      body_template: string | null;
    }>(
      `SELECT notification.id, notification.type, notification.payload_ref,
         notification.resource_type, notification.resource_public_id,
         notification.created_at, notification.read_at,
         COALESCE(template.locale, $4::text, profile.preferred_locale, 'zh-Hans') AS locale,
         COALESCE(template.version, notification.template_version) AS template_version,
         template.title_template, template.body_template
       FROM notification.notifications notification
       LEFT JOIN identity.profiles profile ON profile.user_id = notification.user_id
       LEFT JOIN LATERAL (
         SELECT candidate.locale, candidate.version, candidate.title_template, candidate.body_template
         FROM notification.templates candidate
         WHERE candidate.type = notification.type AND candidate.active
           AND candidate.locale IN (COALESCE($4::text, profile.preferred_locale, 'zh-Hans'), 'zh-Hans', 'en')
         ORDER BY
           CASE candidate.locale
             WHEN COALESCE($4::text, profile.preferred_locale, 'zh-Hans') THEN 0
             WHEN 'zh-Hans' THEN 1 ELSE 2
           END,
           candidate.version DESC
         LIMIT 1
       ) template ON true
       WHERE notification.user_id = $1
         AND ($2::timestamptz IS NULL OR notification.created_at < $2)
       ORDER BY notification.created_at DESC, notification.id DESC LIMIT $3`,
      [userId, date?.toISOString() ?? null, safeLimit + 1, requestedLocale ?? null],
    );
    const hasMore = result.rows.length > safeLimit;
    const rows = result.rows.slice(0, safeLimit);
    return {
      items: rows.map((row) => {
        const fallback = this.fallbackCopy(row.type, row.locale);
        return {
          id: row.id,
          type: row.type,
          locale: row.locale,
          templateVersion: row.template_version,
          title: this.render(row.title_template ?? fallback.title, row.payload_ref),
          body: this.render(row.body_template ?? fallback.body, row.payload_ref),
          variables: row.payload_ref,
          resourceType: row.resource_type,
          resourcePublicId: row.resource_public_id,
          createdAt: row.created_at.toISOString(),
          readAt: row.read_at?.toISOString() ?? null,
        };
      }),
      hasMore,
      nextCursor:
        hasMore && rows.at(-1)
          ? Buffer.from(rows.at(-1)!.created_at.toISOString()).toString('base64url')
          : null,
    };
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE notification.notifications SET read_at = COALESCE(read_at, clock_timestamp())
         WHERE id = $1 AND user_id = $2`,
        [notificationId, userId],
      );
      await client.query(
        `SELECT sync.record_change($1, 'notification.read', 'notification', $2,
           'upsert', 1, ARRAY['readAt'], jsonb_build_object('read', true))`,
        [userId, notificationId],
      );
    });
  }

  async registerDevice(userId: string, input: { deviceId?: string | undefined; platform: string; token: string; environment: string }): Promise<unknown> {
    const hash = this.crypto.lookupHash(`push:${input.platform}:${input.token}`);
    const result = await this.database.query<{ id: string; token_hash: Buffer; last_seen_at: Date }>(
      `INSERT INTO notification.device_tokens(user_id, device_id, platform, token_cipher, token_hash, environment)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (token_hash) DO UPDATE SET user_id = EXCLUDED.user_id,
         device_id = EXCLUDED.device_id, token_cipher = EXCLUDED.token_cipher,
         environment = EXCLUDED.environment, last_seen_at = clock_timestamp(),
         disabled_at = NULL, disable_reason = NULL
       RETURNING id, token_hash, last_seen_at`,
      [userId, input.deviceId ?? null, input.platform, this.crypto.encrypt(input.token), hash, input.environment],
    );
    const row = result.rows[0]!;
    return { id: row.id, tokenHash: row.token_hash.toString('hex'), platform: input.platform, lastSeenAt: row.last_seen_at.toISOString() };
  }

  async disableDevice(userId: string, hashHex: string): Promise<void> {
    if (!/^[a-f0-9]{64}$/i.test(hashHex)) throw new DomainError('DEVICE_TOKEN_NOT_FOUND', '推送设备不存在。', 404);
    const result = await this.database.query(
      `UPDATE notification.device_tokens SET disabled_at = clock_timestamp(), disable_reason = 'user_removed'
       WHERE user_id = $1 AND token_hash = decode($2, 'hex') AND disabled_at IS NULL`,
      [userId, hashHex],
    );
    if (!result.rowCount) throw new DomainError('DEVICE_TOKEN_NOT_FOUND', '推送设备不存在。', 404);
  }

  async preferences(userId: string): Promise<unknown> {
    const result = await this.database.query<{
      notification_type: string; in_app: boolean; push: boolean; email: boolean; quiet_hours: string | null; locale: string;
    }>(
      `SELECT notification_type, in_app, push, email, quiet_hours::text, locale
       FROM notification.preferences WHERE user_id = $1 ORDER BY notification_type`,
      [userId],
    );
    return { items: result.rows.map((row) => ({ type: row.notification_type, inApp: row.in_app, push: row.push, email: row.email, quietHours: row.quiet_hours, locale: row.locale })) };
  }

  async updatePreference(userId: string, type: string, input: {
    inApp: boolean; push: boolean; email: boolean; quietStart?: string | undefined; quietEnd?: string | undefined; locale: string;
  }): Promise<unknown> {
    const quietHours = input.quietStart && input.quietEnd
      ? this.quietRange(input.quietStart, input.quietEnd)
      : null;
    const result = await this.database.query<{ updated_at: Date }>(
      `INSERT INTO notification.preferences(user_id, notification_type, in_app, push, email, quiet_hours, locale)
       VALUES ($1,$2,$3,$4,$5,$6::tstzrange,$7)
       ON CONFLICT (user_id, notification_type) DO UPDATE SET in_app = EXCLUDED.in_app,
         push = EXCLUDED.push, email = EXCLUDED.email, quiet_hours = EXCLUDED.quiet_hours,
         locale = EXCLUDED.locale, updated_at = clock_timestamp()
       RETURNING updated_at`,
      [userId, type, input.inApp, input.push, input.email, quietHours, input.locale],
    );
    return { type, ...input, updatedAt: result.rows[0]!.updated_at.toISOString() };
  }

  private quietRange(start: string, end: string): string {
    const today = new Date().toISOString().slice(0, 10);
    const endDate = new Date(`${today}T${end}:00+09:00`);
    if (end <= start) endDate.setUTCDate(endDate.getUTCDate() + 1);
    return `[${today}T${start}:00+09:00,${endDate.toISOString()})`;
  }

  private render(template: string, variables: Record<string, unknown>): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
      const value = variables[key];
      return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
    });
  }

  private fallbackCopy(type: string, locale: string): { title: string; body: string } {
    if (locale === 'ja') return { title: 'Spottからのお知らせ', body: type };
    if (locale === 'en') return { title: 'Spott notification', body: type };
    return { title: 'Spott 通知', body: type };
  }
}
