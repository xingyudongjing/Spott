import { DomainError } from '@spott/domain';
import { describe, expect, it, vi } from 'vitest';
import { SyncService } from './sync.service.js';

const userId = '019b0000-0000-7000-8000-000000000001';
const deviceId = '019b0000-0000-7000-9000-000000000001';
const operationId = '019b0000-0000-7000-a000-000000000001';
const entityId = '019b0000-0000-7000-8100-000000000001';

function result(rows: unknown[] = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function profileOperation(patch: Record<string, unknown> = { nickname: 'Spott' }) {
  return {
    operationId,
    entityType: 'profile',
    entityId: userId,
    action: 'patch',
    baseVersion: 3,
    patch,
  };
}

function serviceForPush(
  clientQuery: ReturnType<typeof vi.fn>,
  applyPatch: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue({ userId, version: 4 }),
  deviceRows: unknown[] = [{ id: deviceId }],
) {
  const client = { query: clientQuery };
  const database = {
    query: vi.fn().mockResolvedValue(result(deviceRows)),
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
  };
  const profiles = { applyPatch };
  return {
    service: new SyncService(database as never, profiles as never),
    database,
    client,
    profiles,
  };
}

describe('SyncService pull correctness', () => {
  it('returns a strictly ordered page and preserves deletion tombstones', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ min_seq: '1' }]))
      .mockResolvedValueOnce(result([
        {
          seq: '11',
          entity_type: 'profile',
          entity_id: userId,
          operation: 'upsert',
          version: '2',
          changed_fields: ['nickname'],
          payload: { nickname: 'Spott' },
        },
        {
          seq: '12',
          entity_type: 'favorite',
          entity_id: entityId,
          operation: 'tombstone',
          version: '3',
          changed_fields: ['favorited'],
          payload: { eventId: entityId, favorited: false },
        },
      ]));
    const service = new SyncService({ query } as never, {} as never);

    await expect(service.pull(userId, 10, 20)).resolves.toMatchObject({
      nextCursor: 12,
      hasMore: false,
      changes: [
        { seq: 11, operation: 'upsert', version: 2 },
        { seq: 12, operation: 'tombstone', version: 3 },
      ],
    });
    expect(query.mock.calls[0]?.[0]).not.toContain('user_scope');
    expect(query.mock.calls[1]?.[0]).toContain('ORDER BY seq');
  });

  it('rejects a non-monotonic database page instead of advancing the client cursor', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce(result([{ min_seq: '1' }]))
      .mockResolvedValueOnce(result([
        {
          seq: '12', entity_type: 'profile', entity_id: userId, operation: 'upsert',
          version: '2', changed_fields: [], payload: {},
        },
        {
          seq: '11', entity_type: 'profile', entity_id: userId, operation: 'upsert',
          version: '3', changed_fields: [], payload: {},
        },
      ]));
    const service = new SyncService({ query } as never, {} as never);

    await expect(service.pull(userId, 10, 20)).rejects.toMatchObject({
      code: 'SYNC_SEQUENCE_INVALID',
      status: 409,
    });
  });

  it('rejects an unsafe cursor before issuing a database query', async () => {
    const query = vi.fn();
    const service = new SyncService({ query } as never, {} as never);

    await expect(service.pull(userId, Number.NaN, 20)).rejects.toMatchObject({
      code: 'SYNC_CURSOR_INVALID',
      status: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('SyncService push correctness', () => {
  it('rejects a device that is not owned by the authenticated user before claiming operations', async () => {
    const clientQuery = vi.fn();
    const { service, database } = serviceForPush(clientQuery, undefined, []);

    await expect(service.push(userId, deviceId, [profileOperation()])).rejects.toMatchObject({
      code: 'SYNC_DEVICE_FORBIDDEN',
      status: 403,
    });
    expect(database.transaction).not.toHaveBeenCalled();
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it('scopes an operation claim and completion to user, device and operation ID', async () => {
    const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      if (sql.includes('INSERT INTO sync.pending_operations')) return result([], 1);
      return result([], 1);
    });
    const applied = { userId, version: 4 };
    const { service } = serviceForPush(clientQuery, vi.fn().mockResolvedValue(applied));

    await expect(service.push(userId, deviceId, [profileOperation()])).resolves.toMatchObject({
      results: [{ operationId, state: 'applied', result: applied }],
    });

    const insert = clientQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO sync.pending_operations'));
    const completion = clientQuery.mock.calls.find(([sql]) => sql.includes('SET state =') && sql.includes("'applied'"));
    expect(insert?.[0]).toMatch(/ON CONFLICT\s*\(user_id,\s*device_id,\s*operation_id\)/i);
    expect(insert?.[1]?.slice(0, 3)).toEqual([userId, deviceId, operationId]);
    expect(completion?.[0]).toMatch(/WHERE user_id = \$1 AND device_id = \$2 AND operation_id = \$3/i);
    expect(completion?.[1]?.slice(0, 3)).toEqual([userId, deviceId, operationId]);
  });

  it('rolls back a conflicted mutation to a savepoint and durably records the conflict result', async () => {
    const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      if (sql.includes('INSERT INTO sync.pending_operations')) return result([], 1);
      return result([], 1);
    });
    const conflict = new DomainError('VERSION_CONFLICT', '资料已更新。', 409, {
      meta: { currentVersion: 4 },
    });
    const { service } = serviceForPush(clientQuery, vi.fn().mockRejectedValue(conflict));

    await expect(service.push(userId, deviceId, [profileOperation()])).resolves.toMatchObject({
      results: [{
        operationId,
        state: 'conflict',
        error: { code: 'VERSION_CONFLICT', meta: { currentVersion: 4 } },
      }],
    });

    const statements = clientQuery.mock.calls.map(([sql]) => sql);
    const savepoint = statements.findIndex((sql) => sql === 'SAVEPOINT sync_operation');
    const rollback = statements.findIndex((sql) => sql === 'ROLLBACK TO SAVEPOINT sync_operation');
    const persisted = clientQuery.mock.calls.find(([sql]) => sql.includes('SET state = $4') && sql.includes('result = $5'));
    expect(savepoint).toBeGreaterThanOrEqual(0);
    expect(rollback).toBeGreaterThan(savepoint);
    expect(persisted?.[0]).toMatch(/WHERE user_id = \$1 AND device_id = \$2 AND operation_id = \$3/i);
    expect(persisted?.[1]).toEqual([
      userId,
      deviceId,
      operationId,
      'conflict',
      conflict.toJSON(),
    ]);
  });

  it('replays a persisted conflict without re-running the domain mutation', async () => {
    let requestHash: Buffer = Buffer.alloc(0);
    const storedError = new DomainError('VERSION_CONFLICT', '资料已更新。', 409).toJSON();
    const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO sync.pending_operations')) {
        requestHash = values?.[7] as Buffer;
        return result([], 0);
      }
      if (sql.includes('FROM sync.pending_operations')) {
        return result([{ request_hash: requestHash, state: 'conflict', result: storedError }]);
      }
      return result([], 1);
    });
    const applyPatch = vi.fn();
    const { service } = serviceForPush(clientQuery, applyPatch);

    await expect(service.push(userId, deviceId, [profileOperation()])).resolves.toMatchObject({
      results: [{ operationId, state: 'conflict', error: storedError }],
    });
    expect(applyPatch).not.toHaveBeenCalled();
    const replay = clientQuery.mock.calls.find(([sql]) => sql.includes('FROM sync.pending_operations'));
    expect(replay?.[0]).toMatch(
      /WHERE user_id = \$1 AND device_id = \$2 AND operation_id = \$3 FOR UPDATE/i,
    );
    expect(replay?.[1]).toEqual([userId, deviceId, operationId]);
  });

  it('treats a reordered but equivalent patch as the same idempotent request', async () => {
    let storedHash: Buffer = Buffer.alloc(0);
    let storedResult: unknown;
    let storedState = 'received';
    let insertCount = 0;
    const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('INSERT INTO sync.pending_operations')) {
        insertCount += 1;
        if (insertCount === 1) {
          storedHash = values?.[7] as Buffer;
          return result([], 1);
        }
        return result([], 0);
      }
      if (sql.includes('FROM sync.pending_operations')) {
        return result([{ request_hash: storedHash, state: storedState, result: storedResult }]);
      }
      if (sql.includes("SET state = 'applied'")) {
        storedState = 'applied';
        storedResult = values?.[3];
      }
      return result([], 1);
    });
    const applyPatch = vi.fn().mockResolvedValue({ userId, version: 4 });
    const { service } = serviceForPush(clientQuery, applyPatch);

    const first = profileOperation({ nickname: 'Spott', bio: 'Tokyo' });
    const reordered = profileOperation({ bio: 'Tokyo', nickname: 'Spott' });
    const firstResponse = await service.push(userId, deviceId, [first]);
    const replayedResponse = await service.push(userId, deviceId, [reordered]);

    const firstEnvelope = firstResponse as { results: unknown[]; serverTime: string };
    const replayedEnvelope = replayedResponse as { results: unknown[]; serverTime: string };
    expect(replayedEnvelope.results).toEqual(firstEnvelope.results);
    expect(Date.parse(firstEnvelope.serverTime)).not.toBeNaN();
    expect(Date.parse(replayedEnvelope.serverTime)).toBeGreaterThanOrEqual(Date.parse(firstEnvelope.serverTime));
    expect(applyPatch).toHaveBeenCalledTimes(1);
  });

  it('records an offline favorite deletion as a tombstone and emits one realtime outbox event', async () => {
    const clientQuery = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      if (sql.includes('INSERT INTO sync.pending_operations')) return result([], 1);
      if (sql.includes('FROM events.events')) return result([{ version: '7' }]);
      return result([], 1);
    });
    const { service } = serviceForPush(clientQuery);
    const operation = {
      operationId,
      entityType: 'favorite',
      entityId,
      action: 'delete',
    };

    await expect(service.push(userId, deviceId, [operation])).resolves.toMatchObject({
      results: [{
        operationId,
        state: 'applied',
        result: { eventId: entityId, favorited: false, version: 7 },
      }],
    });

    const change = clientQuery.mock.calls.find(([sql]) => sql.includes('sync.record_change'));
    const outbox = clientQuery.mock.calls.find(([sql]) => sql.includes('sync.outbox_events'));
    expect(change?.[1]).toEqual([
      userId,
      'favorite.changed',
      'favorite',
      entityId,
      'tombstone',
      7,
      ['favorited'],
      { eventId: entityId, favorited: false, version: 7 },
    ]);
    expect(outbox?.[1]).toEqual([
      'favorite',
      entityId,
      'favorite.changed',
      { userId, eventId: entityId, favorited: false, version: 7 },
    ]);
  });
});
