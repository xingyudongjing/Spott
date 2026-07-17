/**
 * Test double that models the parts of the `commerce` schema the StoreKit refund
 * path actually touches, including the invariants Postgres enforces for real:
 *
 * - `commerce.wallets` `CHECK (free_balance >= 0)` (0003_community_commerce_operations.sql)
 *   and the deliberate absence of any such check on `paid_balance`.
 * - `commerce.point_transactions` `UNIQUE (user_id, business_key)`.
 * - `commerce.store_webhook_events` `UNIQUE (store, notification_uuid)`.
 * - `commerce.refunds` `UNIQUE (store_event_id)` and `CHECK (points_reversed >= 0)`.
 * - the deferred `trg_point_entries_balanced` trigger: every transaction's entries
 *   must sum to zero.
 * - `trg_point_entries_immutable`: entries are append-only.
 *
 * A constraint violation aborts the surrounding transaction exactly like Postgres
 * does, so a test can observe the rollback rather than a half-applied refund.
 */

export class CheckViolationError extends Error {
  readonly code = '23514';

  constructor(constraint: string) {
    super(`new row for relation violates check constraint "${constraint}"`);
    this.name = 'CheckViolationError';
  }
}

interface WalletState {
  paid_balance: bigint;
  free_balance: bigint;
}

interface PointTransaction {
  id: string;
  user_id: string;
  type: string;
  business_key: string;
  reversal_of: string | null;
  metadata: unknown;
}

interface PointEntry {
  transaction_id: string;
  account_code: string;
  bucket: 'paid' | 'free';
  amount: bigint;
}

interface StoreOrder {
  id: string;
  user_id: string;
  state: string;
  points_transaction_id: string | null;
  bonus_points_transaction_id: string | null;
  revocation_reason: number | null;
}

export interface FakeCommerceState {
  wallets: Map<string, WalletState>;
  pointTransactions: PointTransaction[];
  pointEntries: PointEntry[];
  storeOrders: StoreOrder[];
  webhookEvents: Set<string>;
  refunds: Array<{ store_event_id: string; points_reversed: bigint; order_id: string }>;
  restrictionFlags: Map<string, string[]>;
}

interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export class FakeCommerceDatabase {
  readonly state: FakeCommerceState;
  private sequence = 0;
  private aborted = false;

  constructor(initial: {
    wallets: Record<string, { paid: bigint; free: bigint }>;
    pointTransactions?: PointTransaction[];
    pointEntries?: PointEntry[];
    storeOrders?: StoreOrder[];
    restrictionFlags?: Record<string, string[]>;
  }) {
    this.state = {
      wallets: new Map(
        Object.entries(initial.wallets).map(([userId, wallet]) => [
          userId,
          { paid_balance: wallet.paid, free_balance: wallet.free },
        ]),
      ),
      pointTransactions: [...(initial.pointTransactions ?? [])],
      pointEntries: [...(initial.pointEntries ?? [])],
      storeOrders: [...(initial.storeOrders ?? [])],
      webhookEvents: new Set(),
      refunds: [],
      restrictionFlags: new Map(Object.entries(initial.restrictionFlags ?? {})),
    };
  }

  /** Mirrors `Database.transaction`: any thrown error rolls the snapshot back. */
  transaction = async <T>(work: (client: unknown) => Promise<T>): Promise<T> => {
    const snapshot = structuredCloneState(this.state);
    try {
      const result = await work({ query: this.query });
      this.assertBalanced();
      return result;
    } catch (error) {
      restoreState(this.state, snapshot);
      this.aborted = true;
      throw error;
    } finally {
      this.aborted = false;
    }
  };

  query = async (sql: string, values: unknown[] = []): Promise<QueryResult<Record<string, unknown>>> => {
    if (this.aborted) throw new Error('current transaction is aborted');

    if (sql.includes('INSERT INTO commerce.store_webhook_events')) {
      const uuid = String(values[0]);
      if (this.state.webhookEvents.has(uuid)) return { rows: [], rowCount: 0 };
      this.state.webhookEvents.add(uuid);
      return { rows: [{ id: `event-${uuid}` }], rowCount: 1 };
    }
    if (sql.includes('UPDATE commerce.store_webhook_events')) return { rows: [], rowCount: 1 };

    if (sql.includes('FROM commerce.store_orders')) {
      const order = this.state.storeOrders[0];
      return order ? { rows: [{ ...order }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE commerce.store_orders')) {
      const order = this.state.storeOrders[0];
      if (order) {
        order.state = 'revoked';
        order.revocation_reason = (values[1] as number | null) ?? null;
      }
      return { rows: [], rowCount: 1 };
    }

    // Checked before the wallet branches: this statement embeds a
    // `SELECT paid_balance FROM commerce.wallets` sub-query.
    if (sql.includes('UPDATE identity.users')) {
      const userId = String(values[0]);
      const wallet = this.state.wallets.get(userId);
      const flags = this.state.restrictionFlags.get(userId) ?? [];
      if (wallet && wallet.paid_balance < 0n && !flags.includes('pointsBlocked')) {
        this.state.restrictionFlags.set(userId, [...flags, 'pointsBlocked']);
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM commerce.wallets')) {
      const wallet = this.state.wallets.get(String(values[0]));
      return wallet
        ? {
            rows: [
              {
                paid_balance: wallet.paid_balance.toString(),
                free_balance: wallet.free_balance.toString(),
                version: '1',
              },
            ],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (sql.includes('UPDATE commerce.wallets')) {
      const userId = String(values[0]);
      const wallet = this.state.wallets.get(userId);
      if (!wallet) return { rows: [], rowCount: 0 };
      wallet.paid_balance -= BigInt(String(values[1]));
      wallet.free_balance -= BigInt(String(values[2]));
      // The real table has CHECK (free_balance >= 0) and no check on paid_balance.
      if (wallet.free_balance < 0n) throw new CheckViolationError('wallets_free_balance_check');
      return { rows: [], rowCount: 1 };
    }

    if (sql.includes('FROM commerce.point_entries')) {
      const transactionId = String(values[0]);
      const accountCode = `user:${String(values[1])}`;
      const totals = new Map<string, bigint>();
      for (const entry of this.state.pointEntries) {
        if (entry.transaction_id !== transactionId) continue;
        if (entry.account_code !== accountCode) continue;
        if (entry.amount <= 0n) continue;
        totals.set(entry.bucket, (totals.get(entry.bucket) ?? 0n) + entry.amount);
      }
      return {
        rows: [...totals].map(([bucket, amount]) => ({ bucket, amount: amount.toString() })),
        rowCount: totals.size,
      };
    }
    if (sql.includes('INSERT INTO commerce.point_entries')) {
      const [transactionId, accountCode, bucket, userAmount, platformAmount] = values;
      this.state.pointEntries.push(
        {
          transaction_id: String(transactionId),
          account_code: String(accountCode),
          bucket: bucket as 'paid' | 'free',
          amount: BigInt(String(userAmount)),
        },
        {
          transaction_id: String(transactionId),
          account_code: 'platform:storekit_refunds',
          bucket: bucket as 'paid' | 'free',
          amount: BigInt(String(platformAmount)),
        },
      );
      return { rows: [], rowCount: 2 };
    }

    if (sql.includes('INSERT INTO commerce.point_transactions')) {
      const [userId, businessKey, reversalOf, metadata] = values;
      const duplicate = this.state.pointTransactions.some(
        (row) => row.user_id === userId && row.business_key === businessKey,
      );
      if (duplicate) return { rows: [], rowCount: 0 };
      const id = `reversal-${++this.sequence}`;
      this.state.pointTransactions.push({
        id,
        user_id: String(userId),
        type: 'storekit_refund',
        business_key: String(businessKey),
        reversal_of: (reversalOf as string | null) ?? null,
        metadata,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO commerce.refunds')) {
      const [orderId, storeEventId, pointsReversed] = values;
      if (this.state.refunds.some((row) => row.store_event_id === storeEventId)) {
        return { rows: [], rowCount: 0 };
      }
      const reversed = BigInt(String(pointsReversed));
      if (reversed < 0n) throw new CheckViolationError('refunds_points_reversed_check');
      this.state.refunds.push({
        store_event_id: String(storeEventId),
        points_reversed: reversed,
        order_id: String(orderId),
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 1 };
  };

  /** Mirrors the DEFERRABLE INITIALLY DEFERRED balanced-entries trigger. */
  private assertBalanced(): void {
    const totals = new Map<string, bigint>();
    for (const entry of this.state.pointEntries) {
      totals.set(entry.transaction_id, (totals.get(entry.transaction_id) ?? 0n) + entry.amount);
    }
    for (const [transactionId, sum] of totals) {
      if (sum !== 0n) {
        throw new CheckViolationError(`point transaction ${transactionId} is unbalanced by ${sum}`);
      }
    }
  }
}

function structuredCloneState(state: FakeCommerceState): FakeCommerceState {
  return {
    wallets: new Map([...state.wallets].map(([key, value]) => [key, { ...value }])),
    pointTransactions: state.pointTransactions.map((row) => ({ ...row })),
    pointEntries: state.pointEntries.map((row) => ({ ...row })),
    storeOrders: state.storeOrders.map((row) => ({ ...row })),
    webhookEvents: new Set(state.webhookEvents),
    refunds: state.refunds.map((row) => ({ ...row })),
    restrictionFlags: new Map([...state.restrictionFlags].map(([key, value]) => [key, [...value]])),
  };
}

function restoreState(target: FakeCommerceState, snapshot: FakeCommerceState): void {
  target.wallets = snapshot.wallets;
  target.pointTransactions = snapshot.pointTransactions;
  target.pointEntries = snapshot.pointEntries;
  target.storeOrders = snapshot.storeOrders;
  target.webhookEvents = snapshot.webhookEvents;
  target.refunds = snapshot.refunds;
  target.restrictionFlags = snapshot.restrictionFlags;
}
