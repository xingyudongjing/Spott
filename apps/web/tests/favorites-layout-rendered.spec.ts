import { expect, test } from "@playwright/test";

const baseURL = process.env.SPOTT_WEB_BASE_URL ?? "http://127.0.0.1:3000";

test.use({ channel: process.env.SPOTT_PLAYWRIGHT_CHANNEL });

const favoriteEvent = {
  id: "019b0000-0000-7000-8100-000000000091",
  publicSlug: "favorite-layout-contract",
  organizerId: "019b0000-0000-7000-8100-000000000092",
  status: "published",
  title: "收藏活动卡片不应逐字竖排",
  description: "用于验证收藏页复用的活动卡在窄容器内仍然可读。",
  category: "music",
  startsAt: "2026-08-31T10:00:00.000Z",
  endsAt: "2026-08-31T12:00:00.000Z",
  deadlineAt: "2026-08-31T09:00:00.000Z",
  displayTimeZone: "Asia/Tokyo",
  region: "tokyo",
  publicArea: "下北沢",
  capacity: 20,
  confirmedCount: 9,
  availableCapacity: 11,
  fee: {
    isFree: true,
    amountJPY: null,
    collectorName: null,
    method: null,
    paymentDeadlineText: null,
    refundPolicy: null,
  },
  coverURL: null,
  tags: ["music", "listening"],
  organizer: {
    id: "019b0000-0000-7000-8100-000000000092",
    name: "Shimokita Listening Table",
    handle: "shimokita_listening",
    viewerFollowing: false,
    trust: {
      phoneVerified: true,
      completedEventCount: 4,
      attendanceRateBand: "90_plus",
    },
  },
  favorited: true,
  registrationStatus: null,
  viewerRegistration: null,
  registrationMode: "automatic",
  waitlistEnabled: true,
  format: "in_person",
  primaryLocale: "ja",
  supportedLocales: ["ja", "zh-Hans"],
  localeConfirmed: true,
  groupId: null,
  availableActions: ["register", "unfavorite"],
  version: 1,
  updatedAt: "2026-07-19T00:00:00.000Z",
  coordinate: { latitude: 35.6616, longitude: 139.6681, precision: "approximate" },
};

test("1440x1000 keeps the favorites event card readable in the shared grid contract", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "spott_locale", value: "zh-Hans", url: baseURL }]);
  const page = await context.newPage();
  const origin = new URL(baseURL).origin;

  await page.route("**/api/session/bootstrap", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      state: "authenticated",
      accessToken: "rendered-layout-access-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      refreshGeneration: 1,
      sessionId: "019b0000-0000-7000-8100-000000000093",
      user: {
        id: "019b0000-0000-7000-8100-000000000094",
        publicHandle: "layout_tester",
        phoneVerified: true,
        restrictions: [],
      },
    }),
  }));
  await page.route("**/v1/me/favorite-events", (route) => {
    const corsHeaders = {
      "Access-Control-Allow-Headers": "Accept, Authorization, X-Spott-Device-Id",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Origin": origin,
      "Content-Type": "application/json",
    };
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({ status: 204, headers: corsHeaders });
    }
    return route.fulfill({
      status: 200,
      headers: corsHeaders,
      body: JSON.stringify({ items: [favoriteEvent] }),
    });
  });

  await page.goto(`${baseURL}/me/favorites`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { level: 1, name: "我的收藏" })).toBeVisible();
  await expect(page.getByTestId("discovery-event")).toHaveCount(1);

  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const card = document.querySelector<HTMLElement>('[data-testid="discovery-event"]');
    const link = card?.querySelector<HTMLAnchorElement>("a");
    const body = link?.children.item(1) as HTMLElement | null;
    const title = card?.querySelector<HTMLElement>("h3");
    if (!card || !body || !title) throw new Error("A rendered favorite event card is required");
    return {
      cardHeight: card.getBoundingClientRect().height,
      bodyWidth: body.getBoundingClientRect().width,
      titleWidth: title.getBoundingClientRect().width,
      overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
    };
  });
  expect(geometry.cardHeight).toBeLessThanOrEqual(520);
  expect(geometry.bodyWidth).toBeGreaterThanOrEqual(150);
  expect(geometry.titleWidth).toBeGreaterThanOrEqual(140);
  expect(geometry.overflowX).toBe(0);
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("favorites-event-card-desktop.png"),
  });
  await context.close();
});
