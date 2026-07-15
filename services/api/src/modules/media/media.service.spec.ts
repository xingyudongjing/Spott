import { describe, expect, it, vi } from 'vitest';
import { MediaService } from './media.service.js';

const user = {
  id: '019b0000-0000-7000-8000-000000000002',
  sessionId: 'session',
  phoneVerified: true,
  restrictions: [],
  roles: ['user'],
};

describe('MediaService profile and group attachment', () => {
  it('atomically replaces the current avatar with a ready owned profile asset and returns its URL', async () => {
    const assetId = '019b0000-0000-7000-9000-000000000001';
    const previousAssetId = '019b0000-0000-7000-9000-000000000002';
    const url = 'https://media.spott.jp/public/derivatives/avatar/thumb.webp';
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM identity.profiles profile') && sql.includes('JOIN media.assets asset')) {
          return { rows: [{
            previous_asset_id: previousAssetId,
            owner_id: user.id,
            purpose: 'profile_avatar',
            state: 'ready',
            moderation_state: 'approved',
            url,
          }], rowCount: 1 };
        }
        if (sql.includes('UPDATE identity.profiles SET avatar_asset_id')) {
          return { rows: [{ version: '4', updated_at: new Date('2026-07-15T00:00:00Z') }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
    };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new MediaService(database as never);

    await expect(service.attachProfile(user, assetId)).resolves.toEqual({
      assetId,
      profileId: user.id,
      url,
      version: 4,
    });
    expect(client.query.mock.calls[0]?.[0]).toContain('asset.purpose');
    expect(client.query.mock.calls[0]?.[0]).toContain('asset.state');
    expect(client.query.mock.calls[0]?.[0]).toContain('asset.moderation_state');
    expect(client.query.mock.calls.some(([sql]) => sql.includes('NOT EXISTS') && sql.includes('avatar_asset_id'))).toBe(true);
  });

  it('requires the current group owner and a ready owned group_cover asset', async () => {
    const assetId = '019b0000-0000-7000-9000-000000000003';
    const groupId = '019b0000-0000-7000-8300-000000000001';
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) };
    const database = {
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    };
    const service = new MediaService(database as never);

    await expect(service.attachGroup(user, assetId, groupId)).rejects.toMatchObject({
      code: 'MEDIA_ATTACH_FORBIDDEN',
      status: 403,
    });
    expect(client.query.mock.calls[0]?.[0]).toContain('group_record.owner_id');
    expect(client.query.mock.calls[0]?.[0]).toContain('asset.purpose');
  });

  it('returns a retryable conflict while an authorized avatar is still processing', async () => {
    const client = { query: vi.fn().mockResolvedValue({
      rows: [{
        previous_asset_id: null,
        owner_id: user.id,
        purpose: 'profile_avatar',
        state: 'processing',
        moderation_state: 'pending',
        url: null,
      }],
      rowCount: 1,
    }) };
    const service = new MediaService({
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    } as never);

    await expect(service.attachProfile(user, '019b0000-0000-7000-9000-000000000004')).rejects.toMatchObject({
      code: 'MEDIA_NOT_READY',
      status: 409,
      retryable: true,
    });
  });

  it('returns a terminal validation error for a rejected group cover', async () => {
    const client = { query: vi.fn().mockResolvedValue({
      rows: [{
        previous_asset_id: null,
        group_owner_id: user.id,
        owner_id: user.id,
        purpose: 'group_cover',
        state: 'rejected',
        moderation_state: 'rejected',
        url: null,
      }],
      rowCount: 1,
    }) };
    const service = new MediaService({
      transaction: vi.fn(async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client)),
    } as never);

    await expect(service.attachGroup(
      user,
      '019b0000-0000-7000-9000-000000000005',
      '019b0000-0000-7000-8300-000000000002',
    )).rejects.toMatchObject({ code: 'MEDIA_REJECTED', status: 422, retryable: false });
  });
});
