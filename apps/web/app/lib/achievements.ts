/**
 * Achievement presentation contract shared by the dashboard screen, the public
 * profile section, and the share landing page.
 *
 * The API returns opaque codes (`GET /me/achievements`, `GET /users/{id}/achievements`).
 * Only codes Spott has actually shipped copy for are named; anything else
 * degrades to a readable form of the raw code instead of disappearing or
 * crashing, exactly like iOS (AchievementPresentation).
 */

import type { MessageKey } from "../i18n/messages";

export const achievementCodes = [
  "first_checkin",
  "city_explorer_5",
  "first_hosted_event",
  "community_builder",
  "continuous_participation",
  "reliable_attendee",
  "friendly_contributor",
  "continuous_organizer",
] as const;

export type AchievementCode = (typeof achievementCodes)[number];

export const revocationReasons = [
  "correction",
  "cheating",
  "valid_complaint",
  "event_delisted",
  "condition_no_longer_met",
  "rule_superseded",
] as const;

export type RevocationReason = (typeof revocationReasons)[number];

export interface AchievementAward {
  id: string;
  code: string;
  audience: string;
  ruleVersion: number;
  visibility: string;
  awardedAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  hidden: boolean;
}

export interface PublicAchievement {
  code: string;
  audience: string;
  ruleVersion: number;
  awardedAt: string;
  hidden?: boolean;
}

export interface AchievementShareCard {
  brand: string;
  nickname: string;
  achievement: {
    code: string;
    audience: string;
    ruleVersion: number;
    awardedAt: string;
  };
  dataRange: {
    eventsAttended?: number;
    completedEvents?: number;
    attendanceBand?: string | null;
  } | null;
  link: string;
}

export function isAchievementCode(value: string): value is AchievementCode {
  return (achievementCodes as readonly string[]).includes(value);
}

export function isRevocationReason(value: string | null): value is RevocationReason {
  return value !== null && (revocationReasons as readonly string[]).includes(value);
}

export function achievementNameKey(code: AchievementCode): MessageKey {
  return `award.${code}.name` as MessageKey;
}

export function achievementDetailKey(code: AchievementCode): MessageKey {
  return `award.${code}.detail` as MessageKey;
}

export function revocationReasonKey(reason: RevocationReason): MessageKey {
  return `achievements.reason.${reason}` as MessageKey;
}

/** Readable fallback for a code this release has no copy for. */
export function achievementCodeFallback(code: string): string {
  return code.replaceAll("_", " ").replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}
