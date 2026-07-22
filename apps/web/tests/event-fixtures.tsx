import type { ReactElement } from "react";
import { render } from "@testing-library/react";

import { I18nProvider } from "../app/components/I18nProvider";
import type { Locale } from "../app/i18n/messages";
import type { EventDetail, EventPage, EventSummary } from "../app/lib/event-contract";

const HOUR_MS = 60 * 60 * 1_000;

function eventTimesFrom(baseline: Date) {
  const baselineTime = baseline.getTime();

  return {
    deadlineAt: new Date(baselineTime + HOUR_MS).toISOString(),
    startsAt: new Date(baselineTime + 2 * HOUR_MS).toISOString(),
    endsAt: new Date(baselineTime + 4.5 * HOUR_MS).toISOString(),
  };
}

const defaultEventTimes = eventTimesFrom(new Date());

export const eventFixture: EventSummary = {
  id: "019b0000-0000-7000-8100-000000000001",
  publicSlug: "tokyo-afterglow-walk",
  organizerId: "019b0000-0000-7000-8100-000000000010",
  status: "published",
  title: "东京余光 · 隅田川蓝调散步",
  description: "沿着河岸慢慢散步。",
  category: "walk",
  startsAt: defaultEventTimes.startsAt,
  endsAt: defaultEventTimes.endsAt,
  deadlineAt: defaultEventTimes.deadlineAt,
  displayTimeZone: "Asia/Tokyo",
  region: "tokyo",
  publicArea: "清澄白河站附近",
  capacity: 24,
  confirmedCount: 11,
  availableCapacity: 13,
  fee: {
    isFree: true,
    amountJPY: null,
    collectorName: null,
    method: null,
    paymentDeadlineText: null,
    refundPolicy: null,
  },
  coverURL: null,
  tags: ["walk"],
  organizer: {
    id: "019b0000-0000-7000-8100-000000000010",
    name: "周末开局",
    handle: "weekend_kai",
    viewerFollowing: false,
    trust: {
      phoneVerified: true,
      completedEventCount: 18,
      attendanceRateBand: "90_plus",
    },
  },
  favorited: false,
  registrationStatus: null,
  viewerRegistration: null,
  registrationMode: "automatic",
  waitlistEnabled: true,
  format: "in_person",
  primaryLocale: "ja",
  supportedLocales: ["ja", "en"],
  localeConfirmed: true,
  groupId: null,
  availableActions: ["register"],
  version: 2,
  updatedAt: "2026-07-16T00:00:00.000Z",
  coordinate: { latitude: 35.68, longitude: 139.79, precision: "approximate" },
};

export function makeEvent(
  overrides: Partial<EventSummary> = {},
  baseline?: Date,
): EventSummary {
  return {
    ...eventFixture,
    ...(baseline ? eventTimesFrom(baseline) : {}),
    ...overrides,
  };
}

export function makeDetail(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    ...eventFixture,
    exactAddress: null,
    organizerContact: null,
    attendeeRequirements: "Bring comfortable shoes.",
    riskFlags: [],
    riskDetails: {},
    exactAddressVisibility: "confirmed",
    registrationQuestions: [],
    media: [],
    mediaCount: 0,
    ...overrides,
  };
}

export function makePage(
  items: EventSummary[] = [eventFixture],
  overrides: Partial<EventPage> = {},
): EventPage {
  return {
    items,
    nextCursor: null,
    hasMore: false,
    serverTime: "2026-07-16T00:00:00.000Z",
    queryExplanationId: "discovery-test",
    ...overrides,
  };
}

export function renderWithI18n(ui: ReactElement, locale: Locale = "zh-Hans") {
  return render(ui, {
    wrapper: ({ children }) => (
      <I18nProvider initialLocale={locale}>{children}</I18nProvider>
    ),
  });
}
