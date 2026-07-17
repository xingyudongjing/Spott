import { describe, expect, it, vi } from 'vitest';
import { PointsService } from './points.service.js';

const userId = '019b0000-0000-7000-8000-000000000001';
const originalTransactionId = '019b0000-0000-7000-8100-000000000001';

interface InsertCall {
  bucket: string;
  userAmount: string;
  counterAmount: string;
}

function buildClient() {
  const inserts: InsertCall[] = [];
  let walletUpdate: { free: string; paid: string } | null = null;
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('INSERT INTO commerce.point_transactions')) {
        return { rows: [{ id: 'reversal-tx' }], rowCount: 1 };
      }
      if (sql.includes('SELECT bucket') && sql.includes('FROM commerce.point_entries')) {
        // Original spend allocated 400 paid + 300 free (700 total).
        return {
          rows: [
            { bucket: 'paid', amount: '400', expires_at: null },
            { bucket: 'free', amount: '300', expires_at: new Date('2026-12-01T00:00:00Z') },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('INSERT INTO commerce.point_entries')) {
        inserts.push({
          bucket: String(values[2]),
          userAmount: String(values[3]),
          counterAmount: String(values[5]),
        });
        return { rows: [], rowCount: 2 };
      }
      if (sql.includes('UPDATE commerce.wallets')) {
        walletUpdate = { free: String(values[1]), paid: String(values[2]) };
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT paid_balance, free_balance, version')) {
        return { rows: [{ paid_balance: '400', free_balance: '425', version: '5' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { client, inserts, walletState: () => walletUpdate };
}

describe('PointsService.reverse partial (pro-rata) allocation', () => {
  it('refunds the requested amount paid-bucket first, then free, capped per bucket', async () => {
    const { client, inserts, walletState } = buildClient();
    const service = new PointsService({} as never);

    await service.reverse(
      client as never,
      userId,
      originalTransactionId,
      'event_boost_refund:promo-1',
      'event_boost_refund',
      { amount: 525n },
    );

    // 525 requested: paid 400 fully restored first, then 125 of the 300 free spent.
    expect(inserts).toEqual([
      { bucket: 'paid', userAmount: '400', counterAmount: '-400' },
      { bucket: 'free', userAmount: '125', counterAmount: '-125' },
    ]);
    // Wallet credited by the same split (update takes free, then paid).
    expect(walletState()).toEqual({ free: '125', paid: '400' });
  });

  it('reverses the full original spend when no partial amount is given', async () => {
    const { client, inserts, walletState } = buildClient();
    const service = new PointsService({} as never);

    await service.reverse(
      client as never,
      userId,
      originalTransactionId,
      'registration_cancel_refund:reg-1',
      'registration_cancel_refund',
    );

    expect(inserts).toEqual([
      { bucket: 'paid', userAmount: '400', counterAmount: '-400' },
      { bucket: 'free', userAmount: '300', counterAmount: '-300' },
    ]);
    expect(walletState()).toEqual({ free: '300', paid: '400' });
  });

  it('never restores more than the requested amount even if it exceeds a single bucket', async () => {
    const { client, inserts } = buildClient();
    const service = new PointsService({} as never);

    await service.reverse(
      client as never,
      userId,
      originalTransactionId,
      'event_boost_refund:promo-2',
      'event_boost_refund',
      { amount: 200n },
    );

    // 200 requested, all from the paid bucket; free bucket untouched.
    expect(inserts).toEqual([{ bucket: 'paid', userAmount: '200', counterAmount: '-200' }]);
  });
});
