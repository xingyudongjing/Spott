import { describe, expect, it, vi } from 'vitest';
import { EventsService } from './events.service.js';

const publisher = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['host'],
};

const benignDraft = {
  id: '019b0000-0000-7000-8100-000000000001',
  organizer_id: publisher.id,
  status: 'draft',
  version: '1',
  display_time_zone: 'Asia/Tokyo',
  title: '周末代代木公园散步',
  description: '一起在代代木公园散步聊天，欢迎新朋友加入，全程两小时左右。',
  starts_at: new Date('2026-08-02T03:00:00.000Z'),
  tags: [],
  attendee_requirements: null,
  risk_flags: [],
  risk_details: {},
  is_free: true,
  amount_jpy: null,
};

/** 深夜酒局 + 投资交流：命中多条计分规则，但不含禁止词。 */
const highRiskDraft = {
  ...benignDraft,
  id: '019b0000-0000-7000-8100-000000000002',
  title: '深夜酒局投资交流会',
  description: '深夜居酒屋畅饮，同时聊聊股票和基金的投资心得，欢迎同行交流。',
  // 23:00 JST：结构化的深夜信号，与文案无关。
  starts_at: new Date('2026-08-02T14:00:00.000Z'),
  // 恶意局头自报「无风险」——服务端绝不能采信。
  risk_flags: [],
};

/** 命中 M3 禁止类：收益保证。 */
const prohibitedDraft = {
  ...benignDraft,
  id: '019b0000-0000-7000-8100-000000000003',
  title: '投资分享会',
  description: '分享一个稳赚不赔的项目，保证收益，月入百万不是梦，名额有限速来。',
};

function harness(draft: Record<string, unknown>, config?: unknown) {
  const client = {
    query: vi.fn(async (sql: string, _values?: readonly unknown[]) => {
      void _values;
      if (sql.includes('FROM admin.config_revisions')) {
        return { rows: config === undefined ? [] : [{ value_json: config }], rowCount: config === undefined ? 0 : 1 };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const database = {
    transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
  };
  const idempotency = {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
    claim: vi.fn().mockResolvedValue(null),
    complete: vi.fn(),
  };
  const points = {
    consumeQuote: vi.fn().mockResolvedValue(100n),
    createHold: vi.fn().mockResolvedValue('019b0000-0000-7000-8300-000000000001'),
    captureHold: vi.fn(),
  };
  const service = new EventsService(database as never, {} as never, idempotency as never, points as never);
  const after = { ...draft, version: '2' };
  Object.assign(service, {
    loadEvent: vi.fn().mockResolvedValueOnce(draft).mockResolvedValue(after),
    validateSubmission: vi.fn(),
    recordChange: vi.fn(),
    toView: vi.fn().mockReturnValue({ id: draft.id }),
  });
  return { service, client, points };
}

function submit(service: EventsService, draft: Record<string, unknown>) {
  return service.submit(publisher, draft.id as string, '019b0000-0000-7000-9000-000000000001', 1, 'quote');
}

type QueryCall = [sql: string, values?: readonly unknown[]];

function callsMatching(client: { query: ReturnType<typeof vi.fn> }, fragment: string): QueryCall[] {
  return (client.query.mock.calls as QueryCall[]).filter(([sql]) => sql.includes(fragment));
}

function statusUpdate(client: { query: ReturnType<typeof vi.fn> }): readonly unknown[] | undefined {
  return callsMatching(client, 'UPDATE events.events SET status')[0]?.[1];
}

function statusWritten(client: { query: ReturnType<typeof vi.fn> }): unknown {
  return statusUpdate(client)?.[3];
}

function riskRowsWritten(client: { query: ReturnType<typeof vi.fn> }) {
  return callsMatching(client, 'INSERT INTO events.event_risks').map(([, values]) => ({
    riskType: values?.[1] as string,
    declaration: values?.[2] as string,
    reviewState: values?.[3] as string,
  }));
}

describe('event submission risk engine', () => {
  it('computes risk flags server-side even when the organizer declares none', async () => {
    // 抽样率 0：确保这里的分流只由分数决定。
    const { service, client } = harness(highRiskDraft, { sampleRate: 0 });

    await submit(service, highRiskDraft);

    const written = riskRowsWritten(client);
    const types = written.map((row) => row.riskType);
    expect(types).toContain('professional_investment');
    expect(types).toContain('alcohol_late_night');
    // 每条都要有给运营看的解释，不能只是一个光秃秃的标记。
    expect(written.every((row) => row.declaration.length > 0)).toBe(true);
    // 服务端算出的 risk_flags 覆盖客户端自报的空数组。
    expect(statusUpdate(client)?.[4]).toEqual(
      expect.arrayContaining(['alcohol_late_night', 'professional_investment']),
    );
  });

  it('routes a high-scoring event to manual review', async () => {
    const { service, client } = harness(highRiskDraft, { sampleRate: 0 });

    await submit(service, highRiskDraft);

    expect(statusWritten(client)).toBe('pending_review');
    expect(riskRowsWritten(client).every((row) => row.reviewState === 'pending')).toBe(true);
  });

  it('auto-approves an ordinary event instead of drowning the review queue', async () => {
    const { service, client, points } = harness(benignDraft, { sampleRate: 0 });

    await submit(service, benignDraft);

    expect(statusWritten(client)).toBe('published');
    // 自动通过没有后续人工决策，hold 必须就地兑现。
    expect(points.captureHold).toHaveBeenCalledOnce();
  });

  it('samples ordinary events into manual review at the configured rate', async () => {
    const { service, client } = harness(benignDraft, { sampleRate: 1 });

    await submit(service, benignDraft);

    expect(statusWritten(client)).toBe('pending_review');
  });

  it('rejects prohibited content with a stable code without charging the organizer', async () => {
    const { service, client, points } = harness(prohibitedDraft);

    await expect(submit(service, prohibitedDraft)).rejects.toMatchObject({
      code: 'EVENT_RISK_PROHIBITED',
      status: 422,
    });

    expect(points.consumeQuote).not.toHaveBeenCalled();
    expect(statusWritten(client)).toBeUndefined();
  });

  it('carries the operator-tuned threshold rather than a hardcoded one', async () => {
    // 后台把阈值调高到 200：同一个高风险活动不再进人工，证明阈值真的来自配置。
    const { service, client } = harness(highRiskDraft, { sampleRate: 0, manualReviewThreshold: 200 });

    await submit(service, highRiskDraft);

    expect(statusWritten(client)).toBe('published');
  });
});
