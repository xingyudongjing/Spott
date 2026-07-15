import { describe, expect, it, vi } from 'vitest';
import { SafetyService } from './safety.service.js';

describe('SafetyService appeal lifecycle', () => {
  it('resolves a user-owned case by public report reference and marks it appealed', async () => {
    const client = {
      query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
        if (sql.includes('FROM safety.moderation_cases moderation_case')) {
          return {
            rows: [{
              id: '019b0000-0000-7000-9000-000000000001',
              public_reference: 'SPT-2026-ABCDEF123456',
              status: 'decided',
            }],
            rowCount: 1,
          };
        }
        if (sql.includes('FROM safety.appeals')) return { rows: [], rowCount: 0 };
        if (sql.includes('INSERT INTO safety.appeals')) {
          return {
            rows: [{ id: '019b0000-0000-7000-9000-000000000002', created_at: new Date('2026-07-15T00:00:00Z') }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new SafetyService(database as never, {} as never);

    await expect(service.appeal('019b0000-0000-7000-8000-000000000001', {
      caseReference: 'SPT-2026-ABCDEF123456',
      statement: '我希望补充更多事实并申请复核。',
    })).resolves.toEqual({
      id: '019b0000-0000-7000-9000-000000000002',
      caseReference: 'SPT-2026-ABCDEF123456',
      status: 'pending',
      createdAt: '2026-07-15T00:00:00.000Z',
    });
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('report.public_reference = $2'),
      [null, 'SPT-2026-ABCDEF123456', '019b0000-0000-7000-8000-000000000001'],
    );
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'appealed'"),
      ['019b0000-0000-7000-9000-000000000001'],
    );
  });

  it('lists submitted and subject safety cases without exposing encrypted evidence', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
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
      }],
    });
    const service = new SafetyService({ query } as never, {} as never);

    await expect(service.cases('019b0000-0000-7000-8000-000000000001')).resolves.toEqual({
      items: [{
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
      }],
    });
  });
});

describe('SafetyService block sync', () => {
  it('casts the block state before building the JSONB sync payload', async () => {
    const blockerId = '019b0000-0000-7000-8000-000000000001';
    const blockedId = '019b0000-0000-7000-8000-000000000002';
    const client = {
      query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
        if (sql.includes('SELECT id FROM identity.users')) {
          return { rows: [{ id: blockedId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new SafetyService(database as never, {} as never);

    await expect(service.setBlock(blockerId, blockedId, true, 'spam')).resolves.toEqual({
      userId: blockedId,
      blocked: true,
    });
    const syncCall = client.query.mock.calls.find(([sql]) => sql.includes("'block.changed'"));
    expect(syncCall?.[0]).toContain("jsonb_build_object('blocked', $3::boolean)");
    expect(syncCall?.[1]).toEqual([blockerId, blockedId, true]);
  });
});
