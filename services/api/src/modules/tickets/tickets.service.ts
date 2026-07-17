import { Injectable } from '@nestjs/common';
import { DomainError, type AvailableAction } from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';
import type { AuthenticatedUser } from '../../platform/request-context.js';

// Ticketing shell (owner ruling 2026-07-17): multiple ticket tiers per event, each disclosing the
// organizer's OFF-PLATFORM price and terms and carrying its own headcount quota. Spott records
// state only — it never collects, holds, refunds or takes commission on ticket money.

interface TicketTypeInput {
  name: string;
  description?: string | undefined;
  isFree: boolean;
  amountJPY?: number | undefined;
  collectorName?: string | undefined;
  method?: string | undefined;
  paymentDeadlineText?: string | undefined;
  refundPolicy?: string | undefined;
  quota?: number | undefined;
}

interface TicketTypeRow {
  id: string;
  event_id: string;
  name: string;
  description: string | null;
  is_free: boolean;
  amount_jpy: string | null;
  collector_name: string | null;
  method: string | null;
  payment_deadline_text: string | null;
  refund_policy: string | null;
  quota: number | null;
  sold_count: number;
  sort_order: number;
  active: boolean;
  updated_at: Date;
}

type TicketTypeUpdateInput = {
  [K in keyof TicketTypeInput]?: TicketTypeInput[K] | undefined;
} & { active?: boolean | undefined };

const DEFAULT_MAX_TYPES_PER_EVENT = 20n;

@Injectable()
export class TicketsService {
  constructor(private readonly database: Database) {}

  async list(eventId: string): Promise<unknown> {
    const event = await this.database.query<{ id: string }>(
      'SELECT id FROM events.events WHERE id = $1 AND deleted_at IS NULL',
      [eventId],
    );
    if (!event.rows[0]) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    const result = await this.database.query<TicketTypeRow>(
      `SELECT id, event_id, name, description, is_free, amount_jpy, collector_name, method,
         payment_deadline_text, refund_policy, quota, sold_count, sort_order, active, updated_at
       FROM events.ticket_types
       WHERE event_id = $1 AND active
       ORDER BY sort_order, id`,
      [eventId],
    );
    return { items: result.rows.map((row) => this.toView(row)) };
  }

  async create(actor: AuthenticatedUser, eventId: string, input: TicketTypeInput): Promise<unknown> {
    const normalized = this.normalize(input);
    return this.database.transaction(async (client) => {
      await this.assertOrganizer(client, eventId, actor);
      const limit = await this.configBigInt(client, 'ticketing.max_types_per_event', DEFAULT_MAX_TYPES_PER_EVENT);
      const stats = await client.query<{ count: string; next_sort: number }>(
        `SELECT count(*)::text AS count,
           COALESCE(max(sort_order), -1) + 1 AS next_sort
         FROM events.ticket_types WHERE event_id = $1`,
        [eventId],
      );
      const count = BigInt(stats.rows[0]?.count ?? '0');
      if (count >= limit) {
        throw new DomainError('TICKET_TYPE_LIMIT_REACHED', '票种数量已达上限。', 409, {
          meta: { limit: Number(limit) },
        });
      }
      const sortOrder = stats.rows[0]?.next_sort ?? 0;
      const result = await client.query<TicketTypeRow>(
        `INSERT INTO events.ticket_types(
           event_id, name, description, is_free, amount_jpy, collector_name, method,
           payment_deadline_text, refund_policy, quota, sort_order
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id, event_id, name, description, is_free, amount_jpy, collector_name, method,
           payment_deadline_text, refund_policy, quota, sold_count, sort_order, active, updated_at`,
        [
          eventId,
          normalized.name,
          normalized.description,
          normalized.isFree,
          normalized.amountJPY,
          normalized.collectorName,
          normalized.method,
          normalized.paymentDeadlineText,
          normalized.refundPolicy,
          normalized.quota,
          sortOrder,
        ],
      );
      return this.toView(result.rows[0]!);
    });
  }

  async update(
    actor: AuthenticatedUser,
    ticketTypeId: string,
    input: TicketTypeUpdateInput,
  ): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const existing = await client.query<TicketTypeRow>(
        `SELECT tt.id, tt.event_id, tt.name, tt.description, tt.is_free, tt.amount_jpy,
           tt.collector_name, tt.method, tt.payment_deadline_text, tt.refund_policy,
           tt.quota, tt.sold_count, tt.sort_order, tt.active, tt.updated_at
         FROM events.ticket_types tt WHERE tt.id = $1 FOR UPDATE OF tt`,
        [ticketTypeId],
      );
      const row = existing.rows[0];
      if (!row) throw new DomainError('TICKET_TYPE_NOT_FOUND', '票种不存在。', 404);
      await this.assertOrganizer(client, row.event_id, actor);

