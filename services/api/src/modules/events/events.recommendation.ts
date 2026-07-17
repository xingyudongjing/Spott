// Explainable, server-side recommendation engine for the D1 home feed.
//
// Product doc D1 / full-stack doc 4.4 & 7.5:
//   * The feed is organised into modules (今日可参加 / 本周末 / 附近热门 / 兴趣推荐 /
//     新活动 / 认证局头 / 关注群组更新) whose ORDER is decided by server configuration,
//     never by the client.
//   * Ranking uses an explainable score: time freshness, distance, interest match,
//     follow relationship, supply quality, capacity availability, an exploration
//     factor and a safety demotion.
//   * At most one first-screen operational banner, which must always be flagged as
//     "推广/运营推荐". Commercial top-listing must be flagged and must keep a minimum
//     organic-results ratio inside every module.
//   * Safety take-downs and account-limited hosts are filtered BEFORE scoring.
//
// Every numeric threshold and weight is passed in via `FeedConfig`, which the service
// hydrates from `admin.config_revisions` so operations can retune without a client
// release. Nothing here is hard-coded at a call site.

export const RECOMMENDATION_MODULE_KEYS = [
  'today',
  'weekend',
  'nearby_hot',
  'interest',
  'new_events',
  'verified_hosts',
  'followed_updates',
] as const;

export type RecommendationModuleKey = (typeof RECOMMENDATION_MODULE_KEYS)[number];

export interface RecommendationWeights {
  freshness: number;
  distance: number;
  interest: number;
  follow: number;
  supplyQuality: number;
  availability: number;
  exploration: number;
  safetyDemotion: number;
}

export const DEFAULT_RECOMMENDATION_WEIGHTS: RecommendationWeights = {
  freshness: 1,
  distance: 1,
  interest: 1.2,
  follow: 1.5,
  supplyQuality: 1,
  availability: 0.8,
  exploration: 0.3,
  safetyDemotion: 2,
};

export interface OperationalBannerConfig {
  eventId: string;
  label: string;
  kind: 'promoted' | 'operational';
  headline?: string | undefined;
  imageURL?: string | null | undefined;
}

export interface FeedConfig {
  weights: RecommendationWeights;
  moduleOrder: RecommendationModuleKey[];
  enabledModules: RecommendationModuleKey[];
  banner: OperationalBannerConfig | null;
  naturalResultsMinRatio: number;
  moduleSize: number;
  nearbyRadiusKm: number;
  newEventWindowHours: number;
  verifiedHostMinCompleted: number;
  freshnessHalfLifeHours: number;
  distanceHalfLifeKm: number;
}

export const DEFAULT_MODULE_ORDER: RecommendationModuleKey[] = [...RECOMMENDATION_MODULE_KEYS];

export const DEFAULT_FEED_CONFIG: FeedConfig = {
  weights: DEFAULT_RECOMMENDATION_WEIGHTS,
  moduleOrder: DEFAULT_MODULE_ORDER,
  enabledModules: [...RECOMMENDATION_MODULE_KEYS],
  banner: null,
  naturalResultsMinRatio: 0.6,
  moduleSize: 12,
  nearbyRadiusKm: 25,
  newEventWindowHours: 72,
  verifiedHostMinCompleted: 3,
  freshnessHalfLifeHours: 48,
  distanceHalfLifeKm: 10,
};

export interface CandidateFeatures {
  id: string;
  startsAt: Date | null;
  createdAt: Date;
  categoryId: string | null;
  tags: string[];
  distanceKm: number | null;
  interestOverlap: number;
  organizerFollowed: boolean;
  groupFollowed: boolean;
  phoneVerifiedHost: boolean;
  completedEventCount: number;
  attendanceRateBand: 'unavailable' | 'under_70' | '70_89' | '90_plus';
  availableCapacity: number;
  capacity: number;
  boosted: boolean;
  safetyPenalty: number;
  safetyExcluded?: boolean;
}

export interface ScoreComponents {
  freshness: number;
  distance: number;
  interest: number;
  follow: number;
  supplyQuality: number;
  availability: number;
  exploration: number;
  safetyDemotion: number;
}

