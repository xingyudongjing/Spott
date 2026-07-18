import { describe, expect, it, vi } from 'vitest';
import { IdempotencyService } from './idempotency.js';

describe('IdempotencyService fingerprint transition', () => {
  it('purges expired generic receipts and accepts one explicit legacy fingerprint', async () => {
    const current = Buffer.alloc(32, 0x21);
    const legacy = Buffer.alloc(32, 0x11);
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        queries.push(sql);
        if (sql.includes('DELETE FROM sync.idempotency_keys')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO sync.idempotency_keys')) {
          expect(values?.[2]).toEqual(current);
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{ request_hash: legacy, response_code: 201, response_body: { id: 'legacy-replay' } }],
          rowCount: 1,
        };
      }),
    };

    const replay = await new IdempotencyService().claim<{ id: string }>(
      client as never,
      '019b0000-0000-7000-8000-000000000001',
      '019b0000-0000-7000-9000-000000000001',
      current,
      [legacy],
    );

    expect(replay).toEqual({ status: 201, body: { id: 'legacy-replay' } });
    expect(queries[0]).toContain('expires_at <= clock_timestamp()');
    expect(queries[0]).toContain('LIMIT 128');
    expect(queries[0]).toContain('FOR UPDATE SKIP LOCKED');
  });
});
