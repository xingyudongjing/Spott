import { describe, expect, it } from 'vitest';
import {
  attendanceBand,
  isRevocationReason,
  planEvaluation,
  ruleMet,
  type AchievementRule,
  type CurrentAwardInput,
  type DefinitionInput,
  type MetricSnapshot,
} from './achievement-rules.js';

function snapshot(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    checkedInCount: 0,
    hostedEndedCount: 0,
    hostedCompletedCount: 0,
    ownedGroupMembers: 0,
    validFeedbackCount: 0,
    recentAttendanceRate: null,
    recentAttendanceSample: 0,
    hostRecentAttendanceRate: null,
    hostRecentAttendanceSample: 0,
    monthlyCheckinStreak: 0,
    monthlyHostingStreak: 0,
    memberRepeatRate: null,
    categoryCheckins: {},
    categoryCompletions: {},
    certified: false,
    noSevereComplaint: true,
    ...overrides,
  };
}

describe('ruleMet', () => {
  it('honours a count threshold and its configuration override', () => {
    const rule: AchievementRule = { metric: 'checked_in_count', gte: 1 };
    expect(ruleMet(rule, snapshot({ checkedInCount: 1 }))).toBe(true);
    // The seeded threshold of 1 is met, but a configured override of 5 is not.
    expect(ruleMet(rule, snapshot({ checkedInCount: 1 }), 5)).toBe(false);
    expect(ruleMet(rule, snapshot({ checkedInCount: 5 }), 5)).toBe(true);
  });

  it('scopes a count rule to a single category', () => {
    const rule: AchievementRule = { metric: 'category_checkin', category: 'city_explore', gte: 5 };
    expect(ruleMet(rule, snapshot({ categoryCheckins: { city_explore: 4 } }))).toBe(false);
    expect(ruleMet(rule, snapshot({ categoryCheckins: { city_explore: 5, food: 9 } }))).toBe(true);
  });

  it('requires a minimum sample before a rate rule can pass', () => {
    const rule: AchievementRule = { type: 'rate', metric: 'recent_attendance_rate', gte: 0.9, minSample: 10 };
    expect(ruleMet(rule, snapshot({ recentAttendanceRate: 1, recentAttendanceSample: 9 }))).toBe(false);
    expect(ruleMet(rule, snapshot({ recentAttendanceRate: 0.9, recentAttendanceSample: 10 }))).toBe(true);
    expect(ruleMet(rule, snapshot({ recentAttendanceRate: 0.89, recentAttendanceSample: 12 }))).toBe(false);
  });

  it('evaluates streaks', () => {
    const rule: AchievementRule = { type: 'streak', metric: 'monthly_checkin_streak', gte: 3 };
    expect(ruleMet(rule, snapshot({ monthlyCheckinStreak: 2 }))).toBe(false);
    expect(ruleMet(rule, snapshot({ monthlyCheckinStreak: 3 }))).toBe(true);
  });

  it('requires every branch of a composite rule (trusted host)', () => {
    const rule: AchievementRule = {
      type: 'composite',
      all: [
        { flag: 'certified' },
        { metric: 'hosted_completed_count', gte: 5 },
        { type: 'rate', metric: 'host_recent_attendance_rate', gte: 0.7, minSample: 1 },
        { flag: 'no_severe_complaint' },
      ],
    };
    const passing = snapshot({
      certified: true,
      hostedCompletedCount: 5,
      hostRecentAttendanceRate: 0.7,
      hostRecentAttendanceSample: 5,
      noSevereComplaint: true,
    });
    expect(ruleMet(rule, passing)).toBe(true);
    expect(ruleMet(rule, { ...passing, noSevereComplaint: false })).toBe(false);
    expect(ruleMet(rule, { ...passing, certified: false })).toBe(false);
  });
});

