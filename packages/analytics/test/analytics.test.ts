import { describe, expect, it, vi } from 'vitest';
import { AnalyticsClient, validateAndScrub, type ProductEvent } from '../src/index.js';

const event: ProductEvent = { eventName: 'event_detail_viewed', schemaVersion: 1, sessionId: '11111111-1111-4111-8111-111111111111', platform: 'web', occurredAt: '2026-07-15T08:00:00.000Z', properties: { event_id: 'public-slug', phone_number: '+819000000000', region: 'tokyo' } };

describe('analytics privacy boundary', () => {
  it('removes direct identifiers before transport', () => { expect(validateAndScrub(event).properties).toEqual({ event_id: 'public-slug', region: 'tokyo' }); });
  it('honors denied consent', async () => { const send = vi.fn(async () => undefined); const client = new AnalyticsClient({ send }, 'denied', 1); client.track(event); await client.flush(); expect(send).not.toHaveBeenCalled(); });
});
