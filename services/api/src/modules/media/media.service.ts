import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { Database } from '../../platform/database.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';

@Injectable()
export class MediaService {
  constructor(private readonly database: Database) {}

  async createIntent(user: AuthenticatedUser, input: {
    purpose: string; filename: string; mimeType: string; byteSize: number; focalX: number; focalY: number;
  }): Promise<unknown> {
    if (user.restrictions.includes('publishBlocked') && input.purpose !== 'report_evidence') {
      throw new DomainError('MEDIA_UPLOAD_RESTRICTED', '当前账号暂不能上传公开内容。', 403);
    }
    const extension = this.extension(input.mimeType);
    const objectKey = `original/${user.id}/${Date.now()}-${randomBytes(12).toString('hex')}.${extension}`;
    const result = await this.database.query<{ id: string; created_at: Date }>(
      `INSERT INTO media.assets(owner_id, purpose, object_key, original_filename, mime_type, byte_size, focal_x, focal_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [user.id, input.purpose, objectKey, input.filename, input.mimeType, input.byteSize, input.focalX, input.focalY],
    );
    const asset = result.rows[0]!;
    const endpoint = process.env.MEDIA_UPLOAD_ORIGIN ?? 'http://127.0.0.1:9100/spott-media';
    return {
      assetId: asset.id,
      method: 'PUT',
      uploadUrl: `${endpoint}/${objectKey}`,
      requiredHeaders: { 'Content-Type': input.mimeType, 'X-Spott-Asset-Id': asset.id },
      expiresAt: new Date(asset.created_at.getTime() + 15 * 60_000).toISOString(),
      maxBytes: input.byteSize,
    };
  }

  async complete(user: AuthenticatedUser, assetId: string, hash: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{ id: string; state: string; object_key: string }>(
        `UPDATE media.assets SET state = 'uploaded', content_hash = decode($3, 'hex'),
           uploaded_at = COALESCE(uploaded_at, clock_timestamp()), updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2 AND state IN ('pending_upload','uploaded')
         RETURNING id, state, object_key`,
        [assetId, user.id, hash],
      );
      const asset = result.rows[0];
      if (!asset) throw new DomainError('MEDIA_ASSET_NOT_FOUND', '上传任务不存在或已失效。', 404);
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('media.asset', $1, 'media.processing_requested', $2)`,
        [asset.id, { assetId: asset.id, objectKey: asset.object_key }],
      );
      return { assetId: asset.id, state: 'processing', moderationState: 'pending' };
    });
  }

  async attachEvent(user: AuthenticatedUser, assetId: string, eventId: string, input: { kind: string; sortOrder: number }): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const authorized = await client.query(
        `SELECT 1 FROM events.events e JOIN media.assets a ON a.id = $1
         WHERE e.id = $2 AND e.organizer_id = $3 AND a.owner_id = $3
           AND a.purpose = 'event_cover' AND a.state IN ('uploaded','processing','ready')
         FOR UPDATE OF e`,
        [assetId, eventId, user.id],
      );
      if (!authorized.rowCount) throw new DomainError('MEDIA_ATTACH_FORBIDDEN', '无权将此图片用于该活动。', 403);
      const sortOrder = input.kind === 'cover' ? 0 : Math.max(1, input.sortOrder);
      if (sortOrder > 5) {
        throw new DomainError('EVENT_MEDIA_LIMIT_EXCEEDED', '活动最多上传 6 张图片。', 422, {
          meta: { minimum: 1, maximum: 6 },
        });
      }
      const existingSlot = await client.query(
        'SELECT 1 FROM events.event_media WHERE event_id = $1 AND sort_order = $2',
        [eventId, sortOrder],
      );
      if (!existingSlot.rowCount) {
        const count = await client.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM events.event_media WHERE event_id = $1',
          [eventId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= 6) {
          throw new DomainError('EVENT_MEDIA_LIMIT_EXCEEDED', '活动最多上传 6 张图片。', 422, {
            meta: { minimum: 1, maximum: 6 },
          });
        }
      }
      const row = await client.query<{ id: string }>(
        `INSERT INTO events.event_media(
           event_id, asset_id, sort_order, focus_x, focus_y, content_hash, media_asset_id
         ) SELECT $1,id,$2,focal_x,focal_y,content_hash,id FROM media.assets WHERE id = $3
         ON CONFLICT (event_id, sort_order) DO UPDATE SET
           asset_id = EXCLUDED.asset_id, focus_x = EXCLUDED.focus_x, focus_y = EXCLUDED.focus_y,
           content_hash = EXCLUDED.content_hash, media_asset_id = EXCLUDED.media_asset_id
         RETURNING id`,
        [eventId, sortOrder, assetId],
      );
      await client.query('UPDATE events.events SET updated_by = $2 WHERE id = $1', [eventId, user.id]);
      const mediaCount = await client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM events.event_media WHERE event_id = $1',
        [eventId],
      );
      return {
        id: row.rows[0]!.id,
        eventId,
        assetId,
        kind: input.kind,
        sortOrder,
        mediaCount: Number(mediaCount.rows[0]?.count ?? 0),
      };
    });
  }

  async attachProfile(user: AuthenticatedUser, assetId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const authorized = await client.query<{
        previous_asset_id: string | null;
        owner_id: string;
        purpose: string;
        state: string;
        moderation_state: string;
        url: string | null;
      }>(
        `SELECT profile.avatar_asset_id AS previous_asset_id,
           asset.owner_id, asset.purpose, asset.state, asset.moderation_state,
           COALESCE(asset.derivatives->'thumb'->>'url', asset.derivatives->'card'->>'url',
             asset.derivatives->'hero'->>'url') AS url
         FROM identity.profiles profile
         JOIN media.assets asset ON asset.id = $1
         WHERE profile.user_id = $2 AND profile.deleted_at IS NULL
         FOR UPDATE OF profile, asset`,
        [assetId, user.id],
      );
      const binding = authorized.rows[0];
      if (!binding || binding.owner_id !== user.id || binding.purpose !== 'profile_avatar') {
        throw new DomainError('MEDIA_ATTACH_FORBIDDEN', '无权将此图片设为头像。', 403);
      }
      this.assertAttachable(binding);
      const updated = await client.query<{ version: string; updated_at: Date }>(
        `UPDATE identity.profiles SET avatar_asset_id = $1
         WHERE user_id = $2 RETURNING version, updated_at`,
        [assetId, user.id],
      );
      if (binding.previous_asset_id && binding.previous_asset_id !== assetId) {
        await client.query(
          `UPDATE media.assets old_asset SET state = 'deleted', deleted_at = clock_timestamp(),
             updated_at = clock_timestamp()
           WHERE old_asset.id = $1 AND old_asset.owner_id = $2
             AND old_asset.purpose = 'profile_avatar'
             AND NOT EXISTS (SELECT 1 FROM identity.profiles profile
               WHERE profile.avatar_asset_id = old_asset.id AND profile.deleted_at IS NULL)`,
          [binding.previous_asset_id, user.id],
        );
      }
      const result = {
        assetId,
        profileId: user.id,
        url: binding.url,
        version: Number(updated.rows[0]!.version),
      };
      await client.query(
        `SELECT sync.record_change($1, 'profile.avatar.updated', 'profile', $1,
           'upsert', $2, ARRAY['avatarURL'], $3)`,
        [user.id, updated.rows[0]!.version, result],
      );
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('profile',$1,'profile.avatar.updated',$2)`,
        [user.id, result],
      );
      return result;
    });
  }

  async attachGroup(user: AuthenticatedUser, assetId: string, groupId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const authorized = await client.query<{
        previous_asset_id: string | null;
        group_owner_id: string;
        owner_id: string;
        purpose: string;
        state: string;
        moderation_state: string;
        url: string | null;
      }>(
        `SELECT group_record.cover_asset_id AS previous_asset_id,
           group_record.owner_id AS group_owner_id,
           asset.owner_id, asset.purpose, asset.state, asset.moderation_state,
           COALESCE(asset.derivatives->'hero'->>'url', asset.derivatives->'card'->>'url',
             asset.derivatives->'thumb'->>'url') AS url
         FROM community.groups group_record
         JOIN media.assets asset ON asset.id = $1
         WHERE group_record.id = $2 AND group_record.deleted_at IS NULL
         FOR UPDATE OF group_record, asset`,
        [assetId, groupId],
      );
      const binding = authorized.rows[0];
      if (!binding || binding.group_owner_id !== user.id || binding.owner_id !== user.id
        || binding.purpose !== 'group_cover') {
        throw new DomainError('MEDIA_ATTACH_FORBIDDEN', '只有群主可以设置自己上传的群组封面。', 403);
      }
      this.assertAttachable(binding);
      const updated = await client.query<{ version: string; updated_at: Date }>(
        `UPDATE community.groups SET cover_asset_id = $1
         WHERE id = $2 RETURNING version, updated_at`,
        [assetId, groupId],
      );
      if (binding.previous_asset_id && binding.previous_asset_id !== assetId) {
        await client.query(
          `UPDATE media.assets old_asset SET state = 'deleted', deleted_at = clock_timestamp(),
             updated_at = clock_timestamp()
           WHERE old_asset.id = $1 AND old_asset.owner_id = $2
             AND old_asset.purpose = 'group_cover'
             AND NOT EXISTS (SELECT 1 FROM community.groups group_record
               WHERE group_record.cover_asset_id = old_asset.id AND group_record.deleted_at IS NULL)`,
          [binding.previous_asset_id, user.id],
        );
      }
      const result = {
        assetId,
        groupId,
        url: binding.url,
        version: Number(updated.rows[0]!.version),
      };
      await client.query(
        `SELECT sync.record_change($1, 'group.cover.updated', 'group', $2,
           'upsert', $3, ARRAY['coverURL'], $4)`,
        [user.id, groupId, updated.rows[0]!.version, result],
      );
      await client.query(
        `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
         VALUES ('group',$1,'group.cover.updated',$2)`,
        [groupId, result],
      );
      return result;
    });
  }

  private extension(mimeType: string): string {
    return ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic' } as Record<string, string>)[mimeType] ?? 'bin';
  }

  private assertAttachable(asset: {
    state: string;
    moderation_state: string;
    url: string | null;
  }): void {
    if (asset.state === 'rejected' || asset.moderation_state === 'rejected') {
      throw new DomainError('MEDIA_REJECTED', '图片未通过安全审核，请重新选择。', 422, {
        retryable: false,
        meta: { state: asset.state, moderationState: asset.moderation_state },
      });
    }
    if (asset.state === 'deleted') {
      throw new DomainError('MEDIA_ASSET_NOT_FOUND', '图片不存在或已删除。', 404);
    }
    if (asset.state !== 'ready' || asset.moderation_state !== 'approved' || !asset.url) {
      throw new DomainError('MEDIA_NOT_READY', '图片仍在处理中，请稍后重试。', 409, {
        retryable: true,
        actions: [{ type: 'retry', label: '稍后重试' }],
        meta: { state: asset.state, moderationState: asset.moderation_state },
      });
    }
  }
}
