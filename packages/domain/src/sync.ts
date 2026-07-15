import { DomainError } from './errors.js';

export type LocalSyncState = 'clean' | 'dirty' | 'pushing' | 'conflict' | 'failed' | 'tombstoned';

export interface SyncChange<T = Record<string, unknown>> {
  seq: number;
  entityType: string;
  entityId: string;
  operation: 'upsert' | 'tombstone';
  version: number;
  changedFields: string[];
  payload: T;
}

export interface SyncPage<T = Record<string, unknown>> {
  nextCursor: number;
  hasMore: boolean;
  serverTime: string;
  changes: Array<SyncChange<T>>;
}

export function validateSyncPage(currentCursor: number, page: SyncPage): void {
  let previous = currentCursor;
  for (const change of page.changes) {
    if (change.seq <= previous) {
      throw new DomainError('SYNC_SEQUENCE_INVALID', '同步变更序列不是严格递增。', 409, {
        meta: { previous, received: change.seq },
      });
    }
    previous = change.seq;
  }
  if (page.nextCursor < previous) {
    throw new DomainError('SYNC_CURSOR_INVALID', '同步游标落后于已返回变更。', 409);
  }
}

export function backoffMilliseconds(retryCount: number, entropy: number): number {
  const boundedRetry = Math.max(0, Math.min(retryCount, 8));
  const base = Math.min(30_000, 500 * 2 ** boundedRetry);
  const jitter = Math.max(0, Math.min(entropy, 1)) * base * 0.3;
  return Math.round(base + jitter);
}
