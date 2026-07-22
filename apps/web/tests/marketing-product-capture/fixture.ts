import type { Locale } from "../../app/i18n/messages";
import type { GroupView } from "../../app/lib/client-api";
import type { DiscoveryFeed } from "../../app/lib/discovery-feed";
import type { EventDetail, EventSummary } from "../../app/lib/event-contract";

export type MarketingCaptureSurface = "discover" | "event-detail" | "groups";

export const marketingCaptureContract = Object.freeze({
  capturedAt: "2026-07-22T12:00:00.000Z",
  colorScheme: "light" as const,
  reducedMotion: "reduce" as const,
  textScale: "100%",
  timeZone: "Asia/Tokyo",
  viewports: Object.freeze({
    desktop: Object.freeze({ height: 900, width: 1440 }),
    mobile: Object.freeze({ height: 844, width: 390 }),
  }),
});

type FixtureCopy = Readonly<{
  area: string;
  detailDescription: string;
  detailRequirements: string;
  eventDescription: string;
  eventTitle: string;
  groupDescriptions: readonly [string, string];
  groupNames: readonly [string, string];
  groupUpdates: readonly [string, string];
  groupsHeading: string;
  host: string;
  secondArea: string;
  secondDescription: string;
  secondTitle: string;
  discoverHeading: string;
}>;

const copyByLocale: Readonly<Record<Locale, FixtureCopy>> = Object.freeze({
  "zh-Hans": Object.freeze({
    area: "清澄白河站附近",
    detailDescription: "沿着隅田川慢慢散步，在三处短暂停留观察城市光线，最后在河岸分享今天最喜欢的一张照片。",
    detailRequirements: "请穿适合步行的鞋，并自备饮用水。相机与手机都可以参加。",
    eventDescription: "沿着河岸观察暮色、街区与日常生活，适合第一次参加的人。",
    eventTitle: "东京余光 · 隅田川散步",
    groupDescriptions: [
      "每月选择一段适合慢走的东京街区，边走边观察光线、建筑和日常生活。",
      "用轻松的节奏探索旧书店、咖啡馆与小巷，也分享下一次想去的地方。",
    ] as const,
    groupNames: ["东京慢走与光线观察", "神保町书店散步会"] as const,
    groupUpdates: ["九月河岸路线与集合提示", "下一次旧书店路线投票"] as const,
    groupsHeading: "兴趣群组",
    host: "东京余光散步会",
    secondArea: "神保町站附近",
    secondDescription: "一起走访独立书店与安静咖啡馆，交换最近读过的作品。",
    secondTitle: "神保町书店与咖啡散步",
    discoverHeading: "遇见真正想参加的活动",
  }),
  ja: Object.freeze({
    area: "清澄白河駅周辺",
    detailDescription: "隅田川沿いをゆっくり歩き、三つの場所で街の光を観察します。最後に河岸で今日いちばん気に入った一枚を共有します。",
    detailRequirements: "歩きやすい靴と飲み物をご用意ください。カメラでもスマートフォンでも参加できます。",
    eventDescription: "河岸の夕暮れと街の日常を観察する、初参加の方にもやさしい散歩です。",
    eventTitle: "東京の余光 · 隅田川ウォーク",
    groupDescriptions: [
      "毎月、ゆっくり歩ける東京の街を選び、光や建築、日々の風景を一緒に観察します。",
      "古書店や喫茶店、路地を穏やかなペースで巡り、次に歩きたい場所も共有します。",
    ] as const,
    groupNames: ["東京スローウォークと光の観察", "神保町の本と喫茶を歩く会"] as const,
    groupUpdates: ["9月の河岸ルートと集合案内", "次回の古書店ルート投票"] as const,
    groupsHeading: "興味でつながるグループ",
    host: "東京の余光ウォーク",
    secondArea: "神保町駅周辺",
    secondDescription: "個性ある書店と静かな喫茶店を巡り、最近読んだ本を紹介し合います。",
    secondTitle: "神保町の本と喫茶ウォーク",
    discoverHeading: "本当に参加したいイベントに出会う",
  }),
  en: Object.freeze({
    area: "Near Kiyosumi-shirakawa Station",
    detailDescription: "Walk slowly along the Sumida River, pause in three places to notice the city light, then share one favorite photograph by the water.",
    detailRequirements: "Bring comfortable walking shoes and water. A camera or a phone is equally welcome.",
    eventDescription: "Notice evening light, neighborhood details, and everyday life on a relaxed first-timer-friendly walk.",
    eventTitle: "Tokyo Afterglow · Sumida Walk",
    groupDescriptions: [
      "Each month we choose a Tokyo neighborhood for an unhurried walk through its light, architecture, and everyday life.",
      "Explore bookshops, coffee rooms, and quiet lanes at an easy pace, then share where the group should wander next.",
    ] as const,
    groupNames: ["Tokyo Slow Walks & City Light", "Jimbocho Books & Coffee Walks"] as const,
    groupUpdates: ["September riverside route and meeting notes", "Vote for our next bookshop route"] as const,
    groupsHeading: "Interest groups",
    host: "Tokyo Afterglow Walks",
    secondArea: "Near Jimbocho Station",
    secondDescription: "Visit independent bookshops and quiet coffee rooms, then trade recommendations from recent reading.",
    secondTitle: "Jimbocho Books & Coffee Walk",
    discoverHeading: "Find events you genuinely want to join",
  }),
});

