import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
import { Database } from '../../platform/database.js';

interface WalletRow {
  paid_balance: string;
  free_balance: string;
  version: string;
}

export interface WalletView {
  paidBalance: number;
  freeBalance: number;
  totalBalance: number;
  version: number;
  nextFreeExpiry: string | null;
}

@Injectable()
export class PointsService {
  constructor(private readonly database: Database) {}

  async wallet(userId: string): Promise<WalletView> {
    const result = await this.database.query<WalletRow & { next_free_expiry: Date | null }>(
      `SELECT w.paid_balance, w.free_balance, w.version,
         (SELECT min(e.expires_at) FROM commerce.point_entries e
          JOIN commerce.point_transactions t ON t.id = e.transaction_id
          WHERE t.user_id = w.user_id AND e.bucket = 'free' AND e.amount > 0
            AND e.expires_at > clock_timestamp()) AS next_free_expiry
       FROM commerce.wallets w WHERE w.user_id = $1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('WALLET_NOT_FOUND', '积分钱包不存在。', 404);
    return this.mapWallet(row);
  }

  async transactions(userId: string, cursor?: string, limit = 20): Promise<unknown> {
    const decoded = cursor ? new Date(Buffer.from(cursor, 'base64url').toString('utf8')) : null;
    const result = await this.database.query<{
      id: string;
      type: string;
      business_key: string;
      status: string;
      posted_at: Date | null;
      created_at: Date;
      paid_delta: string;
      free_delta: string;
    }>(
      `SELECT t.id, t.type, t.business_key, t.status, t.posted_at, t.created_at,
         COALESCE(sum(e.amount) FILTER (WHERE e.account_code = 'user:' || t.user_id::text AND e.bucket = 'paid'), 0) AS paid_delta,
         COALESCE(sum(e.amount) FILTER (WHERE e.account_code = 'user:' || t.user_id::text AND e.bucket = 'free'), 0) AS free_delta
       FROM commerce.point_transactions t
       LEFT JOIN commerce.point_entries e ON e.transaction_id = t.id
       WHERE t.user_id = $1 AND ($2::timestamptz IS NULL OR t.created_at < $2)
       GROUP BY t.id
       ORDER BY t.created_at DESC, t.id DESC LIMIT $3`,
      [userId, decoded?.toISOString() ?? null, Math.min(Math.max(limit, 1), 100) + 1],
    );
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        paidDelta: Number(row.paid_delta),
        freeDelta: Number(row.free_delta),
        occurredAt: (row.posted_at ?? row.created_at).toISOString(),
      })),
      hasMore,
      nextCursor:
        hasMore && rows.at(-1)
          ? Buffer.from(rows.at(-1)!.created_at.toISOString()).toString('base64url')
          : null,
    };
  }

  async createQuote(
    userId: string,
    purpose: string,
    resourceId?: string,
  ): Promise<{ id: string; amount: number; currency: 'POINTS'; expiresAt: string }> {
    const allowed: Record<string, { key: string; fallback: bigint }> = {
      registration: { key: 'points.cost.registration', fallback: 10n },
      event_publish: { key: 'points.cost.event_publish', fallback: 100n },
      group_create: { key: 'points.cost.group_create', fallback: 300n },
      group_capacity: { key: 'points.cost.group_capacity', fallback: 200n },
      poster: { key: 'points.cost.poster', fallback: 20n },
      boost_24h: { key: 'points.cost.boost_24h', fallback: 300n },
      boost_72h: { key: 'points.cost.boost_72h', fallback: 700n },
      boost_7d: { key: 'points.cost.boost_7d', fallback: 1500n },
      extra_announcement: { key: 'points.cost.extra_announcement', fallback: 50n },
      organizer_export: { key: 'points.cost.organizer_export', fallback: 100n },
    };
    const selected = allowed[purpose];
    if (!selected) throw new DomainError('QUOTE_PURPOSE_INVALID', '不支持的报价用途。', 400);
    return this.database.transaction(async (client) => {
      const amount = await this.configBigInt(client, selected.key, selected.fallback);
      const result = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO commerce.quotes(
         user_id, purpose, resource_id, amount, currency, config_versions, expires_at
       ) VALUES ($1, $2, $3, $4, 'POINTS',
           jsonb_build_object($5::text, COALESCE((SELECT max(version) FROM admin.config_revisions WHERE key = $5::text), 0)),
           clock_timestamp() + interval '15 minutes')
         RETURNING id, expires_at`,
        [userId, purpose, resourceId ?? null, amount.toString(), selected.key],
      );
      const row = result.rows[0];
      if (!row) throw new DomainError('QUOTE_CREATE_FAILED', '报价生成失败。', 500);
      return { id: row.id, amount: Number(amount), currency: 'POINTS' as const, expiresAt: row.expires_at.toISOString() };
    });
  }

  async consumeQuote(
    client: PoolClient,
    userId: string,
    quoteId: string,
    purpose: string,
    resourceId?: string,
  ): Promise<bigint> {
    const result = await client.query<{ amount: string; resource_id: string | null }>(
      `SELECT amount, resource_id FROM commerce.quotes
       WHERE id = $1 AND user_id = $2 AND purpose = $3
         AND consumed_at IS NULL AND expires_at > clock_timestamp()
       FOR UPDATE`,
      [quoteId, userId, purpose],
    );
    const quote = result.rows[0];
    if (!quote || (resourceId && quote.resource_id && quote.resource_id !== resourceId)) {
      throw new DomainError('QUOTE_EXPIRED', '确认价格已过期，请重新确认。', 409, {
        actions: [{ type: 'refreshQuote', label: '重新确认' }],
      });
    }
    await client.query('UPDATE commerce.quotes SET consumed_at = clock_timestamp() WHERE id = $1', [quoteId]);
    return BigInt(quote.amount);
  }

  async spend(
    client: PoolClient,
    userId: string,
    amount: bigint,
    type: string,
    businessKey: string,
    metadata: Record<string, unknown> = {},
    excludeHoldId?: string,
  ): Promise<{ transactionId: string; wallet: WalletView }> {
    const walletResult = await client.query<WalletRow>(
      'SELECT paid_balance, free_balance, version FROM commerce.wallets WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', '积分钱包不存在。', 404);
    const holds = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(total_amount), 0)::text AS total
       FROM commerce.point_holds
       WHERE user_id = $1 AND state = 'active' AND expires_at > clock_timestamp()
         AND ($2::uuid IS NULL OR id <> $2)`,
      [userId, excludeHoldId ?? null],
    );
    const reserved = BigInt(holds.rows[0]?.total ?? '0');
    const total = BigInt(wallet.free_balance) + BigInt(wallet.paid_balance) - reserved;
    if (amount <= 0n) throw new DomainError('VALIDATION_FAILED', '积分消耗必须大于 0。', 400);
    if (total < amount) {
      throw new DomainError('POINTS_INSUFFICIENT', '积分不足。', 409, {
        actions: [{ type: 'openWallet', label: '查看获取方式' }],
        meta: { required: amount.toString(), available: total.toString() },
      });
    }

    const transaction = await client.query<{ id: string }>(
      `INSERT INTO commerce.point_transactions(user_id, type, business_key, status, metadata, posted_at)
       VALUES ($1, $2, $3, 'posted', $4, clock_timestamp())
       ON CONFLICT (user_id, business_key) DO NOTHING RETURNING id`,
      [userId, type, businessKey, metadata],
    );
    if (transaction.rowCount === 0) {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM commerce.point_transactions WHERE user_id = $1 AND business_key = $2',
        [userId, businessKey],
      );
      return { transactionId: existing.rows[0]!.id, wallet: await this.walletInTransaction(client, userId) };
    }
    const transactionId = transaction.rows[0]!.id;
    const lots = await client.query<{
      id: string;
      bucket: 'paid' | 'free';
      expires_at: Date | null;
      remaining: string;
    }>(
      `SELECT credit.id, credit.bucket, credit.expires_at,
         (credit.amount + COALESCE((
           SELECT sum(spend.amount) FROM commerce.point_entries spend
           WHERE spend.source_lot_id = credit.id
         ), 0))::text AS remaining
       FROM commerce.point_entries credit
       JOIN commerce.point_transactions tx ON tx.id = credit.transaction_id
       WHERE tx.user_id = $1 AND credit.account_code = 'user:' || $1::text
         AND credit.amount > 0
         AND (credit.expires_at IS NULL OR credit.expires_at > clock_timestamp())
         AND credit.amount + COALESCE((
           SELECT sum(spend.amount) FROM commerce.point_entries spend
           WHERE spend.source_lot_id = credit.id
         ), 0) > 0
       ORDER BY CASE WHEN credit.bucket = 'free' THEN 0 ELSE 1 END,
         credit.expires_at ASC NULLS LAST, credit.id
       FOR UPDATE OF credit`,
      [userId],
    );

    let remaining = amount;
    let freeSpent = 0n;
    let paidSpent = 0n;
    for (const lot of lots.rows) {
      if (remaining === 0n) break;
      const available = BigInt(lot.remaining);
      const allocation = available < remaining ? available : remaining;
      await client.query(
        `INSERT INTO commerce.point_entries(
           transaction_id, account_code, bucket, amount, source_lot_id
         ) VALUES
           ($1, $2, $3, $4, $5),
           ($1, 'platform:spent', $3, $6, $5)`,
        [transactionId, `user:${userId}`, lot.bucket, (-allocation).toString(), lot.id, allocation.toString()],
      );
      if (lot.bucket === 'free') freeSpent += allocation;
      else paidSpent += allocation;
      remaining -= allocation;
    }
    if (remaining !== 0n) {
      throw new DomainError('LEDGER_SNAPSHOT_MISMATCH', '钱包余额需要对账，积分操作已暂停。', 503, {
        retryable: false,
      });
    }
    await client.query(
      `UPDATE commerce.wallets SET
         free_balance = free_balance - $2,
         paid_balance = paid_balance - $3
       WHERE user_id = $1`,
      [userId, freeSpent.toString(), paidSpent.toString()],
    );
    return { transactionId, wallet: await this.walletInTransaction(client, userId) };
  }

  async createHold(
    client: PoolClient,
    userId: string,
    amount: bigint,
    businessKey: string,
    expiresIn: '15 minutes' | '24 hours' = '24 hours',
  ): Promise<string> {
    const walletResult = await client.query<WalletRow>(
      'SELECT paid_balance, free_balance, version FROM commerce.wallets WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const wallet = walletResult.rows[0];
    if (!wallet) throw new DomainError('WALLET_NOT_FOUND', '积分钱包不存在。', 404);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM commerce.point_holds WHERE user_id = $1 AND business_key = $2`,
      [userId, businessKey],
    );
    if (existing.rows[0]) return existing.rows[0].id;
    const holds = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(total_amount), 0)::text AS total FROM commerce.point_holds
       WHERE user_id = $1 AND state = 'active' AND expires_at > clock_timestamp()`,
      [userId],
    );
    const available = BigInt(wallet.free_balance) + BigInt(wallet.paid_balance) - BigInt(holds.rows[0]?.total ?? '0');
    if (available < amount) {
      throw new DomainError('POINTS_INSUFFICIENT', '可用积分不足。', 409, {
        meta: { required: amount.toString(), available: available.toString() },
        actions: [{ type: 'openWallet', label: '查看获取方式' }],
      });
    }
    const free = BigInt(wallet.free_balance) < amount ? BigInt(wallet.free_balance) : amount;
    const paid = amount - free;
    const result = await client.query<{ id: string }>(
      `INSERT INTO commerce.point_holds(
         user_id, business_key, bucket_allocations, total_amount, expires_at
       ) VALUES ($1, $2, $3::jsonb, $4,
         clock_timestamp() + CASE WHEN $5::text = '15 minutes' THEN interval '15 minutes' ELSE interval '24 hours' END)
       RETURNING id`,
      [
        userId,
        businessKey,
        JSON.stringify([
          ...(free > 0n ? [{ bucket: 'free', amount: free.toString() }] : []),
          ...(paid > 0n ? [{ bucket: 'paid', amount: paid.toString() }] : []),
        ]),
        amount.toString(),
        expiresIn,
      ],
    );
    return result.rows[0]!.id;
  }

  async captureHold(
    client: PoolClient,
    holdId: string,
    transactionType: string,
    businessKey: string,
  ): Promise<{ transactionId: string; wallet: WalletView }> {
    const result = await client.query<{ user_id: string; total_amount: string; state: string }>(
      `SELECT user_id, total_amount, state FROM commerce.point_holds WHERE id = $1 FOR UPDATE`,
      [holdId],
    );
    const hold = result.rows[0];
    if (!hold) throw new DomainError('POINT_HOLD_NOT_FOUND', '积分预留不存在。', 404);
    if (hold.state === 'captured') {
      const linked = await client.query<{ transaction_id: string }>(
        'SELECT transaction_id FROM commerce.point_holds WHERE id = $1',
        [holdId],
      );
      return {
        transactionId: linked.rows[0]!.transaction_id,
        wallet: await this.walletInTransaction(client, hold.user_id),
      };
    }
    if (hold.state !== 'active') throw new DomainError('POINT_HOLD_EXPIRED', '积分预留已失效。', 409);
    const spent = await this.spend(
      client,
      hold.user_id,
      BigInt(hold.total_amount),
      transactionType,
      businessKey,
      { holdId },
      holdId,
    );
    await client.query(
      `UPDATE commerce.point_holds SET state = 'captured', transaction_id = $2,
         updated_at = clock_timestamp() WHERE id = $1`,
      [holdId, spent.transactionId],
    );
    return spent;
  }

  async releaseHold(client: PoolClient, holdId: string): Promise<void> {
    await client.query(
      `UPDATE commerce.point_holds SET state = 'released', updated_at = clock_timestamp()
       WHERE id = $1 AND state = 'active'`,
      [holdId],
    );
  }

  async reverse(
    client: PoolClient,
    userId: string,
    originalTransactionId: string,
    businessKey: string,
    type: string,
    options: { amount?: bigint } = {},
  ): Promise<{ transactionId: string; wallet: WalletView }> {
    if (options.amount !== undefined && options.amount <= 0n) {
      throw new DomainError('VALIDATION_FAILED', '冲正积分必须大于 0。', 400);
    }
    const existing = await client.query<{ id: string }>(
      `INSERT INTO commerce.point_transactions(
         user_id, type, business_key, status, reversal_of, posted_at
       ) VALUES ($1, $2, $3, 'posted', $4, clock_timestamp())
       ON CONFLICT (user_id, business_key) DO NOTHING RETURNING id`,
      [userId, type, businessKey, originalTransactionId],
    );
    if (existing.rowCount === 0) {
      const row = await client.query<{ id: string }>(
        'SELECT id FROM commerce.point_transactions WHERE user_id = $1 AND business_key = $2',
        [userId, businessKey],
      );
      return { transactionId: row.rows[0]!.id, wallet: await this.walletInTransaction(client, userId) };
    }
    const reversalId = existing.rows[0]!.id;
    const original = await client.query<{ bucket: 'paid' | 'free'; amount: string; expires_at: Date | null }>(
      `SELECT bucket, -sum(amount)::text AS amount,
         max(expires_at) FILTER (WHERE expires_at > clock_timestamp()) AS expires_at
       FROM commerce.point_entries
       WHERE transaction_id = $1 AND account_code = $2 AND amount < 0
       GROUP BY bucket`,
      [originalTransactionId, `user:${userId}`],
    );
    // A partial reversal (pro-rata promotion refund) restores the more valuable
    // paid bucket first, then free, capped at the amount actually spent per
    // bucket. Omitting options.amount reverses the full original spend, which is
    // the historical behaviour every existing caller relies on.
    const totalSpent = original.rows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    let remaining = options.amount === undefined || options.amount > totalSpent ? totalSpent : options.amount;
    const ordered = [
      ...original.rows.filter((row) => row.bucket === 'paid'),
      ...original.rows.filter((row) => row.bucket === 'free'),
    ];
    let free = 0n;
    let paid = 0n;
    for (const row of ordered) {
      if (remaining === 0n) break;
      const bucketSpent = BigInt(row.amount);
      const amount = bucketSpent < remaining ? bucketSpent : remaining;
      if (amount === 0n) continue;
      const expiry = row.bucket === 'free' ? row.expires_at ?? new Date(Date.now() + 30 * 86_400_000) : null;
      await client.query(
        `INSERT INTO commerce.point_entries(transaction_id, account_code, bucket, amount, expires_at)
         VALUES ($1, $2, $3, $4, $5), ($1, 'platform:reversal', $3, $6, NULL)`,
        [reversalId, `user:${userId}`, row.bucket, amount.toString(), expiry, (-amount).toString()],
      );
      if (row.bucket === 'free') free += amount;
      else paid += amount;
      remaining -= amount;
    }
    await client.query(
      `UPDATE commerce.wallets SET free_balance = free_balance + $2, paid_balance = paid_balance + $3
       WHERE user_id = $1`,
      [userId, free.toString(), paid.toString()],
    );
    return { transactionId: reversalId, wallet: await this.walletInTransaction(client, userId) };
  }

  async credit(
    client: PoolClient,
    userId: string,
    amount: bigint,
    bucket: 'paid' | 'free',
    type: string,
    businessKey: string,
    options: { expiresAt?: Date; metadata?: Record<string, unknown> } = {},
  ): Promise<{ transactionId: string; wallet: WalletView }> {
    if (amount <= 0n) throw new DomainError('VALIDATION_FAILED', '入账积分必须大于 0。', 400);
    await client.query(
      'SELECT user_id FROM commerce.wallets WHERE user_id = $1 FOR UPDATE',
      [userId],
    );
    const transaction = await client.query<{ id: string }>(
      `INSERT INTO commerce.point_transactions(user_id, type, business_key, status, metadata, posted_at)
       VALUES ($1, $2, $3, 'posted', $4, clock_timestamp())
       ON CONFLICT (user_id, business_key) DO NOTHING RETURNING id`,
      [userId, type, businessKey, options.metadata ?? {}],
    );
    if (transaction.rowCount === 0) {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM commerce.point_transactions WHERE user_id = $1 AND business_key = $2',
        [userId, businessKey],
      );
      return { transactionId: existing.rows[0]!.id, wallet: await this.walletInTransaction(client, userId) };
    }
    const transactionId = transaction.rows[0]!.id;
    const freeExpiry =
      bucket === 'free'
        ? options.expiresAt ?? new Date(Date.now() + Number(await this.configBigInt(client, 'points.expiry.free_days', 180n)) * 86_400_000)
        : null;
    await client.query(
      `INSERT INTO commerce.point_entries(transaction_id, account_code, bucket, amount, expires_at)
       VALUES ($1, $2, $3, $4, $5), ($1, 'platform:credits', $3, $6, NULL)`,
      [
        transactionId,
        `user:${userId}`,
        bucket,
        amount.toString(),
        freeExpiry,
        (-amount).toString(),
      ],
    );
    await client.query(
      `UPDATE commerce.wallets
       SET free_balance = free_balance + CASE WHEN $2 = 'free' THEN $3::bigint ELSE 0 END,
           paid_balance = paid_balance + CASE WHEN $2 = 'paid' THEN $3::bigint ELSE 0 END
       WHERE user_id = $1`,
      [userId, bucket, amount.toString()],
    );
    return { transactionId, wallet: await this.walletInTransaction(client, userId) };
  }

  async configBigInt(client: PoolClient, key: string, fallback: bigint): Promise<bigint> {
    const result = await client.query<{ value_json: unknown }>(
      `SELECT value_json FROM admin.config_revisions
       WHERE key = $1 AND state = 'active'
         AND (effective_from IS NULL OR effective_from <= clock_timestamp())
         AND (effective_to IS NULL OR effective_to > clock_timestamp())
       ORDER BY version DESC LIMIT 1`,
      [key],
    );
    const value = result.rows[0]?.value_json;
    if (typeof value === 'number' || typeof value === 'string') return BigInt(value);
    const catalog = await client.query<{ configured_value: string }>(
      `SELECT CASE
         WHEN COALESCE((
           SELECT value_json #>> '{}' FROM admin.config_revisions
           WHERE key = 'points.lifecycle.stage' AND state = 'active'
             AND (effective_from IS NULL OR effective_from <= clock_timestamp())
             AND (effective_to IS NULL OR effective_to > clock_timestamp())
           ORDER BY version DESC LIMIT 1
         ), 'launch') = 'stable' THEN stable_value ELSE launch_value
       END::text AS configured_value
       FROM commerce.point_rule_catalog WHERE key = $1`,
      [key],
    );
    return catalog.rows[0] ? BigInt(catalog.rows[0].configured_value) : fallback;
  }

  async rules(): Promise<unknown> {
    const result = await this.database.query<{
      key: string;
      rule_type: string;
      launch_value: string;
      stable_value: string;
      effective_value: string;
      unit: string;
      conditions: Record<string, unknown>;
      description: string;
      stage: string;
    }>(
      `WITH stage AS (
         SELECT COALESCE((
           SELECT value_json #>> '{}' FROM admin.config_revisions
           WHERE key = 'points.lifecycle.stage' AND state = 'active'
             AND (effective_from IS NULL OR effective_from <= clock_timestamp())
             AND (effective_to IS NULL OR effective_to > clock_timestamp())
           ORDER BY version DESC LIMIT 1
         ), 'launch') AS value
       )
       SELECT c.key, c.rule_type, c.launch_value::text, c.stable_value::text,
         COALESCE((
           SELECT value_json #>> '{}' FROM admin.config_revisions revision
           WHERE revision.key = c.key AND revision.state = 'active'
             AND (revision.effective_from IS NULL OR revision.effective_from <= clock_timestamp())
             AND (revision.effective_to IS NULL OR revision.effective_to > clock_timestamp())
           ORDER BY revision.version DESC LIMIT 1
         ), CASE WHEN stage.value = 'stable' THEN c.stable_value::text ELSE c.launch_value::text END) AS effective_value,
         c.unit, c.conditions, c.description, stage.value AS stage
       FROM commerce.point_rule_catalog c CROSS JOIN stage
       ORDER BY c.rule_type, c.key`,
    );
    return {
      stage: result.rows[0]?.stage ?? 'launch',
      items: result.rows.map((row) => ({
        key: row.key,
        type: row.rule_type,
        launchValue: Number(row.launch_value),
        stableValue: Number(row.stable_value),
        effectiveValue: Number(row.effective_value),
        unit: row.unit,
        conditions: row.conditions,
        description: row.description,
      })),
    };
  }

  private async walletInTransaction(client: PoolClient, userId: string): Promise<WalletView> {
    const result = await client.query<WalletRow>(
      'SELECT paid_balance, free_balance, version FROM commerce.wallets WHERE user_id = $1',
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError('WALLET_NOT_FOUND', '积分钱包不存在。', 404);
    return this.mapWallet({ ...row, next_free_expiry: null });
  }

  private mapWallet(row: WalletRow & { next_free_expiry?: Date | null }): WalletView {
    const paid = Number(row.paid_balance);
    const free = Number(row.free_balance);
    return {
      paidBalance: paid,
      freeBalance: free,
      totalBalance: paid + free,
      version: Number(row.version),
      nextFreeExpiry: row.next_free_expiry?.toISOString() ?? null,
    };
  }
}
