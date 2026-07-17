// Pure, deterministic achievement rule engine.
//
// The engine is intentionally data-driven: every achievement (participant and
// host) is expressed as an `achievement_definitions` row whose `rule_json`
// selects one of the supported rule shapes below. Numeric trigger thresholds
// are never hard-coded — they come from the definition and may be overridden per
// code through the configuration centre (see CommunityService.evaluateAchievements).
//
// Product references: 产品文档 H (成就系统), 开发文档 7.2.4.

export type RevocationReason =
  | 'correction' // 补签纠正
  | 'cheating' // 作弊
  | 'valid_complaint' // 有效投诉
  | 'event_delisted' // 活动下架导致条件不再满足
  | 'condition_no_longer_met'
  | 'rule_superseded';

export const REVOCATION_REASONS: readonly RevocationReason[] = [
  'correction',
  'cheating',
  'valid_complaint',
  'event_delisted',
  'condition_no_longer_met',
  'rule_superseded',
];

export function isRevocationReason(value: unknown): value is RevocationReason {
  return typeof value === 'string' && (REVOCATION_REASONS as readonly string[]).includes(value);
}

/**
 * A snapshot of every metric the shipped achievements can reference. All
 * behavioural values are aggregates; nothing exact enough to expose raw
 * behaviour is placed on the share card (see shareDataRange).
 */
export interface MetricSnapshot {
  checkedInCount: number;
  hostedEndedCount: number;
  hostedCompletedCount: number;
  ownedGroupMembers: number;
  validFeedbackCount: number;
  recentAttendanceRate: number | null;
  recentAttendanceSample: number;
  hostRecentAttendanceRate: number | null;
  hostRecentAttendanceSample: number;
  monthlyCheckinStreak: number;
  monthlyHostingStreak: number;
  memberRepeatRate: number | null;
  categoryCheckins: Record<string, number>;
  categoryCompletions: Record<string, number>;
  certified: boolean;
  noSevereComplaint: boolean;
}

export interface CountRule {
  type?: 'count';
  metric: string;
  gte: number;
  category?: string;
}

export interface RateRule {
  type: 'rate';
  metric: string;
  gte: number;
  minSample?: number;
}

export interface StreakRule {
  type: 'streak';
  metric: string;
  gte: number;
}

export type FlagName = 'certified' | 'no_severe_complaint';

export interface FlagRule {
  flag: FlagName;
}

export type LeafRule = CountRule | RateRule | StreakRule | FlagRule;

export interface CompositeRule {
  type: 'composite';
  all: LeafRule[];
}

export type AchievementRule = LeafRule | CompositeRule;

function metricValue(
  snapshot: MetricSnapshot,
  metric: string,
  category: string | undefined,
): number | null {
  switch (metric) {
    case 'checked_in_count':
      return snapshot.checkedInCount;
    case 'hosted_ended_count':
      return snapshot.hostedEndedCount;
    case 'hosted_completed_count':
      return snapshot.hostedCompletedCount;
    case 'owned_group_members':
      return snapshot.ownedGroupMembers;
    case 'valid_feedback_count':
      return snapshot.validFeedbackCount;
    case 'recent_attendance_rate':
      return snapshot.recentAttendanceRate;
    case 'host_recent_attendance_rate':
      return snapshot.hostRecentAttendanceRate;
    case 'monthly_checkin_streak':
      return snapshot.monthlyCheckinStreak;
    case 'monthly_hosting_streak':
      return snapshot.monthlyHostingStreak;
    case 'member_repeat_rate':
      return snapshot.memberRepeatRate;
    case 'category_checkin':
      return category ? snapshot.categoryCheckins[category] ?? 0 : null;
    case 'category_completion':
      return category ? snapshot.categoryCompletions[category] ?? 0 : null;
    default:
      return null;
  }
}

function sampleFor(snapshot: MetricSnapshot, metric: string): number {
  if (metric === 'recent_attendance_rate') return snapshot.recentAttendanceSample;
  if (metric === 'host_recent_attendance_rate') return snapshot.hostRecentAttendanceSample;
  return Number.POSITIVE_INFINITY;
}