export function marketingCaptureFixture(locale: Locale) {
  const copy = copyByLocale[locale];
  const primary = eventSummary(locale, copy, {
    id: "019b0000-0000-7000-8300-000000000001",
    publicSlug: "tokyo-afterglow-sumida-walk",
  });
  const secondary = eventSummary(locale, copy, {
    id: "019b0000-0000-7000-8300-000000000002",
    publicArea: copy.secondArea,
    publicSlug: "jimbocho-books-coffee-walk",
    startsAt: "2036-09-19T01:00:00.000Z",
    endsAt: "2036-09-19T03:00:00.000Z",
    deadlineAt: "2036-09-18T12:00:00.000Z",
    title: copy.secondTitle,
    description: copy.secondDescription,
    category: "learning",
    tags: ["learning", "small-group"],
    capacity: 14,
    confirmedCount: 8,
    availableCapacity: 6,
  });
  const detail: EventDetail = {
    ...primary,
    description: copy.detailDescription,
    attendeeRequirements: copy.detailRequirements,
    checkinMode: "manual",
    commentPermission: "participants",
    exactAddress: null,
    exactAddressVisibility: "confirmed",
    media: [],
    mediaCount: 0,
    organizerContact: null,
    posterEnabled: false,
    registrationQuestions: [],
    riskDetails: {},
    riskFlags: [],
  };
  const groups = groupFixtures(locale, copy);
  const feed: DiscoveryFeed = {
    generatedAt: "2026-07-22T12:00:00.000Z",
    moduleOrder: ["weekend"],
    modules: [{ key: "weekend", serverTitle: copy.discoverHeading, items: [primary, secondary] }],
    queryExplanationId: "marketing-capture-discovery-v1",
    serverTime: "2026-07-22T12:00:00.000Z",
  };

  return Object.freeze({
    copy,
    detail,
    discoveryFeed: feed,
    groups,
    forbiddenFixtureText: Object.values(copyByLocale)
      .filter((other) => other !== copy)
      .flatMap((other) => [
        other.eventTitle,
        other.secondTitle,
        ...other.groupNames,
        ...other.groupDescriptions,
        ...other.groupUpdates,
      ]),
  });
}

function eventSummary(
  locale: Locale,
  copy: FixtureCopy,
  overrides: Partial<EventSummary>,
): EventSummary {
  return {
    availableActions: ["register"],
    availableCapacity: 13,
    capacity: 24,
    category: "city-walk",
    confirmedCount: 11,
    coordinate: { latitude: 35.6812, longitude: 139.7976, precision: "approximate" },
    coverURL: null,
    deadlineAt: "2036-09-11T12:00:00.000Z",
    description: copy.eventDescription,
    displayTimeZone: "Asia/Tokyo",
    endsAt: "2036-09-12T10:30:00.000Z",
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
    id: "019b0000-0000-7000-8300-000000000001",
    localeConfirmed: true,
    organizer: {
      handle: "tokyo_afterglow",
      id: "019b0000-0000-7000-8300-000000000010",
      name: copy.host,
      trust: { attendanceRateBand: "90_plus", completedEventCount: 18, phoneVerified: true },
      viewerFollowing: false,
    },
    organizerId: "019b0000-0000-7000-8300-000000000010",
    primaryLocale: locale,
    publicArea: copy.area,
    publicSlug: "tokyo-afterglow-sumida-walk",
    region: "tokyo",
    registrationMode: "automatic",
    registrationStatus: null,
    startsAt: "2036-09-12T08:00:00.000Z",
    status: "published",
    supportedLocales: [locale],
    tags: ["photography", "first-timer-friendly"],
    title: copy.eventTitle,
    updatedAt: "2026-07-22T12:00:00.000Z",
    version: 4,
    viewerRegistration: null,
    waitlistEnabled: true,
    ...overrides,
  };
}

function groupFixtures(locale: Locale, copy: FixtureCopy): readonly GroupView[] {
  return copy.groupNames.map((name, index) => ({
    announcementSummary: [{
      authorName: copy.host,
      body: copy.groupDescriptions[index],
      commentCount: index + 2,
      commentsEnabled: true,
      createdAt: "2026-07-22T12:00:00.000Z",
      groupId: `019b0000-0000-7000-8400-00000000000${index + 1}`,
      id: `019b0000-0000-7000-8500-00000000000${index + 1}`,
      likeCount: 6 + index,
      pinnedAt: index === 0 ? "2026-07-22T12:00:00.000Z" : null,
      title: copy.groupUpdates[index],
      version: 2,
      viewerLiked: false,
      visibility: "public",
    }],
    availableActions: ["request_join"],
    capacity: index === 0 ? 48 : 36,
    categoryId: index === 0 ? "city-walk" : "learning",
    description: copy.groupDescriptions[index],
    id: `019b0000-0000-7000-8400-00000000000${index + 1}`,
    joinMode: index === 0 ? "approval" : "open",
    memberCount: index === 0 ? 32 : 21,
    name,
    owner: {
      handle: "tokyo_afterglow",
      id: "019b0000-0000-7000-8300-000000000010",
      name: copy.host,
    },
    ownerId: "019b0000-0000-7000-8300-000000000010",
    regionId: "tokyo",
    slug: index === 0 ? "tokyo-slow-walks" : "jimbocho-books-coffee-walks",
    status: "active",
    tags: index === 0
      ? ["city-walk", "photography", "easy-pace"]
      : ["learning", "small-group", "coffee"],
    version: 3,
  } satisfies GroupView));
}
