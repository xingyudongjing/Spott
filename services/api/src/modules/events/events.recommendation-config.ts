import { z } from 'zod';
import {
  DEFAULT_FEED_CONFIG,
  RECOMMENDATION_MODULE_KEYS,
  type FeedConfig,
  type OperationalBannerConfig,
  type RecommendationModuleKey,
} from './events.recommendation.js';

const moduleKeySchema = z.enum(RECOMMENDATION_MODULE_KEYS);

const weightsSchema = z
  .object({
    freshness: z.number().min(0).max(100),
    distance: z.number().min(0).max(100),
    interest: z.number().min(0).max(100),
    follow: z.number().min(0).max(100),
    supplyQuality: z.number().min(0).max(100),
    availability: z.number().min(0).max(100),
    exploration: z.number().min(0).max(100),
    safetyDemotion: z.number().min(0).max(100),
  })
  .partial();

const feedConfigSchema = z
  .object({
    weights: weightsSchema,
    moduleOrder: z.array(moduleKeySchema).min(1),
    enabledModules: z.array(moduleKeySchema),
    naturalResultsMinRatio: z.number().min(0).max(1),
    moduleSize: z.number().int().min(1).max(50),
    nearbyRadiusKm: z.number().min(0).max(1000),
    newEventWindowHours: z.number().min(1).max(2160),
    verifiedHostMinCompleted: z.number().int().min(0).max(1000),
    freshnessHalfLifeHours: z.number().min(1).max(2160),
    distanceHalfLifeKm: z.number().min(0.1).max(1000),
  })
  .partial();

const bannerConfigSchema = z.object({
  eventId: z.uuid(),
  label: z.string().min(1).max(60),
  kind: z.enum(['promoted', 'operational']).default('operational'),
  headline: z.string().max(120).optional(),
  imageURL: z.string().url().nullable().optional(),
});

function dedupeOrder(order: RecommendationModuleKey[]): RecommendationModuleKey[] {
  const seen = new Set<RecommendationModuleKey>();
  const result: RecommendationModuleKey[] = [];
  for (const key of order) {
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

// Merge operator-controlled config (from admin.config_revisions) with the built-in
// baseline. Invalid or partial config never crashes the feed — it falls back to the
// safe defaults so a bad revision cannot black-hole discovery.
export function parseFeedConfig(rawFeed: unknown, rawBanner: unknown): FeedConfig {
  const parsedFeed = feedConfigSchema.safeParse(rawFeed ?? {});
  const feed = parsedFeed.success ? parsedFeed.data : {};

  const moduleOrder = feed.moduleOrder
    ? dedupeOrder(feed.moduleOrder)
    : DEFAULT_FEED_CONFIG.moduleOrder;
  const enabledModules = feed.enabledModules
    ? dedupeOrder(feed.enabledModules)
    : DEFAULT_FEED_CONFIG.enabledModules;

  let banner: OperationalBannerConfig | null = DEFAULT_FEED_CONFIG.banner;
  if (rawBanner !== null && rawBanner !== undefined) {
    const parsedBanner = bannerConfigSchema.safeParse(rawBanner);
    banner = parsedBanner.success
      ? {
          eventId: parsedBanner.data.eventId,
          label: parsedBanner.data.label,
          kind: parsedBanner.data.kind,
          headline: parsedBanner.data.headline,
          imageURL: parsedBanner.data.imageURL ?? null,
        }
      : null;
  }

  const overrides = feed.weights ?? {};
  const weights: FeedConfig['weights'] = {
    freshness: overrides.freshness ?? DEFAULT_FEED_CONFIG.weights.freshness,
    distance: overrides.distance ?? DEFAULT_FEED_CONFIG.weights.distance,
    interest: overrides.interest ?? DEFAULT_FEED_CONFIG.weights.interest,
    follow: overrides.follow ?? DEFAULT_FEED_CONFIG.weights.follow,
    supplyQuality: overrides.supplyQuality ?? DEFAULT_FEED_CONFIG.weights.supplyQuality,
    availability: overrides.availability ?? DEFAULT_FEED_CONFIG.weights.availability,
    exploration: overrides.exploration ?? DEFAULT_FEED_CONFIG.weights.exploration,
    safetyDemotion: overrides.safetyDemotion ?? DEFAULT_FEED_CONFIG.weights.safetyDemotion,
  };

  return {
    weights,
    moduleOrder,
    enabledModules,
    banner,
    naturalResultsMinRatio:
      feed.naturalResultsMinRatio ?? DEFAULT_FEED_CONFIG.naturalResultsMinRatio,
    moduleSize: feed.moduleSize ?? DEFAULT_FEED_CONFIG.moduleSize,
    nearbyRadiusKm: feed.nearbyRadiusKm ?? DEFAULT_FEED_CONFIG.nearbyRadiusKm,
    newEventWindowHours: feed.newEventWindowHours ?? DEFAULT_FEED_CONFIG.newEventWindowHours,
    verifiedHostMinCompleted:
      feed.verifiedHostMinCompleted ?? DEFAULT_FEED_CONFIG.verifiedHostMinCompleted,
    freshnessHalfLifeHours:
      feed.freshnessHalfLifeHours ?? DEFAULT_FEED_CONFIG.freshnessHalfLifeHours,
    distanceHalfLifeKm: feed.distanceHalfLifeKm ?? DEFAULT_FEED_CONFIG.distanceHalfLifeKm,
  };
}
