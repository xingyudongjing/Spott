import { createHmac, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError, findBannedTerm } from '@spott/domain';
import type { PoolClient } from 'pg';
import { configuration } from '../../config.js';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from '../points/points.service.js';

/**
 * Fallback offensive-term list used only when operators have not published a
 * `community.discussion.banned_words` config revision. The live list is always
 * read from admin.config_revisions first so the filter is backend-configurable
 * without a deploy; this constant just keeps the filter from being a no-op on a
 * fresh environment.
 */
const DEFAULT_DISCUSSION_BANNED_WORDS: readonly string[] = [
  '傻逼',
  '去死',
  '滚蛋',
  'fuck',
  'idiot',
  'asshole',
];

interface GroupRow {
  id: string;
  owner_id: string;
  owner_name: string | null;
  owner_handle: string;
  cover_url?: string | null;
  name: string;
  slug: string;
  description: string;
  join_mode: 'open' | 'approval' | 'invite_only';
  capacity: number;
  status: string;
  version: string;
  member_count: string;
  region_id: string;
  category_id: string | null;
  tags: string[];
  rules: string;
  membership_status: string | null;
  membership_role: string | null;
  viewer_following: boolean;
  announcement_summary: AnnouncementRow[];
  closing_at: Date | null;
  dissolve_after: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface AnnouncementRow {
  id: string;
  group_id: string;
  author_id: string;
  author_name?: string | null;
  title: string;
  body: string;
  visibility: 'public' | 'members';
  comments_enabled: boolean;
  pinned_at: Date | null;
  version: string;
  created_at: Date;
  updated_at: Date;
  like_count?: string;
  viewer_liked?: boolean;
  comment_count?: string;
}

interface CommentRow {
  id: string;
  target_id: string;
  author_id: string;
  author_name: string | null;
  body: string;
  parent_id: string | null;
  source_language: 'zh-Hans' | 'ja' | 'en';
  version: string;
  created_at: Date;
  updated_at: Date;
}

interface DiscussionRow extends CommentRow {
  status?: string;
  like_count?: string;
  viewer_liked?: boolean;
  reply_count?: string;
}

@Injectable()
export class GroupsService {
  constructor(
    private readonly database: Database,
    private readonly points: PointsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async discover(
    viewerId: string | undefined,
    options: {
      region?: string | undefined;
      category?: string | undefined;
      query?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    },
  ): Promise<unknown> {
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const cursor = this.decodeCursor(options.cursor);
    const result = await this.database.query<GroupRow>(
      `SELECT g.*, owner.public_handle AS owner_handle, profile.nickname AS owner_name,
         (SELECT COALESCE(cover.derivatives->'hero'->>'url', cover.derivatives->'card'->>'url')
          FROM media.assets cover WHERE cover.id = g.cover_asset_id AND cover.state = 'ready'
            AND cover.moderation_state = 'approved') AS cover_url,
         (SELECT count(*) FROM community.group_memberships member
          WHERE member.group_id = g.id AND member.status IN ('active','muted'))::text AS member_count,
         viewer.status::text AS membership_status, viewer.role::text AS membership_role,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $1 AND follow.target_type = 'group'
             AND follow.target_id = g.id AND follow.deleted_at IS NULL) AS viewer_following,
         COALESCE((SELECT jsonb_agg(summary ORDER BY (summary->>'created_at')::timestamptz DESC)
           FROM (SELECT jsonb_build_object(
             'id', announcement.id, 'group_id', announcement.group_id,
             'author_id', announcement.author_id, 'title', announcement.title,
             'body', announcement.body, 'visibility', announcement.visibility,
             'comments_enabled', announcement.comments_enabled,
             'pinned_at', announcement.pinned_at, 'version', announcement.version,
             'created_at', announcement.created_at, 'updated_at', announcement.updated_at
           ) AS summary FROM community.announcements announcement
           WHERE announcement.group_id = g.id AND announcement.deleted_at IS NULL
             AND announcement.visibility = 'public'
           ORDER BY announcement.pinned_at DESC NULLS LAST, announcement.created_at DESC LIMIT 2) recent
         ), '[]'::jsonb) AS announcement_summary
       FROM community.groups g
       JOIN identity.users owner ON owner.id = g.owner_id
       LEFT JOIN identity.profiles profile ON profile.user_id = g.owner_id AND profile.deleted_at IS NULL
       LEFT JOIN community.group_memberships viewer
         ON viewer.group_id = g.id AND viewer.user_id = $1
           AND viewer.status IN ('active','muted','pending')
       WHERE g.deleted_at IS NULL AND g.status IN ('active','transfer_pending','closing')
         AND ($2::text IS NULL OR g.region_id = $2 OR g.region_id = 'nationwide')
         AND ($3::text IS NULL OR g.category_id = $3)
         AND ($4::text IS NULL OR g.name ILIKE '%' || $4 || '%'
           OR g.description ILIKE '%' || $4 || '%' OR $4 = ANY(g.tags)
           OR similarity(g.name, $4) > 0.15)
         AND ($5::timestamptz IS NULL OR (g.created_at, g.id) < ($5, $6::uuid))
       ORDER BY g.created_at DESC, g.id DESC LIMIT $7`,
      [
        viewerId ?? null,
        options.region ?? null,
        options.category ?? null,
        options.query?.trim() || null,
        cursor?.date ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const last = rows.at(-1);
    return {
      items: rows.map((row) => this.view(row, viewerId)),
      hasMore,
      nextCursor: hasMore && last ? this.encodeCursor(last.created_at, last.id) : null,
    };
  }

  async get(identifier: string, viewerId?: string): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      return this.view(await this.load(client, identifier, viewerId, false), viewerId);
    } finally {
      client.release();
    }
  }

  async mine(userId: string): Promise<unknown> {
    const result = await this.database.query<GroupRow>(
      `SELECT g.*, owner.public_handle AS owner_handle, profile.nickname AS owner_name,
         (SELECT COALESCE(cover.derivatives->'hero'->>'url', cover.derivatives->'card'->>'url')
          FROM media.assets cover WHERE cover.id = g.cover_asset_id AND cover.state = 'ready'
            AND cover.moderation_state = 'approved') AS cover_url,
         (SELECT count(*) FROM community.group_memberships member
          WHERE member.group_id = g.id AND member.status IN ('active','muted'))::text AS member_count,
         viewer.status::text AS membership_status, viewer.role::text AS membership_role,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $1 AND follow.target_type = 'group'
             AND follow.target_id = g.id AND follow.deleted_at IS NULL) AS viewer_following,
         '[]'::jsonb AS announcement_summary
       FROM community.groups g
       JOIN community.group_memberships viewer ON viewer.group_id = g.id
       JOIN identity.users owner ON owner.id = g.owner_id
       LEFT JOIN identity.profiles profile ON profile.user_id = g.owner_id AND profile.deleted_at IS NULL
       WHERE viewer.user_id = $1 AND viewer.status IN ('active','muted','pending')
         AND g.deleted_at IS NULL
       ORDER BY viewer.joined_at DESC`,
      [userId],
    );
    return { items: result.rows.map((row) => this.view(row, userId)) };
  }

  async create(
    user: AuthenticatedUser,
    key: string,
    input: {
      quoteId: string;
      name: string;
      slug: string;
      description: string;
      joinMode: 'open' | 'approval' | 'invite_only';
      regionId: string;
      categoryId: string;
      tags: string[];
      rules: string;
    },
  ): Promise<unknown> {
    this.requireVerified(user);
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', '/groups', input);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const idResult = await client.query<{ id: string }>('SELECT uuidv7() AS id');
      const id = idResult.rows[0]!.id;
      const cost = await this.points.consumeQuote(client, user.id, input.quoteId, 'group_create', id);
      await this.points.spend(client, user.id, cost, 'group_create', `group_create:${id}`, { groupId: id });
      try {
        await client.query(
          `INSERT INTO community.groups(
             id, owner_id, name, slug, description, join_mode,
             region_id, category_id, tags, rules
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            id,
            user.id,
            input.name,
            input.slug,
            input.description,
            input.joinMode,
            input.regionId,
            input.categoryId,
            input.tags,
            input.rules,
          ],
        );
        await client.query(
          "INSERT INTO community.group_memberships(group_id, user_id, role, status) VALUES ($1,$2,'owner','active')",
          [id, user.id],
        );
      } catch (error) {
        if (this.pgCode(error) === '23505') throw new DomainError('GROUP_SLUG_TAKEN', '群组链接已被使用。', 409);
        throw error;
      }
      await this.change(client, user.id, id, 1, 'group.created', { name: input.name });
      const row = await this.load(client, id, user.id, true);
      const body = this.view(row, user.id);
      await this.idempotency.complete(client, user.id, key, { status: 201, body }, { type: 'group', id });
      return body;
    });
  }

  async join(
    user: AuthenticatedUser,
    groupId: string,
    key: string,
    inviteCode?: string,
  ): Promise<unknown> {
    this.requireVerified(user);
    return this.database.transaction(async (client) => {
      const request = { inviteCode: inviteCode ?? null };
      const hash = this.idempotency.requestHash('POST', `/groups/${groupId}/join`, request);
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const group = await this.load(client, groupId, user.id, true);
      if (group.status !== 'active' && group.status !== 'transfer_pending') {
        throw new DomainError('GROUP_JOIN_CLOSED', '群组暂不接受新成员。', 409);
      }
      const blocked = await client.query(
        `SELECT 1 FROM identity.blocks
         WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
        [user.id, group.owner_id],
      );
      if (blocked.rowCount) throw new DomainError('GROUP_JOIN_FORBIDDEN', '无法加入此群组。', 403);
      const existing = await client.query<{ status: string }>(
        'SELECT status FROM community.group_memberships WHERE group_id = $1 AND user_id = $2',
        [group.id, user.id],
      );
      if (existing.rows[0]?.status && ['active', 'muted', 'pending'].includes(existing.rows[0].status)) {
        const body = { groupId: group.id, status: existing.rows[0].status };
        await this.idempotency.complete(client, user.id, key, { status: 200, body }, {
          type: 'group_membership', id: group.id,
        });
        return body;
      }
      if (Number(group.member_count) >= group.capacity) {
        throw new DomainError('GROUP_CAPACITY_FULL', '群组人数已满。', 409, {
          meta: { capacity: group.capacity },
        });
      }
      if (group.join_mode === 'invite_only') {
        if (!inviteCode) throw new DomainError('GROUP_INVITE_REQUIRED', '此群组需要有效邀请码。', 403);
        const invite = await client.query<{ id: string }>(
          `UPDATE community.group_invites SET used_count = used_count + 1
           WHERE group_id = $1 AND code_hash = $2 AND revoked_at IS NULL
             AND expires_at > clock_timestamp() AND used_count < max_uses
           RETURNING id`,
          [group.id, this.codeHash(inviteCode)],
        );
        if (!invite.rows[0]) throw new DomainError('GROUP_INVITE_INVALID', '邀请码无效或已过期。', 403);
      }
      const status = group.join_mode === 'approval' ? 'pending' : 'active';
      await client.query(
        `INSERT INTO community.group_memberships(group_id, user_id, role, status)
         VALUES ($1,$2,'member',$3)
         ON CONFLICT (group_id, user_id) DO UPDATE SET status = EXCLUDED.status,
           role = 'member', joined_at = clock_timestamp(), updated_at = clock_timestamp()`,
        [group.id, user.id, status],
      );
      await this.change(client, user.id, group.id, Number(group.version), 'group.member_joined', {
        memberId: user.id,
        status,
      });
      const body = { groupId: group.id, status };
      await this.idempotency.complete(client, user.id, key, { status: 201, body }, {
        type: 'group_membership', id: group.id,
      });
      return body;
    });
  }

