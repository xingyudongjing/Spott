import type { ReactElement } from "react";
import { render } from "@testing-library/react";

import { I18nProvider } from "../app/components/I18nProvider";
import type { Locale } from "../app/i18n/messages";
import type { EventPage, EventSummary } from "../app/lib/event-contract";

export const eventFixture: EventSummary = {
  id: "019b0000-0000-7000-8100-000000000001",
  publicSlug: "tokyo-afterglow-walk",
  organizerId: "019b0000-0000-7000-8100-000000000010",
  status: "published",
  title: "东京余光 · 隅田川蓝调散步",
  description: "沿着河岸慢慢散步。",
  category: "walk",
  startsAt: "2026-07-18T08:30:00.000Z",
  endsAt: "2026-07-18T11:00:00.000Z",
  deadlineAt: "2026-07-18T07:30:00.000Z",
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
  availableActions: ["register"],
  version: 2,
  updatedAt: "2026-07-16T00:00:00.000Z",
  coordinate: { latitude: 35.68, longitude: 139.79, precision: "approximate" },
};

export function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return { ...eventFixture, ...overrides };
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
