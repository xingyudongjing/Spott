import { describe, expect, it, vi } from 'vitest';
import { GroupsService } from './groups.service.js';

const actor = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['host'],
};

const groupRow = {
  id: '019b0000-0000-7000-8300-000000000001',
  owner_id: actor.id,
  owner_name: '群主',
  owner_handle: 'owner',
  name: '东京周末社',
  slug: 'tokyo-weekend',
  description: '面向东京地区朋友的周末兴趣活动群组。',
  join_mode: 'open',
  capacity: 50,
  status: 'active',
  version: '1',
  member_count: '1',
  region_id: 'tokyo',
  category_id: 'walk',
  tags: ['walk'],
  rules: '',
  membership_status: 'active',
  membership_role: 'owner',
  viewer_following: false,
  announcement_summary: [],
  closing_at: null,
  dissolve_after: null,
  created_at: new Date('2026-07-15T00:00:00Z'),
  updated_at: new Date('2026-07-15T00:00:00Z'),
};

describe('GroupsService point quote consistency', () => {
  it('consumes the confirmed group_create quote before spending points', async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === 'SELECT uuidv7() AS id') return { rows: [{ id: groupRow.id }], rowCount: 1 };
        if (sql.includes('SELECT g.*')) return { rows: [groupRow], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const points = {
      configBigInt: vi.fn().mockResolvedValue(300n),
      consumeQuote: vi.fn().mockResolvedValue(300n),
      spend: vi.fn().mockResolvedValue({ transactionId: 'point-transaction' }),
    };
    const idempotency = {
      requestHash: vi.fn().mockReturnValue(Buffer.alloc(32)),
      claim: vi.fn().mockResolvedValue(undefined),
      complete: vi.fn().mockResolvedValue(undefined),
    };
    const service = new GroupsService(database as never, points as never, idempotency as never);
    const create = service as unknown as {
      create: (
        user: typeof actor,
        key: string,
        input: {
          quoteId: string;
          name: string;
          slug: string;
          description: string;
          joinMode: 'open';
          regionId: string;
          categoryId: string;
          tags: string[];
          rules: string;
        },
      ) => Promise<unknown>;
    };

    await create.create(actor, '019b0000-0000-7000-9000-000000000001', {
      quoteId: '019b0000-0000-7000-9000-000000000002',
      name: '东京周末社',
      slug: 'tokyo-weekend',
      description: '面向东京地区朋友的周末兴趣活动群组。',
      joinMode: 'open',
      regionId: 'tokyo',
      categoryId: 'walk',
      tags: ['walk'],
      rules: '',
    });

    expect(points.consumeQuote).toHaveBeenCalledWith(
      client,
      actor.id,
      '019b0000-0000-7000-9000-000000000002',
      'group_create',
      groupRow.id,
    );
    expect(points.spend).toHaveBeenCalledWith(
      client,
      actor.id,
      300n,
      'group_create',
      `group_create:${groupRow.id}`,
      { groupId: groupRow.id },
    );
  });
});

describe('GroupsService member management', () => {
  it('returns a manager-only member page with user identity and moderation state', async () => {
    const joinedAt = new Date('2026-07-01T00:00:00Z');
    const updatedAt = new Date('2026-07-15T00:00:00Z');
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT g.*')) return { rows: [groupRow], rowCount: 1 };
        if (sql.includes('SELECT role::text FROM community.group_memberships')) {
          return { rows: [{ role: 'owner', status: 'active' }], rowCount: 1 };
        }
        if (sql.includes('FROM community.group_memberships membership')) {
          return {
            rows: [{
              user_id: '019b0000-0000-7000-8000-000000000001',
              public_handle: 'member',
              nickname: '成员',
              role: 'member',
              status: 'muted',
              joined_at: joinedAt,
              updated_at: updatedAt,
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new GroupsService(database as never, {} as never, {} as never);

    await expect(service.members(actor, groupRow.id, undefined, 20)).resolves.toEqual({
      items: [{
        user: {
          id: '019b0000-0000-7000-8000-000000000001',
          name: '成员',
          handle: 'member',
        },
        role: 'member',
        status: 'muted',
        joinedAt: joinedAt.toISOString(),
        updatedAt: updatedAt.toISOString(),
      }],
      hasMore: false,
      nextCursor: null,
    });
  });
});

describe('GroupsService active ownership transfer recovery', () => {
  it('returns the active transfer to the receiving user so another device can resume it', async () => {
    const expiresAt = new Date('2026-07-22T00:00:00Z');
    const cooldownUntil = new Date('2026-07-16T00:00:00Z');
    const receiverId = '019b0000-0000-7000-8000-000000000099';
    const transferId = '019b0000-0000-7000-9000-000000000099';
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: transferId,
        group_id: groupRow.id,
        owner_id: actor.id,
        from_user: actor.id,
        to_user: receiverId,
        state: 'cooling_off',
        expires_at: expiresAt,
        cooldown_until: cooldownUntil,
      }],
      rowCount: 1,
    });
    const service = new GroupsService({ query } as never, {} as never, {} as never);

    await expect(service.activeTransfer({ ...actor, id: receiverId }, groupRow.id)).resolves.toEqual({
      id: transferId,
      groupId: groupRow.id,
      fromUserId: actor.id,
      toUserId: receiverId,
      state: 'cooling_off',
      expiresAt: expiresAt.toISOString(),
      cooldownUntil: cooldownUntil.toISOString(),
    });
    expect(query.mock.calls[0]?.[0]).toContain("transfer.state IN ('awaiting_target','cooling_off')");
  });

  it('does not reveal an active transfer to an unrelated group member', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: '019b0000-0000-7000-9000-000000000099',
        group_id: groupRow.id,
        owner_id: actor.id,
        from_user: actor.id,
        to_user: '019b0000-0000-7000-8000-000000000099',
        state: 'awaiting_target',
        expires_at: new Date('2026-07-22T00:00:00Z'),
        cooldown_until: null,
      }],
      rowCount: 1,
    });
    const service = new GroupsService({ query } as never, {} as never, {} as never);

    await expect(service.activeTransfer({
      ...actor,
      id: '019b0000-0000-7000-8000-000000000088',
    }, groupRow.id)).rejects.toMatchObject({ code: 'GROUP_TRANSFER_FORBIDDEN', status: 403 });
  });
});
