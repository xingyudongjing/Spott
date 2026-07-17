import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';
import { PointsService } from '../points/points.service.js';

/**
 * Invite reward closed loop (product L, "邀请奖励必须在受邀者首次真实签到后发放").
 *
 * The attribution chain reuses the existing tables:
 *   - growth.share_links(campaign = 'invite')  marks a share as a referral invite; creator_id is
 *     the inviter, kept internal and never exposed in the public URL.
 *   - growth.attributions(action = 'registered', user_id = invitee, share_link_id)  records that a
 *     genuinely new invitee accepted the invite, together with occurred_at for the 30 day window.
 *   - commerce.point_transactions(type = 'referral_reward', business_key = referral:<invitee>)
 *     is the ledger side and, being unique per (user, business_key) and deterministically keyed on
 *     the invitee, guarantees the reward is paid at most once per invitee, ever.
 *
 * This service owns the attribution link only; every point movement goes through the ledger
 * (PointsService.credit). All amounts and windows are backend-configurable.
 */
@Injectable()
export class ReferralService {
  constructor(
    private readonly database: Database,
    private readonly points: PointsService,
  ) {}

  /**
   * Record that {@link inviteeId} accepted an invite share. Only genuinely new invitees — those who
   * have never really attended an event and have never been rewarded — are eligible, so returning
   * users cannot be laundered into a fresh referral. Returns whether an attribution was written.
   */
  async recordAcceptance(
    client: PoolClient,
    inviteeId: string,
    link: { id: string; creator_id: string },
  ): Promise<boolean> {
    if (link.creator_id === inviteeId) return false;

    const priorCheckin = await client.query(
      `SELECT 1 FROM events.checkins WHERE user_id = $1 LIMIT 1`,
      [inviteeId],
    );
    if (priorCheckin.rowCount) return false;

    const alreadyRewarded = await client.query(
      `SELECT 1 FROM commerce.point_transactions
       WHERE type = 'referral_reward' AND business_key = $1 LIMIT 1`,
      [`referral:${inviteeId}`],
    );
    if (alreadyRewarded.rowCount) return false;

    // occurred_at anchors the row; the 30 day window is resolved again at grant time so an admin can
    // widen or narrow it without a migration.
    await client.query(
      `INSERT INTO growth.attributions(share_link_id, user_id, session_id, action, occurred_at)
       VALUES ($1, $2, uuidv7(), 'registered', clock_timestamp())`,
      [link.id, inviteeId],
    );
    return true;
  }

  /**
   * Authenticated entry point: an invitee accepts an invite link by its public code.
   */
  async acceptInvite(inviteeId: string, code: string): Promise<{ accepted: boolean }> {
    const link = await this.database.query<{ id: string; creator_id: string }>(
      `SELECT id, creator_id FROM growth.share_links
       WHERE public_code = $1 AND campaign = 'invite' AND disabled_at IS NULL
         AND (expires_at IS NULL OR expires_at > clock_timestamp())`,
      [code],
    );
    const row = link.rows[0];
    if (!row) throw new DomainError('INVITE_NOT_FOUND', '邀请链接不存在或已失效。', 404);
    if (row.creator_id === inviteeId) {
      throw new DomainError('INVITE_SELF_FORBIDDEN', '不能使用自己的邀请码。', 422);
    }
    const accepted = await this.database.transaction((client) =>
      this.recordAcceptance(client, inviteeId, row),
    );
    return { accepted };
  }

  /**
   * Grant the referral reward for {@link inviteeId}'s first real check-in. Idempotent: safe to call
   * on every check-in because the ledger business key pays at most once, and after a check-in no new
   * acceptances can be recorded for the invitee.
   */
  async grantReferralReward(
    client: PoolClient,
    inviteeId: string,
  ): Promise<
    | { rewarded: true; amount: number; inviterId: string }
    | { rewarded: false; capped?: true }
  > {
    const windowDays = await this.points.configBigInt(
      client,
      'referral.attribution.window_days',
      30n,
    );
    const invite = await client.query<{ id: string; inviter_id: string; share_link_id: string }>(
      `SELECT a.id, s.creator_id AS inviter_id, s.id AS share_link_id
       FROM growth.attributions a
       JOIN growth.share_links s ON s.id = a.share_link_id
       JOIN identity.users inviter
         ON inviter.id = s.creator_id AND inviter.deleted_at IS NULL
       WHERE a.user_id = $1
         AND a.action = 'registered'
         AND s.campaign = 'invite'
         AND s.creator_id <> $1
         AND s.disabled_at IS NULL
         AND a.occurred_at > clock_timestamp() - ($2 || ' days')::interval
       ORDER BY a.occurred_at DESC, a.id DESC
       LIMIT 1`,
      [inviteeId, windowDays.toString()],
    );
    const winner = invite.rows[0];
    if (!winner) return { rewarded: false };

    const cap = await this.points.configBigInt(client, 'points.limit.referral.monthly', 5n);
    const awarded = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM commerce.point_transactions
       WHERE user_id = $1 AND type = 'referral_reward' AND status = 'posted'
         AND created_at >= date_trunc('month', clock_timestamp() AT TIME ZONE 'Asia/Tokyo')
           AT TIME ZONE 'Asia/Tokyo'`,
      [winner.inviter_id],
    );
    if (BigInt(awarded.rows[0]?.count ?? '0') >= cap) return { rewarded: false, capped: true };

    const amount = await this.points.configBigInt(client, 'points.reward.referral', 100n);
    // The reward runs inside the check-in transaction, so it must never throw:
    // credit() rejects amount <= 0, and setting points.reward.referral to 0 is the
    // natural way an operator disables invite rewards. Skip cleanly in that case so
    // disabling the reward can never roll back a check-in.
    if (amount <= 0n) return { rewarded: false };
    await this.points.credit(
      client,
      winner.inviter_id,
      amount,
      'free',
      'referral_reward',
      `referral:${inviteeId}`,
      { metadata: { inviteeId, inviterId: winner.inviter_id, shareLinkId: winner.share_link_id } },
    );
    return { rewarded: true, amount: Number(amount), inviterId: winner.inviter_id };
  }
}
