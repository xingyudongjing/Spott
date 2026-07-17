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

interface OverviewResult {
  queues: { p0Open: number; outboxBacklog: number };
  health: { deliverySuccessRate1h: number };
  growth: { checkinRate30d: number };
}

interface AuditLogPageResult {
  items: Array<{ resourceIdMasked: string; resourceId?: never }>;
}

interface OrganizerPageResult {
  items: Array<{ repeatRate60d: number }>;
}

interface EventPageResult {
  items: Array<{
    id: string;
    categoryId: string | null;
    startsAt: string | null;
    publicArea: string | null;
    isFree: boolean | null;
    amountJpy: number | null;
    riskReasons: string[];
  }>;
  hasMore: boolean;
  nextCursor: string | null;
}

interface ConfigPageResult {
  items: Array<{
    value: unknown;
    region: string | null;
    effectiveFrom: string | null;
    effectiveTo: string | null;
    approvedBy: { id: string; label: string } | null;
  }>;
}

interface ModerationCaseResult {
  assignee: { id: string; label: string } | null;
  reporter: { present: boolean };
  evidence: Array<{
    mimeType: string | null;
    byteSize: number;
    signedUrl: string | null;
  }>;
  actions: Array<{ expiresAt: string | null }>;
  appeals: Array<{ decidedAt: string | null }>;
}

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
  const promotions = { refund: vi.fn(async () => null) };
  return {
    service: new OpsService(database as never, points as never, idempotency as never, promotions as never),
    database,
    idempotency,
    promotions,
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

    const result = await service.overview(operator) as OverviewResult;

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

    const result = await service.auditLogs(operator, {}, undefined, 20) as AuditLogPageResult;

    expect(result.items[0]?.resourceIdMasked).toBe('019f1234…9abc');
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

    const result = await service.organizers(operator, {}, undefined, 20) as OrganizerPageResult;

    expect(result.items[0]?.repeatRate60d).toBe(0.4);
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

describe('OpsService typed core read models', () => {
  it('preserves nullable event joins and derives the cursor from the last visible row', async () => {
    const first = {
      id: '00000000-0000-4000-8000-000000000021',
      public_slug: 'night-walk',
      title: 'Night walk',
      status: 'pending_review',
      category_id: null,
      starts_at: null,
      submitted_at: new Date('2026-07-17T10:00:00.000Z'),
      version: '3',
      created_at: new Date('2026-07-17T09:00:00.000Z'),
      organizer_id: '00000000-0000-4000-8000-000000000011',
      organizer_handle: 'city_host',
      organizer_nickname: 'City Host',
      public_area: null,
      region_id: null,
      is_free: null,
      amount_jpy: null,
      risk_score: '0',
      risk_reasons: [],
    };
    const overFetched = {
      ...first,
      id: '00000000-0000-4000-8000-000000000020',
      created_at: new Date('2026-07-17T08:00:00.000Z'),
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [first, overFetched], rowCount: 2 });
    const { service } = serviceWith(query);

    const result = await service.events(operator, {}, undefined, 1) as EventPageResult;

    expect(result.items).toEqual([expect.objectContaining({
      id: first.id,
      categoryId: null,
      startsAt: null,
      publicArea: null,
      isFree: null,
      amountJpy: null,
      riskReasons: [],
    })]);
    const expectedCursor = Buffer.from(JSON.stringify({
      at: first.created_at.toISOString(),
      id: first.id,
    })).toString('base64url');
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(expectedCursor);
  });
});

describe('OpsService typed finance and admin read models', () => {
  it('forwards config JSONB unchanged and preserves nullable read fields', async () => {
    const value = ['city', { enabled: true, threshold: 3 }];
    const configAdmin = { ...admin, roles: ['configApprover'] };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [configAdmin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000041',
          key: 'discovery.ranking',
          value_json: value,
          version: '7',
          audience: { locale: ['ja', 'zh-Hans', 'en'] },
          region: null,
          min_app_version: null,
          effective_from: null,
          effective_to: null,
          state: 'draft',
          created_at: new Date('2026-07-17T00:00:00.000Z'),
          reason: 'typed boundary',
          submitter_id: '00000000-0000-4000-8000-000000000042',
          submitter_label: 'Submitter',
          approver_id: null,
          approver_label: null,
        }],
        rowCount: 1,
      });
    const { service } = serviceWith(query);

    const result = await service.configRevisions(operator, {}, undefined, 20) as ConfigPageResult;

    expect(result.items[0]).toMatchObject({
      value,
      region: null,
      effectiveFrom: null,
      effectiveTo: null,
      approvedBy: null,
    });
    expect(result.items[0]?.value).toBe(value);
  });
});

