import { describe, expect, it } from 'vitest';
import { parseFeedConfig } from './events.recommendation-config.js';
import { DEFAULT_FEED_CONFIG } from './events.recommendation.js';

describe('parseFeedConfig', () => {
  it('falls back to the built-in baseline when no operator config exists', () => {
    const config = parseFeedConfig(null, null);
    expect(config.moduleOrder).toEqual(DEFAULT_FEED_CONFIG.moduleOrder);
    expect(config.weights).toEqual(DEFAULT_FEED_CONFIG.weights);
    expect(config.banner).toBeNull();
  });

  it('applies an operator-supplied module order and weight overrides', () => {
    const config = parseFeedConfig(
      {
        moduleOrder: ['interest', 'today', 'weekend'],
        weights: { follow: 3.5 },
        naturalResultsMinRatio: 0.75,
      },
      null,
    );
    expect(config.moduleOrder).toEqual(['interest', 'today', 'weekend']);
    expect(config.weights.follow).toBe(3.5);
    // untouched weights keep their defaults
    expect(config.weights.interest).toBe(DEFAULT_FEED_CONFIG.weights.interest);
    expect(config.naturalResultsMinRatio).toBe(0.75);
  });

  it('deduplicates a module order that repeats a key', () => {
    const config = parseFeedConfig({ moduleOrder: ['today', 'today', 'interest'] }, null);
    expect(config.moduleOrder).toEqual(['today', 'interest']);
  });

  it('accepts a compliant operational banner', () => {
    const config = parseFeedConfig(null, {
      eventId: '00000000-0000-7000-8000-000000000001',
      label: '推广/运营推荐',
      kind: 'operational',
    });
    expect(config.banner).toEqual({
      eventId: '00000000-0000-7000-8000-000000000001',
      label: '推广/运营推荐',
      kind: 'operational',
      headline: undefined,
      imageURL: null,
    });
  });

  it('drops a malformed banner rather than crashing discovery', () => {
    const config = parseFeedConfig(null, { eventId: 'not-a-uuid', label: '' });
    expect(config.banner).toBeNull();
  });

  it('ignores an invalid feed revision and keeps the safe defaults', () => {
    const config = parseFeedConfig({ moduleOrder: ['nonexistent-module'], moduleSize: -5 }, null);
    expect(config.moduleOrder).toEqual(DEFAULT_FEED_CONFIG.moduleOrder);
    expect(config.moduleSize).toBe(DEFAULT_FEED_CONFIG.moduleSize);
  });
});
