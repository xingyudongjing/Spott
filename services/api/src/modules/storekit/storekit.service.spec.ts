import { describe, expect, it, vi } from 'vitest';
import { FakeCommerceDatabase } from './fake-commerce-database.js';
import { StoreKitService } from './storekit.service.js';

const REFUND_USER = '019b0000-0000-7000-8000-000000000001';
const NOTIFICATION_UUID = '019b0000-0000-7000-9000-000000000001';

/**
 * Rebuilds the exact attack state described in P0-3 against the real production
 * path (`processNotification` -> `reverseRevokedOrder`):
 *
 *   1. user buys the 1000-point pack, which grants 200 promotional free points;
 *   2. `PointsService.spend` allocates free lots first, so the 200 free points are
 *      necessarily the first thing spent -> free_balance hits 0, paid stays 1000;
 *   3. Apple refunds the cash and sends a REFUND notification.
 *
 * The refund then has to claw back 1000 paid + 200 free while free_balance is 0.
 */
function refundScenario(options: { free?: bigint; paid?: bigint } = {}) {
  const database = new FakeCommerceDatabase({
    wallets: { [REFUND_USER]: { paid: options.paid ?? 1000n, free: options.free ?? 0n } },
    storeOrders: [
      {
        id: 'order-row',
        user_id: REFUND_USER,
        state: 'credited',
        points_transaction_id: 'paid-transaction',
        bonus_points_transaction_id: 'bonus-transaction',
        revocation_reason: null,
      },
    ],
    pointTransactions: [
      {
        id: 'paid-transaction',
        user_id: REFUND_USER,
        type: 'storekit_purchase',
        business_key: 'storekit:apple-transaction:paid',
        reversal_of: null,
        metadata: {},
      },
      {
        id: 'bonus-transaction',
        user_id: REFUND_USER,
        type: 'storekit_bonus',
        business_key: 'storekit:apple-transaction:bonus',
        reversal_of: null,
        metadata: {},
      },
    ],
    pointEntries: [
      { transaction_id: 'paid-transaction', account_code: `user:${REFUND_USER}`, bucket: 'paid', amount: 1000n },
      { transaction_id: 'paid-transaction', account_code: 'platform:credits', bucket: 'paid', amount: -1000n },
      { transaction_id: 'bonus-transaction', account_code: `user:${REFUND_USER}`, bucket: 'free', amount: 200n },
      { transaction_id: 'bonus-transaction', account_code: 'platform:credits', bucket: 'free', amount: -200n },
      // the 200 promotional free points already spent, free-lots-first
      { transaction_id: 'spend-transaction', account_code: `user:${REFUND_USER}`, bucket: 'free', amount: -200n },
      { transaction_id: 'spend-transaction', account_code: 'platform:spent', bucket: 'free', amount: 200n },
    ],
  });
  const service = new StoreKitService(database as never, {} as never);
  const internals = service as unknown as {
    verifyNotification: (payload: string) => Promise<unknown>;
    verifyTransaction: (payload: string) => Promise<unknown>;
  };
  vi.spyOn(internals, 'verifyNotification').mockResolvedValue({
    notificationUUID: NOTIFICATION_UUID,
    notificationType: 'REFUND',
    data: { signedTransactionInfo: 'signed-transaction-info' },
  });
  vi.spyOn(internals, 'verifyTransaction').mockResolvedValue({
    transactionId: 'apple-transaction',
    revocationDate: Date.now(),
    revocationReason: 1,
    revocationPercentage: 1_000_000,
  });
  return { database, service };
}

describe('StoreKitService Apple refund clawback', () => {
  it('claws the refunded pack back even when the promotional free points were already spent', async () => {
    const { database, service } = refundScenario();

    await expect(service.processNotification('signed-payload')).resolves.toBeUndefined();

    const wallet = database.state.wallets.get(REFUND_USER)!;
    // free_balance must never go below zero: the 200 free points that no longer
    // exist are carried as paid debt instead of aborting the whole webhook.
    expect(wallet.free_balance).toBe(0n);
    expect(wallet.paid_balance).toBe(-200n);
    expect(database.state.storeOrders[0]!.state).toBe('revoked');
    expect(database.state.refunds).toEqual([
      { store_event_id: NOTIFICATION_UUID, points_reversed: 1200n, order_id: 'order-row' },
    ]);
    expect(database.state.restrictionFlags.get(REFUND_USER)).toEqual(['pointsBlocked']);
  });

  it('posts the clawback as a new immutable reversal transaction, never rewriting history', async () => {
    const { database, service } = refundScenario();
    const historyBefore = database.state.pointEntries.map((entry) => ({ ...entry }));

    await service.processNotification('signed-payload');

    const reversal = database.state.pointTransactions.find((row) => row.type === 'storekit_refund')!;
    expect(reversal.reversal_of).toBe('paid-transaction');
    expect(reversal.business_key).toBe(`storekit_refund:${NOTIFICATION_UUID}`);
    // original entries are still there, byte for byte
    expect(database.state.pointEntries.slice(0, historyBefore.length)).toEqual(historyBefore);
    const reversalEntries = database.state.pointEntries.filter(
      (entry) => entry.transaction_id === reversal.id && entry.account_code === `user:${REFUND_USER}`,
    );
    expect(reversalEntries).toEqual([
      { transaction_id: reversal.id, account_code: `user:${REFUND_USER}`, bucket: 'paid', amount: -1200n },
    ]);
  });

  it('still reverses each bucket in place when the free points are untouched', async () => {
    const { database, service } = refundScenario({ free: 200n });

    await service.processNotification('signed-payload');

    const wallet = database.state.wallets.get(REFUND_USER)!;
    expect(wallet.free_balance).toBe(0n);
    expect(wallet.paid_balance).toBe(0n);
    expect(database.state.restrictionFlags.get(REFUND_USER)).toBeUndefined();
  });

  it('books the clawback exactly once when Apple retries the same notification 100 times', async () => {
    const { database, service } = refundScenario();

    for (let attempt = 0; attempt < 100; attempt += 1) {
      await service.processNotification('signed-payload');
    }

    const wallet = database.state.wallets.get(REFUND_USER)!;
    expect(wallet.paid_balance).toBe(-200n);
    expect(wallet.free_balance).toBe(0n);
    expect(database.state.refunds).toHaveLength(1);
    expect(database.state.pointTransactions.filter((row) => row.type === 'storekit_refund')).toHaveLength(1);
  });
});

