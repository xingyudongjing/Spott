import { describe, expect, it, vi } from 'vitest';
import { ReferralService } from './referral.service.js';

const INVITEE = '019b0000-0000-7000-a000-000000000001';
const INVITER = '019b0000-0000-7000-a000-000000000002';
const SHARE = '019b0000-0000-7000-a000-000000000003';

function pointsStub(credit = vi.fn(async (...args: unknown[]) => ({ transactionId: 'txn-1', wallet: {}, args }))) {
  return {
    configBigInt: vi.fn(async (_client: unknown, key: string, fallback: bigint) => {
      if (key === 'points.reward.referral') return 100n;
      if (key === 'points.limit.referral.monthly') return 5n;
      if (key === 'referral.attribution.window_days') return 30n;
      return fallback;
    }),
    credit,
  };
}

describe('ReferralService.grantReferralReward', () => {
  it('pays the inviter through the ledger when a valid unexpired invite attribution exists', async () => {
    const query = vi
      .fn()
      // 1) latest valid invite attribution
      .mockResolvedValueOnce({ rows: [{ id: 'attr-1', inviter_id: INVITER, share_link_id: SHARE }], rowCount: 1 })
      // 2) monthly count so far
      .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 });
    const points = pointsStub();
    const service = new ReferralService({ query } as never, points as never);

    const result = await service.grantReferralReward({ query } as never, INVITEE);

    expect(result).toEqual({ rewarded: true, amount: 100, inviterId: INVITER });
    // credit goes to the inviter, once per invitee, from the free bucket via the ledger.
    expect(points.credit).toHaveBeenCalledTimes(1);
    const creditArgs = points.credit.mock.calls[0] as unknown[];
    expect(creditArgs[1]).toBe(INVITER);
    expect(creditArgs[2]).toBe(100n);
    expect(creditArgs[3]).toBe('free');
    expect(creditArgs[4]).toBe('referral_reward');
    expect(creditArgs[5]).toBe(`referral:${INVITEE}`);
    // the winning attribution query orders by newest first ("以最后一个有效邀请码为准")
    const selectSql = query.mock.calls[0]![0] as string;
    expect(selectSql).toContain("a.action = 'registered'");
    expect(selectSql).toContain("s.campaign = 'invite'");
    expect(selectSql).toContain('ORDER BY a.occurred_at DESC');
    expect(selectSql).toMatch(/days'\)::interval/);
  });

  it('does nothing when there is no valid invite attribution', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const points = pointsStub();
    const service = new ReferralService({ query } as never, points as never);

    const result = await service.grantReferralReward({ query } as never, INVITEE);

    expect(result).toEqual({ rewarded: false });
    expect(points.credit).not.toHaveBeenCalled();
  });

  it('respects the configurable monthly referral cap and pays nothing over the limit', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 'attr-1', inviter_id: INVITER, share_link_id: SHARE }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 });
    const points = pointsStub();
    const service = new ReferralService({ query } as never, points as never);

    const result = await service.grantReferralReward({ query } as never, INVITEE);

    expect(result).toEqual({ rewarded: false, capped: true });
    expect(points.credit).not.toHaveBeenCalled();
  });
});

describe('ReferralService.recordAcceptance', () => {
  it('records the invite attribution for a genuinely new invitee', async () => {
    const query = vi
      .fn()
      // prior check-in guard: none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // already rewarded guard: none
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      // insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const points = pointsStub();
    const service = new ReferralService({ query } as never, points as never);

    const recorded = await service.recordAcceptance({ query } as never, INVITEE, {
      id: SHARE,
      creator_id: INVITER,
    });

    expect(recorded).toBe(true);
    const insertSql = query.mock.calls.at(-1)![0] as string;
    expect(insertSql).toContain('INSERT INTO growth.attributions');
    expect(insertSql).toContain("'registered'");
  });

  it('refuses to record an invite for someone who already attended an event', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ one: 1 }], rowCount: 1 });
    const points = pointsStub();
    const service = new ReferralService({ query } as never, points as never);

    const recorded = await service.recordAcceptance({ query } as never, INVITEE, {
      id: SHARE,
      creator_id: INVITER,
    });

    expect(recorded).toBe(false);
    // never reaches the insert
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects self-invites before touching the database', async () => {
    const query = vi.fn();
    const points = pointsStub();
    const service = new ReferralService({ query } as never, points as never);

    const recorded = await service.recordAcceptance({ query } as never, INVITER, {
      id: SHARE,
      creator_id: INVITER,
    });

    expect(recorded).toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
