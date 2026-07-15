import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import { OpsService } from './ops.service.js';

const operator: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-000000000099',
  sessionId: '00000000-0000-4000-8000-000000000098',
  phoneVerified: true,
  restrictions: [],
  roles: ['operator', 'moderator', 'eventReviewer', 'pointsApprover', 'auditReader'],
};

const admin = {
  id: '00000000-0000-4000-8000-000000000088',
  roles: ['moderator', 'eventReviewer', 'pointsApprover', 'auditReader'],
  data_scopes: ['jp'],
  mfa_enrolled_at: new Date('2026-07-01T00:00:00.000Z'),
};

function serviceWith(query: ReturnType<typeof vi.fn>) {
  const database = {
    query,
    transaction: vi.fn(async (work: (client: { query: typeof query }) => unknown) => work({ query })),
  };
  const points = { captureHold: vi.fn(), releaseHold: vi.fn() };
  const idempotency = {
    requestHash: vi.fn(() => Buffer.from('request')),
    claim: vi.fn(async () => null),
    complete: vi.fn(async () => undefined),
  };
  return {
    service: new OpsService(database as never, points as never, idempotency as never),
    database,
    idempotency,
  };
}

describe('OpsService contract', () => {
  it('returns the scoped overview contract after enforcing MFA operator access', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          p0_open: '1', moderation_open: '3', event_review_pending: '4',
          point_approvals_pending: '2', appeals_pending: '1', outbox_backlog: '5',
          delivered_1h: '95', delivery_total_1h: '100', ledger_delta_paid: '0',
          ledger_delta_free: '0', active_users_30d: '120', active_groups: '8',
          events_open: '16', checked_in_30d: '45', eligible_checkins_30d: '50',
          repeat_users_60d: '12', participants_60d: '30',
        }],
      });
    const { service } = serviceWith(query);

    const result = await service.overview(operator) as Record<string, any>;

    expect(result.queues).toEqual(expect.objectContaining({ p0Open: 1, outboxBacklog: 5 }));
    expect(result.health.deliverySuccessRate1h).toBe(0.95);
    expect(result.growth.checkinRate30d).toBe(0.9);
    expect(query.mock.calls[0]?.[0]).toContain('mfa_enrolled_at IS NOT NULL');
  });

  it('masks resource identifiers in immutable audit search results', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000001',
          created_at: new Date('2026-07-15T00:00:00.000Z'),
          actor_id: admin.id,
          actor_label: 'Nao',
          action: 'event.reviewed',
          resource: 'event',
          resource_id: '019f1234-5678-7000-8000-123456789abc',
          purpose: 'moderation',
          trace_id: 'trace-1',
        }],
      });
    const { service } = serviceWith(query);

    const result = await service.auditLogs(operator, {}, undefined, 20) as Record<string, any>;

    expect(result.items[0].resourceIdMasked).toBe('019f1234…9abc');
    expect(result.items[0]).not.toHaveProperty('resourceId');
  });

  it('calculates organizer repeat participation from returning participants instead of a placeholder', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000011',
          public_handle: 'city_host',
          nickname: 'City Host',
          status: 'active',
          restriction_flags: [],
          phone_verified_at: new Date('2026-07-01T00:00:00.000Z'),
          version: '2',
          created_at: new Date('2026-06-01T00:00:00.000Z'),
          hosted_count: '4',
          upcoming_count: '1',
          completed_count: '3',
          checked_in_count: '8',
          eligible_count: '10',
          participants_60d: '10',
          repeat_participants_60d: '4',
          complaint_count: '1',
        }],
        rowCount: 1,
      });
    const { service } = serviceWith(query);

    const result = await service.organizers(operator, {}, undefined, 20) as Record<string, any>;

    expect(result.items[0].repeatRate60d).toBe(0.4);
    expect(String(query.mock.calls[1]?.[0])).toContain('repeat_participants_60d');
  });

  it('rejects point self-approval before changing the ledger', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000077',
          requested_by: admin.id,
          state: 'pending',
          required_approvals: 1,
          approval_count: 0,
        }],
      });
    const { service } = serviceWith(query);

    await expect(service.decidePointAdjustment(
      operator,
      '00000000-0000-4000-8000-000000000077',
      '00000000-0000-4000-8000-000000000066',
      { decision: 'approve', reason: 'reviewed evidence' },
      'trace-2',
    )).rejects.toMatchObject({ code: 'APPROVAL_SEPARATION_REQUIRED' });
  });

  it('claims versioned event review idempotency in the same transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          organizer_id: '00000000-0000-4000-8000-000000000011',
          status: 'pending_review',
          version: '3',
          poster_enabled: true,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ version: '4' }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const { service, idempotency } = serviceWith(query);

    await service.reviewEvent(
      operator,
      '00000000-0000-4000-8000-000000000022',
      3,
      '00000000-0000-4000-8000-000000000033',
      'published',
      'all checks passed',
      'trace-3',
    );

    expect(idempotency.claim).toHaveBeenCalledOnce();
    expect(idempotency.complete).toHaveBeenCalledOnce();
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO growth.poster_jobs'))).toBe(true);
  });

  it('reports a development Ops session without querying an invalid UUID session id', async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [admin], rowCount: 1 });
    const { service } = serviceWith(query);

    await expect(service.session({ ...operator, sessionId: 'development-session' })).resolves.toMatchObject({
      operatorId: admin.id,
      mfaEnrolled: true,
      mfaAgeSeconds: 0,
    });
    expect(query).toHaveBeenCalledOnce();
  });

  it('casts the export approver id as UUID so PostgreSQL can type the approval CASE expression', async () => {
    const exportId = '00000000-0000-4000-8000-000000000077';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: exportId,
          requested_by: '00000000-0000-4000-8000-000000000066',
          state: 'pending',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: exportId,
          dataset: 'audit_log',
          purpose: 'security review',
          state: 'ready',
          watermark: 'SPOTT-TEST',
          expires_at: new Date('2026-07-16T00:00:00.000Z'),
          max_downloads: 1,
          download_count: 0,
          created_at: new Date('2026-07-15T00:00:00.000Z'),
          requester_id: '00000000-0000-4000-8000-000000000066',
          requester_label: 'Requester',
          approver_id: admin.id,
          approver_label: 'Approver',
        }],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const { service } = serviceWith(query);

    await service.approveExport(
      operator,
      exportId,
      '00000000-0000-4000-8000-000000000055',
      { decision: 'approve', reason: 'scope and purpose verified' },
      'trace-export',
    );

    const approvalUpdate = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE admin.exports SET state'));
    expect(String(approvalUpdate?.[0])).toContain('THEN $3::uuid');
  });
});
