import type { EventSummary } from "../../app/lib/event-contract";
import { normalizeEvent } from "../../app/lib/api";
import type { EventView } from "../../app/lib/demo-data";
import type { Locale } from "../../app/i18n/messages";

export const hostStudioCaptureContract = Object.freeze({
  capturedAt: "2026-07-22T12:00:00.000Z",
  colorScheme: "light" as const,
  deviceScaleFactor: 1,
  reducedMotion: "reduce" as const,
  textScale: "100%",
  timeZone: "Asia/Tokyo",
  viewport: Object.freeze({ height: 900, width: 1440 }),
});

type LocalizedRecord = Readonly<{
  area: string;
  draftArea: string;
  draftTitle: string;
  liveTitle: string;
  organizer: string;
}>;

const localizedRecords: Readonly<Record<Locale, LocalizedRecord>> = Object.freeze({
  "zh-Hans": Object.freeze({
    area: "清澄白河站附近",
    draftArea: "谷中银座附近",
    draftTitle: "谷中清晨写生会",
    liveTitle: "东京余光 · 隅田川散步",
    organizer: "周末开局",
  }),
  ja: Object.freeze({
    area: "清澄白河駅周辺",
    draftArea: "谷中銀座周辺",
    draftTitle: "谷中モーニングスケッチ",
    liveTitle: "東京の余光 · 隅田川ウォーク",
    organizer: "週末のはじまり",
  }),
  en: Object.freeze({
    area: "Near Kiyosumi-shirakawa Station",
    draftArea: "Near Yanaka Ginza",
    draftTitle: "Yanaka Morning Sketch",
    liveTitle: "Tokyo Afterglow · Sumida Walk",
    organizer: "Weekend Beginnings",
  }),
});

export function hostStudioCaptureItems(locale: Locale): readonly EventView[] {
  const copy = localizedRecords[locale];
  return Object.freeze([
    normalizeEvent(makeEvent({
      confirmedCount: 18,
      publicArea: copy.area,
      title: copy.liveTitle,
    })),
    normalizeEvent(makeEvent({
      capacity: 16,
      confirmedCount: 0,
      deadlineAt: "2036-09-19T23:59:00.000+09:00",
      endsAt: "2036-09-20T12:00:00.000+09:00",
      id: "019b0000-0000-7000-8100-000000000002",
      publicArea: copy.draftArea,
      publicSlug: "yanaka-morning-sketch",
      startsAt: "2036-09-20T09:30:00.000+09:00",
      status: "draft",
      title: copy.draftTitle,
      version: 1,
    })),
  ]);
}

function makeEvent(overrides: Partial<EventSummary>): EventSummary {
  const locale = localeForTitle(overrides.title);
  const copy = localizedRecords[locale];
  return {
    availableActions: ["edit"],
    availableCapacity: Math.max(0, (overrides.capacity ?? 28) - (overrides.confirmedCount ?? 18)),
    capacity: 28,
    category: "walk",
    confirmedCount: 18,
    coordinate: { latitude: 35.6812, longitude: 139.7976, precision: "approximate" },
    coverURL: null,
    deadlineAt: "2036-09-11T23:59:00.000+09:00",
    description: "A source-recorded synthetic event used for deterministic product evidence.",
    displayTimeZone: "Asia/Tokyo",
    endsAt: "2036-09-12T19:30:00.000+09:00",
    favorited: false,
    fee: {
      amountJPY: null,
      collectorName: null,
      isFree: true,
      method: null,
      paymentDeadlineText: null,
      refundPolicy: null,
    },
    format: "in_person",
    groupId: null,
    id: "019b0000-0000-7000-8100-000000000001",
    localeConfirmed: true,
    organizer: {
      handle: "weekend_beginnings",
      id: "019b0000-0000-7000-8100-000000000010",
      name: copy.organizer,
      trust: {
        attendanceRateBand: "90_plus",
        completedEventCount: 18,
        phoneVerified: true,
      },
      viewerFollowing: false,
    },
    organizerId: "019b0000-0000-7000-8100-000000000010",
    primaryLocale: locale,
    publicArea: copy.area,
    publicSlug: "tokyo-afterglow-sumida-walk",
    region: "tokyo",
    registrationMode: "automatic",
    registrationStatus: null,
    startsAt: "2036-09-12T17:00:00.000+09:00",
    status: "published",
    supportedLocales: [locale],
    tags: ["walk", "tokyo"],
    title: copy.liveTitle,
    updatedAt: "2026-07-22T12:00:00.000Z",
    version: 4,
    viewerRegistration: null,
    waitlistEnabled: true,
    ...overrides,
  };
}

function localeForTitle(title: EventSummary["title"] | undefined): Locale {
  if (title === localizedRecords.ja.liveTitle || title === localizedRecords.ja.draftTitle) return "ja";
  if (title === localizedRecords.en.liveTitle || title === localizedRecords.en.draftTitle) return "en";
  return "zh-Hans";
}
