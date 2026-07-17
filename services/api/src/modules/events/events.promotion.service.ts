import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';
import { IdempotencyService } from '../../platform/idempotency.js';
import { PointsService } from '../points/points.service.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';

export type PromotionTier = 'boost_24h' | 'boost_72h' | 'boost_7d';

const TIER_HOURS_CONFIG: Record<PromotionTier, { key: string; fallback: bigint }> = {
  boost_24h: { key: 'points.boost.hours_24h', fallback: 24n },
  boost_72h: { key: 'points.boost.hours_72h', fallback: 72n },
  boost_7d: { key: 'points.boost.hours_7d', fallback: 168n },
};

interface PromotionRow {
  id: string;
  event_id: string;
  organizer_id: string;
  tier: string;
  amount: string;
  duration_hours: number;
  purchase_transaction_id: string;
  starts_at: Date;
  expires_at: Date;
  state: string;
}

export interface PromotionView {
  id: string;
  eventId: string;
  tier: string;
  amount: number;
  durationHours: number;
  state: string;
  startsAt: string;
  expiresAt: string;
  purchaseTransactionId: string;
}

@Injectable()
export class EventPromotionService {
  constructor(
    private readonly database: Database,
    private readonly idempotency: IdempotencyService,
    private readonly points: PointsService,
  ) {}

