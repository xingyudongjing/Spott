import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { PointsService } from './points.service.js';

const databaseURL = process.env.SPOTT_TEST_DATABASE_URL;
if (!databaseURL) throw new Error('SPOTT_TEST_DATABASE_URL is required');

function databaseFor(pool: Pool) {
  return {
    async query<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []) {
      return pool.query<Row>(text, [...values]);
    },
    async transaction<Value>(work: (client: PoolClient) => Promise<Value>): Promise<Value> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL TIME ZONE 'UTC'");
        await client.query("SET LOCAL lock_timeout = '5s'");
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

let pool: Pool;
let points: PointsService;

async function today(): Promise<string> {
  const result = await pool.query<{ day: string }>(
    "SELECT (clock_timestamp() AT TIME ZONE 'Asia/Tokyo')::date::text AS day",
  );
  return result.rows[0]!.day;
}

async function newUser(): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO identity.users(id,public_handle,phone_verified_at) VALUES ($1,'checkin_' || $2,clock_timestamp())",
    [id, id.slice(0, 8)],
  );
  await pool.query('INSERT INTO commerce.wallets(user_id) VALUES ($1)', [id]);
  return id;
}

async function seedStreak(userId: string, lastCheckinDate: string, currentStreak: number): Promise<void> {
  await pool.query(
    `INSERT INTO commerce.daily_checkin_streaks(user_id,last_checkin_date,current_streak,longest_streak)
     VALUES ($1,$2::date,$3,$3)`,
    [userId, lastCheckinDate, currentStreak],
  );
}

async function freeBalance(userId: string): Promise<number> {
  const result = await pool.query<{ free_balance: string }>(
    'SELECT free_balance FROM commerce.wallets WHERE user_id = $1',
    [userId],
  );
  return Number(result.rows[0]!.free_balance);
}

beforeAll(() => {
  pool = new Pool({ connectionString: databaseURL, max: 4 });
  points = new PointsService(databaseFor(pool) as never);
});

afterAll(async () => {
  await pool.end();
});

describe('daily check-in retention engine (integration)', () => {
  it('grants the daily reward and opens a streak on the first check-in', async () => {
    const userId = await newUser();
    const result = await points.dailyCheckin(userId);
    expect(result.alreadyCheckedIn).toBe(false);
    expect(result.streak).toBe(1);
    expect(result.rewards).toEqual([{ type: 'daily_checkin_reward', points: 10 }]);
    expect(await freeBalance(userId)).toBe(10);
  });

  it('is idempotent within the same Asia/Tokyo day', async () => {
    const userId = await newUser();
    await points.dailyCheckin(userId);
    const repeat = await points.dailyCheckin(userId);
    expect(repeat.alreadyCheckedIn).toBe(true);
    expect(repeat.rewards).toEqual([]);
    expect(await freeBalance(userId)).toBe(10);
    const transactions = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM commerce.point_transactions WHERE user_id = $1 AND type = 'daily_checkin_reward'",
      [userId],
    );
    expect(Number(transactions.rows[0]!.count)).toBe(1);
  });

  it('adds the seven-day bonus when the streak reaches seven consecutive days', async () => {
    const userId = await newUser();
    const day = await today();
    const yesterday = new Date(`${day}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    await seedStreak(userId, yesterday.toISOString().slice(0, 10), 6);
    const result = await points.dailyCheckin(userId);
    expect(result.streak).toBe(7);
    expect(result.rewards).toEqual([
      { type: 'daily_checkin_reward', points: 10 },
      { type: 'streak_7_reward', points: 50 },
    ]);
    expect(await freeBalance(userId)).toBe(60);
  });

  it('resets the streak and grants only the daily reward after a gap', async () => {
    const userId = await newUser();
    const day = await today();
    const threeDaysAgo = new Date(`${day}T00:00:00Z`);
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    await seedStreak(userId, threeDaysAgo.toISOString().slice(0, 10), 9);
    const result = await points.dailyCheckin(userId);
    expect(result.streak).toBe(1);
    expect(result.rewards).toEqual([{ type: 'daily_checkin_reward', points: 10 }]);
    expect(await freeBalance(userId)).toBe(10);
  });
});