describe('OpsService typed safety mutations', () => {
  it('preserves nullable moderation evidence, action, and appeal fields', async () => {
    const caseId = '00000000-0000-4000-8000-000000000051';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: caseId,
          report_id: '00000000-0000-4000-8000-000000000052',
          public_reference: 'SPOTT-CASE-1',
          target_type: 'event',
          target_id: '00000000-0000-4000-8000-000000000053',
          reason: 'evidence review',
          severity: 'p1',
          status: 'open',
          sla_due_at: new Date('2026-07-18T00:00:00.000Z'),
          version: '4',
          created_at: new Date('2026-07-17T00:00:00.000Z'),
          reporter_id: null,
          assignee_id: null,
          assignee_label: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000054',
          asset_id: '00000000-0000-4000-8000-000000000055',
          retention_until: new Date('2026-08-17T00:00:00.000Z'),
          created_at: new Date('2026-07-17T00:00:00.000Z'),
          mime_type: null,
          byte_size: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000056',
          action_type: 'note',
          reason: 'triaged',
          expires_at: null,
          created_at: new Date('2026-07-17T00:00:00.000Z'),
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{
          id: '00000000-0000-4000-8000-000000000057',
          status: 'pending',
          created_at: new Date('2026-07-17T00:00:00.000Z'),
          decided_at: null,
        }],
        rowCount: 1,
      });
    const { service } = serviceWith(query);

    const result = await service.moderationCase(operator, caseId) as ModerationCaseResult;

    expect(result).toMatchObject({
      assignee: null,
      reporter: { present: false },
      evidence: [{ mimeType: null, byteSize: 0, signedUrl: null }],
      actions: [{ expiresAt: null }],
      appeals: [{ decidedAt: null }],
    });
  });

  it('refunds an active event promotion when a moderation takedown removes the event', async () => {
    const caseId = '00000000-0000-4000-8000-000000000071';
    const eventTargetId = '00000000-0000-4000-8000-000000000072';
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: caseId,
          report_id: '00000000-0000-4000-8000-000000000073',
          version: '3',
          status: 'assigned',
          target_type: 'event',
          target_id: eventTargetId,
        }],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [{ version: '4' }], rowCount: 1 });
    const { service, promotions } = serviceWith(query);

    await service.decide(
      operator,
      caseId,
      3,
      '00000000-0000-4000-8000-000000000074',
      { decision: 'remove', reason: 'policy violation' },
      'trace-remove',
    );

    expect(promotions.refund).toHaveBeenCalledWith(
      expect.anything(),
      eventTargetId,
      'moderation_remove',
    );
    // The event must actually be taken offline before the refund runs.
    const removal = query.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes("UPDATE events.events SET status = 'removed'"),
    );
    expect(removal).toBeDefined();
  });
});

describe('OpsService typed approval and execution mutations', () => {
  it('keeps point execution arithmetic in bigint space', async () => {
    const adjustmentId = '00000000-0000-4000-8000-000000000061';
    const targetUserId = '00000000-0000-4000-8000-000000000062';
    const transactionId = '00000000-0000-4000-8000-000000000063';
    const loaded = {
      id: adjustmentId,
      bucket: 'paid',
      amount: '9007199254740993',
      reason: 'restore verified balance',
      state: 'executed',
      points_transaction_id: transactionId,
      created_at: new Date('2026-07-17T00:00:00.000Z'),
      decided_at: new Date('2026-07-17T00:01:00.000Z'),
      executed_at: new Date('2026-07-17T00:02:00.000Z'),
      required_approvals: '2',
      approval_count: '2',
      version: '4',
      target_id: targetUserId,
      target_handle: 'balance_owner',
      target_nickname: 'Balance Owner',
      requester_id: '00000000-0000-4000-8000-000000000064',
      requester_label: 'Requester',
      approver_id: admin.id,
      approver_label: 'Approver',
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [admin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: adjustmentId,
          target_user_id: targetUserId,
          bucket: 'paid',
          amount: '9007199254740993',
          state: 'approved',
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{ paid_balance: '9007199254740993', free_balance: '0' }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: transactionId }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [loaded], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const { service } = serviceWith(query);

    await service.executePointAdjustment(operator, adjustmentId, 'attempt-1', 'trace-bigint');

    const ledgerInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO commerce.point_entries'));
    expect(ledgerInsert?.[1]).toEqual([
      transactionId,
      targetUserId,
      'paid',
      '9007199254740993',
      '-9007199254740993',
    ]);
  });

  it('reads only rollback-owned config columns and forwards JSONB unchanged', async () => {
    const revisionId = '00000000-0000-4000-8000-000000000071';
    const replacementId = '00000000-0000-4000-8000-000000000072';
    const value = { ranking: ['distance', 'quality'], enabled: true };
    const audience = { locales: ['zh-Hans', 'ja', 'en'] };
    const configAdmin = { ...admin, roles: ['configEditor'] };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [configAdmin], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          key: 'discovery.ranking',
          value_json: value,
          audience,
          region: null,
          min_app_version: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [{ id: replacementId }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: replacementId,
          key: 'discovery.ranking',
          value_json: value,
          version: '8',
          audience,
          region: null,
          min_app_version: null,
          effective_from: null,
          effective_to: null,
          state: 'draft',
          created_at: new Date('2026-07-17T00:00:00.000Z'),
          reason: 'rollback verified revision',
          submitter_id: configAdmin.id,
          submitter_label: 'Config Editor',
          approver_id: null,
          approver_label: null,
        }],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 1 });
    const { service } = serviceWith(query);

    await service.rollbackConfig(
      operator,
      revisionId,
      'rollback-attempt-1',
      'rollback verified revision',
      'trace-rollback',
    );

    expect(String(query.mock.calls[1]?.[0]).replace(/\s+/g, ' ').trim()).toBe(
      'SELECT key,value_json,audience,region,min_app_version FROM admin.config_revisions WHERE id=$1',
    );
    expect(query.mock.calls[2]?.[1]).toEqual([
      'discovery.ranking',
      value,
      audience,
      null,
      null,
      configAdmin.id,
      'rollback verified revision',
    ]);
  });
});
