import { describe, expect, it, vi } from 'vitest';
import { EventPromotionService } from './events.promotion.service.js';

const organizer = {
  id: '019b0000-0000-7000-8000-000000000010',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['host'],
};

const eventId = '019b0000-0000-7000-8100-000000000001';
const promotionId = '019b0000-0000-7000-8200-000000000001';
const quoteId = '019b0000-0000-7000-8300-000000000001';
const key = '019b0000-0000-7000-8400-000000000001';

function publishedEventRow(overrides: Record<string, unknown> = {}) {
  return {
    organizer_id: organizer.id,
    status: 'published',
    deadline_at: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

interface Handlers {
  event?: Record<string, unknown> | null;
  activePromotion?: Record<string, unknown> | null;
  insertReturning?: Record<string, unknown>;
}

function buildClient(handlers: Handlers = {}) {
  const calls: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (sql.includes('uuidv7() AS id')) return { rows: [{ id: promotionId }], rowCount: 1 };
      if (sql.includes('FROM events.events')) {
        const row = handlers.event === undefined ? publishedEventRow() : handlers.event;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('FROM commerce.event_promotions') && sql.includes("state = 'active'")) {
        const row = handlers.activePromotion ?? null;
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO commerce.event_promotions')) {
        return {
          rows: [handlers.insertReturning ?? {
            id: promotionId,
            event_id: eventId,
            organizer_id: organizer.id,
            tier: 'boost_72h',
            amount: '700',
            duration_hours: 72,
            purchase_transaction_id: 'point-transaction-1',
            state: 'active',
            starts_at: new Date('2026-07-18T00:00:00Z'),
            expires_at: new Date('2026-07-21T00:00:00Z'),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  return { client, calls };
}

function buildDeps(handlers: Handlers = {}) {
  const { client, calls } = buildClient(handlers);
  const database = {
    transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)),
  };
  const points = {
    configBigInt: vi.fn(async (_c: unknown, configKey: string) => {
      if (configKey === 'points.boost.hours_24h') return 24n;
      if (configKey === 'points.boost.hours_72h') return 72n;
      if (configKey === 'points.boost.hours_7d') return 168n;
      return 0n;
    }),
    consumeQuote: vi.fn().mockResolvedValue(700n),
    spend: vi.fn().mockResolvedValue({ transactionId: 'point-transaction-1' }),
    reverse: vi.fn().mockResolvedValue({ transactionId: 'reversal-1' }),
  };
  const idempotency = {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
    claim: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new EventPromotionService(database as never, idempotency as never, points as never);
  return { service, database, points, idempotency, client, calls };
}

describe('EventPromotionService.purchase', () => {
  it('consumes the boost quote and spends points through the ledger before recording the promotion', async () => {
    const { service, points, calls } = buildDeps();

    const result = (await service.purchase(organizer, eventId, 'boost_72h', quoteId, key)) as {
      id: string;
      tier: string;
      amount: number;
      state: string;
      expiresAt: string;
    };

    expect(points.consumeQuote).toHaveBeenCalledWith(expect.anything(), organizer.id, quoteId, 'boost_72h', eventId);
    expect(points.spend).toHaveBeenCalledWith(
      expect.anything(),
      organizer.id,
      700n,
      'event_boost',
      `event_boost:${promotionId}`,
      expect.objectContaining({ eventId, tier: 'boost_72h' }),
    );

    const insert = calls.find((c) => c.sql.includes('INSERT INTO commerce.event_promotions'));
    expect(insert).toBeDefined();
    // The purchase must be recorded after the debit, carrying the ledger transaction id.
    expect(insert!.values).toContain('point-transaction-1');
    // 72h tier resolves to 72 configured hours (not hardcoded in the query text).
    expect(insert!.values).toContain(72);

    expect(result).toMatchObject({ tier: 'boost_72h', amount: 700, state: 'active' });
    expect(result.expiresAt).toBe(new Date('2026-07-21T00:00:00Z').toISOString());
  });

  it('rejects a promotion bought by anyone other than the organizer', async () => {
    const { service } = buildDeps({ event: publishedEventRow({ organizer_id: 'someone-else' }) });
    await expect(
      service.purchase(organizer as never, eventId, 'boost_24h', quoteId, key),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses to promote an event that is not approved and open for registration', async () => {
    const { service, points } = buildDeps({ event: publishedEventRow({ status: 'pending_review' }) });
    await expect(
      service.purchase(organizer as never, eventId, 'boost_24h', quoteId, key),
    ).rejects.toMatchObject({ status: 409 });
    expect(points.spend).not.toHaveBeenCalled();
  });

  it('refuses to promote an event whose registration deadline has already passed', async () => {
    const { service, points } = buildDeps({
      event: publishedEventRow({ deadline_at: new Date(Date.now() - 60_000) }),
    });
    await expect(
      service.purchase(organizer as never, eventId, 'boost_24h', quoteId, key),
    ).rejects.toMatchObject({ status: 409 });
    expect(points.spend).not.toHaveBeenCalled();
  });

  it('rejects a second promotion while one is still active', async () => {
    const { service, points } = buildDeps({ activePromotion: { id: 'existing' } });
    await expect(
      service.purchase(organizer as never, eventId, 'boost_24h', quoteId, key),
    ).rejects.toMatchObject({ status: 409 });
    expect(points.spend).not.toHaveBeenCalled();
  });

  it('replays the idempotent result without charging twice', async () => {
    const { service, points, idempotency } = buildDeps();
    idempotency.claim.mockResolvedValueOnce({ body: { id: promotionId, replayed: true } });
    const result = await service.purchase(organizer, eventId, 'boost_24h', quoteId, key);
    expect(result).toMatchObject({ replayed: true });
    expect(points.consumeQuote).not.toHaveBeenCalled();
    expect(points.spend).not.toHaveBeenCalled();
  });
});

describe('EventPromotionService.refund', () => {
  it('reverses the remaining unused portion of an active promotion pro-rata', async () => {
    const now = Date.now();
    const promotionRow = {
      id: promotionId,
      event_id: eventId,
      organizer_id: organizer.id,
      amount: '700',
      purchase_transaction_id: 'point-transaction-1',
      starts_at: new Date(now - 18 * 3_600_000), // 18h elapsed of a 72h window
      expires_at: new Date(now + 54 * 3_600_000), // 54h remaining
      duration_hours: 72,
      state: 'active',
    };
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM commerce.event_promotions')) return { rows: [promotionRow], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const points = {
      reverse: vi.fn().mockResolvedValue({ transactionId: 'reversal-1' }),
    };
    const service = new EventPromotionService({} as never, {} as never, points as never);

    const refunded = (await (service as unknown as {
      refund: (
        c: typeof client,
        eventId: string,
        reason: string,
      ) => Promise<{ refundedAmount: number } | null>;
    }).refund(client, eventId, 'platform_fault'));

    // 54h of 72h remaining -> 75% of 700 = 525 points reversed.
    expect(points.reverse).toHaveBeenCalledWith(
      expect.anything(),
      organizer.id,
      'point-transaction-1',
      expect.stringContaining('event_boost_refund'),
      'event_boost_refund',
      expect.objectContaining({ amount: 525n }),
    );
    expect(refunded).toMatchObject({ refundedAmount: 525 });
  });

  it('returns null when the event has no active promotion to refund', async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const points = { reverse: vi.fn() };
    const service = new EventPromotionService({} as never, {} as never, points as never);
    const refunded = await (service as unknown as {
      refund: (c: typeof client, eventId: string, reason: string) => Promise<unknown>;
    }).refund(client, eventId, 'takedown');
    expect(refunded).toBeNull();
    expect(points.reverse).not.toHaveBeenCalled();
  });
});
