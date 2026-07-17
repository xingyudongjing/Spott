import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '@spott/domain';
import { GroupsService } from './groups.service.js';

const groupId = '019b0000-0000-7000-8300-000000000001';
const actor = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [] as string[],
  roles: ['host'],
};

function baseGroupRow(overrides: Record<string, unknown> = {}) {
  return {
    id: groupId,
    owner_id: '019b0000-0000-7000-8000-000000000099',
    owner_name: '群主',
    owner_handle: 'owner',
    name: '东京周末社',
    slug: 'tokyo-weekend',
    description: '面向东京地区朋友的周末兴趣活动群组。',
    join_mode: 'open',
    capacity: 50,
    status: 'active',
    version: '3',
    member_count: '10',
    region_id: 'tokyo',
    category_id: 'walk',
    tags: ['walk'],
    rules: '',
    membership_status: 'active',
    membership_role: 'member',
    viewer_following: false,
    announcement_summary: [],
    closing_at: null,
    dissolve_after: null,
    created_at: new Date('2026-07-15T00:00:00Z'),
    updated_at: new Date('2026-07-15T00:00:00Z'),
    ...overrides,
  };
}

interface Handler {
  match: (sql: string) => boolean;
  rows: unknown[];
}

function buildService(handlers: Handler[], captured?: string[]) {
  const client = {
    query: vi.fn(async (sql: string) => {
      captured?.push(sql);
      for (const handler of handlers) {
        if (handler.match(sql)) return { rows: handler.rows, rowCount: handler.rows.length };
      }
      return { rows: [], rowCount: 0 };
    }),
  };
  const database = {
    pool: { connect: vi.fn(async () => ({ ...client, release: vi.fn() })) },
    transaction: vi.fn(async (work: (c: typeof client) => Promise<unknown>) => work(client)),
    query: client.query,
  };
  const points = { configBigInt: vi.fn().mockResolvedValue(20n) };
  const idempotency = {
    requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
    claim: vi.fn().mockResolvedValue(undefined),
    complete: vi.fn().mockResolvedValue(undefined),
  };
  const service = new GroupsService(database as never, points as never, idempotency as never);
  return { service: service as never as DiscussionApi, client };
}

type TestActor = {
  id: string;
  sessionId: string;
  phoneVerified: boolean;
  restrictions: string[];
  roles: string[];
};

interface DiscussionApi {
  discussion(groupId: string, viewerId?: string, cursor?: string, limit?: number): Promise<{ items: unknown[] }>;
  discussionReplies(groupId: string, postId: string, viewerId?: string): Promise<unknown>;
  createDiscussionPost(
    user: TestActor,
    groupId: string,
    key: string,
    input: { body: string; locale: 'zh-Hans' | 'ja' | 'en' },
  ): Promise<unknown>;
  createDiscussionReply(
    user: TestActor,
    groupId: string,
    postId: string,
    key: string,
    input: { body: string; locale: 'zh-Hans' | 'ja' | 'en' },
  ): Promise<unknown>;
  setDiscussionLike(userId: string, groupId: string, commentId: string, liked: boolean): Promise<unknown>;
  moderateDiscussionComment(
    user: TestActor,
    groupId: string,
    commentId: string,
    input: { status: 'visible' | 'hidden' | 'removed' },
  ): Promise<unknown>;
}

describe('group discussion board — entry binding to membership', () => {
  it('rejects reading the board for a non-member (controlled messaging boundary)', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow({ membership_status: null, membership_role: null })] },
    ]);
    await expect(service.discussion(groupId, actor.id)).rejects.toMatchObject({
      code: 'GROUP_DISCUSSION_FORBIDDEN',
    });
  });

  it('lets an active member read the board', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow()] },
      { match: (sql) => sql.includes('FROM community.comments'), rows: [] },
    ]);
    await expect(service.discussion(groupId, actor.id)).resolves.toMatchObject({ items: [] });
  });
});

describe('group discussion board — role control on posting', () => {
  it('blocks a muted member from posting', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow({ membership_status: 'muted' })] },
    ]);
    await expect(
      service.createDiscussionPost(actor, groupId, '019b0000-0000-7000-9000-000000000001', {
        body: '大家好',
        locale: 'zh-Hans',
      }),
    ).rejects.toMatchObject({ code: 'GROUP_DISCUSSION_MUTED' });
  });

  it('blocks a non-member from posting', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow({ membership_status: null })] },
    ]);
    await expect(
      service.createDiscussionPost(actor, groupId, '019b0000-0000-7000-9000-000000000001', {
        body: '大家好',
        locale: 'zh-Hans',
      }),
    ).rejects.toMatchObject({ code: 'GROUP_DISCUSSION_FORBIDDEN' });
  });

  it('rejects a member carrying the commentBlocked restriction', async () => {
    const restricted = { ...actor, restrictions: ['commentBlocked'] };
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow()] },
    ]);
    await expect(
      service.createDiscussionPost(restricted, groupId, '019b0000-0000-7000-9000-000000000001', {
        body: '大家好',
        locale: 'zh-Hans',
      }),
    ).rejects.toMatchObject({ code: 'DISCUSSION_RESTRICTED' });
  });
});

describe('group discussion board — offensive content filter', () => {
  it('blocks a post that contains a configured banned term', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow()] },
      {
        match: (sql) => sql.includes('community.discussion.banned_words'),
        rows: [{ value_json: ['去死'] }],
      },
    ]);
    await expect(
      service.createDiscussionPost(actor, groupId, '019b0000-0000-7000-9000-000000000001', {
        body: '你快去 死 吧',
        locale: 'zh-Hans',
      }),
    ).rejects.toMatchObject({ code: 'DISCUSSION_CONTENT_BLOCKED' });
  });
});

describe('group discussion board — moderation', () => {
  it('rejects moderation by a plain member', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow()] },
      // assertManager query returns no owner/admin role
      { match: (sql) => sql.includes("role IN ('owner','admin')"), rows: [] },
    ]);
    await expect(
      service.moderateDiscussionComment(actor, groupId, '019b0000-0000-7000-8400-000000000001', {
        status: 'removed',
      }),
    ).rejects.toMatchObject({ code: 'GROUP_MANAGEMENT_FORBIDDEN' });
  });
});

describe('group discussion board — reply integrity', () => {
  it('rejects a reply when the parent post is missing from this group', async () => {
    const { service } = buildService([
      { match: (sql) => sql.includes('SELECT g.*'), rows: [baseGroupRow()] },
      { match: (sql) => sql.includes('community.discussion.banned_words'), rows: [{ value_json: [] }] },
      // parent lookup returns nothing
      { match: (sql) => sql.includes('AS parent_exists'), rows: [] },
    ]);
    await expect(
      service.createDiscussionReply(actor, groupId, '019b0000-0000-7000-8400-0000000000ff', '019b0000-0000-7000-9000-000000000001', {
        body: '同意',
        locale: 'zh-Hans',
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
