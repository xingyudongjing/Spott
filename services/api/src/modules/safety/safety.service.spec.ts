import { describe, expect, it, vi } from 'vitest';
import { SafetyService } from './safety.service.js';

function idempotency(replay: unknown = null) {
  return {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32, 9)),
    claim: vi.fn().mockResolvedValue(replay),
    complete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SafetyService report severity contract', () => {
  it.each([
    ['fraud', 'p0', '1 hour'],
    ['minor_safety', 'p0', '1 hour'],
    ['danger', 'p1', '24 hours'],
    ['harassment', 'p1', '24 hours'],
    ['spam', 'p2', '72 hours'],
  ] as const)('maps %s to %s with the matching SLA', async (reason, severity, sla) => {
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        void values;
        if (sql.includes('INSERT INTO safety.reports')) {
          return {
            rows: [
              {
                id: '019b0000-0000-7000-9000-000000000010',
                created_at: new Date('2026-07-16T00:00:00Z'),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const service = new SafetyService(
      database as never,
      { encrypt: vi.fn(() => 'ciphertext') } as never,
      idempotency() as never,
    );

    await service.report(
      '019b0000-0000-7000-8000-000000000001',
      '019b0000-0000-7000-9000-000000000001',
      {
        targetType: 'event',
        targetId: '019b0000-0000-7000-8100-000000000001',
        reason,
        details: 'contract test details',
        evidenceAssetIds: [],
      },
    );

    const reportCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO safety.reports'),
    );
    const caseCall = client.query.mock.calls.find(([sql]) =>
      sql.includes('INSERT INTO safety.moderation_cases'),
    );
    expect(reportCall?.[1]?.[6]).toBe(severity);
    expect(caseCall?.[1]).toEqual(['019b0000-0000-7000-9000-000000000010', sla]);
  });
});

describe('SafetyService appeal lifecycle', () => {
  it('resolves a user-owned case by public report reference and marks it appealed', async () => {
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        void values;
        if (sql.includes('FROM safety.moderation_cases moderation_case')) {
          return {
            rows: [
              {
                id: '019b0000-0000-7000-9000-000000000001',
                public_reference: 'SPT-2026-ABCDEF123456',
                status: 'decided',
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM safety.appeals')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO safety.appeals')) {
          return {
            rows: [
              {
                id: '019b0000-0000-7000-9000-000000000002',
                created_at: new Date('2026-07-15T00:00:00Z'),
              },
            ],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const service = new SafetyService(database as never, {} as never, {} as never);

    await expect(
      service.appeal('019b0000-0000-7000-8000-000000000001', {
        caseReference: 'SPT-2026-ABCDEF123456',
        statement: '我希望补充更多事实并申请复核。',
      }),
    ).resolves.toEqual({
      id: '019b0000-0000-7000-9000-000000000002',
      caseReference: 'SPT-2026-ABCDEF123456',
      status: 'pending',
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('report.public_reference = $2'),
      [null, 'SPT-2026-ABCDEF123456', '019b0000-0000-7000-8000-000000000001'],
    );
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'appealed'"), [
      '019b0000-0000-7000-9000-000000000001',
    ]);
  });

  it('lists submitted and subject safety cases without exposing encrypted evidence', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [
        {
          public_reference: 'SPT-2026-ABCDEF123456',
          relationship: 'submitted',
          target_type: 'event',
          target_id: '019b0000-0000-7000-8100-000000000001',
          reason: '疑似诈骗',
          severity: 'p0',
          report_status: 'appealed',
          case_status: 'appealed',
          decision: 'content_removed',
          sla_due_at: new Date('2026-07-16T00:00:00Z'),
          created_at: new Date('2026-07-15T00:00:00Z'),
          updated_at: new Date('2026-07-15T01:00:00Z'),
          appeal_id: '019b0000-0000-7000-9000-000000000002',
          appeal_status: 'pending',
          appeal_created_at: new Date('2026-07-15T01:00:00Z'),
          appeal_decided_at: null,
        },
      ],
    });
    const service = new SafetyService({ query } as never, {} as never, {} as never);

    await expect(service.cases('019b0000-0000-7000-8000-000000000001')).resolves.toEqual({
      items: [
        {
          reference: 'SPT-2026-ABCDEF123456',
          relationship: 'submitted',
          targetType: 'event',
          targetId: '019b0000-0000-7000-8100-000000000001',
          reason: '疑似诈骗',
          severity: 'p0',
          status: 'appealed',
          caseStatus: 'appealed',
          decision: 'content_removed',
          slaDueAt: '2026-07-16T00:00:00.000Z',
          createdAt: '2026-07-15T00:00:00.000Z',
          updatedAt: '2026-07-15T01:00:00.000Z',
          appeal: {
            id: '019b0000-0000-7000-9000-000000000002',
            status: 'pending',
            createdAt: '2026-07-15T01:00:00.000Z',
            decidedAt: null,
          },
        },
      ],
    });
  });
});

describe('SafetyService block sync', () => {
  it('casts the block state before building the JSONB sync payload', async () => {
    const blockerId = '019b0000-0000-7000-8000-000000000001';
    const blockedId = '019b0000-0000-7000-8000-000000000002';
    const client = {
      query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
        void values;
        if (sql.includes('SELECT id FROM identity.users')) {
          return { rows: [{ id: blockedId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const service = new SafetyService(database as never, {} as never, {} as never);

    await expect(service.setBlock(blockerId, blockedId, true, 'spam')).resolves.toEqual({
      userId: blockedId,
      blocked: true,
    });
    const syncCall = client.query.mock.calls.find(([sql]) => sql.includes("'block.changed'"));
    expect(syncCall?.[0]).toContain("jsonb_build_object('blocked', $3::boolean)");
    expect(syncCall?.[1]).toEqual([blockerId, blockedId, true]);
  });
});

describe('SafetyService report idempotency', () => {
  const reporterId = '019b0000-0000-7000-8000-000000000001';
  const key = '019b0000-0000-7000-9000-000000000001';
  const input = {
    targetType: 'event',
    targetId: '019b0000-0000-7000-8100-000000000001',
    reason: 'danger',
    details: 'There is an immediate risk.',
    evidenceAssetIds: ['019b0000-0000-7000-8200-000000000001'],
  };

  it('replays a completed response before creating a report, case, evidence, or outbox event', async () => {
    const replayed = {
      reference: 'SPT-2026-ABCDEF123456',
      status: 'open',
      submittedAt: '2026-07-16T00:00:00.000Z',
    };
    const client = { query: vi.fn() };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const requestIdempotency = idempotency({ status: 201, body: replayed });
    const crypto = { encrypt: vi.fn() };
    const service = new SafetyService(
      database as never,
      crypto as never,
      requestIdempotency as never,
    );

    await expect(service.report(reporterId, key, input)).resolves.toEqual(replayed);

    expect(requestIdempotency.requestHash).toHaveBeenCalledWith('POST', '/reports', input);
    expect(requestIdempotency.claim).toHaveBeenCalledWith(
      client,
      reporterId,
      key,
      Buffer.alloc(32, 9),
    );
    expect(client.query).not.toHaveBeenCalled();
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(requestIdempotency.complete).not.toHaveBeenCalled();
  });

  it('completes the first report with the report resource in the same transaction', async () => {
    const reportId = '019b0000-0000-7000-8300-000000000001';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM media.assets')) {
          return {
            rows: [{ id: input.evidenceAssetIds[0], content_hash: Buffer.alloc(32, 0xab) }],
            rowCount: 1,
          };
        }
        if (sql.includes('INSERT INTO safety.reports')) {
          return {
            rows: [{ id: reportId, created_at: new Date('2026-07-16T00:00:00.000Z') }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const requestIdempotency = idempotency();
    const service = new SafetyService(
      database as never,
      { encrypt: vi.fn().mockReturnValue('ciphertext') } as never,
      requestIdempotency as never,
    );

    const response = await service.report(reporterId, key, input);

    expect(requestIdempotency.complete).toHaveBeenCalledWith(
      client,
      reporterId,
      key,
      { status: 201, body: response },
      { type: 'safety_report', id: reportId },
    );
    expect(
      client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO safety.reports')),
    ).toHaveLength(1);
    expect(
      client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO safety.evidence_assets')),
    ).toHaveLength(1);
    expect(
      client.query.mock.calls.filter(([sql]) =>
        sql.includes('INSERT INTO safety.moderation_cases'),
      ),
    ).toHaveLength(1);
    expect(
      client.query.mock.calls.filter(([sql]) => sql.includes("'report.created'")),
    ).toHaveLength(1);
  });

  it('locks owned ready evidence and persists its verified content hash in caller order', async () => {
    const reportId = '019b0000-0000-7000-8300-000000000010';
    const firstAssetId = input.evidenceAssetIds[0]!;
    const secondAssetId = '019b0000-0000-7000-8200-000000000002';
    const orderedInput = { ...input, evidenceAssetIds: [secondAssetId, firstAssetId] };
    const firstHash = Buffer.alloc(32, 0xab);
    const secondHash = Buffer.alloc(32, 0xcd);
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM media.assets')) {
          return {
            rows: [
              { id: firstAssetId, content_hash: firstHash },
              { id: secondAssetId, content_hash: secondHash },
            ],
            rowCount: 2,
          };
        }
        if (sql.includes('INSERT INTO safety.reports')) {
          return {
            rows: [{ id: reportId, created_at: new Date('2026-07-16T00:00:00.000Z') }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) =>
        work(client),
      ),
    };
    const service = new SafetyService(
      database as never,
      { encrypt: vi.fn().mockReturnValue('ciphertext') } as never,
      idempotency() as never,
    );

    await service.report(reporterId, key, orderedInput);

    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/FROM\s+media\.assets[\s\S]*FOR\s+UPDATE/u),
      [orderedInput.evidenceAssetIds, reporterId],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT\s+INTO\s+safety\.evidence_assets/u),
      [reportId, secondAssetId, 0, secondHash],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringMatching(/INSERT\s+INTO\s+safety\.evidence_assets/u),
      [reportId, firstAssetId, 1, firstHash],
    );
    const evidenceSQL = String(
      client.query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO safety.evidence_assets'),
      )?.[0],
    );
    expect(evidenceSQL).not.toContain('digest($2::text');
  });
});