describe('StoreKitService catalog', () => {
  it('returns only the server-configured active Apple point products', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        { product_id: 'jp.spott.points.1000', points: '1000', bonus_points: '50' },
        { product_id: 'jp.spott.points.500', points: '500', bonus_points: '0' },
      ],
    });
    const service = new StoreKitService({ query } as never, {} as never);

    await expect(service.catalog()).resolves.toEqual({
      store: 'apple',
      items: [
        { productId: 'jp.spott.points.500', points: 500, bonusPoints: 0 },
        { productId: 'jp.spott.points.1000', points: 1000, bonusPoints: 50 },
      ],
    });
    expect(query).toHaveBeenCalledOnce();
  });
});

describe('StoreKitService purchase ledger', () => {
  it('credits paid points and promotional free points into separate buckets', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM commerce.store_orders')) return { rows: [], rowCount: 0 };
        if (sql.includes('FROM commerce.store_products')) {
          return { rows: [{ id: 'product-row', points: '1000', bonus_points: '50' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO commerce.store_orders')) {
          return { rows: [{ id: 'order-row' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const finalWallet = {
      paidBalance: 1000,
      freeBalance: 50,
      totalBalance: 1050,
      version: 3,
      nextFreeExpiry: null,
    };
    const credit = vi
      .fn()
      .mockResolvedValueOnce({ transactionId: 'paid-transaction', wallet: { ...finalWallet, freeBalance: 0 } })
      .mockResolvedValueOnce({ transactionId: 'bonus-transaction', wallet: finalWallet });
    const service = new StoreKitService(database as never, { credit } as never);
    const verifier = service as unknown as {
      verifyTransaction: (signedTransaction: string) => Promise<Record<string, unknown>>;
    };
    vi.spyOn(verifier, 'verifyTransaction').mockResolvedValue({
      transactionId: 'apple-transaction',
      originalTransactionId: 'apple-original',
      productId: 'jp.spott.points.1000',
      purchaseDate: Date.now(),
      appAccountToken: '019b0000-0000-7000-8000-000000000001',
      quantity: 1,
      environment: 'Sandbox',
    });

    const wallet = await service.verifyAndCredit(
      '019b0000-0000-7000-8000-000000000001',
      'signed-transaction',
      'idempotency-key',
    );

    expect(credit).toHaveBeenNthCalledWith(
      1,
      client,
      '019b0000-0000-7000-8000-000000000001',
      1000n,
      'paid',
      'storekit_purchase',
      'storekit:apple-transaction:paid',
      expect.any(Object),
    );
    expect(credit).toHaveBeenNthCalledWith(
      2,
      client,
      '019b0000-0000-7000-8000-000000000001',
      50n,
      'free',
      'storekit_bonus',
      'storekit:apple-transaction:bonus',
      expect.any(Object),
    );
    expect(wallet).toEqual(finalWallet);
  });

  it('reverses paid and promotional free buckets together on an App Store revocation', async () => {
    const userId = '019b0000-0000-7000-8000-000000000001';
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('FROM commerce.store_orders')) {
          return {
            rows: [{
              id: 'order-row',
              user_id: userId,
              state: 'credited',
              points_transaction_id: 'paid-transaction',
              bonus_points_transaction_id: 'bonus-transaction',
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM commerce.wallets')) {
          return { rows: [{ free_balance: '50' }], rowCount: 1 };
        }
        if (sql.includes('FROM commerce.point_entries')) {
          return values?.[0] === 'paid-transaction'
            ? { rows: [{ bucket: 'paid', amount: '1000' }], rowCount: 1 }
            : { rows: [{ bucket: 'free', amount: '50' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO commerce.point_transactions')) {
          return { rows: [{ id: 'refund-transaction' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const service = new StoreKitService({} as never, {} as never);
    const reverse = service as unknown as {
      reverseRevokedOrder: (
        transactionClient: typeof client,
        transaction: {
          transactionId: string;
          revocationDate: number;
          revocationPercentage: number;
        },
        notificationUUID: string,
      ) => Promise<void>;
    };

    await reverse.reverseRevokedOrder(
      client,
      {
        transactionId: 'apple-transaction',
        revocationDate: Date.now(),
        revocationPercentage: 1_000_000,
      },
      '019b0000-0000-7000-9000-000000000001',
    );

    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce.point_entries'),
      ['refund-transaction', `user:${userId}`, 'paid', '-1000', '1000'],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO commerce.point_entries'),
      ['refund-transaction', `user:${userId}`, 'free', '-50', '50'],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('SET paid_balance = paid_balance - $2'),
      [userId, '1000', '50'],
    );
  });
});