  async purchase(
    user: AuthenticatedUser,
    eventId: string,
    tier: PromotionTier,
    quoteId: string,
    key: string,
  ): Promise<unknown> {
    if (!TIER_HOURS_CONFIG[tier]) {
      throw new DomainError('PROMOTION_TIER_INVALID', '不支持的置顶档位。', 400);
    }
    return this.database.transaction(async (client) => {
      const hash = this.idempotency.requestHash('POST', `/events/${eventId}/promotions`, { tier, quoteId });
      const replay = await this.idempotency.claim<unknown>(client, user.id, key, hash);
      if (replay) return replay.body;

      const event = await client.query<{ organizer_id: string; status: string; deadline_at: Date | null }>(
        `SELECT organizer_id, status, deadline_at FROM events.events
         WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [eventId],
      );
      const row = event.rows[0];
      if (!row) throw new DomainError('EVENT_NOT_FOUND', '活动不存在或已不可见。', 404);
      if (row.organizer_id !== user.id) {
        throw new DomainError('PROMOTION_FORBIDDEN', '只有活动组织者可以购买置顶。', 403);
      }
      // Open condition (product doc N): the event must have passed review and
      // still be open for registration. Promotion never touches activity fees —
      // it is a points-only discovery product.
      const registrationOpen =
        row.status === 'published' && (!row.deadline_at || row.deadline_at.getTime() > Date.now());
      if (!registrationOpen) {
        throw new DomainError('PROMOTION_EVENT_NOT_OPEN', '活动需审核通过且仍可报名才能置顶。', 409, {
          meta: { status: row.status },
        });
      }

      const active = await client.query<{ id: string }>(
        `SELECT id FROM commerce.event_promotions
         WHERE event_id = $1 AND state = 'active' AND expires_at > clock_timestamp()
         FOR UPDATE`,
        [eventId],
      );
      if (active.rows[0]) {
        throw new DomainError('PROMOTION_ALREADY_ACTIVE', '该活动已有生效中的置顶。', 409);
      }

      const idResult = await client.query<{ id: string }>('SELECT uuidv7() AS id');
      const promotionId = idResult.rows[0]!.id;
      const durationHours = await this.points.configBigInt(
        client,
        TIER_HOURS_CONFIG[tier].key,
        TIER_HOURS_CONFIG[tier].fallback,
      );

      const amount = await this.points.consumeQuote(client, user.id, quoteId, tier, eventId);
      const spent = await this.points.spend(
        client,
        user.id,
        amount,
        'event_boost',
        `event_boost:${promotionId}`,
        { eventId, tier, promotionId },
      );

      const inserted = await client.query<PromotionRow>(
        `INSERT INTO commerce.event_promotions(
           id, event_id, organizer_id, tier, duration_hours, amount,
           purchase_transaction_id, expires_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7,
           clock_timestamp() + make_interval(hours => $5))
         RETURNING id, event_id, organizer_id, tier, amount, duration_hours,
           purchase_transaction_id, starts_at, expires_at, state`,
        [
          promotionId,
          eventId,
          user.id,
          tier,
          Number(durationHours),
          amount.toString(),
          spent.transactionId,
        ],
      );

      const body = this.view(inserted.rows[0]!);
      await this.idempotency.complete(client, user.id, key, { status: 201, body }, { type: 'event', id: eventId });
      return body;
    });
  }

  async active(eventId: string): Promise<PromotionView | null> {
    const result = await this.database.query<PromotionRow>(
      `SELECT id, event_id, organizer_id, tier, amount, duration_hours,
         purchase_transaction_id, starts_at, expires_at, state
       FROM commerce.event_promotions
       WHERE event_id = $1 AND state = 'active' AND expires_at > clock_timestamp()
       ORDER BY expires_at DESC LIMIT 1`,
      [eventId],
    );
    return result.rows[0] ? this.view(result.rows[0]) : null;
  }

  /**
   * Pro-rata refund of an active promotion through a ledger Reversal. Used when
   * an event is taken down in review or a platform fault invalidated the
   * promotion window (product doc N: 审核拒绝或平台故障按比例退). The refunded
   * amount is the unused fraction of the paid window. Returns null when the
   * event has no active promotion to refund.
   */
  async refund(
    client: PoolClient,
    eventId: string,
    reason: string,
  ): Promise<{ promotionId: string; refundedAmount: number; refundTransactionId: string } | null> {
    const result = await client.query<PromotionRow>(
      `SELECT id, event_id, organizer_id, tier, amount, duration_hours,
         purchase_transaction_id, starts_at, expires_at, state
       FROM commerce.event_promotions
       WHERE event_id = $1 AND state = 'active'
       ORDER BY expires_at DESC LIMIT 1
       FOR UPDATE`,
      [eventId],
    );
    const promotion = result.rows[0];
    if (!promotion) return null;

    const amount = BigInt(promotion.amount);
    const totalMs = promotion.expires_at.getTime() - promotion.starts_at.getTime();
    const remainingMs = Math.min(Math.max(promotion.expires_at.getTime() - Date.now(), 0), totalMs);
    // Rounded pro-rata share of the unused window, half-up.
    const refundAmount =
      totalMs <= 0
        ? amount
        : (amount * BigInt(remainingMs) + BigInt(Math.floor(totalMs / 2))) / BigInt(totalMs);

    let refundTransactionId: string | null = null;
    if (refundAmount > 0n) {
      const reversed = await this.points.reverse(
        client,
        promotion.organizer_id,
        promotion.purchase_transaction_id,
        `event_boost_refund:${promotion.id}`,
        'event_boost_refund',
        { amount: refundAmount },
      );
      refundTransactionId = reversed.transactionId;
    }

    await client.query(
      `UPDATE commerce.event_promotions
       SET state = 'refunded', refund_transaction_id = $2, refunded_amount = $3,
         refund_reason = $4, refunded_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = $1`,
      [promotion.id, refundTransactionId, refundAmount.toString(), reason],
    );

    return {
      promotionId: promotion.id,
      refundedAmount: Number(refundAmount),
      refundTransactionId: refundTransactionId ?? '',
    };
  }

  private view(row: PromotionRow): PromotionView {
    return {
      id: row.id,
      eventId: row.event_id,
      tier: row.tier,
      amount: Number(row.amount),
      durationHours: Number(row.duration_hours),
      state: row.state,
      startsAt: row.starts_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
      purchaseTransactionId: row.purchase_transaction_id,
    };
  }
}
