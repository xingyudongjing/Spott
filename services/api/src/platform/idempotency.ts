import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { PoolClient } from 'pg';

export interface StoredResponse<T> {
  status: number;
  body: T;
}

@Injectable()
export class IdempotencyService {
  requestHash(method: string, path: string, body: unknown): Buffer {
    return createHash('sha256')
      .update(`${method}\n${path}\n${JSON.stringify(body ?? null)}`)
      .digest();
  }

  async claim<T>(
    client: PoolClient,
    userId: string,
    key: string,
    requestHash: Buffer,
    compatibleRequestHashes: readonly Buffer[] = [],
  ): Promise<StoredResponse<T> | null> {
    // Generic receipts are short-lived. Bound opportunistic cleanup prevents
    // expired legacy fingerprints from becoming an indefinite privacy log
    // without turning a request transaction into an unbounded table sweep.
    await client.query(
      `DELETE FROM sync.idempotency_keys
       WHERE ctid IN (
         SELECT ctid FROM sync.idempotency_keys
         WHERE expires_at <= clock_timestamp()
         ORDER BY expires_at
         LIMIT 128
         FOR UPDATE SKIP LOCKED
       )`,
    );
    const inserted = await client.query(
      `INSERT INTO sync.idempotency_keys(key, user_id, request_hash, expires_at)
       VALUES ($1, $2, $3, clock_timestamp() + interval '48 hours')
       ON CONFLICT (user_id, key) DO NOTHING
       RETURNING key`,
      [key, userId, requestHash],
    );
    if (inserted.rowCount === 1) return null;

    const existing = await client.query<{
      request_hash: Buffer;
      response_code: number | null;
      response_body: T | null;
    }>(
      `SELECT request_hash, response_code, response_body
       FROM sync.idempotency_keys WHERE user_id = $1 AND key = $2 FOR UPDATE`,
      [userId, key],
    );
    const row = existing.rows[0];
    const acceptedHashes = [requestHash, ...compatibleRequestHashes];
    if (!row || !acceptedHashes.some((candidate) => row.request_hash.equals(candidate))) {
      throw new DomainError('IDEMPOTENCY_KEY_REUSED', '该幂等键已用于不同请求。', 409);
    }
    if (row.response_code === null || row.response_body === null) {
      throw new DomainError('REQUEST_IN_PROGRESS', '相同请求正在处理中。', 409, {
        retryable: true,
      });
    }
    return { status: row.response_code, body: row.response_body };
  }

  async complete(
    client: PoolClient,
    userId: string,
    key: string,
    response: StoredResponse<unknown>,
    resource?: { type: string; id: string },
  ): Promise<void> {
    await client.query(
      `UPDATE sync.idempotency_keys
       SET response_code = $3, response_body = $4, resource_type = $5, resource_id = $6
       WHERE user_id = $1 AND key = $2`,
      [userId, key, response.status, response.body, resource?.type ?? null, resource?.id ?? null],
    );
  }
}