  async createInvite(
    actor: AuthenticatedUser,
    groupId: string,
    input: { maxUses: number; expiresInHours: number },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      await this.assertManager(client, group.id, actor.id);
      const code = randomBytes(12).toString('base64url');
      const result = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO community.group_invites(group_id, code_hash, created_by, max_uses, expires_at)
         VALUES ($1,$2,$3,$4,clock_timestamp() + ($5::text || ' hours')::interval)
         RETURNING id, expires_at`,
        [group.id, this.codeHash(code), actor.id, input.maxUses, input.expiresInHours],
      );
      return { id: result.rows[0]!.id, groupId: group.id, code, expiresAt: result.rows[0]!.expires_at.toISOString() };
    });
  }

  async members(
    actor: AuthenticatedUser,
    groupId: string,
    cursor?: string,
    limit = 50,
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, false);
      await this.assertManager(client, group.id, actor.id);
      const safeLimit = Math.min(Math.max(limit, 1), 100);
      const decoded = this.decodeCursor(cursor);
      const result = await client.query<{
        user_id: string;
        public_handle: string;
        nickname: string | null;
        role: string;
        status: string;
        joined_at: Date;
        updated_at: Date;
      }>(
        `SELECT membership.user_id, member.public_handle, profile.nickname,
           membership.role, membership.status, membership.joined_at, membership.updated_at
         FROM community.group_memberships membership
         JOIN identity.users member ON member.id = membership.user_id
         LEFT JOIN identity.profiles profile ON profile.user_id = membership.user_id
           AND profile.deleted_at IS NULL
         WHERE membership.group_id = $1
           AND ($2::timestamptz IS NULL OR (membership.joined_at, membership.user_id) < ($2, $3::uuid))
         ORDER BY membership.joined_at DESC, membership.user_id DESC
         LIMIT $4`,
        [group.id, decoded?.date ?? null, decoded?.id ?? null, safeLimit + 1],
      );
      const hasMore = result.rows.length > safeLimit;
      const rows = result.rows.slice(0, safeLimit);
      const last = rows.at(-1);
      return {
        items: rows.map((row) => ({
          user: {
            id: row.user_id,
            name: row.nickname ?? `@${row.public_handle}`,
            handle: row.public_handle,
          },
          role: row.role,
          status: row.status,
          joinedAt: row.joined_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
        hasMore,
        nextCursor: hasMore && last ? this.encodeCursor(last.joined_at, last.user_id) : null,
      };
    });
  }

  async updateMember(
    actor: AuthenticatedUser,
    groupId: string,
    userId: string,
    input: { role?: 'admin' | 'member' | undefined; status?: 'active' | 'muted' | 'removed' | undefined },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      const actorRole = await this.assertManager(client, group.id, actor.id);
      if (input.role && actorRole !== 'owner') {
        throw new DomainError('GROUP_ROLE_FORBIDDEN', '只有群主可以任命或撤销管理员。', 403);
      }
      const updated = await client.query<{ role: string; status: string }>(
        `UPDATE community.group_memberships SET role = COALESCE($3, role),
           status = COALESCE($4, status), updated_at = clock_timestamp()
         WHERE group_id = $1 AND user_id = $2 AND role <> 'owner'
         RETURNING role, status`,
        [group.id, userId, input.role ?? null, input.status ?? null],
      );
      const row = updated.rows[0];
      if (!row) throw new DomainError('GROUP_MEMBER_NOT_FOUND', '成员不存在或不能修改群主。', 404);
      await this.audit(client, actor.id, 'group.member.updated', 'group_membership', `${group.id}:${userId}`, row);
      await this.change(client, actor.id, group.id, Number(group.version), 'group.member.updated', {
        memberId: userId,
        ...row,
      });
      return { groupId: group.id, userId, ...row };
    });
  }

  async purchaseCapacity(user: AuthenticatedUser, groupId: string, quoteId: string, key: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/groups/${groupId}/capacity-purchases`, { quoteId });
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;
      const group = await this.load(client, groupId, user.id, true);
      if (group.owner_id !== user.id) throw new DomainError('GROUP_CAPACITY_FORBIDDEN', '只有群主可以扩容。', 403);
      if (group.capacity >= 500) throw new DomainError('GROUP_CAPACITY_MAX', '普通群组容量上限为 500 人。', 422);
      const amount = await this.points.consumeQuote(client, user.id, quoteId, 'group_capacity', group.id);
      const spent = await this.points.spend(
        client,
        user.id,
        amount,
        'group_capacity',
        `group_capacity:${group.id}:${group.capacity + 50}`,
        { groupId: group.id, before: group.capacity, after: group.capacity + 50 },
      );
      const updated = await client.query<{ version: string }>(
        'UPDATE community.groups SET capacity = capacity + 50 WHERE id = $1 RETURNING version',
        [group.id],
      );
      await client.query(
        `INSERT INTO community.group_capacity_purchases(
           group_id, points_transaction_id, before_capacity, after_capacity
         ) VALUES ($1,$2,$3,$4)`,
        [group.id, spent.transactionId, group.capacity, group.capacity + 50],
      );
      await this.change(client, user.id, group.id, Number(updated.rows[0]!.version), 'group.capacity_changed', {
        before: group.capacity,
        after: group.capacity + 50,
      });
      const row = await this.load(client, group.id, user.id, false);
      const body = this.view(row, user.id);
      await this.idempotency.complete(client, user.id, key, { status: 200, body }, { type: 'group', id: group.id });
      return body;
    });
  }

  async setFollow(userId: string, groupId: string, following: boolean): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, userId, false);
      if (following) {
        await client.query(
          `INSERT INTO identity.follows(follower_id, target_type, target_id)
           VALUES ($1,'group',$2)
           ON CONFLICT (follower_id, target_type, target_id)
           DO UPDATE SET deleted_at = NULL, created_at = clock_timestamp()`,
          [userId, group.id],
        );
      } else {
        await client.query(
          `UPDATE identity.follows SET deleted_at = COALESCE(deleted_at, clock_timestamp())
           WHERE follower_id = $1 AND target_type = 'group' AND target_id = $2`,
          [userId, group.id],
        );
      }
      await client.query(
        `SELECT sync.record_change($1, 'follow.changed', 'group', $2, 'upsert', $3,
           ARRAY['viewerFollowing'], jsonb_build_object('viewerFollowing', $4::boolean))`,
        [userId, group.id, Number(group.version), following],
      );
      return { groupId: group.id, following };
    });
  }

  async announcements(groupId: string, viewerId: string | undefined, cursor?: string, limit = 20): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      const group = await this.load(client, groupId, viewerId, false);
      const isMember = ['active', 'muted'].includes(group.membership_status ?? '');
      const safeLimit = Math.min(Math.max(limit, 1), 100);
      const date = this.decodeDateCursor(cursor);
      const result = await client.query<AnnouncementRow>(
        `SELECT announcement.*, profile.nickname AS author_name,
           (SELECT count(*) FROM community.announcement_reactions reaction
            WHERE reaction.announcement_id = announcement.id)::text AS like_count,
           EXISTS(SELECT 1 FROM community.announcement_reactions reaction
            WHERE reaction.announcement_id = announcement.id AND reaction.user_id = $2) AS viewer_liked,
           (SELECT count(*) FROM community.comments comment
            WHERE comment.target_type = 'announcement' AND comment.target_id = announcement.id
              AND comment.status = 'visible' AND comment.deleted_at IS NULL)::text AS comment_count
         FROM community.announcements announcement
         LEFT JOIN identity.profiles profile ON profile.user_id = announcement.author_id
         WHERE announcement.group_id = $1 AND announcement.deleted_at IS NULL
           AND (announcement.visibility = 'public' OR $3::boolean)
           AND ($4::timestamptz IS NULL OR announcement.created_at < $4)
         ORDER BY announcement.pinned_at DESC NULLS LAST, announcement.created_at DESC, announcement.id DESC
         LIMIT $5`,
        [group.id, viewerId ?? null, isMember, date?.toISOString() ?? null, safeLimit + 1],
      );
      const hasMore = result.rows.length > safeLimit;
      const rows = result.rows.slice(0, safeLimit);
      return {
        items: rows.map((row) => this.announcementView(row)),
        hasMore,
        nextCursor: hasMore && rows.at(-1) ? this.encodeDateCursor(rows.at(-1)!.created_at) : null,
      };
    } finally {
      client.release();
    }
  }

  async createAnnouncement(
    actor: AuthenticatedUser,
    groupId: string,
    key: string,
    input: { title: string; body: string; visibility: 'public' | 'members'; commentsEnabled: boolean },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/groups/${groupId}/announcements`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const group = await this.load(client, groupId, actor.id, true);
      await this.assertManager(client, group.id, actor.id);
      const todayCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM community.announcements
         WHERE group_id = $1 AND created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'Asia/Tokyo') AT TIME ZONE 'Asia/Tokyo'
           AND deleted_at IS NULL`,
        [group.id],
      );
      if (Number(todayCount.rows[0]?.count ?? 0) >= 2) {
        throw new DomainError('GROUP_ANNOUNCEMENT_RATE_LIMITED', '同一群组每天最多发送 2 条普通公告。', 429);
      }
      const result = await client.query<AnnouncementRow>(
        `INSERT INTO community.announcements(
           group_id, author_id, title, body, visibility, comments_enabled
         ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [group.id, actor.id, input.title, input.body, input.visibility, input.commentsEnabled],
      );
      const row = result.rows[0]!;
      await this.change(client, actor.id, group.id, Number(group.version), 'group.announcement.created', {
        announcementId: row.id,
      });
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('group', $1, 'group.announcement', $2)`,
        [group.id, { groupId: group.id, groupName: group.name, announcementId: row.id, announcementTitle: row.title }],
      );
      const body = this.announcementView(row);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, {
        type: 'announcement', id: row.id,
      });
      return body;
    });
  }

  async updateAnnouncement(
    actor: AuthenticatedUser,
    groupId: string,
    announcementId: string,
    baseVersion: number,
    input: {
      title?: string | undefined;
      body?: string | undefined;
      visibility?: 'public' | 'members' | undefined;
      commentsEnabled?: boolean | undefined;
    },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      await this.assertManager(client, group.id, actor.id);
      const result = await client.query<AnnouncementRow>(
        `UPDATE community.announcements SET
           title = COALESCE($3, title), body = COALESCE($4, body),
           visibility = COALESCE($5, visibility), comments_enabled = COALESCE($6, comments_enabled)
         WHERE id = $1 AND group_id = $2 AND version = $7 AND deleted_at IS NULL
         RETURNING *`,
        [
          announcementId,
          group.id,
          input.title ?? null,
          input.body ?? null,
          input.visibility ?? null,
          input.commentsEnabled ?? null,
          baseVersion,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('VERSION_CONFLICT', '公告已更新或不存在。', 409);
      await this.audit(client, actor.id, 'group.announcement.updated', 'announcement', row.id, input);
      return this.announcementView(row);
    });
  }

  async deleteAnnouncement(actor: AuthenticatedUser, groupId: string, announcementId: string): Promise<void> {
    await this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      await this.assertManager(client, group.id, actor.id);
      const result = await client.query(
        `UPDATE community.announcements SET deleted_at = clock_timestamp(), deleted_by = $3
         WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
        [announcementId, group.id, actor.id],
      );
      if (!result.rowCount) throw new DomainError('ANNOUNCEMENT_NOT_FOUND', '公告不存在。', 404);
      await this.audit(client, actor.id, 'group.announcement.deleted', 'announcement', announcementId, {});
    });
  }

  async comments(groupId: string, announcementId: string, viewerId: string | undefined): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      const group = await this.load(client, groupId, viewerId, false);
      await this.assertAnnouncementReadable(client, group, announcementId);
      const result = await client.query<CommentRow>(
        `SELECT comment.*, profile.nickname AS author_name
         FROM community.comments comment
         LEFT JOIN identity.profiles profile ON profile.user_id = comment.author_id
         WHERE comment.target_type = 'announcement' AND comment.target_id = $1
           AND comment.status = 'visible' AND comment.deleted_at IS NULL
         ORDER BY comment.created_at, comment.id`,
        [announcementId],
      );
      return { items: result.rows.map((row) => this.commentView(row)) };
    } finally {
      client.release();
    }
  }

  async createComment(
    actor: AuthenticatedUser,
    groupId: string,
    announcementId: string,
    key: string,
    input: { body: string; parentId?: string | undefined; locale: 'zh-Hans' | 'ja' | 'en' },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash(
        'POST',
        `/groups/${groupId}/announcements/${announcementId}/comments`,
        input,
      );
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const group = await this.load(client, groupId, actor.id, false);
      if (group.membership_status !== 'active') {
        throw new DomainError('GROUP_COMMENT_FORBIDDEN', '只有未被禁言的群成员可以评论。', 403);
      }
      const announcement = await client.query<{ comments_enabled: boolean }>(
        `SELECT comments_enabled FROM community.announcements
         WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
        [announcementId, group.id],
      );
      if (!announcement.rows[0]?.comments_enabled) {
        throw new DomainError('GROUP_COMMENTS_DISABLED', '此公告已关闭评论。', 422);
      }
      if (input.parentId) {
        const parent = await client.query(
          `SELECT 1 FROM community.comments
           WHERE id = $1 AND target_type = 'announcement' AND target_id = $2
             AND status = 'visible' AND deleted_at IS NULL`,
          [input.parentId, announcementId],
        );
        if (!parent.rowCount) throw new DomainError('COMMENT_PARENT_NOT_FOUND', '回复的评论不存在。', 404);
      }
      const result = await client.query<CommentRow>(
        `INSERT INTO community.comments(
           target_type, target_id, author_id, body, parent_id, source_language
         ) VALUES ('announcement',$1,$2,$3,$4,$5) RETURNING *, NULL::text AS author_name`,
        [announcementId, actor.id, input.body, input.parentId ?? null, input.locale],
      );
      const row = result.rows[0]!;
      await this.change(client, actor.id, group.id, Number(group.version), 'group.comment.created', {
        announcementId,
        commentId: row.id,
      });
      const body = this.commentView(row);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, {
        type: 'comment', id: row.id,
      });
      return body;
    });
  }

  async updateComment(actor: AuthenticatedUser, commentId: string, baseVersion: number, body: string): Promise<unknown> {
    const result = await this.database.query<CommentRow>(
      `UPDATE community.comments SET body = $3
       WHERE id = $1 AND author_id = $2 AND version = $4
         AND status = 'visible' AND deleted_at IS NULL
       RETURNING *, NULL::text AS author_name`,
      [commentId, actor.id, body, baseVersion],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('VERSION_CONFLICT', '评论已更新、被删除或无权编辑。', 409);
    return this.commentView(row);
  }

  async deleteComment(actor: AuthenticatedUser, commentId: string): Promise<void> {
    const result = await this.database.query(
      `UPDATE community.comments SET status = 'removed', deleted_at = clock_timestamp(), deleted_by = $2
       WHERE id = $1 AND author_id = $2 AND deleted_at IS NULL`,
      [commentId, actor.id],
    );
    if (!result.rowCount) throw new DomainError('COMMENT_NOT_FOUND', '评论不存在或无权删除。', 404);
  }

  async setAnnouncementLike(userId: string, groupId: string, announcementId: string, liked: boolean): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, userId, false);
      if (!['active', 'muted'].includes(group.membership_status ?? '')) {
        throw new DomainError('GROUP_REACTION_FORBIDDEN', '只有群成员可以点赞公告。', 403);
      }
      await this.assertAnnouncementReadable(client, group, announcementId);
      if (liked) {
        await client.query(
          `INSERT INTO community.announcement_reactions(announcement_id, user_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [announcementId, userId],
        );
      } else {
        await client.query(
          'DELETE FROM community.announcement_reactions WHERE announcement_id = $1 AND user_id = $2',
          [announcementId, userId],
        );
      }
      return { announcementId, liked };
    });
  }

  // --- Group discussion board (controlled messaging) ---------------------------
  //
  // Members author top-level posts and threaded replies directly on the group.
  // These reuse community.comments with target_type = 'group' (posts have
  // parent_id NULL, replies point at their post). Every entry point below first
  // loads the group and asserts the caller's membership, so a discussion thread
  // is strictly bound to group membership — there is no way to open a message
  // surface against an arbitrary user. That binding is the whole difference
  // between this feature and open stranger DMs, which V1 deliberately omits.

  async discussion(
    groupId: string,
    viewerId: string | undefined,
    cursor?: string,
    limit = 20,
  ): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      const group = await this.load(client, groupId, viewerId, false);
      this.assertDiscussionAudience(group);
      const safeLimit = Math.min(Math.max(limit, 1), 100);
      const date = this.decodeDateCursor(cursor);
      const result = await client.query<DiscussionRow>(
        `SELECT post.*, profile.nickname AS author_name,
           (SELECT count(*) FROM community.comment_reactions reaction
            WHERE reaction.comment_id = post.id)::text AS like_count,
           EXISTS(SELECT 1 FROM community.comment_reactions reaction
            WHERE reaction.comment_id = post.id AND reaction.user_id = $2) AS viewer_liked,
           (SELECT count(*) FROM community.comments reply
            WHERE reply.parent_id = post.id AND reply.status = 'visible'
              AND reply.deleted_at IS NULL)::text AS reply_count
         FROM community.comments post
         LEFT JOIN identity.profiles profile ON profile.user_id = post.author_id
         WHERE post.target_type = 'group' AND post.target_id = $1
           AND post.parent_id IS NULL AND post.status = 'visible' AND post.deleted_at IS NULL
           AND ($3::timestamptz IS NULL OR post.created_at < $3)
         ORDER BY post.created_at DESC, post.id DESC
         LIMIT $4`,
        [group.id, viewerId ?? null, date?.toISOString() ?? null, safeLimit + 1],
      );
      const hasMore = result.rows.length > safeLimit;
      const rows = result.rows.slice(0, safeLimit);
      return {
        items: rows.map((row) => this.discussionView(row)),
        hasMore,
        nextCursor: hasMore && rows.at(-1) ? this.encodeDateCursor(rows.at(-1)!.created_at) : null,
      };
    } finally {
      client.release();
    }
  }

  async discussionReplies(groupId: string, postId: string, viewerId: string | undefined): Promise<unknown> {
    const client = await this.database.pool.connect();
    try {
      const group = await this.load(client, groupId, viewerId, false);
      this.assertDiscussionAudience(group);
      const result = await client.query<DiscussionRow>(
        `SELECT reply.*, profile.nickname AS author_name,
           (SELECT count(*) FROM community.comment_reactions reaction
            WHERE reaction.comment_id = reply.id)::text AS like_count,
           EXISTS(SELECT 1 FROM community.comment_reactions reaction
            WHERE reaction.comment_id = reply.id AND reaction.user_id = $3) AS viewer_liked,
           '0'::text AS reply_count
         FROM community.comments reply
         LEFT JOIN identity.profiles profile ON profile.user_id = reply.author_id
         WHERE reply.parent_id = $1 AND reply.target_type = 'group' AND reply.target_id = $2
           AND reply.status = 'visible' AND reply.deleted_at IS NULL
         ORDER BY reply.created_at, reply.id`,
        [postId, group.id, viewerId ?? null],
      );
      return { items: result.rows.map((row) => this.discussionView(row)) };
    } finally {
      client.release();
    }
  }

  async createDiscussionPost(
    actor: AuthenticatedUser,
    groupId: string,
    key: string,
    input: { body: string; locale: 'zh-Hans' | 'ja' | 'en' },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/groups/${groupId}/discussion`, input);
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const group = await this.load(client, groupId, actor.id, false);
      this.assertCanPost(actor, group);
      await this.assertCleanContent(client, input.body);
      await this.assertPostRate(client, group.id, actor.id);
      const result = await client.query<DiscussionRow>(
        `INSERT INTO community.comments(target_type, target_id, author_id, body, source_language)
         VALUES ('group', $1, $2, $3, $4)
         RETURNING *, NULL::text AS author_name, '0'::text AS like_count,
           false AS viewer_liked, '0'::text AS reply_count`,
        [group.id, actor.id, input.body, input.locale],
      );
      const row = result.rows[0]!;
      await this.change(client, actor.id, group.id, Number(group.version), 'group.discussion.posted', {
        postId: row.id,
      });
      const body = this.discussionView(row);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, {
        type: 'comment', id: row.id,
      });
      return body;
    });
  }

  async createDiscussionReply(
    actor: AuthenticatedUser,
    groupId: string,
    postId: string,
    key: string,
    input: { body: string; locale: 'zh-Hans' | 'ja' | 'en' },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash(
        'POST',
        `/groups/${groupId}/discussion/${postId}/replies`,
        input,
      );
      const replay = await this.idempotency.claim<unknown>(client, actor.id, key, hash);
      if (replay) return replay.body;
      const group = await this.load(client, groupId, actor.id, false);
      this.assertCanPost(actor, group);
      await this.assertCleanContent(client, input.body);
      const parent = await client.query<{ parent_exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM community.comments
           WHERE id = $1 AND target_type = 'group' AND target_id = $2
             AND parent_id IS NULL AND status = 'visible' AND deleted_at IS NULL
         ) AS parent_exists`,
        [postId, group.id],
      );
      if (!parent.rows[0]?.parent_exists) {
        throw new DomainError('DISCUSSION_POST_NOT_FOUND', '要回复的帖子不存在或已删除。', 404);
      }
      await this.assertPostRate(client, group.id, actor.id);
      const result = await client.query<DiscussionRow>(
        `INSERT INTO community.comments(target_type, target_id, author_id, body, parent_id, source_language)
         VALUES ('group', $1, $2, $3, $4, $5)
         RETURNING *, NULL::text AS author_name, '0'::text AS like_count,
           false AS viewer_liked, '0'::text AS reply_count`,
        [group.id, actor.id, input.body, postId, input.locale],
      );
      const row = result.rows[0]!;
      await this.change(client, actor.id, group.id, Number(group.version), 'group.discussion.replied', {
        postId,
        replyId: row.id,
      });
      const body = this.discussionView(row);
      await this.idempotency.complete(client, actor.id, key, { status: 201, body }, {
        type: 'comment', id: row.id,
      });
      return body;
    });
  }

  async setDiscussionLike(
    userId: string,
    groupId: string,
    commentId: string,
    liked: boolean,
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, userId, false);
      this.assertDiscussionAudience(group);
      const target = await client.query(
        `SELECT 1 FROM community.comments
         WHERE id = $1 AND target_type = 'group' AND target_id = $2
           AND status = 'visible' AND deleted_at IS NULL`,
        [commentId, group.id],
      );
      if (!target.rowCount) {
        throw new DomainError('DISCUSSION_POST_NOT_FOUND', '内容不存在或已删除。', 404);
      }
      if (liked) {
        await client.query(
          `INSERT INTO community.comment_reactions(comment_id, user_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [commentId, userId],
        );
      } else {
        await client.query(
          'DELETE FROM community.comment_reactions WHERE comment_id = $1 AND user_id = $2',
          [commentId, userId],
        );
      }
      return { commentId, liked };
    });
  }

  async moderateDiscussionComment(
    actor: AuthenticatedUser,
    groupId: string,
    commentId: string,
    input: { status: 'visible' | 'hidden' | 'removed' },
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      await this.assertManager(client, group.id, actor.id);
      const result = await client.query<CommentRow>(
        `UPDATE community.comments SET status = $3,
           deleted_at = CASE WHEN $3 = 'visible' THEN NULL ELSE clock_timestamp() END,
           deleted_by = CASE WHEN $3 = 'visible' THEN NULL ELSE $4 END
         WHERE id = $1 AND target_type = 'group' AND target_id = $2
         RETURNING *, NULL::text AS author_name`,
        [commentId, group.id, input.status, actor.id],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('DISCUSSION_POST_NOT_FOUND', '内容不存在。', 404);
      await this.audit(client, actor.id, 'group.discussion.moderated', 'comment', commentId, {
        status: input.status,
      });
      await this.change(client, actor.id, group.id, Number(group.version), 'group.discussion.moderated', {
        commentId,
        status: input.status,
      });
      return this.commentView(row);
    });
  }

  private assertDiscussionAudience(group: GroupRow): void {
    if (!group.membership_status || !['active', 'muted'].includes(group.membership_status)) {
      throw new DomainError('GROUP_DISCUSSION_FORBIDDEN', '只有群成员可以查看群组讨论区。', 403);
    }
  }

  private assertCanPost(actor: AuthenticatedUser, group: GroupRow): void {
    if (!group.membership_status || !['active', 'muted'].includes(group.membership_status)) {
      throw new DomainError('GROUP_DISCUSSION_FORBIDDEN', '只有群成员可以参与群组讨论区。', 403);
    }
    if (group.membership_status === 'muted') {
      throw new DomainError('GROUP_DISCUSSION_MUTED', '你已被禁言，暂不能在讨论区发言。', 403);
    }
    if (!actor.phoneVerified) {
      throw new DomainError('PHONE_VERIFICATION_REQUIRED', '在讨论区发言前需要验证日本手机号。', 403, {
        actions: [{ type: 'verifyPhone', label: '继续验证' }],
      });
    }
    if (actor.restrictions.includes('commentBlocked')) {
      throw new DomainError('DISCUSSION_RESTRICTED', '你的账号当前被限制发布内容。', 403);
    }
  }

  private async assertCleanContent(client: PoolClient, body: string): Promise<void> {
    const words = await this.discussionBannedWords(client);
    if (findBannedTerm(body, words)) {
      throw new DomainError(
        'DISCUSSION_CONTENT_BLOCKED',
        '内容包含被禁止的攻击性词语，请修改后再发送。',
        422,
        { retryable: false },
      );
    }
  }

  private async discussionBannedWords(client: PoolClient): Promise<readonly string[]> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = 'community.discussion.banned_words' AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
    );
    const configured = result.rows[0]?.value_json;
    if (Array.isArray(configured)) {
      return configured.filter((entry): entry is string => typeof entry === 'string');
    }
    return DEFAULT_DISCUSSION_BANNED_WORDS;
  }

  private async assertPostRate(client: PoolClient, groupId: string, authorId: string): Promise<void> {
    const limit = Number(
      await this.points.configBigInt(client, 'community.discussion.post_rate_per_hour', 20n),
    );
    const result = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM community.comments
       WHERE target_type = 'group' AND target_id = $1 AND author_id = $2
         AND created_at >= clock_timestamp() - interval '1 hour'`,
      [groupId, authorId],
    );
    if (Number(result.rows[0]?.count ?? 0) >= limit) {
      throw new DomainError('DISCUSSION_RATE_LIMITED', '发言过于频繁，请稍后再试。', 429);
    }
  }

  private discussionView(row: DiscussionRow): Record<string, unknown> {
    return {
      id: row.id,
      groupId: row.target_id,
      author: { id: row.author_id, name: row.author_name ?? 'Spott 用户' },
      body: row.body,
      parentId: row.parent_id,
      locale: row.source_language,
      likeCount: Number(row.like_count ?? 0),
      viewerLiked: row.viewer_liked ?? false,
      replyCount: Number(row.reply_count ?? 0),
      version: Number(row.version),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  async startTransfer(actor: AuthenticatedUser, groupId: string, targetUserId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      if (group.owner_id !== actor.id) throw new DomainError('GROUP_TRANSFER_FORBIDDEN', '只有群主可以发起转让。', 403);
      const target = await client.query<{ joined_at: Date; phone_verified_at: Date | null }>(
        `SELECT membership.joined_at, target.phone_verified_at
         FROM community.group_memberships membership
         JOIN identity.users target ON target.id = membership.user_id
         WHERE membership.group_id = $1 AND membership.user_id = $2
           AND membership.status = 'active' AND membership.joined_at <= clock_timestamp() - interval '7 days'`,
        [group.id, targetUserId],
      );
      if (!target.rows[0]?.phone_verified_at) {
        throw new DomainError('GROUP_TRANSFER_TARGET_INELIGIBLE', '接收人需验证日本手机号并入群满 7 天。', 422);
      }
      const result = await client.query<{
        id: string;
        state: string;
        created_at: Date;
        expires_at: Date;
      }>(
        `INSERT INTO community.group_transfers(
           group_id, from_user, to_user, from_confirmed_at, expires_at
         ) VALUES ($1,$2,$3,clock_timestamp(),clock_timestamp() + interval '7 days')
         RETURNING id, state, created_at, expires_at`,
        [group.id, actor.id, targetUserId],
      );
      await this.audit(client, actor.id, 'group.transfer.started', 'group_transfer', result.rows[0]!.id, {
        groupId: group.id,
        targetUserId,
      });
      return {
        id: result.rows[0]!.id,
        groupId: group.id,
        fromUserId: actor.id,
        toUserId: targetUserId,
        state: result.rows[0]!.state,
        expiresAt: result.rows[0]!.expires_at.toISOString(),
      };
    });
  }

  async activeTransfer(actor: AuthenticatedUser, groupId: string): Promise<unknown> {
    const result = await this.database.query<{
      id: string;
      group_id: string;
      owner_id: string;
      from_user: string;
      to_user: string;
      state: 'awaiting_target' | 'cooling_off';
      expires_at: Date;
      cooldown_until: Date | null;
    }>(
      `SELECT transfer.id, transfer.group_id, group_record.owner_id,
         transfer.from_user, transfer.to_user, transfer.state,
         transfer.expires_at, transfer.cooldown_until
       FROM community.group_transfers transfer
       JOIN community.groups group_record ON group_record.id = transfer.group_id
       WHERE transfer.group_id = $1
         AND transfer.state IN ('awaiting_target','cooling_off')
         AND transfer.expires_at > clock_timestamp()
         AND group_record.deleted_at IS NULL
       ORDER BY transfer.created_at DESC
       LIMIT 1`,
      [groupId],
    );
    const transfer = result.rows[0];
    if (!transfer) throw new DomainError('GROUP_TRANSFER_NOT_FOUND', '当前没有进行中的群主转让。', 404);
    if (![transfer.owner_id, transfer.from_user, transfer.to_user].includes(actor.id)) {
      throw new DomainError('GROUP_TRANSFER_FORBIDDEN', '无权查看此群主转让。', 403);
    }
    return {
      id: transfer.id,
      groupId: transfer.group_id,
      fromUserId: transfer.from_user,
      toUserId: transfer.to_user,
      state: transfer.state,
      expiresAt: transfer.expires_at.toISOString(),
      cooldownUntil: transfer.cooldown_until?.toISOString() ?? null,
    };
  }

  async acceptTransfer(actor: AuthenticatedUser, groupId: string, transferId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      const result = await client.query<{ cooldown_until: Date }>(
        `UPDATE community.group_transfers SET state = 'cooling_off',
           to_confirmed_at = clock_timestamp(), cooldown_until = clock_timestamp() + interval '24 hours'
         WHERE id = $1 AND group_id = $2 AND to_user = $3
           AND state = 'awaiting_target' AND expires_at > clock_timestamp()
         RETURNING cooldown_until`,
        [transferId, group.id, actor.id],
      );
      if (!result.rows[0]) throw new DomainError('GROUP_TRANSFER_INVALID', '转让请求无效或已过期。', 409);
      await client.query("UPDATE community.groups SET status = 'transfer_pending' WHERE id = $1", [group.id]);
      await this.audit(client, actor.id, 'group.transfer.accepted', 'group_transfer', transferId, {});
      return {
        id: transferId,
        groupId: group.id,
        state: 'cooling_off',
        cooldownUntil: result.rows[0].cooldown_until.toISOString(),
      };
    });
  }

  async completeTransfer(actor: AuthenticatedUser, groupId: string, transferId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      const transfer = await client.query<{ from_user: string; to_user: string }>(
        `SELECT from_user, to_user FROM community.group_transfers
         WHERE id = $1 AND group_id = $2 AND state = 'cooling_off'
           AND cooldown_until <= clock_timestamp() FOR UPDATE`,
        [transferId, group.id],
      );
      const row = transfer.rows[0];
      if (!row || ![row.from_user, row.to_user].includes(actor.id)) {
        throw new DomainError('GROUP_TRANSFER_COOLDOWN', '转让仍在冷静期或无权完成。', 409);
      }
      await client.query(
        "UPDATE community.group_memberships SET role = 'member', updated_at = clock_timestamp() WHERE group_id = $1 AND user_id = $2",
        [group.id, row.from_user],
      );
      await client.query(
        "UPDATE community.group_memberships SET role = 'owner', status = 'active', updated_at = clock_timestamp() WHERE group_id = $1 AND user_id = $2",
        [group.id, row.to_user],
      );
      await client.query(
        "UPDATE community.groups SET owner_id = $2, status = 'active' WHERE id = $1",
        [group.id, row.to_user],
      );
      await client.query(
        "UPDATE community.group_transfers SET state = 'completed', completed_at = clock_timestamp() WHERE id = $1",
        [transferId],
      );
      await this.audit(client, actor.id, 'group.transfer.completed', 'group_transfer', transferId, row);
      return { id: transferId, groupId: group.id, state: 'completed', ownerId: row.to_user };
    });
  }

  async cancelTransfer(actor: AuthenticatedUser, groupId: string, transferId: string, reason: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      const result = await client.query(
        `UPDATE community.group_transfers SET state = 'cancelled', cancelled_by = $3, cancel_reason = $4
         WHERE id = $1 AND group_id = $2 AND state IN ('awaiting_target','cooling_off')
           AND (from_user = $3 OR to_user = $3)`,
        [transferId, group.id, actor.id, reason],
      );
      if (!result.rowCount) throw new DomainError('GROUP_TRANSFER_INVALID', '转让请求不存在或不能取消。', 409);
      await client.query("UPDATE community.groups SET status = 'active' WHERE id = $1", [group.id]);
      await this.audit(client, actor.id, 'group.transfer.cancelled', 'group_transfer', transferId, { reason });
      return { id: transferId, groupId: group.id, state: 'cancelled' };
    });
  }

  async requestDissolution(actor: AuthenticatedUser, groupId: string, reason: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      if (group.owner_id !== actor.id) throw new DomainError('GROUP_DISSOLUTION_FORBIDDEN', '只有群主可以解散群组。', 403);
      const activeEvents = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM events.events
         WHERE group_id = $1 AND deleted_at IS NULL
           AND status NOT IN ('ended','cancelled','removed','archived','deleted','rejected')`,
        [group.id],
      );
      if (Number(activeEvents.rows[0]?.count ?? 0) > 0) {
        throw new DomainError('GROUP_DISSOLUTION_ACTIVE_EVENTS', '群组仍有未结束活动，暂不能解散。', 409);
      }
      const requestedAt = new Date();
      const scheduledFor = new Date(requestedAt.getTime() + 7 * 86_400_000);
      const result = await client.query<{ id: string }>(
        `INSERT INTO community.group_dissolutions(
           group_id, requested_by, reason, scheduled_for, created_at
         ) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [group.id, actor.id, reason, scheduledFor, requestedAt],
      );
      await client.query(
        "UPDATE community.groups SET status = 'closing', closing_at = $2, dissolve_after = $3 WHERE id = $1",
        [group.id, requestedAt, scheduledFor],
      );
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('group',$1,'group.dissolution_scheduled',$2)`,
        [group.id, { groupId: group.id, scheduledFor: scheduledFor.toISOString() }],
      );
      await this.audit(client, actor.id, 'group.dissolution.scheduled', 'group_dissolution', result.rows[0]!.id, {
        scheduledFor,
      });
      return { id: result.rows[0]!.id, groupId: group.id, state: 'scheduled', scheduledFor: scheduledFor.toISOString() };
    });
  }

  async cancelDissolution(actor: AuthenticatedUser, groupId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      if (group.owner_id !== actor.id) throw new DomainError('GROUP_DISSOLUTION_FORBIDDEN', '只有群主可以取消解散。', 403);
      const result = await client.query<{ id: string }>(
        `UPDATE community.group_dissolutions SET cancelled_at = clock_timestamp(), cancelled_by = $2
         WHERE group_id = $1 AND cancelled_at IS NULL AND completed_at IS NULL
           AND scheduled_for > clock_timestamp() RETURNING id`,
        [group.id, actor.id],
      );
      if (!result.rows[0]) throw new DomainError('GROUP_DISSOLUTION_NOT_FOUND', '没有可取消的解散计划。', 404);
      await client.query(
        "UPDATE community.groups SET status = 'active', closing_at = NULL, dissolve_after = NULL WHERE id = $1",
        [group.id],
      );
      return { id: result.rows[0].id, groupId: group.id, state: 'cancelled' };
    });
  }

  async finalizeDissolution(actor: AuthenticatedUser, groupId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const group = await this.load(client, groupId, actor.id, true);
      if (group.owner_id !== actor.id && !actor.roles.includes('operator')) {
        throw new DomainError('GROUP_DISSOLUTION_FORBIDDEN', '无权完成解散。', 403);
      }
      const result = await client.query<{ id: string }>(
        `UPDATE community.group_dissolutions SET completed_at = clock_timestamp()
         WHERE group_id = $1 AND cancelled_at IS NULL AND completed_at IS NULL
           AND scheduled_for <= clock_timestamp() RETURNING id`,
        [group.id],
      );
      if (!result.rows[0]) throw new DomainError('GROUP_DISSOLUTION_COOLDOWN', '七天通知期尚未结束。', 409);
      await client.query(
        "UPDATE community.groups SET status = 'dissolved', deleted_at = clock_timestamp() WHERE id = $1",
        [group.id],
      );
      await this.audit(client, actor.id, 'group.dissolution.completed', 'group_dissolution', result.rows[0].id, {});
      return { id: result.rows[0].id, groupId: group.id, state: 'completed' };
    });
  }

  private async load(client: PoolClient, identifier: string, viewerId: string | undefined, lock: boolean): Promise<GroupRow> {
    const result = await client.query<GroupRow>(
      `SELECT g.*, owner.public_handle AS owner_handle, profile.nickname AS owner_name,
         (SELECT COALESCE(cover.derivatives->'hero'->>'url', cover.derivatives->'card'->>'url')
          FROM media.assets cover WHERE cover.id = g.cover_asset_id AND cover.state = 'ready'
            AND cover.moderation_state = 'approved') AS cover_url,
         (SELECT count(*) FROM community.group_memberships member
          WHERE member.group_id = g.id AND member.status IN ('active','muted'))::text AS member_count,
         viewer.status::text AS membership_status, viewer.role::text AS membership_role,
         EXISTS(SELECT 1 FROM identity.follows follow
           WHERE follow.follower_id = $2 AND follow.target_type = 'group'
             AND follow.target_id = g.id AND follow.deleted_at IS NULL) AS viewer_following,
         COALESCE((SELECT jsonb_agg(summary ORDER BY (summary->>'created_at')::timestamptz DESC)
           FROM (SELECT jsonb_build_object(
             'id', announcement.id, 'group_id', announcement.group_id,
             'author_id', announcement.author_id, 'title', announcement.title,
             'body', announcement.body, 'visibility', announcement.visibility,
             'comments_enabled', announcement.comments_enabled,
             'pinned_at', announcement.pinned_at, 'version', announcement.version,
             'created_at', announcement.created_at, 'updated_at', announcement.updated_at
           ) AS summary FROM community.announcements announcement
           WHERE announcement.group_id = g.id AND announcement.deleted_at IS NULL
             AND (announcement.visibility = 'public' OR viewer.status IN ('active','muted'))
           ORDER BY announcement.pinned_at DESC NULLS LAST, announcement.created_at DESC LIMIT 3) recent
         ), '[]'::jsonb) AS announcement_summary
       FROM community.groups g
       JOIN identity.users owner ON owner.id = g.owner_id
       LEFT JOIN identity.profiles profile ON profile.user_id = g.owner_id AND profile.deleted_at IS NULL
       LEFT JOIN community.group_memberships viewer
         ON viewer.group_id = g.id AND viewer.user_id = $2
           AND viewer.status IN ('active','muted','pending')
       WHERE (g.id::text = $1 OR g.slug = $1) AND g.deleted_at IS NULL
         AND g.status NOT IN ('dissolved','removed')
       ${lock ? 'FOR UPDATE OF g' : ''}`,
      [identifier, viewerId ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('GROUP_NOT_FOUND', '群组不存在或已不可见。', 404);
    return row;
  }

  private view(row: GroupRow, viewerId?: string): Record<string, unknown> {
    const memberCount = Number(row.member_count);
    return {
      id: row.id,
      ownerId: row.owner_id,
      owner: {
        id: row.owner_id,
        name: row.owner_name ?? `@${row.owner_handle}`,
        handle: row.owner_handle,
      },
      name: row.name,
      slug: row.slug,
      description: row.description,
      coverURL: row.cover_url ?? null,
      joinMode: row.join_mode,
      regionId: row.region_id,
      categoryId: row.category_id,
      tags: row.tags,
      rules: row.rules,
      capacity: row.capacity,
      memberCount,
      status: row.status,
      membershipStatus: row.membership_status,
      membershipRole: row.membership_role,
      viewerFollowing: row.viewer_following,
      announcementSummary: row.announcement_summary.map((item) => this.announcementView(item)),
      closingAt: row.closing_at?.toISOString() ?? null,
      dissolveAfter: row.dissolve_after?.toISOString() ?? null,
      availableActions: [
        ...(viewerId === row.owner_id ? ['manage', 'purchaseCapacity', 'transferGroup', 'dissolveGroup'] : []),
        ...(!row.membership_status && memberCount < row.capacity && row.status === 'active' ? ['joinGroup'] : []),
        ...(row.membership_status ? ['viewAnnouncements'] : []),
        ...(row.viewer_following ? ['unfollowGroup'] : ['followGroup']),
      ],
      version: Number(row.version),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private announcementView(row: AnnouncementRow): Record<string, unknown> {
    return {
      id: row.id,
      groupId: row.group_id,
      authorId: row.author_id,
      authorName: row.author_name ?? null,
      title: row.title,
      body: row.body,
      visibility: row.visibility,
      commentsEnabled: row.comments_enabled,
      pinnedAt: row.pinned_at instanceof Date ? row.pinned_at.toISOString() : row.pinned_at ?? null,
      likeCount: Number(row.like_count ?? 0),
      viewerLiked: row.viewer_liked ?? false,
      commentCount: Number(row.comment_count ?? 0),
      version: Number(row.version),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    };
  }

  private commentView(row: CommentRow): Record<string, unknown> {
    return {
      id: row.id,
      announcementId: row.target_id,
      author: { id: row.author_id, name: row.author_name ?? 'Spott 用户' },
      body: row.body,
      parentId: row.parent_id,
      locale: row.source_language,
      version: Number(row.version),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private requireVerified(user: AuthenticatedUser): void {
    if (!user.phoneVerified) {
      throw new DomainError('PHONE_VERIFICATION_REQUIRED', '创建或加入群组前需要验证日本手机号。', 403, {
        actions: [{ type: 'verifyPhone', label: '继续验证' }],
      });
    }
  }

  private async assertManager(client: PoolClient, groupId: string, actorId: string): Promise<'owner' | 'admin'> {
    const result = await client.query<{ role: 'owner' | 'admin' }>(
      `SELECT role::text FROM community.group_memberships
       WHERE group_id = $1 AND user_id = $2 AND status = 'active' AND role IN ('owner','admin')`,
      [groupId, actorId],
    );
    const role = result.rows[0]?.role;
    if (!role) throw new DomainError('GROUP_MANAGEMENT_FORBIDDEN', '没有群组管理权限。', 403);
    return role;
  }

  private async assertAnnouncementReadable(client: PoolClient, group: GroupRow, announcementId: string): Promise<void> {
    const result = await client.query<{ visibility: string }>(
      `SELECT visibility FROM community.announcements
       WHERE id = $1 AND group_id = $2 AND deleted_at IS NULL`,
      [announcementId, group.id],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('ANNOUNCEMENT_NOT_FOUND', '公告不存在。', 404);
    if (row.visibility === 'members' && !['active', 'muted'].includes(group.membership_status ?? '')) {
      throw new DomainError('ANNOUNCEMENT_FORBIDDEN', '此公告仅群成员可见。', 403);
    }
  }

  private async change(
    client: PoolClient,
    userId: string,
    groupId: string,
    version: number,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const changePayload = { groupId, ...payload };
    await client.query(
      "SELECT sync.record_change($1, $2, 'group', $3, 'upsert', $4, $5, $6)",
      [userId, type, groupId, version, Object.keys(payload), changePayload],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('group', $1, $2, $3)`,
      [groupId, type, changePayload],
    );
  }

  private async audit(
    client: PoolClient,
    actorId: string,
    action: string,
    resource: string,
    resourceId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO admin.audit_logs(actor_id, action, resource, resource_id, after_hash, trace_id)
       VALUES ($1,$2,$3,$4,digest($5::text,'sha256'),$6)`,
      [actorId, action, resource, resourceId, JSON.stringify(after), `group-${resourceId}`],
    );
  }

  private codeHash(code: string): Buffer {
    return createHmac('sha256', configuration().ACCESS_TOKEN_SECRET).update(`group-invite:${code}`).digest();
  }

  private encodeCursor(date: Date, id: string): string {
    return Buffer.from(JSON.stringify({ date: date.toISOString(), id })).toString('base64url');
  }

  private decodeCursor(cursor?: string): { date: string; id: string } | null {
    if (!cursor) return null;
    try {
      const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { date?: string; id?: string };
      if (!value.date || !value.id) throw new Error('invalid');
      return { date: value.date, id: value.id };
    } catch {
      throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    }
  }

  private encodeDateCursor(date: Date): string {
    return Buffer.from(date.toISOString()).toString('base64url');
  }

  private decodeDateCursor(cursor?: string): Date | null {
    if (!cursor) return null;
    const value = new Date(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Number.isNaN(value.getTime())) throw new DomainError('CURSOR_INVALID', '分页游标无效。', 400);
    return value;
  }

  private pgCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
  }
}
