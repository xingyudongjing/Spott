import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FEED_CONFIG,
  DEFAULT_MODULE_ORDER,
  DEFAULT_RECOMMENDATION_WEIGHTS,
  RECOMMENDATION_MODULE_KEYS,
  assembleFeed,
  scoreCandidate,
  type CandidateFeatures,
  type FeedConfig,
} from './events.recommendation.js';

const now = new Date('2026-07-18T02:00:00.000Z'); // Sat 2026-07-18 11:00 JST

function candidate(overrides: Partial<CandidateFeatures> = {}): CandidateFeatures {
  return {
    id: '00000000-0000-7000-8000-000000000001',
    startsAt: new Date('2026-07-18T06:00:00.000Z'), // later today JST
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    categoryId: 'outdoor',
    tags: ['outdoor'],
    distanceKm: 3,
    interestOverlap: 0,
    organizerFollowed: false,
    groupFollowed: false,
    phoneVerifiedHost: true,
    completedEventCount: 6,
    attendanceRateBand: '90_plus',
    availableCapacity: 5,
    capacity: 10,
    boosted: false,
    safetyPenalty: 0,
    ...overrides,
  };
}

describe('scoreCandidate', () => {
  it('produces an explainable component for every configured signal', () => {
    const result = scoreCandidate(candidate(), DEFAULT_RECOMMENDATION_WEIGHTS, now);
    expect(Object.keys(result.components).sort()).toEqual(
      [
        'availability',
        'distance',
        'exploration',
        'follow',
        'freshness',
        'interest',
        'safetyDemotion',
        'supplyQuality',
      ].sort(),
    );
    expect(result.total).toBeTypeOf('number');
    // total is the weighted sum of the components
    const expected = (Object.values(result.components) as number[]).reduce(
      (sum, value) => sum + value,
      0,
    );
    expect(result.total).toBeCloseTo(expected, 6);
  });

  it('rewards interest overlap, follow relationship and nearby distance', () => {
    const base = scoreCandidate(candidate(), DEFAULT_RECOMMENDATION_WEIGHTS, now);
    const interested = scoreCandidate(candidate({ interestOverlap: 3 }), DEFAULT_RECOMMENDATION_WEIGHTS, now);
    const followed = scoreCandidate(candidate({ organizerFollowed: true }), DEFAULT_RECOMMENDATION_WEIGHTS, now);
    const far = scoreCandidate(candidate({ distanceKm: 200 }), DEFAULT_RECOMMENDATION_WEIGHTS, now);

    expect(interested.components.interest).toBeGreaterThan(base.components.interest);
    expect(followed.components.follow).toBeGreaterThan(base.components.follow);
    expect(far.components.distance).toBeLessThan(base.components.distance);
  });

  it('demotes candidates carrying a safety penalty', () => {
    const clean = scoreCandidate(candidate(), DEFAULT_RECOMMENDATION_WEIGHTS, now);
    const risky = scoreCandidate(candidate({ safetyPenalty: 1 }), DEFAULT_RECOMMENDATION_WEIGHTS, now);
    expect(risky.components.safetyDemotion).toBeLessThan(0);
    expect(risky.total).toBeLessThan(clean.total);
  });

  it('honours configurable weights instead of hard-coded constants', () => {
    const zeroInterest: typeof DEFAULT_RECOMMENDATION_WEIGHTS = {
      ...DEFAULT_RECOMMENDATION_WEIGHTS,
      interest: 0,
    };
    const scored = scoreCandidate(candidate({ interestOverlap: 5 }), zeroInterest, now);
    expect(scored.components.interest).toBe(0);
  });
});

