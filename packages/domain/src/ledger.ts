import { DomainError } from './errors.js';

export type PointBucket = 'free' | 'paid';

export interface PointLot {
  id: string;
  bucket: PointBucket;
  available: bigint;
  expiresAt?: Date;
}

export interface PointAllocation {
  lotId: string;
  bucket: PointBucket;
  amount: bigint;
}

export interface LedgerEntry {
  accountCode: string;
  bucket: PointBucket;
  amount: bigint;
  expiresAt?: Date;
}

export function allocatePointSpend(
  lots: readonly PointLot[],
  requested: bigint,
  now: Date,
): PointAllocation[] {
  if (requested <= 0n) {
    throw new DomainError('VALIDATION_FAILED', '积分消耗必须大于 0。', 400);
  }

  const eligible = lots
    .filter((lot) => lot.available > 0n && (!lot.expiresAt || lot.expiresAt > now))
    .toSorted((left, right) => {
      if (left.bucket !== right.bucket) return left.bucket === 'free' ? -1 : 1;
      if (left.bucket === 'paid') return left.id.localeCompare(right.id);
      const leftExpiry = left.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const rightExpiry = right.expiresAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return leftExpiry - rightExpiry || left.id.localeCompare(right.id);
    });

  let remaining = requested;
  const allocations: PointAllocation[] = [];
  for (const lot of eligible) {
    if (remaining === 0n) break;
    const amount = lot.available < remaining ? lot.available : remaining;
    allocations.push({ lotId: lot.id, bucket: lot.bucket, amount });
    remaining -= amount;
  }

  if (remaining > 0n) {
    const available = requested - remaining;
    throw new DomainError('POINTS_INSUFFICIENT', '积分不足。', 409, {
      actions: [{ type: 'openWallet', label: '查看获取方式' }],
      meta: { required: requested.toString(), available: available.toString() },
    });
  }
  return allocations;
}

export function assertBalancedEntries(entries: readonly LedgerEntry[]): void {
  if (entries.length < 2) {
    throw new DomainError('LEDGER_UNBALANCED', '积分交易必须至少包含两条分录。', 500);
  }
  const sum = entries.reduce((total, entry) => total + entry.amount, 0n);
  if (sum !== 0n) {
    throw new DomainError('LEDGER_UNBALANCED', '积分交易分录不平衡。', 500, {
      meta: { imbalance: sum.toString() },
    });
  }
}
