import { describe, expect, it, vi } from 'vitest';
import { StoreKitService } from './storekit.service.js';

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