function leafMet(
  rule: LeafRule,
  snapshot: MetricSnapshot,
  thresholdOverride: number | undefined,
): boolean {
  if ('flag' in rule) {
    return rule.flag === 'certified' ? snapshot.certified : snapshot.noSevereComplaint;
  }
  const threshold = thresholdOverride ?? rule.gte;
  if (rule.type === 'rate') {
    const value = metricValue(snapshot, rule.metric, undefined);
    const sample = sampleFor(snapshot, rule.metric);
    const minSample = rule.minSample ?? 1;
    if (value === null || sample < minSample) return false;
    return value >= threshold;
  }
  const value = metricValue(
    snapshot,
    rule.metric,
    'category' in rule ? rule.category : undefined,
  );
  if (value === null) return false;
  return value >= threshold;
}

/**
 * Evaluate a single rule against a snapshot. `thresholdOverride` (from the
 * configuration centre) replaces the top-level numeric gate when present; it is
 * ignored for composite sub-rules, which carry their own thresholds.
 */
export function ruleMet(
  rule: AchievementRule,
  snapshot: MetricSnapshot,
  thresholdOverride?: number,
): boolean {
  if ('all' in rule) {
    return rule.all.every((leaf) => leafMet(leaf, snapshot, undefined));
  }
  return leafMet(rule, snapshot, thresholdOverride);
}

export interface DefinitionInput {
  id: string;
  code: string;
  ruleVersion: number;
  ruleJson: AchievementRule;
}

export interface CurrentAwardInput {
  definitionId: string;
  code: string;
  ruleVersion: number;
}

export interface AwardDecision {
  definitionId: string;
  code: string;
  ruleVersion: number;
}

export interface RevokeDecision {
  definitionId: string;
  code: string;
  reason: RevocationReason;
}

export interface EvaluationPlan {
  toAward: AwardDecision[];
  toRevoke: RevokeDecision[];
}

/**
 * Decide which awards to grant and which to revoke given the active
 * definitions, the awards the user currently holds, and the metric snapshot.
 *
 * Rule versioning: for each code the highest active `rule_version` is canonical.
 * Awards granted under a superseded definition are revoked as `rule_superseded`;
 * the canonical definition is then re-evaluated for a fresh award. A canonical
 * award whose condition no longer holds is revoked as `condition_no_longer_met`.
 */
export function planEvaluation(
  definitions: DefinitionInput[],
  currentAwards: CurrentAwardInput[],
  snapshot: MetricSnapshot,
  thresholdOverrides: Record<string, number>,
): EvaluationPlan {
  const canonicalByCode = new Map<string, DefinitionInput>();
  for (const definition of definitions) {
    const existing = canonicalByCode.get(definition.code);
    if (!existing || definition.ruleVersion > existing.ruleVersion) {
      canonicalByCode.set(definition.code, definition);
    }
  }

  const toRevoke: RevokeDecision[] = [];
  const heldCanonicalDefinitionIds = new Set<string>();

  for (const award of currentAwards) {
    const canonical = canonicalByCode.get(award.code);
    if (!canonical) {
      // The definition (or its whole code) is no longer active.
      toRevoke.push({
        definitionId: award.definitionId,
        code: award.code,
        reason: 'condition_no_longer_met',
      });
      continue;
    }
    if (award.definitionId !== canonical.id) {
      toRevoke.push({
        definitionId: award.definitionId,
        code: award.code,
        reason: 'rule_superseded',
      });
      continue;
    }
    const met = ruleMet(canonical.ruleJson, snapshot, thresholdOverrides[award.code]);
    if (!met) {
      toRevoke.push({
        definitionId: award.definitionId,
        code: award.code,
        reason: 'condition_no_longer_met',
      });
      continue;
    }
    heldCanonicalDefinitionIds.add(canonical.id);
  }

  const toAward: AwardDecision[] = [];
  for (const canonical of canonicalByCode.values()) {
    if (heldCanonicalDefinitionIds.has(canonical.id)) continue;
    if (ruleMet(canonical.ruleJson, snapshot, thresholdOverrides[canonical.code])) {
      toAward.push({
        definitionId: canonical.id,
        code: canonical.code,
        ruleVersion: canonical.ruleVersion,
      });
    }
  }

  return { toAward, toRevoke };
}

/**
 * Coarse, share-safe representation of an attendance rate. Exact behavioural
 * numbers are never published (产品文档 H: 精确行为数据不公开); the host attendance
 * rate is disclosed only as an interval band (公开区间).
 */
export function attendanceBand(rate: number | null): string | null {
  if (rate === null) return null;
  const percent = Math.round(rate * 100);
  if (percent >= 90) return '≥90%';
  if (percent >= 80) return '80–89%';
  if (percent >= 70) return '70–79%';
  if (percent >= 50) return '50–69%';
  return '<50%';
}
