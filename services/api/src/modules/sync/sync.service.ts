import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
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

type OperationState = 'applied' | 'conflict' | 'failed';

interface OperationOutcome {
  state: OperationState;
  result?: unknown;
  error?: unknown;
}

function canonicalJSON(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJSON);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) normalized[key] = canonicalJSON(source[key]);
    }
    return normalized;
  }
  return value;
}

@Injectable()
export class SyncService {
  constructor(
    private readonly database: Database,
    private readonly profiles: ProfilesService,
  ) {}

  async pull(userId: string, cursor: number, limit: number): Promise<unknown> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new DomainError('SYNC_CURSOR_INVALID', '同步游标无效。', 400);
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new DomainError('SYNC_LIMIT_INVALID', '同步分页大小无效。', 400);
    }
    const safeLimit = Math.min(limit, 500);
    const boundary = await this.database.query<{ min_seq: string | null }>(
      `SELECT min(seq)::text AS min_seq FROM sync.change_log`,
    );
    const minSeq = this.databaseInteger(boundary.rows[0]?.min_seq ?? '0', 'SYNC_SEQUENCE_INVALID');
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
    let previousSequence = cursor;
    const changes = rows.map((row) => {
      const seq = this.databaseInteger(row.seq, 'SYNC_SEQUENCE_INVALID');
      const version = this.databaseInteger(row.version, 'SYNC_VERSION_INVALID');
      if (seq <= previousSequence) {
        throw new DomainError('SYNC_SEQUENCE_INVALID', '同步变更序列不是严格递增。', 409, {
          meta: { previous: previousSequence, received: seq },
        });
      }
      if (version < 1) {
        throw new DomainError('SYNC_VERSION_INVALID', '同步实体版本无效。', 409, {
          meta: { entityType: row.entity_type, entityId: row.entity_id, version },
        });
      }
      if (row.operation !== 'upsert' && row.operation !== 'tombstone') {
        throw new DomainError('SYNC_OPERATION_INVALID', '同步变更操作无效。', 409);
      }
      previousSequence = seq;
      return {
        seq,
        entityType: row.entity_type,
        entityId: row.entity_id,
        operation: row.operation,
        version,
        changedFields: row.changed_fields,
        payload: row.payload,
      };
    });
    return {
      nextCursor: changes.at(-1)?.seq ?? cursor,
      hasMore,
      serverTime: new Date().toISOString(),
      changes,
    };
  }

  async push(userId: string, deviceId: string, operations: PushOperation[]): Promise<unknown> {
    await this.requireOwnedDevice(userId, deviceId);
    const results: unknown[] = [];
    for (const operation of operations) {
      try {
        const outcome = await this.applyOperation(userId, deviceId, operation);
        results.push({ operationId: operation.operationId, ...outcome });
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

  private async applyOperation(
    userId: string,
    deviceId: string,
    operation: PushOperation,
  ): Promise<OperationOutcome> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify(canonicalJSON(operation)))
      .digest();
    return this.database.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO sync.pending_operations(
           user_id, device_id, operation_id, entity_type, entity_id, action,
           base_version, request_hash, state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'received')
         ON CONFLICT (user_id, device_id, operation_id) DO NOTHING`,
        [
          userId,
          deviceId,
          operation.operationId,
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
          state: 'received' | OperationState;
          result: unknown;
        }>(
          `SELECT request_hash, state, result FROM sync.pending_operations
           WHERE user_id = $1 AND device_id = $2 AND operation_id = $3 FOR UPDATE`,
          [userId, deviceId, operation.operationId],
        );
        const row = existing.rows[0];
        if (!row?.request_hash.equals(requestHash)) {
          throw new DomainError('IDEMPOTENCY_KEY_REUSED', 'operationId 已用于不同操作。', 409);
        }
        if (row.state === 'received') {
          throw new DomainError('REQUEST_IN_PROGRESS', '相同同步操作正在处理中。', 409, {
            retryable: true,
          });
        }
        return row.state === 'applied'
          ? { state: 'applied', result: row.result }
          : { state: row.state, error: row.result };
      }

      await client.query('SAVEPOINT sync_operation');
      try {
        const result = await this.executeOperation(client, userId, operation);
        await client.query(
          `UPDATE sync.pending_operations SET state = 'applied', result = $4,
             updated_at = clock_timestamp()
           WHERE user_id = $1 AND device_id = $2 AND operation_id = $3`,
          [userId, deviceId, operation.operationId, result],
        );
        await client.query('RELEASE SAVEPOINT sync_operation');
        return { state: 'applied', result };
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        await client.query('ROLLBACK TO SAVEPOINT sync_operation');
        await client.query('RELEASE SAVEPOINT sync_operation');
        const state: OperationState = error.code === 'VERSION_CONFLICT' ? 'conflict' : 'failed';
        const serialized = error.toJSON();
        await client.query(
          `UPDATE sync.pending_operations SET state = $4, result = $5,
             updated_at = clock_timestamp()
           WHERE user_id = $1 AND device_id = $2 AND operation_id = $3`,
          [userId, deviceId, operation.operationId, state, serialized],
        );
        return { state, error: serialized };
      }
    });
  }

  private async executeOperation(
    client: PoolClient,
    userId: string,
    operation: PushOperation,
  ): Promise<unknown> {
    if (operation.entityType === 'profile' && operation.action === 'patch') {
      return this.profiles.applyPatch(
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
    }
    if (operation.entityType === 'favorite' && operation.entityId) {
      return this.applyFavorite(client, userId, operation.entityId, operation.action);
    }
    if (operation.entityType === 'notification' && operation.action === 'read' && operation.entityId) {
      await client.query(
        `UPDATE notification.notifications SET read_at = COALESCE(read_at, clock_timestamp())
         WHERE id = $1 AND user_id = $2`,
        [operation.entityId, userId],
      );
      return { notificationId: operation.entityId, read: true };
    }
    throw new DomainError('SYNC_OPERATION_UNSUPPORTED', '该操作不能离线排队。', 400);
  }

  private async applyFavorite(
    client: PoolClient,
    userId: string,
    eventId: string,
    action: string,
  ): Promise<unknown> {
    if (action !== 'put' && action !== 'delete') {
      throw new DomainError('SYNC_OPERATION_UNSUPPORTED', '不支持的收藏操作。', 400);
    }
    const event = await client.query<{ version: string }>(
      'SELECT version FROM events.events WHERE id = $1 AND deleted_at IS NULL',
      [eventId],
    );
    const row = event.rows[0];
    if (!row) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    const version = this.databaseInteger(row.version, 'SYNC_VERSION_INVALID');
    const favorited = action === 'put';
    if (favorited) {
      await client.query(
        `INSERT INTO events.event_favorites(user_id, event_id) VALUES ($1, $2)
         ON CONFLICT (user_id, event_id)
         DO UPDATE SET deleted_at = NULL, created_at = clock_timestamp()`,
        [userId, eventId],
      );
    } else {
      await client.query(
        `UPDATE events.event_favorites SET deleted_at = COALESCE(deleted_at, clock_timestamp())
         WHERE user_id = $1 AND event_id = $2`,
        [userId, eventId],
      );
    }
    const result = { eventId, favorited, version };
    await client.query(
      `SELECT sync.record_change($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userId,
        'favorite.changed',
        'favorite',
        eventId,
        favorited ? 'upsert' : 'tombstone',
        version,
        ['favorited'],
        result,
      ],
    );
    await client.query(
      `INSERT INTO sync.outbox_events(aggregate, aggregate_id, type, payload)
       VALUES ($1, $2, $3, $4)`,
      ['favorite', eventId, 'favorite.changed', { userId, ...result }],
    );
    return result;
  }

  private async requireOwnedDevice(userId: string, deviceId: string): Promise<void> {
    const device = await this.database.query<{ id: string }>(
      `SELECT id FROM identity.devices
       WHERE id = $1 AND user_id = $2 AND risk_state <> 'blocked'`,
      [deviceId, userId],
    );
    if (!device.rows[0]) {
      throw new DomainError('SYNC_DEVICE_FORBIDDEN', '同步设备不属于当前账号或已被停用。', 403);
    }
  }

  private databaseInteger(value: string | number, code: string): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new DomainError(code, '同步序列或版本超出安全范围。', 409);
    }
    return parsed;
  }
}
