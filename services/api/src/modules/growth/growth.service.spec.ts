import { describe, expect, it, vi } from 'vitest';
import { GrowthService } from './growth.service.js';

describe('GrowthService poster jobs', () => {
  it('returns the approved generated poster URL when the job is ready', async () => {
    const updatedAt = new Date('2026-07-15T00:00:00Z');
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: '019b0000-0000-7000-9000-000000000001',
        state: 'ready',
        asset_id: '019b0000-0000-7000-9000-000000000002',
        failure_code: null,
        template: 'tokyo_afterglow',
        locale: 'ja',
        updated_at: updatedAt,
        url: 'https://media.spott.jp/public/posters/poster.webp',
      }],
      rowCount: 1,
    });
    const service = new GrowthService({ query } as never);

    await expect(service.poster(
      '019b0000-0000-7000-8000-000000000001',
      '019b0000-0000-7000-9000-000000000001',
    )).resolves.toMatchObject({
      state: 'ready',
      assetId: '019b0000-0000-7000-9000-000000000002',
      url: 'https://media.spott.jp/public/posters/poster.webp',
    });
    expect(query.mock.calls[0]?.[0]).toContain('LEFT JOIN media.assets asset');
    expect(query.mock.calls[0]?.[0]).toContain("asset.state = 'ready'");
    expect(query.mock.calls[0]?.[0]).toContain("asset.moderation_state = 'approved'");
  });

  it('lets the event organizer restore the latest automatic poster job', async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        id: '019b0000-0000-7000-9000-000000000010',
        organizer_id: '019b0000-0000-7000-8000-000000000001',
        state: 'queued',
        asset_id: null,
        failure_code: null,
        template: 'event_approved',
        locale: 'zh-Hans',
        updated_at: new Date('2026-07-15T00:00:00Z'),
        url: null,
      }],
      rowCount: 1,
    });
    const service = new GrowthService({ query } as never);

    await expect(service.eventPoster({
      id: '019b0000-0000-7000-8000-000000000001',
      sessionId: 'session',
      phoneVerified: true,
      restrictions: [],
      roles: ['host'],
    }, '019b0000-0000-7000-9000-000000000020')).resolves.toMatchObject({
      id: '019b0000-0000-7000-9000-000000000010',
      state: 'queued',
      resourceType: 'event',
      resourceId: '019b0000-0000-7000-9000-000000000020',
    });
    expect(query.mock.calls[0]?.[0]).toContain('event_record.organizer_id');
  });
});
