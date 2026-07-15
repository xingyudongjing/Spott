import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';
import { configuration } from '../../config.js';
import { Database } from '../../platform/database.js';
import { PointsService, type WalletView } from '../points/points.service.js';

interface ProductRow {
  id: string;
  points: string;
  bonus_points: string;
}

interface CatalogProductRow {
  product_id: string;
  points: string;
  bonus_points: string;
}

@Injectable()
export class StoreKitService {
  private signedDataVerifier?: SignedDataVerifier;

  constructor(
    private readonly database: Database,
    private readonly points: PointsService,
  ) {}

  async catalog(): Promise<unknown> {
    const result = await this.database.query<CatalogProductRow>(
      `SELECT product_id, points::text, bonus_points::text
       FROM commerce.store_products
       WHERE store = 'apple'
         AND active_from <= clock_timestamp()
         AND (active_until IS NULL OR active_until > clock_timestamp())
       ORDER BY commerce.store_products.points, commerce.store_products.bonus_points, product_id`,
    );
    return {
      store: 'apple',
      items: result.rows
        .map((row) => ({
          productId: row.product_id,
          points: Number(row.points),
          bonusPoints: Number(row.bonus_points),
        }))
        .sort((left, right) => left.points - right.points || left.bonusPoints - right.bonusPoints),
    };
  }

  async verifyAndCredit(
    userId: string,
    signedTransaction: string,
    idempotencyKey?: string,
  ): Promise<WalletView> {
    const decoded = await this.verifyTransaction(signedTransaction);
    if (
      !decoded.transactionId ||
      !decoded.originalTransactionId ||
      !decoded.productId ||
      !decoded.purchaseDate
    ) {
      throw new DomainError('STORE_TRANSACTION_INCOMPLETE', '购买凭证缺少必要信息。', 400);
    }
    if (!decoded.appAccountToken || decoded.appAccountToken.toLowerCase() !== userId.toLowerCase()) {
      throw new DomainError('STORE_ACCOUNT_MISMATCH', '购买凭证不属于当前账号。', 409);
    }
    if (decoded.revocationDate) {
      throw new DomainError('STORE_TRANSACTION_REVOKED', '该购买已退款或撤销。', 409);
    }
    const quantity = BigInt(Math.max(1, decoded.quantity ?? 1));
    const payloadHash = createHash('sha256').update(signedTransaction).digest();

    return this.database.transaction(async (client) => {
      const existing = await client.query<{ user_id: string; state: string }>(
        `SELECT user_id, state FROM commerce.store_orders
         WHERE store = 'apple' AND transaction_id = $1 FOR UPDATE`,
        [decoded.transactionId],
      );
      const previous = existing.rows[0];
      if (previous) {
        if (previous.user_id !== userId) {
          throw new DomainError('STORE_TRANSACTION_REPLAYED', '该购买已绑定其他账号。', 409);
        }
        return this.walletInTransaction(client, userId);
      }

      const productResult = await client.query<ProductRow>(
        `SELECT id, points, bonus_points FROM commerce.store_products
         WHERE store = 'apple' AND product_id = $1
           AND active_from <= clock_timestamp()
           AND (active_until IS NULL OR active_until > clock_timestamp())`,
        [decoded.productId],
      );
      const product = productResult.rows[0];
      if (!product) throw new DomainError('STORE_PRODUCT_UNAVAILABLE', '该积分商品当前不可用。', 409);
      const paidPoints = BigInt(product.points) * quantity;
      const bonusPoints = BigInt(product.bonus_points) * quantity;

      const order = await client.query<{ id: string }>(
        `INSERT INTO commerce.store_orders(
           user_id, store, product_id, transaction_id, original_transaction_id,
           signed_payload_hash, state, purchased_at, environment, storefront, app_account_token
         ) VALUES ($1, 'apple', $2, $3, $4, $5, 'verified', $6, $7, $8, $9)
         RETURNING id`,
        [
          userId,
          decoded.productId,
          decoded.transactionId,
          decoded.originalTransactionId,
          payloadHash,
          new Date(decoded.purchaseDate!),
          decoded.environment ?? configuration().APPLE_STORE_ENVIRONMENT,
          decoded.storefront ?? null,
          decoded.appAccountToken,
        ],
      );
      const orderId = order.rows[0]!.id;
      const paidCredit = await this.points.credit(
        client,
        userId,
        paidPoints,
        'paid',
        'storekit_purchase',
        `storekit:${decoded.transactionId}:paid`,
        {
          metadata: {
            orderId,
            productId: decoded.productId,
            quantity: quantity.toString(),
            idempotencyKey: idempotencyKey ?? null,
          },
        },
      );
      let wallet = paidCredit.wallet;
      let bonusTransactionId: string | null = null;
      if (bonusPoints > 0n) {
        const bonusCredit = await this.points.credit(
          client,
          userId,
          bonusPoints,
          'free',
          'storekit_bonus',
          `storekit:${decoded.transactionId}:bonus`,
          {
            metadata: {
              orderId,
              productId: decoded.productId,
              quantity: quantity.toString(),
              source: 'storekit_purchase',
            },
          },
        );
        bonusTransactionId = bonusCredit.transactionId;
        wallet = bonusCredit.wallet;
      }
      await client.query(
        `UPDATE commerce.store_orders SET state = 'credited', points_transaction_id = $2,
           bonus_points_transaction_id = $3,
           updated_at = clock_timestamp() WHERE id = $1`,
        [orderId, paidCredit.transactionId, bonusTransactionId],
      );
      return wallet;
    });
  }

