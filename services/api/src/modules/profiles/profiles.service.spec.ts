import { describe, expect, it, vi } from 'vitest';
import { ProfilesService } from './profiles.service.js';

describe('ProfilesService public organizer events', () => {
  it('resolves a public handle and returns only explicitly public event states', async () => {
    const organizerId = '019b0000-0000-7000-8000-000000000002';
    const startsAt = new Date('2026-07-20T10:00:00Z');
    const endsAt = new Date('2026-07-20T12:00:00Z');
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: organizerId }], rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [{
          id: '019b0000-0000-7000-8100-000000000001',
          public_slug: 'tokyo-summer-walk',
          status: 'published',
          title: '东京夏日散步',
          starts_at: startsAt,
          ends_at: endsAt,
          region_id: 'tokyo',
          public_area: '涩谷站附近',
          is_free: true,
          amount_jpy: null,
          cover_url: 'https://media.spott.jp/public/cover.webp',
          created_at: new Date('2026-07-15T00:00:00Z'),
        }],
        rowCount: 1,
      });
    const service = new ProfilesService({ query } as never);

    await expect(service.publicEvents('organizer', undefined, 20)).resolves.toEqual({
      items: [{
        id: '019b0000-0000-7000-8100-000000000001',
        publicSlug: 'tokyo-summer-walk',
        status: 'published',
        title: '东京夏日散步',
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        region: 'tokyo',
        publicArea: '涩谷站附近',
        priceLabel: '免费',
        coverURL: 'https://media.spott.jp/public/cover.webp',
      }],
      hasMore: false,
      nextCursor: null,
    });
    expect(query.mock.calls[1]?.[0]).toContain("e.status IN ('published','registration_closed','in_progress','ended','archived')");
    expect(query.mock.calls[1]?.[0]).toContain('e.deleted_at IS NULL');
    expect(query.mock.calls[1]?.[0]).toContain("asset.state = 'ready'");
    expect(query.mock.calls[1]?.[0]).toContain("asset.moderation_state = 'approved'");
  });

  it('does not expose events for a missing or non-public profile', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const service = new ProfilesService({ query } as never);

    await expect(service.publicEvents('missing', undefined, 20)).rejects.toMatchObject({
      code: 'PROFILE_NOT_FOUND',
      status: 404,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