      const merged = this.normalize({
        name: input.name ?? row.name,
        description: input.description !== undefined ? input.description : (row.description ?? undefined),
        isFree: input.isFree ?? row.is_free,
        amountJPY:
          input.amountJPY !== undefined
            ? input.amountJPY
            : (row.amount_jpy === null ? undefined : Number(row.amount_jpy)),
        collectorName:
          input.collectorName !== undefined ? input.collectorName : (row.collector_name ?? undefined),
        method: input.method !== undefined ? input.method : (row.method ?? undefined),
        paymentDeadlineText:
          input.paymentDeadlineText !== undefined
            ? input.paymentDeadlineText
            : (row.payment_deadline_text ?? undefined),
        refundPolicy:
          input.refundPolicy !== undefined ? input.refundPolicy : (row.refund_policy ?? undefined),
        quota: input.quota !== undefined ? input.quota : (row.quota ?? undefined),
      });
      // Quota can never drop below the seats already taken: existing holders keep their place.
      if (merged.quota !== null && merged.quota < row.sold_count) {
        throw new DomainError('TICKET_TYPE_QUOTA_BELOW_SOLD', '票种上限不能低于已占用的名额。', 409, {
          meta: { soldCount: row.sold_count },
        });
      }
      const active = input.active ?? row.active;
      const result = await client.query<TicketTypeRow>(
        `UPDATE events.ticket_types SET
           name = $2, description = $3, is_free = $4, amount_jpy = $5, collector_name = $6,
           method = $7, payment_deadline_text = $8, refund_policy = $9, quota = $10,
           active = $11, updated_at = clock_timestamp()
         WHERE id = $1
         RETURNING id, event_id, name, description, is_free, amount_jpy, collector_name, method,
           payment_deadline_text, refund_policy, quota, sold_count, sort_order, active, updated_at`,
        [
          ticketTypeId,
          merged.name,
          merged.description,
          merged.isFree,
          merged.amountJPY,
          merged.collectorName,
          merged.method,
          merged.paymentDeadlineText,
          merged.refundPolicy,
          merged.quota,
          active,
        ],
      );
      return this.toView(result.rows[0]!);
    });
  }

  async reportPayment(user: AuthenticatedUser, registrationId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        user_id: string;
        status: string;
        tier_free: boolean | null;
        event_free: boolean | null;
      }>(
        `SELECT r.user_id, r.status::text AS status,
           tt.is_free AS tier_free, ef.is_free AS event_free
         FROM events.registrations r
         LEFT JOIN events.ticket_types tt ON tt.id = r.ticket_type_id
         LEFT JOIN events.event_fees ef ON ef.event_id = r.event_id
         WHERE r.id = $1 AND r.deleted_at IS NULL FOR UPDATE OF r`,
        [registrationId],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不存在。', 404);
      if (row.user_id !== user.id) {
        throw new DomainError('REGISTRATION_FORBIDDEN', '无权操作此报名。', 403);
      }
      if (!['pending', 'confirmed', 'checked_in'].includes(row.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能标记付款。', 422);
      }
      // Only a paid tier (or a paid single-fee event) has anything to pay off-platform.
      const paid = row.tier_free === false || (row.tier_free === null && row.event_free === false);
      if (!paid) {
        throw new DomainError('TICKET_PAYMENT_NOT_APPLICABLE', '此报名无需线下付款。', 409);
      }
      const updated = await client.query<{ payment_self_reported_at: Date }>(
        `UPDATE events.registrations
         SET payment_self_reported_at = clock_timestamp()
         WHERE id = $1
         RETURNING payment_self_reported_at`,
        [registrationId],
      );
      return {
        registrationId,
        paymentStatus: 'self_reported',
        selfReportedAt: updated.rows[0]!.payment_self_reported_at.toISOString(),
      };
    });
  }

  async confirmPayment(actor: AuthenticatedUser, registrationId: string): Promise<unknown> {
    return this.database.transaction(async (client) => {
      const result = await client.query<{
        organizer_id: string;
        status: string;
        payment_self_reported_at: Date | null;
      }>(
        `SELECT e.organizer_id, r.status::text AS status, r.payment_self_reported_at
         FROM events.registrations r
         JOIN events.events e ON e.id = r.event_id
         WHERE r.id = $1 AND r.deleted_at IS NULL FOR UPDATE OF r`,
        [registrationId],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('REGISTRATION_NOT_FOUND', '报名记录不存在。', 404);
      if (row.organizer_id !== actor.id && !actor.roles.includes('operator')) {
        throw new DomainError('TICKET_PAYMENT_CONFIRM_FORBIDDEN', '只有局头可以确认收款。', 403);
      }
      if (!['pending', 'confirmed', 'checked_in'].includes(row.status)) {
        throw new DomainError('INVALID_STATE_TRANSITION', '当前报名状态不能确认收款。', 422);
      }
      const updated = await client.query<{ payment_confirmed_at: Date }>(
        `UPDATE events.registrations
         SET payment_confirmed_at = clock_timestamp(), payment_confirmed_by = $2
         WHERE id = $1
         RETURNING payment_confirmed_at`,
        [registrationId, actor.id],
      );
      return {
        registrationId,
        paymentStatus: 'confirmed',
        confirmedAt: updated.rows[0]!.payment_confirmed_at.toISOString(),
        confirmedBy: actor.id,
      };
    });
  }

  private async assertOrganizer(
    client: PoolClient,
    eventId: string,
    actor: AuthenticatedUser,
  ): Promise<void> {
    const event = await client.query<{ organizer_id: string }>(
      'SELECT organizer_id FROM events.events WHERE id = $1 AND deleted_at IS NULL',
      [eventId],
    );
    if (!event.rows[0]) throw new DomainError('EVENT_NOT_FOUND', '活动不存在。', 404);
    if (event.rows[0].organizer_id !== actor.id && !actor.roles.includes('operator')) {
      throw new DomainError('TICKET_MANAGE_FORBIDDEN', '只有局头可以管理票种。', 403);
    }
  }

  private normalize(input: TicketTypeInput): {
    name: string;
    description: string | null;
    isFree: boolean;
    amountJPY: number | null;
    collectorName: string | null;
    method: string | null;
    paymentDeadlineText: string | null;
    refundPolicy: string | null;
    quota: number | null;
  } {
    const name = input.name?.trim() ?? '';
    if (name.length < 1 || name.length > 80) {
      throw new DomainError('TICKET_TYPE_INVALID', '票种名称需为 1–80 字。', 400, {
        fieldErrors: [{ field: 'name', message: '票种名称需为 1–80 字。' }],
      });
    }
    if (input.quota !== undefined && (!Number.isInteger(input.quota) || input.quota < 1)) {
      throw new DomainError('TICKET_TYPE_INVALID', '票种上限需为正整数。', 400, {
        fieldErrors: [{ field: 'quota', message: '票种上限需为正整数。' }],
      });
    }
    if (input.isFree) {
      // A free tier discloses no price or collector: this is the non-custody money shape.
      if (input.amountJPY !== undefined || input.collectorName || input.method) {
        throw new DomainError('TICKET_TYPE_INVALID', '免费票不能填写金额或收款信息。', 400, {
          fieldErrors: [{ field: 'amountJPY', message: '免费票不能填写金额或收款信息。' }],
        });
      }
      return {
        name,
        description: input.description?.trim() || null,
        isFree: true,
        amountJPY: null,
        collectorName: null,
        method: null,
        paymentDeadlineText: null,
        refundPolicy: null,
        quota: input.quota ?? null,
      };
    }
    // A paid tier must disclose a positive external amount, an off-platform collector and a method,
    // plus a refund policy — Spott only shows these, it never processes the money.
    const amount = input.amountJPY;
    const collector = input.collectorName?.trim();
    const method = input.method?.trim();
    const refundPolicy = input.refundPolicy?.trim();
    const fieldErrors: Array<{ field: string; message: string }> = [];
    if (amount === undefined || !Number.isInteger(amount) || amount <= 0) {
      fieldErrors.push({ field: 'amountJPY', message: '付费票金额需为正整数日元。' });
    }
    if (!collector) fieldErrors.push({ field: 'collectorName', message: '请填写收款主体。' });
    if (!method) fieldErrors.push({ field: 'method', message: '请填写 App 外收款方式。' });
    if (!refundPolicy) fieldErrors.push({ field: 'refundPolicy', message: '请填写退款规则。' });
    if (fieldErrors.length) {
      throw new DomainError('TICKET_TYPE_INVALID', '请完整填写付费票信息。', 400, { fieldErrors });
    }
    return {
      name,
      description: input.description?.trim() || null,
      isFree: false,
      amountJPY: amount!,
      collectorName: collector!,
      method: method!,
      paymentDeadlineText: input.paymentDeadlineText?.trim() || null,
      refundPolicy: refundPolicy!,
      quota: input.quota ?? null,
    };
  }

  private toView(row: TicketTypeRow): Record<string, unknown> {
    const remaining = row.quota === null ? null : Math.max(0, row.quota - row.sold_count);
    const soldOut = remaining !== null && remaining <= 0;
    const actions: AvailableAction[] = [];
    if (row.active && !soldOut) actions.push('selectTicket');
    return {
      id: row.id,
      eventId: row.event_id,
      name: row.name,
      description: row.description,
      isFree: row.is_free,
      amountJPY: row.amount_jpy === null ? null : Number(row.amount_jpy),
      collectorName: row.collector_name,
      method: row.method,
      paymentDeadlineText: row.payment_deadline_text,
      refundPolicy: row.refund_policy,
      quota: row.quota,
      soldCount: row.sold_count,
      remaining,
      soldOut,
      active: row.active,
      sortOrder: row.sort_order,
      availableActions: actions,
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async configBigInt(client: PoolClient, key: string, fallback: bigint): Promise<bigint> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = $1 AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
      [key],
    );
    const value = result.rows[0]?.value_json;
    if (typeof value === 'number' || typeof value === 'string') {
      try {
        const parsed = BigInt(value);
        if (parsed > 0n) return parsed;
      } catch {
        // fall through to the safe default
      }
    }
    return fallback;
  }
}