  async processNotification(signedPayload: string): Promise<void> {
    const decoded = await this.verifyNotification(signedPayload);
    if (!decoded.notificationUUID || !decoded.notificationType) {
      throw new DomainError('STORE_NOTIFICATION_INCOMPLETE', 'App Store 通知缺少必要信息。', 400);
    }
    const payloadHash = createHash('sha256').update(signedPayload).digest();
    const transaction = decoded.data?.signedTransactionInfo
      ? await this.verifyTransaction(decoded.data.signedTransactionInfo)
      : null;

    await this.database.transaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO commerce.store_webhook_events(
           store, notification_uuid, notification_type, subtype,
           signed_payload_hash, payload_json
         ) VALUES ('apple', $1, $2, $3, $4, $5)
         ON CONFLICT (store, notification_uuid) DO NOTHING RETURNING id`,
        [decoded.notificationUUID, decoded.notificationType, decoded.subtype ?? null, payloadHash, decoded],
      );
      if (inserted.rowCount === 0) return;

      if (transaction?.transactionId && transaction.revocationDate) {
        await this.reverseRevokedOrder(client, transaction, decoded.notificationUUID!);
      }
      await client.query(
        `UPDATE commerce.store_webhook_events SET state = 'processed', processed_at = clock_timestamp()
         WHERE store = 'apple' AND notification_uuid = $1`,
        [decoded.notificationUUID],
      );
    });
  }

  private async reverseRevokedOrder(
    client: PoolClient,
    transaction: {
      transactionId?: string;
      revocationDate?: number;
      revocationReason?: number | string;
      revocationPercentage?: number;
    },
    notificationUUID: string,
  ): Promise<void> {
    const orderResult = await client.query<{
      id: string;
      user_id: string;
      state: string;
      points_transaction_id: string | null;
      bonus_points_transaction_id: string | null;
    }>(
      `SELECT id, user_id, state, points_transaction_id, bonus_points_transaction_id
       FROM commerce.store_orders
       WHERE store = 'apple' AND transaction_id = $1 FOR UPDATE`,
      [transaction.transactionId],
    );
    const order = orderResult.rows[0];
    if (!order || !order.points_transaction_id || ['refunded', 'revoked'].includes(order.state)) return;
    const percentage = BigInt(Math.min(1_000_000, Math.max(0, transaction.revocationPercentage ?? 1_000_000)));
    const creditedTransactions = [order.points_transaction_id, order.bonus_points_transaction_id].filter(
      (id): id is string => Boolean(id),
    );
    const reversals: Array<{ bucket: 'paid' | 'free'; amount: bigint }> = [];
    for (const transactionId of creditedTransactions) {
      const creditResult = await client.query<{ bucket: 'paid' | 'free'; amount: string }>(
        `SELECT bucket, COALESCE(sum(amount), 0)::text AS amount
         FROM commerce.point_entries
         WHERE transaction_id = $1 AND account_code = 'user:' || $2::text AND amount > 0
         GROUP BY bucket`,
        [transactionId, order.user_id],
      );
      for (const credit of creditResult.rows) {
        const credited = BigInt(credit.amount);
        const amount = (credited * percentage + 999_999n) / 1_000_000n;
        if (amount > 0n) reversals.push({ bucket: credit.bucket, amount });
      }
    }
    const reversed = reversals.reduce((sum, entry) => sum + entry.amount, 0n);
    if (reversed <= 0n) return;

    const reversal = await client.query<{ id: string }>(
      `INSERT INTO commerce.point_transactions(
         user_id, type, business_key, status, reversal_of, metadata, posted_at
       ) VALUES ($1, 'storekit_refund', $2, 'posted', $3, $4, clock_timestamp())
       ON CONFLICT (user_id, business_key) DO NOTHING RETURNING id`,
      [
        order.user_id,
        `storekit_refund:${notificationUUID}`,
        order.points_transaction_id,
        { orderId: order.id, revocationReason: transaction.revocationReason ?? null },
      ],
    );
    if (reversal.rowCount === 1) {
      const reversalId = reversal.rows[0]!.id;
      let paidReversed = 0n;
      let freeReversed = 0n;
      for (const entry of reversals) {
        await client.query(
          `INSERT INTO commerce.point_entries(transaction_id, account_code, bucket, amount)
           VALUES ($1, $2, $3, $4), ($1, 'platform:storekit_refunds', $3, $5)`,
          [
            reversalId,
            `user:${order.user_id}`,
            entry.bucket,
            (-entry.amount).toString(),
            entry.amount.toString(),
          ],
        );
        if (entry.bucket === 'paid') paidReversed += entry.amount;
        else freeReversed += entry.amount;
      }
      await client.query(
        `UPDATE commerce.wallets
         SET paid_balance = paid_balance - $2, free_balance = free_balance - $3
         WHERE user_id = $1`,
        [order.user_id, paidReversed.toString(), freeReversed.toString()],
      );
      await client.query(
        `INSERT INTO commerce.refunds(
           order_id, store_event_id, points_reversed, state, reversal_transaction_id
         ) VALUES ($1, $2, $3, 'posted', $4)
         ON CONFLICT (store_event_id) DO NOTHING`,
        [order.id, notificationUUID, reversed.toString(), reversalId],
      );
    }
    await client.query(
      `UPDATE commerce.store_orders SET state = 'revoked', revocation_reason = $2,
         revoked_at = $3, updated_at = clock_timestamp() WHERE id = $1`,
      [
        order.id,
        typeof transaction.revocationReason === 'number' ? transaction.revocationReason : null,
        transaction.revocationDate ? new Date(transaction.revocationDate) : new Date(),
      ],
    );
    await client.query(
      `UPDATE identity.users SET restriction_flags =
         CASE WHEN (SELECT paid_balance FROM commerce.wallets WHERE user_id = $1) < 0
           THEN array_append(restriction_flags, 'pointsBlocked') ELSE restriction_flags END
       WHERE id = $1 AND NOT ('pointsBlocked' = ANY(restriction_flags))`,
      [order.user_id],
    );
  }

  private async walletInTransaction(client: PoolClient, userId: string): Promise<WalletView> {
    const result = await client.query<{
      paid_balance: string;
      free_balance: string;
      version: string;
    }>('SELECT paid_balance, free_balance, version FROM commerce.wallets WHERE user_id = $1', [userId]);
    const row = result.rows[0];
    if (!row) throw new DomainError('WALLET_NOT_FOUND', '积分钱包不存在。', 404);
    const paid = Number(row.paid_balance);
    const free = Number(row.free_balance);
    return {
      paidBalance: paid,
      freeBalance: free,
      totalBalance: paid + free,
      version: Number(row.version),
      nextFreeExpiry: null,
    };
  }

  private async verifyTransaction(signedTransaction: string) {
    try {
      return await this.verifier().verifyAndDecodeTransaction(signedTransaction);
    } catch (error) {
      this.throwVerificationError(error);
    }
  }

  private async verifyNotification(signedPayload: string) {
    try {
      return await this.verifier().verifyAndDecodeNotification(signedPayload);
    } catch (error) {
      this.throwVerificationError(error);
    }
  }

  private verifier(): SignedDataVerifier {
    if (this.signedDataVerifier) return this.signedDataVerifier;
    const config = configuration();
    const environment =
      config.APPLE_STORE_ENVIRONMENT === 'Production' ? Environment.PRODUCTION : Environment.SANDBOX;
    if (environment === Environment.PRODUCTION && !config.APPLE_APP_ID) {
      throw new DomainError('STOREKIT_NOT_CONFIGURED', '生产环境缺少 App Store 应用 ID。', 503);
    }
    const roots = config.APPLE_ROOT_CA_PATHS.split(',')
      .map((path) => path.trim())
      .filter(Boolean)
      .map((path) => readFileSync(resolve(path)));
    if (roots.length === 0) throw new DomainError('STOREKIT_NOT_CONFIGURED', '缺少 Apple 根证书。', 503);
    this.signedDataVerifier = new SignedDataVerifier(
      roots,
      config.APPLE_ENABLE_ONLINE_CHECKS === 'true',
      environment,
      config.APPLE_BUNDLE_ID,
      config.APPLE_APP_ID,
    );
    return this.signedDataVerifier;
  }

  private throwVerificationError(error: unknown): never {
    const retryable =
      error instanceof VerificationException &&
      error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE;
    throw new DomainError(
      retryable ? 'STORE_VERIFICATION_UNAVAILABLE' : 'STORE_SIGNATURE_INVALID',
      retryable ? 'App Store 验证服务暂时不可用。' : '购买凭证签名无效。',
      retryable ? 503 : 400,
      { retryable },
    );
  }
}
