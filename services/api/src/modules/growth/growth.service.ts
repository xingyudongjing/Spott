import { randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { Database } from '../../platform/database.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';

@Injectable()
export class GrowthService {
  constructor(private readonly database: Database) {}

  async createShare(userId: string, input: { resourceType: string; resourceId: string; campaign?: string | undefined }): Promise<unknown> {
    await this.assertResource(input.resourceType, input.resourceId);
    const code = randomBytes(9).toString('base64url');
    const row = await this.database.query<{ id: string; created_at: Date }>(
      `INSERT INTO growth.share_links(public_code, resource_type, resource_id, creator_id, campaign)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [code, input.resourceType, input.resourceId, userId, input.campaign ?? null],
    );
    return { id: row.rows[0]!.id, code, url: `https://spott.jp/s/${code}`, createdAt: row.rows[0]!.created_at.toISOString() };
  }

  async open(code: string, sessionId?: string, anonymousId?: string, userId?: string): Promise<unknown> {
    const link = await this.database.query<{ id: string; resource_type: string; resource_id: string }>(
      `SELECT id, resource_type, resource_id FROM growth.share_links
       WHERE public_code = $1 AND disabled_at IS NULL AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [code],
    );
    const row = link.rows[0];
    if (!row) throw new DomainError('SHARE_NOT_FOUND', '分享链接不存在或已失效。', 404);
    const validSession = sessionId && /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : randomUUID();
    const validAnonymous = anonymousId && /^[0-9a-f-]{36}$/i.test(anonymousId) ? anonymousId : null;
    await this.database.query(
      `INSERT INTO growth.attributions(share_link_id, anonymous_user_id, user_id, session_id, action, occurred_at)
       VALUES ($1,$2,$3,$4,'opened',clock_timestamp())`,
      [row.id, validAnonymous, userId ?? null, validSession],
    );
    return { resourceType: row.resource_type, resourceId: row.resource_id, canonicalPath: this.path(row.resource_type, row.resource_id), sessionId: validSession };
  }

  async createPoster(user: AuthenticatedUser, input: { resourceType: string; resourceId: string; template: string; locale: string; mode: string }): Promise<unknown> {
    await this.assertResource(input.resourceType, input.resourceId);
    if (input.mode === 'ai_assisted' && process.env.FEATURE_AI_POSTER !== 'true') {
      throw new DomainError('FEATURE_DISABLED', 'AI 辅助海报正在灰度中，可先使用品牌模板。', 422, {
        actions: [{ type: 'useTemplate', label: '使用品牌模板' }],
      });
    }
    const row = await this.database.query<{ id: string; created_at: Date }>(
      `INSERT INTO growth.poster_jobs(user_id, resource_type, resource_id, template, locale)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [user.id, input.resourceType, input.resourceId, input.mode === 'ai_assisted' ? `ai:${input.template}` : input.template, input.locale],
    );
    await this.database.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ('poster', $1, 'poster.render_requested', $2)`,
      [row.rows[0]!.id, { posterJobId: row.rows[0]!.id, ...input }],
    );
    return { id: row.rows[0]!.id, state: 'queued', createdAt: row.rows[0]!.created_at.toISOString() };
  }

  async poster(userId: string, id: string): Promise<unknown> {
    const row = await this.database.query<{
      id: string;
      state: string;
      asset_id: string | null;
      failure_code: string | null;
      template: string;
      locale: string;
      updated_at: Date;
      url: string | null;
    }>(
      `SELECT job.id, job.state, job.asset_id, job.failure_code, job.template, job.locale,
         job.updated_at,
         CASE WHEN job.state = 'ready' AND asset.state = 'ready'
           AND asset.moderation_state = 'approved'
           THEN asset.derivatives->'poster'->>'url' ELSE NULL END AS url
       FROM growth.poster_jobs job
       LEFT JOIN media.assets asset ON asset.id = job.asset_id
       WHERE job.id = $1 AND job.user_id = $2`,
      [id, userId],
    );
    if (!row.rows[0]) throw new DomainError('POSTER_NOT_FOUND', '海报任务不存在。', 404);
    const result = row.rows[0];
    return {
      id: result.id,
      state: result.state,
      assetId: result.asset_id,
      url: result.url,
      failureCode: result.failure_code,
      template: result.template,
      locale: result.locale,
      updatedAt: result.updated_at.toISOString(),
    };
  }

  async eventPoster(actor: AuthenticatedUser, eventId: string): Promise<unknown> {
    const row = await this.database.query<{
      id: string;
      organizer_id: string;
      state: string;
      asset_id: string | null;
      failure_code: string | null;
      template: string;
      locale: string;
      updated_at: Date;
      url: string | null;
    }>(
      `SELECT job.id, event_record.organizer_id, job.state, job.asset_id,
         job.failure_code, job.template, job.locale, job.updated_at,
         CASE WHEN job.state = 'ready' AND asset.state = 'ready'
           AND asset.moderation_state = 'approved'
           THEN asset.derivatives->'poster'->>'url' ELSE NULL END AS url
       FROM events.events event_record
       JOIN growth.poster_jobs job ON job.resource_type = 'event'
         AND job.resource_id = event_record.id
       LEFT JOIN media.assets asset ON asset.id = job.asset_id
       WHERE event_record.id = $1 AND event_record.deleted_at IS NULL
         AND (event_record.organizer_id = $2 OR $3::boolean)
       ORDER BY (job.template = 'event_approved') DESC, job.created_at DESC, job.id DESC
       LIMIT 1`,
      [eventId, actor.id, actor.roles.includes('operator')],
    );
    const result = row.rows[0];
    if (!result) throw new DomainError('EVENT_POSTER_NOT_FOUND', '活动海报尚未生成。', 404);
    return {
      id: result.id,
      resourceType: 'event',
      resourceId: eventId,
      state: result.state,
      assetId: result.asset_id,
      url: result.url,
      failureCode: result.failure_code,
      template: result.template,
      locale: result.locale,
      updatedAt: result.updated_at.toISOString(),
    };
  }

  private async assertResource(type: string, id: string): Promise<void> {
    const table = type === 'event' ? 'events.events' : type === 'group' ? 'community.groups' : 'identity.profiles';
    const column = type === 'profile' ? 'user_id' : 'id';
    const result = await this.database.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [id]);
    if (!result.rowCount) throw new DomainError('RESOURCE_NOT_FOUND', '分享对象不存在。', 404);
  }

  private path(type: string, id: string): string {
    return type === 'event' ? `/e/${id}` : type === 'group' ? `/g/${id}` : `/u/${id}`;
  }
}