describe('planEvaluation', () => {
  const first: DefinitionInput = { id: 'def-first', code: 'first_checkin', ruleVersion: 1, ruleJson: { metric: 'checked_in_count', gte: 1 } };

  it('awards a newly satisfied achievement once', () => {
    const plan = planEvaluation([first], [], snapshot({ checkedInCount: 1 }), {});
    expect(plan.toAward).toEqual([{ definitionId: 'def-first', code: 'first_checkin', ruleVersion: 1 }]);
    expect(plan.toRevoke).toEqual([]);
  });

  it('does not re-award an achievement the user already holds', () => {
    const held: CurrentAwardInput = { definitionId: 'def-first', code: 'first_checkin', ruleVersion: 1 };
    const plan = planEvaluation([first], [held], snapshot({ checkedInCount: 3 }), {});
    expect(plan.toAward).toEqual([]);
    expect(plan.toRevoke).toEqual([]);
  });

  it('respects a configuration override so the threshold is not hard-coded', () => {
    const plan = planEvaluation([first], [], snapshot({ checkedInCount: 1 }), { first_checkin: 5 });
    expect(plan.toAward).toEqual([]);
  });

  it('revokes a held award when the condition no longer holds', () => {
    const held: CurrentAwardInput = { definitionId: 'def-first', code: 'first_checkin', ruleVersion: 1 };
    const plan = planEvaluation([first], [held], snapshot({ checkedInCount: 0 }), {});
    expect(plan.toRevoke).toEqual([
      { definitionId: 'def-first', code: 'first_checkin', reason: 'condition_no_longer_met' },
    ]);
    expect(plan.toAward).toEqual([]);
  });

  it('supersedes an award from an older rule version and re-awards the canonical one', () => {
    const v1: DefinitionInput = { id: 'def-v1', code: 'reliable_attendee', ruleVersion: 1, ruleJson: { type: 'rate', metric: 'recent_attendance_rate', gte: 0.8, minSample: 5 } };
    const v2: DefinitionInput = { id: 'def-v2', code: 'reliable_attendee', ruleVersion: 2, ruleJson: { type: 'rate', metric: 'recent_attendance_rate', gte: 0.9, minSample: 10 } };
    const heldOld: CurrentAwardInput = { definitionId: 'def-v1', code: 'reliable_attendee', ruleVersion: 1 };
    const snap = snapshot({ recentAttendanceRate: 0.95, recentAttendanceSample: 10 });
    const plan = planEvaluation([v1, v2], [heldOld], snap, {});
    expect(plan.toRevoke).toEqual([
      { definitionId: 'def-v1', code: 'reliable_attendee', reason: 'rule_superseded' },
    ]);
    expect(plan.toAward).toEqual([
      { definitionId: 'def-v2', code: 'reliable_attendee', ruleVersion: 2 },
    ]);
  });

  it('revokes an award whose code is no longer active', () => {
    const held: CurrentAwardInput = { definitionId: 'def-old', code: 'retired_badge', ruleVersion: 1 };
    const plan = planEvaluation([first], [held], snapshot({ checkedInCount: 1 }), {});
    expect(plan.toRevoke).toEqual([
      { definitionId: 'def-old', code: 'retired_badge', reason: 'condition_no_longer_met' },
    ]);
  });
});

describe('attendanceBand', () => {
  it('discloses only a coarse interval, never the exact rate', () => {
    expect(attendanceBand(null)).toBeNull();
    expect(attendanceBand(0.97)).toBe('≥90%');
    expect(attendanceBand(0.85)).toBe('80–89%');
    expect(attendanceBand(0.72)).toBe('70–79%');
    expect(attendanceBand(0.4)).toBe('<50%');
  });
});

describe('isRevocationReason', () => {
  it('accepts the documented reasons and rejects others', () => {
    expect(isRevocationReason('cheating')).toBe(true);
    expect(isRevocationReason('event_delisted')).toBe(true);
    expect(isRevocationReason('because')).toBe(false);
    expect(isRevocationReason(42)).toBe(false);
  });
});
