import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { Database } from '../../platform/database.js';
import { ProfilesService } from '../profiles/profiles.service.js';

interface PushOperation {
  operationId: string;
  entityType: string;
  entityId?: string | null | undefined;
  action: string;
  baseVersion?: number | null | undefined;
  patch?: Record<string, unknown> | undefined;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly database: Database,
    private readonly profiles: ProfilesService,
  ) {}

  async pull(userId: string, cursor: number, limit: number): Promise<unknown> {
    const safeLimit = Math.min(Math.max(limit, 1), 500);
    const boundary = await this.database.query<{ min_seq: string | null; max_seq: string | null }>(
      `SELECT min(seq)::text AS min_seq, max(seq)::text AS max_seq FROM sync.change_log
       WHERE user_scope = $1 OR topic = 'public'`,
      [userId],
    );
    const minSeq = Number(boundary.rows[0]?.min_seq ?? 0);
    if (cursor > 0 && minSeq > 0 && cursor < minSeq - 1) {
      throw new DomainError('CURSOR_EXPIRED', '同步游标已过期，需要重建安全快照。', 409, {
        actions: [{ type: 'rebuildSnapshot', label: '重新同步' }],
        meta: { minimumCursor: minSeq - 1 },
      });
    }
    const result = await this.database.query<{
      seq: string;
      entity_type: string;
      entity_id: string;
      operation: 'upsert' | 'tombstone';
      version: string;
      changed_fields: string[];
      payload: Record<string, unknown>;
    }>(
      `SELECT seq, entity_type, entity_id, operation, version, changed_fields, payload
       FROM sync.change_log
       WHERE seq > $1 AND (user_scope = $2 OR topic = 'public')
       ORDER BY seq LIMIT $3`,
      [cursor, userId, safeLimit + 1],
    );
    const hasMore = result.rows.length > safeLimit;
    const rows = result.rows.slice(0, safeLimit);
    const nextCursor = rows.length > 0 ? Number(rows.at(-1)!.seq) : cursor;
    return {
      nextCursor,
      hasMore,
      serverTime: new Date().toISOString(),
      changes: rows.map((row) => ({
        seq: Number(row.seq),
        entityType: row.entity_type,
        entityId: row.entity_id,
        operation: row.operation,
        version: Number(row.version),
        changedFields: row.changed_fields,
        payload: row.payload,
      })),
    };
  }

  async push(userId: string, deviceId: string, operations: PushOperation[]): Promise<unknown> {
    const results: unknown[] = [];
    for (const operation of operations) {
      try {
        const result = await this.applyOperation(userId, deviceId, operation);
        results.push({ operationId: operation.operationId, state: 'applied', result });
      } catch (error) {
        if (error instanceof DomainError) {
          results.push({
            operationId: operation.operationId,
            state: error.code === 'VERSION_CONFLICT' ? 'conflict' : 'failed',
            error: error.toJSON(),
          });
        } else {
          throw error;
        }
      }
    }
    return { results, serverTime: new Date().toISOString() };
  }

  private async applyOperation(userId: string, deviceId: string, operation: PushOperation): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const requestHash = Buffer.from(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(operation))),
      );
      const inserted = await client.query(
        `INSERT INTO sync.pending_operations(
           operation_id, device_id, user_id, entity_type, entity_id, action,
           base_version, request_hash, state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received')
         ON CONFLICT (operation_id) DO NOTHING`,
        [
          operation.operationId,
          deviceId,
          userId,
          operation.entityType,
          operation.entityId ?? null,
          operation.action,
          operation.baseVersion ?? null,
          requestHash,
        ],
      );
      if (inserted.rowCount === 0) {
        const existing = await client.query<{
          request_hash: Buffer;
          state: string;
          result: unknown;
        }>('SELECT request_hash, state, result FROM sync.pending_operations WHERE operation_id = $1', [
          operation.operationId,
        ]);
        const row = existing.rows[0];
        if (!row?.request_hash.equals(requestHash)) {
          throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'operationId 已用于不同操作。', 409);
        }
        return row.result;
      }

      let result: unknown;
      if (operation.entityType === 'profile' && operation.action === 'patch') {
        result = await this.profiles.applyPatch(
          client,
          userId,
          operation.baseVersion ?? 0,
          {
            ...(typeof operation.patch?.nickname === 'string'
              ? { nickname: operation.patch.nickname }
              : {}),
            ...(typeof operation.patch?.bio === 'string' ? { bio: operation.patch.bio } : {}),
            ...(typeof operation.patch?.regionId === 'string'
              ? { regionId: operation.patch.regionId }
              : {}),
          },
        );
      } else if (operation.entityType === 'favorite' && operation.entityId) {
        const favorited = operation.action === 'put';
        if (!favorited && operation.action !== 'delete') {
          throw new DomainError('SYNC_OPERATION_UNSUPPORTED', '不支持的收藏操作。', 400);
        }
        if (favorited) {
          await client.query(
            `INSERT INTO events.event_favorites(user_id, event_id) VALUES ($1, $2)
             ON CONFLICT (user_id, event_id) DO UPDATE SET deleted_at = NULL`,
            [userId, operation.entityId],
          );
        } else {
          await client.query(
            'UPDATE events.event_favorites SET deleted_at = clock_timestamp() WHERE user_id = $1 AND event_id = $2',
            [userId, operation.entityId],
          );
        }
        result = { eventId: operation.entityId, favorited };
      } else if (operation.entityType === 'notification' && operation.action === 'read' && operation.entityId) {
        await client.query(
          `UPDATE notification.notifications SET read_at = COALESCE(read_at, clock_timestamp())
           WHERE id = $1 AND user_id = $2`,
          [operation.entityId, userId],
        );
        result = { notificationId: operation.entityId, read: true };
      } else {
        throw new DomainError('SYNC_OPERATION_UNSUPPORTED', '该操作不能离线排队。', 400);
      }
      await client.query(
        `UPDATE sync.pending_operations SET state = 'applied', result = $2,
           updated_at = clock_timestamp() WHERE operation_id = $1`,
        [operation.operationId, result],
      );
      return result;
    });
  }
}