describe('assembleFeed', () => {
  it('groups candidates into the server-configured module order', () => {
    const feed = assembleFeed(
      [
        candidate({ id: '00000000-0000-7000-8000-0000000000a1', interestOverlap: 2 }),
        candidate({ id: '00000000-0000-7000-8000-0000000000a2', organizerFollowed: true }),
      ],
      DEFAULT_FEED_CONFIG,
      now,
    );
    const returnedKeys = feed.modules.map((module) => module.key);
    // modules preserve configured order and are a subset of the enabled modules
    const configOrder = DEFAULT_FEED_CONFIG.moduleOrder.filter((key) => returnedKeys.includes(key));
    expect(returnedKeys).toEqual(configOrder);
    expect(RECOMMENDATION_MODULE_KEYS).toEqual(expect.arrayContaining(returnedKeys));
  });

  it('reorders modules purely from configuration, never from the client', () => {
    const reversed: FeedConfig = {
      ...DEFAULT_FEED_CONFIG,
      moduleOrder: [...DEFAULT_MODULE_ORDER].reverse(),
    };
    const candidates = [
      candidate({ id: '00000000-0000-7000-8000-0000000000b1', interestOverlap: 2, organizerFollowed: true }),
    ];
    const defaultFeed = assembleFeed(candidates, DEFAULT_FEED_CONFIG, now);
    const reversedFeed = assembleFeed(candidates, reversed, now);
    expect(reversedFeed.modules.map((m) => m.key)).toEqual(
      [...defaultFeed.modules.map((m) => m.key)].reverse(),
    );
  });

  it('emits at most one first-screen banner and always flags it as promotional', () => {
    const promotedId = '00000000-0000-7000-8000-0000000000c1';
    const config: FeedConfig = {
      ...DEFAULT_FEED_CONFIG,
      banner: { eventId: promotedId, label: '推广/运营推荐', kind: 'operational' },
    };
    const feed = assembleFeed([candidate({ id: promotedId, interestOverlap: 1 })], config, now);
    expect(feed.banner).not.toBeNull();
    expect(feed.banner?.eventId).toBe(promotedId);
    expect(feed.banner?.label).toBe('推广/运营推荐');
    expect(feed.banner?.promotional).toBe(true);
  });

  it('drops an operational banner whose target was filtered out for safety', () => {
    const config: FeedConfig = {
      ...DEFAULT_FEED_CONFIG,
      banner: { eventId: 'ffffffff-0000-7000-8000-000000000000', label: '推广/运营推荐', kind: 'operational' },
    };
    const feed = assembleFeed([candidate()], config, now);
    expect(feed.banner).toBeNull();
  });

  it('rejects a banner that is missing its promotional compliance label', () => {
    const targetId = '00000000-0000-7000-8000-0000000000d1';
    const config: FeedConfig = {
      ...DEFAULT_FEED_CONFIG,
      banner: { eventId: targetId, label: '   ', kind: 'operational' },
    };
    const feed = assembleFeed([candidate({ id: targetId })], config, now);
    expect(feed.banner).toBeNull();
  });

  it('keeps the organic minimum ratio by capping boosted items inside a module', () => {
    const boosted = Array.from({ length: 8 }, (_, index) =>
      candidate({
        id: `00000000-0000-7000-8000-0000000010${index.toString().padStart(2, '0')}`,
        interestOverlap: 3,
        boosted: true,
      }),
    );
    const organic = Array.from({ length: 8 }, (_, index) =>
      candidate({
        id: `00000000-0000-7000-8000-0000000020${index.toString().padStart(2, '0')}`,
        interestOverlap: 2,
        boosted: false,
      }),
    );
    const config: FeedConfig = {
      ...DEFAULT_FEED_CONFIG,
      moduleOrder: ['interest'],
      enabledModules: ['interest'],
      moduleSize: 8,
      naturalResultsMinRatio: 0.5,
    };
    const feed = assembleFeed([...boosted, ...organic], config, now);
    const interest = feed.modules.find((module) => module.key === 'interest');
    expect(interest).toBeDefined();
    const items = interest?.items ?? [];
    const boostedShown = items.filter((item) => item.boosted).length;
    // at least half the slots stay organic
    expect(boostedShown).toBeLessThanOrEqual(items.length - Math.ceil(items.length * 0.5));
  });

  it('excludes candidates that fail the safety gate before scoring', () => {
    const feed = assembleFeed(
      [
        candidate({ id: '00000000-0000-7000-8000-0000000000e1', safetyExcluded: true, interestOverlap: 5 }),
        candidate({ id: '00000000-0000-7000-8000-0000000000e2', interestOverlap: 1 }),
      ],
      DEFAULT_FEED_CONFIG,
      now,
    );
    const allItems = feed.modules.flatMap((module) => module.items.map((item) => item.id));
    expect(allItems).not.toContain('00000000-0000-7000-8000-0000000000e1');
    expect(allItems).toContain('00000000-0000-7000-8000-0000000000e2');
  });

  it('places a candidate matching multiple modules into each relevant module', () => {
    const versatile = candidate({
      id: '00000000-0000-7000-8000-0000000000f1',
      interestOverlap: 2,
      organizerFollowed: true,
    });
    const feed = assembleFeed([versatile], DEFAULT_FEED_CONFIG, now);
    const interest = feed.modules.find((module) => module.key === 'interest');
    const followed = feed.modules.find((module) => module.key === 'followed_updates');
    expect(interest?.items.some((item) => item.id === versatile.id)).toBe(true);
    expect(followed?.items.some((item) => item.id === versatile.id)).toBe(true);
  });
});