export interface CandidateScore {
  total: number;
  components: ScoreComponents;
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const ATTENDANCE_QUALITY: Record<CandidateFeatures['attendanceRateBand'], number> = {
  unavailable: 0.4,
  under_70: 0.3,
  '70_89': 0.7,
  '90_plus': 1,
};

function halfLifeDecay(value: number, halfLife: number): number {
  if (!(halfLife > 0)) return value <= 0 ? 1 : 0;
  return 2 ** (-Math.max(value, 0) / halfLife);
}

// Deterministic 0..1 jitter derived from the candidate id so that ties diversify
// without turning the ranking non-reproducible within a single request.
function explorationJitter(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

export interface ScoreTuning {
  freshnessHalfLifeHours: number;
  distanceHalfLifeKm: number;
}

const DEFAULT_SCORE_TUNING: ScoreTuning = {
  freshnessHalfLifeHours: DEFAULT_FEED_CONFIG.freshnessHalfLifeHours,
  distanceHalfLifeKm: DEFAULT_FEED_CONFIG.distanceHalfLifeKm,
};

export function scoreCandidate(
  candidate: CandidateFeatures,
  weights: RecommendationWeights,
  now: Date,
  tuning: ScoreTuning = DEFAULT_SCORE_TUNING,
): CandidateScore {
  const hoursToStart = candidate.startsAt
    ? (candidate.startsAt.getTime() - now.getTime()) / HOUR_MS
    : null;
  const startsSoon =
    hoursToStart === null
      ? 0.3
      : halfLifeDecay(Math.abs(hoursToStart), tuning.freshnessHalfLifeHours * 1.5);
  const recentlyCreated = halfLifeDecay(
    (now.getTime() - candidate.createdAt.getTime()) / HOUR_MS,
    tuning.freshnessHalfLifeHours,
  );
  const freshnessSignal = 0.6 * startsSoon + 0.4 * recentlyCreated;

  const distanceSignal =
    candidate.distanceKm === null
      ? 0.5
      : halfLifeDecay(candidate.distanceKm, tuning.distanceHalfLifeKm);

  const interestSignal = candidate.interestOverlap / (candidate.interestOverlap + 1);

  const followSignal = candidate.organizerFollowed || candidate.groupFollowed ? 1 : 0;

  const supplySignal =
    0.6 * ATTENDANCE_QUALITY[candidate.attendanceRateBand] +
    0.25 * (candidate.completedEventCount / (candidate.completedEventCount + 3)) +
    0.15 * (candidate.phoneVerifiedHost ? 1 : 0);

  const occupancyRatio =
    candidate.capacity > 0
      ? Math.min(Math.max(candidate.availableCapacity, 0) / candidate.capacity, 1)
      : 0;
  // Some availability is good, but a nearly-full event ("即将满员") reads as hot; a full
  // event (no availability) is not surfaceable, so it collapses to zero.
  const availabilitySignal = candidate.availableCapacity <= 0 ? 0 : 0.35 + 0.65 * occupancyRatio;

  const explorationSignal = explorationJitter(candidate.id);

  const components: ScoreComponents = {
    freshness: weights.freshness * freshnessSignal,
    distance: weights.distance * distanceSignal,
    interest: weights.interest * interestSignal,
    follow: weights.follow * followSignal,
    supplyQuality: weights.supplyQuality * supplySignal,
    availability: weights.availability * availabilitySignal,
    exploration: weights.exploration * explorationSignal,
    safetyDemotion: -weights.safetyDemotion * Math.max(candidate.safetyPenalty, 0),
  };

  const total = (Object.values(components) as number[]).reduce((sum, value) => sum + value, 0);
  return { total, components };
}

function jstDayInfo(date: Date): { dayStart: number; dayEnd: number; weekday: number } {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  const weekday = shifted.getUTCDay();
  const startOfDayUTC = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate(),
  );
  const dayStart = startOfDayUTC - JST_OFFSET_MS;
  return { dayStart, dayEnd: dayStart + 24 * HOUR_MS, weekday };
}

function withinToday(candidate: CandidateFeatures, now: Date): boolean {
  if (!candidate.startsAt) return false;
  const { dayEnd } = jstDayInfo(now);
  const start = candidate.startsAt.getTime();
  return start >= now.getTime() && start < dayEnd;
}

function withinUpcomingWeekend(candidate: CandidateFeatures, now: Date): boolean {
  if (!candidate.startsAt) return false;
  const { dayStart, weekday } = jstDayInfo(now);
  // Days until the coming Saturday (weekday 6) in JST; if today is the weekend, use it.
  const daysUntilSaturday = weekday === 0 ? 6 : (6 - weekday + 7) % 7;
  const saturdayStart = dayStart + daysUntilSaturday * 24 * HOUR_MS;
  const weekendStart = weekday === 6 || weekday === 0 ? dayStart : saturdayStart;
  const weekendEnd =
    weekday === 0 ? dayStart + 24 * HOUR_MS : saturdayStart + 2 * 24 * HOUR_MS;
  const start = candidate.startsAt.getTime();
  return start >= Math.max(weekendStart, now.getTime()) && start < weekendEnd;
}

const MODULE_PREDICATES: Record<
  RecommendationModuleKey,
  (candidate: CandidateFeatures, config: FeedConfig, now: Date) => boolean
> = {
  today: (candidate, _config, now) => withinToday(candidate, now),
  weekend: (candidate, _config, now) => withinUpcomingWeekend(candidate, now),
  nearby_hot: (candidate, config) =>
    candidate.distanceKm !== null && candidate.distanceKm <= config.nearbyRadiusKm,
  interest: (candidate) => candidate.interestOverlap > 0,
  new_events: (candidate, config, now) =>
    now.getTime() - candidate.createdAt.getTime() <= config.newEventWindowHours * HOUR_MS,
  verified_hosts: (candidate, config) =>
    candidate.phoneVerifiedHost && candidate.completedEventCount >= config.verifiedHostMinCompleted,
  followed_updates: (candidate) => candidate.organizerFollowed || candidate.groupFollowed,
};

export interface RankedItem {
  id: string;
  score: number;
  boosted: boolean;
  components: ScoreComponents;
}

export interface FeedModule {
  key: RecommendationModuleKey;
  items: RankedItem[];
}

export interface OperationalBanner {
  eventId: string;
  label: string;
  kind: 'promoted' | 'operational';
  promotional: true;
  headline?: string | undefined;
  imageURL?: string | null | undefined;
}

export interface AssembledFeed {
  banner: OperationalBanner | null;
  modules: FeedModule[];
  weights: RecommendationWeights;
  scoringVersion: string;
  generatedAt: string;
}

export const SCORING_VERSION = 'v1';

// Cap boosted entries so at least `naturalResultsMinRatio` of the shown slots stay organic.
function applyOrganicFloor(items: RankedItem[], minRatio: number, size: number): RankedItem[] {
  const ratio = Math.min(Math.max(minRatio, 0), 1);
  const capacity = Math.max(size, 0);
  const minOrganic = Math.ceil(capacity * ratio);
  const maxBoosted = Math.max(capacity - minOrganic, 0);
  const result: RankedItem[] = [];
  let boostedShown = 0;
  const deferred: RankedItem[] = [];
  for (const item of items) {
    if (result.length >= capacity) break;
    if (item.boosted) {
      if (boostedShown >= maxBoosted) {
        deferred.push(item);
        continue;
      }
      boostedShown += 1;
    }
    result.push(item);
  }
  // Fill any remaining slots with the deferred boosted items only if organic ran out.
  for (const item of deferred) {
    if (result.length >= capacity) break;
    result.push(item);
  }
  return result;
}

function toRankedItem(candidate: CandidateFeatures, score: CandidateScore): RankedItem {
  return {
    id: candidate.id,
    score: score.total,
    boosted: candidate.boosted,
    components: score.components,
  };
}

export function assembleFeed(
  candidates: CandidateFeatures[],
  config: FeedConfig,
  now: Date,
): AssembledFeed {
  const eligible = candidates.filter((candidate) => candidate.safetyExcluded !== true);
  const tuning: ScoreTuning = {
    freshnessHalfLifeHours: config.freshnessHalfLifeHours,
    distanceHalfLifeKm: config.distanceHalfLifeKm,
  };
  const scored = new Map<string, { candidate: CandidateFeatures; score: CandidateScore }>();
  for (const candidate of eligible) {
    scored.set(candidate.id, {
      candidate,
      score: scoreCandidate(candidate, config.weights, now, tuning),
    });
  }

  const enabled = new Set(config.enabledModules);
  const modules: FeedModule[] = [];
  for (const key of config.moduleOrder) {
    if (!enabled.has(key)) continue;
    const predicate = MODULE_PREDICATES[key];
    const members = [...scored.values()]
      .filter(({ candidate }) => predicate(candidate, config, now))
      .sort((left, right) => right.score.total - left.score.total)
      .map(({ candidate, score }) => toRankedItem(candidate, score));
    const items = applyOrganicFloor(members, config.naturalResultsMinRatio, config.moduleSize);
    if (items.length > 0) modules.push({ key, items });
  }

  let banner: OperationalBanner | null = null;
  const bannerConfig = config.banner;
  if (bannerConfig && bannerConfig.label.trim().length > 0 && scored.has(bannerConfig.eventId)) {
    banner = {
      eventId: bannerConfig.eventId,
      label: bannerConfig.label,
      kind: bannerConfig.kind,
      promotional: true,
      headline: bannerConfig.headline,
      imageURL: bannerConfig.imageURL ?? null,
    };
  }

  return {
    banner,
    modules,
    weights: config.weights,
    scoringVersion: SCORING_VERSION,
    generatedAt: now.toISOString(),
  };
}
