import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';

interface ProfileRow {
  user_id: string;
  public_handle?: string;
  nickname: string;
  bio: string;
  region_id: string | null;
  avatar_asset_id: string | null;
  avatar_url?: string | null;
  preferred_locale: 'zh-Hans' | 'ja' | 'en';
  content_languages: Array<'zh-Hans' | 'ja' | 'en'>;
  follower_count?: string;
  viewer_following?: boolean;
  version: string;
  updated_at: Date;
}

interface PublicEventRow {
  id: string;
  public_slug: string;
  status: string;
  title: string;
  starts_at: Date;
  ends_at: Date;
  region_id: string | null;
  public_area: string | null;
  is_free: boolean | null;
  amount_jpy: string | null;
  cover_url: string | null;
  created_at: Date;
}

@Injectable()
export class ProfilesService {
  constructor(private readonly database: Database) {}

  async get(userId: string): Promise<unknown> {
    const result = await this.database.query<ProfileRow>(
      `SELECT user_id, nickname, bio, region_id, avatar_asset_id,
         (SELECT avatar.derivatives->'thumb'->>'url' FROM media.assets avatar
          WHERE avatar.id = avatar_asset_id AND avatar.state = 'ready'
            AND avatar.moderation_state = 'approved') AS avatar_url,
         preferred_locale, content_languages, version, updated_at
       FROM identity.profiles WHERE user_id = $1 AND deleted_at IS NULL`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('PROFILE_NOT_FOUND', '个人资料不存在。', 404);
    return this.view(row);
  }

  async getPublic(identifier: string, viewerId?: string): Promise<unknown> {
    const result = await this.database.query<ProfileRow>(
      `SELECT p.user_id, u.public_handle, p.nickname, p.bio, p.region_id,
         p.avatar_asset_id,
         (SELECT avatar.derivatives->'thumb'->>'url' FROM media.assets avatar
          WHERE avatar.id = p.avatar_asset_id AND avatar.state = 'ready'
            AND avatar.moderation_state = 'approved') AS avatar_url,
         p.preferred_locale, p.content_languages, p.version, p.updated_at,
         (SELECT count(*) FROM identity.follows f
          WHERE f.target_type = 'user' AND f.target_id = p.user_id AND f.deleted_at IS NULL)::text AS follower_count,
         EXISTS(SELECT 1 FROM identity.follows f
          WHERE f.follower_id = $2 AND f.target_type = 'user'
            AND f.target_id = p.user_id AND f.deleted_at IS NULL) AS viewer_following
       FROM identity.profiles p
       JOIN identity.users u ON u.id = p.user_id
       WHERE (p.user_id::text = $1 OR u.public_handle = $1)
         AND p.deleted_at IS NULL AND u.deleted_at IS NULL AND u.status <> 'anonymized'`,
      [identifier, viewerId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('PROFILE_NOT_FOUND', '个人资料不存在。', 404);
    return {
      ...this.view(row),
      publicHandle: row.public_handle,
      followerCount: Number(row.follower_count ?? 0),
      viewerFollowing: row.viewer_following ?? false,
    };
  }

  async publicEvents(identifier: string, cursorValue?: string, limitValue = 20): Promise<unknown> {
    const profile = await this.database.query<{ id: string }>(
      `SELECT users.id
       FROM identity.users users
       JOIN identity.profiles profile ON profile.user_id = users.id
       WHERE (users.id::text = $1 OR users.public_handle = $1)
         AND users.deleted_at IS NULL AND users.status <> 'anonymized'
         AND profile.deleted_at IS NULL`,
      [identifier],
    );
    const organizerId = profile.rows[0]?.id;
    if (!organizerId) throw new DomainError('PROFILE_NOT_FOUND', '个人资料不存在。', 404);
    const limit = Math.min(Math.max(Number.isFinite(limitValue) ? limitValue : 20, 1), 100);
    const cursor = this.decodeEventCursor(cursorValue);
    const result = await this.database.query<PublicEventRow>(
      `SELECT e.id, e.public_slug, e.status::text, e.title, e.starts_at, e.ends_at,
         location.region_id, location.public_area, fee.is_free, fee.amount_jpy,
         CASE WHEN asset.state = 'ready' AND asset.moderation_state = 'approved'
           THEN asset.derivatives->'card'->>'url' ELSE NULL END AS cover_url,
         e.created_at
       FROM events.events e
       LEFT JOIN events.event_locations location ON location.event_id = e.id
       LEFT JOIN events.event_fees fee ON fee.event_id = e.id
       LEFT JOIN events.event_media cover ON cover.event_id = e.id AND cover.sort_order = 0
       LEFT JOIN media.assets asset ON asset.id = cover.media_asset_id
       WHERE e.organizer_id = $1
         AND e.status IN ('published','registration_closed','in_progress','ended','archived')
         AND e.deleted_at IS NULL
         AND ($2::timestamptz IS NULL OR (e.created_at, e.id) < ($2, $3::uuid))
       ORDER BY e.created_at DESC, e.id DESC
       LIMIT $4`,
      [organizerId, cursor?.date ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => ({
        id: row.id,
        publicSlug: row.public_slug,
        status: row.status,
        title: row.title,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        region: row.region_id ?? 'tokyo',
        publicArea: row.public_area ?? '地点待定',
        priceLabel: row.is_free === false
          ? `¥${Number(row.amount_jpy ?? 0).toLocaleString('ja-JP')}`
          : '免费',
        coverURL: row.cover_url,
      })),
      hasMore,
      nextCursor: hasMore && last ? this.encodeEventCursor(last.created_at, last.id) : null,
    };
  }

  async setFollow(followerId: string, identifier: string, following: boolean): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const target = await client.query<{ id: string }>(
        `SELECT id FROM identity.users
         WHERE (id::text = $1 OR public_handle = $1) AND deleted_at IS NULL`,
        [identifier],
      );
      const targetId = target.rows[0]?.id;
      if (!targetId) throw new DomainError('PROFILE_NOT_FOUND', '个人资料不存在。', 404);
      if (targetId === followerId) {
        throw new DomainError('FOLLOW_SELF_FORBIDDEN', '不能关注自己。', 422);
      }
      const blocked = await client.query(
        `SELECT 1 FROM identity.blocks
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [followerId, targetId],
      );
      if (blocked.rowCount) throw new DomainError('FOLLOW_FORBIDDEN', '当前无法关注此用户。', 403);
      if (following) {
        await client.query(
          `INSERT INTO identity.follows(follower_id, target_type, target_id)
           VALUES ($1, 'user', $2)
           ON CONFLICT (follower_id, target_type, target_id)
           DO UPDATE SET deleted_at = NULL, created_at = clock_timestamp()`,
          [followerId, targetId],
        );
      } else {
        await client.query(
          `UPDATE identity.follows SET deleted_at = COALESCE(deleted_at, clock_timestamp())
           WHERE follower_id = $1 AND target_type = 'user' AND target_id = $2`,
          [followerId, targetId],
        );
      }
      await client.query(
        `SELECT sync.record_change($1, 'follow.changed', 'profile', $2, 'upsert', 1,
           ARRAY['viewerFollowing'], jsonb_build_object('viewerFollowing', $3::boolean))`,
        [followerId, targetId, following],
      );
      return { targetUserId: targetId, following };
    });
  }

  async update(
    userId: string,
    baseVersion: number,
    patch: {
      nickname?: string | undefined;
      bio?: string | undefined;
      regionId?: string | undefined;
      preferredLocale?: 'zh-Hans' | 'ja' | 'en' | undefined;
      contentLanguages?: Array<'zh-Hans' | 'ja' | 'en'> | undefined;
    },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => this.applyPatch(client, userId, baseVersion, patch));
  }

  async applyPatch(
    client: PoolClient,
    userId: string,
    baseVersion: number,
    patch: {
      nickname?: string | undefined;
      bio?: string | undefined;
      regionId?: string | undefined;
      preferredLocale?: 'zh-Hans' | 'ja' | 'en' | undefined;
      contentLanguages?: Array<'zh-Hans' | 'ja' | 'en'> | undefined;
    },
  ): Promise<unknown> {
    const currentResult = await client.query<ProfileRow>(
      `SELECT user_id, nickname, bio, region_id, avatar_asset_id,
         (SELECT avatar.derivatives->'thumb'->>'url' FROM media.assets avatar
          WHERE avatar.id = avatar_asset_id AND avatar.state = 'ready'
            AND avatar.moderation_state = 'approved') AS avatar_url,
         preferred_locale, content_languages, version, updated_at
       FROM identity.profiles WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const current = currentResult.rows[0];
    if (!current) throw new DomainError('PROFILE_NOT_FOUND', '个人资料不存在。', 404);
    if (Number(current.version) !== baseVersion) {
      const attempted: Record<string, unknown> = {};
      if (patch.nickname !== undefined) attempted.nickname = patch.nickname;
      if (patch.bio !== undefined) attempted.bio = patch.bio;
      if (patch.regionId !== undefined) attempted.regionId = patch.regionId;
      if (patch.preferredLocale !== undefined) attempted.preferredLocale = patch.preferredLocale;
      if (patch.contentLanguages !== undefined) attempted.contentLanguages = patch.contentLanguages;
      throw new DomainError('VERSION_CONFLICT', '个人资料已在其他设备更新。', 409, {
        meta: { current: this.view(current), attempted },
        actions: [{ type: 'compareFields', label: '比较更改' }],
      });
    }
    const updated = await client.query<ProfileRow>(
      `UPDATE identity.profiles SET
         nickname = COALESCE($2, nickname), bio = COALESCE($3, bio),
         region_id = COALESCE($4, region_id),
         preferred_locale = COALESCE($5, preferred_locale),
         source_language = COALESCE($5, source_language),
         content_languages = COALESCE($6, content_languages)
       WHERE user_id = $1
       RETURNING user_id, nickname, bio, region_id, avatar_asset_id,
         (SELECT avatar.derivatives->'thumb'->>'url' FROM media.assets avatar
          WHERE avatar.id = avatar_asset_id AND avatar.state = 'ready'
            AND avatar.moderation_state = 'approved') AS avatar_url,
         preferred_locale, content_languages, version, updated_at`,
      [
        userId,
        patch.nickname ?? null,
        patch.bio ?? null,
        patch.regionId ?? null,
        patch.preferredLocale ?? null,
        patch.contentLanguages ?? null,
      ],
    );
    const row = updated.rows[0]!;
    const view = this.view(row);
    await client.query(
      "SELECT sync.record_change($1, 'profile.updated', 'profile', $1, 'upsert', $2, $3, $4)",
      [userId, row.version, Object.keys(patch), view],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('profile', $1, 'profile.updated', $2)`,
      [userId, view],
    );
    return view;
  }

  private view(row: ProfileRow): Record<string, unknown> {
    return {
      userId: row.user_id,
      nickname: row.nickname,
      bio: row.bio,
      regionId: row.region_id,
      avatarURL: row.avatar_url ?? null,
      preferredLocale: row.preferred_locale,
      contentLanguages: row.content_languages,
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private decodeEventCursor(value?: string): { date: Date; id: string } | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { date?: string; id?: string };
      const date = parsed.date ? new Date(parsed.date) : new Date(Number.NaN);
      if (!parsed.id || Number.isNaN(date.getTime())) throw new Error('invalid cursor');
      return { date, id: parsed.id };
    } catch {
      throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    }
  }

  private encodeEventCursor(date: Date, id: string): string {
    return Buffer.from(JSON.stringify({ date: date.toISOString(), id })).toString('base64url');
  }
}
