import { describe, expect, it, vi } from 'vitest';
import { PointsService } from './points.service.js';

const userId = '019b0000-0000-7000-8000-0000000000aa';

const wallet = {
  paidBalance: 0,
  freeBalance: 10,
  totalBalance: 10,
  version: 1,
  nextFreeExpiry: null,
};

interface StreakRow {
  last_checkin_date: string | null;
  current_streak: number | null;
  jp_today: string;
}

function serviceWith(streakRow: StreakRow) {
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const client = {
    query: vi.fn(async (text: string, values: readonly unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes('pg_advisory_xact_lock')) return { rows: [{}], rowCount: 1 };
      if (text.includes('commerce.daily_checkin_streaks s')) return { rows: [streakRow], rowCount: 1 };
      if (text.includes('INSERT INTO commerce.daily_checkin_streaks')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
  };
  const service = new PointsService(database as never);
  vi.spyOn(service as unknown as { walletInTransaction: () => Promise<unknown> }, 'walletInTransaction')
    .mockResolvedValue(wallet);
  const configByKey: Record<string, bigint> = {
    'points.reward.daily_checkin': 10n,
    'points.reward.streak_7': 50n,
    'points.reward.streak_30': 200n,
  };
  vi.spyOn(service, 'configBigInt').mockImplementation(async (_client, key: string, fallback: bigint) =>
    configByKey[key] ?? fallback,
  );
  const credit = vi.spyOn(service, 'credit').mockResolvedValue({ transactionId: 'tx', wallet });
  return { service, client, credit, queries };
}

describe('PointsService daily check-in retention engine', () => {
  it('serialises per-user with an advisory lock before reading streak state', async () => {
    const { service, client } = serviceWith({
      last_checkin_date: '2026-07-17',
      current_streak: 3,
      jp_today: '2026-07-18',
    });
    await service.dailyCheckin(userId);
    const [lockSQL, lockValues] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(lockSQL).toContain('pg_advisory_xact_lock');
    expect(lockValues[0]).toBe(`daily_checkin:${userId}`);
  });

  it('is idempotent for a same-day repeat: no streak write, no credit', async () => {
    const { service, credit, queries } = serviceWith({
      last_checkin_date: '2026-07-18',
      current_streak: 3,
      jp_today: '2026-07-18',
    });
    const result = await service.dailyCheckin(userId);
    expect(result).toMatchObject({ alreadyCheckedIn: true, streak: 3, rewards: [] });
    expect(credit).not.toHaveBeenCalled();
    expect(queries.some((q) => q.text.includes('INSERT INTO commerce.daily_checkin_streaks'))).toBe(false);
  });

  it('credits only the daily reward on an ordinary consecutive day and advances the streak', async () => {
    const { service, credit, queries } = serviceWith({
      last_checkin_date: '2026-07-17',
      current_streak: 3,
      jp_today: '2026-07-18',
    });
    const result = await service.dailyCheckin(userId);
    expect(result.alreadyCheckedIn).toBe(false);
    expect(result.streak).toBe(4);
    expect(result.rewards).toEqual([{ type: 'daily_checkin_reward', points: 10 }]);
    expect(credit).toHaveBeenCalledTimes(1);
    expect(credit).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      10n,
      'free',
      'daily_checkin_reward',
      'daily_checkin:2026-07-18',
      expect.anything(),
    );
    const upsert = queries.find((q) => q.text.includes('INSERT INTO commerce.daily_checkin_streaks'));
    expect(upsert?.values).toEqual([userId, '2026-07-18', 4]);
  });

  it('adds the seven-day continuity bonus with a day-scoped idempotency key at day seven', async () => {
    const { service, credit } = serviceWith({
      last_checkin_date: '2026-07-17',
      current_streak: 6,
      jp_today: '2026-07-18',
    });
    const result = await service.dailyCheckin(userId);
    expect(result.streak).toBe(7);
    expect(result.rewards).toEqual([
      { type: 'daily_checkin_reward', points: 10 },
      { type: 'streak_7_reward', points: 50 },
    ]);
    expect(credit).toHaveBeenCalledWith(
      expect.anything(), userId, 50n, 'free', 'streak_7_reward', 'streak7:2026-07-18', expect.anything(),
    );
  });

  it('adds the thirty-day continuity bonus at day thirty', async () => {
    const { service, credit } = serviceWith({
      last_checkin_date: '2026-07-17',
      current_streak: 29,
      jp_today: '2026-07-18',
    });
    const result = await service.dailyCheckin(userId);
    expect(result.streak).toBe(30);
    expect(result.rewards.map((r) => r.type)).toEqual(['daily_checkin_reward', 'streak_30_reward']);
    expect(credit).toHaveBeenCalledWith(
      expect.anything(), userId, 200n, 'free', 'streak_30_reward', 'streak30:2026-07-18', expect.anything(),
    );
  });

  it('resets the streak to one after a gap and grants only the daily reward', async () => {
    const { service, credit, queries } = serviceWith({
      last_checkin_date: '2026-07-15',
      current_streak: 12,
      jp_today: '2026-07-18',
    });
    const result = await service.dailyCheckin(userId);
    expect(result.streak).toBe(1);
    expect(result.rewards).toEqual([{ type: 'daily_checkin_reward', points: 10 }]);
    expect(credit).toHaveBeenCalledTimes(1);
    const upsert = queries.find((q) => q.text.includes('INSERT INTO commerce.daily_checkin_streaks'));
    expect(upsert?.values).toEqual([userId, '2026-07-18', 1]);
  });
});
