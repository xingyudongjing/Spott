import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.SPOTT_WEB_BASE_URL ?? "http://127.0.0.1:3000";
const groupsAPIProxy = process.env.SPOTT_GROUPS_API_PROXY;

test.use({ channel: process.env.SPOTT_PLAYWRIGHT_CHANNEL });

const locales = [
  { cookie: "zh-Hans", lang: "zh-Hans", screenshot: "zh-Hans" },
  { cookie: "ja", lang: "ja", screenshot: "ja" },
  { cookie: "en", lang: "en", screenshot: "en" },
] as const;

async function proxyPublicAPI(page: Page) {
  if (!groupsAPIProxy) return;
  await page.route("**/v1/**", async (route) => {
    const requestURL = new URL(route.request().url());
    const upstream = await fetch(`${groupsAPIProxy}${requestURL.pathname}${requestURL.search}`);
    await route.fulfill({
      status: upstream.status,
      contentType: upstream.headers.get("content-type") ?? "application/json",
      body: await upstream.text(),
    });
  });
}

async function eventCardGeometry(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const card = document.querySelector<HTMLElement>('[data-testid="discovery-event"]');
    const link = card?.querySelector<HTMLAnchorElement>("a");
    const body = link?.children.item(1) as HTMLElement | null;
    const title = card?.querySelector<HTMLElement>("h3");
    if (!card || !link || !body || !title) {
      throw new Error("A rendered event card with a title and body is required");
    }
    const cardBounds = card.getBoundingClientRect();
    const bodyBounds = body.getBoundingClientRect();
    const titleBounds = title.getBoundingClientRect();
    return {
      cardWidth: cardBounds.width,
      cardHeight: cardBounds.height,
      bodyWidth: bodyBounds.width,
      titleWidth: titleBounds.width,
      overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
    };
  });
}

function expectReadableEventCard(
  geometry: Awaited<ReturnType<typeof eventCardGeometry>>,
  label: string,
) {
  expect(geometry.cardWidth, `${label}: card width`).toBeGreaterThanOrEqual(300);
  expect(geometry.cardHeight, `${label}: card height`).toBeLessThanOrEqual(520);
  expect(geometry.bodyWidth, `${label}: body width`).toBeGreaterThanOrEqual(150);
  expect(geometry.titleWidth, `${label}: title width`).toBeGreaterThanOrEqual(140);
  expect(geometry.overflowX, `${label}: horizontal overflow`).toBe(0);
}

test("1440x1000 keeps the group event card readable inside the three-column grid", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "zh-Hans", url: baseURL }]);
  const page = await context.newPage();
  await proxyPublicAPI(page);

  await page.goto(`${baseURL}/g/shimokita-one-record`, { waitUntil: "domcontentloaded" });
  await expect(page).toHaveTitle(/Spott/u);
  await expect(page.getByRole("heading", { level: 1, name: "下北沢一枚聴く会" })).toBeVisible();
  await expect(page.getByTestId("discovery-event")).toHaveCount(1);

  expectReadableEventCard(await eventCardGeometry(page), "desktop group detail");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("group-event-card-desktop.png"),
  });
  await page.getByTestId("discovery-event").getByRole("link").click();
  await expect(page).toHaveURL(`${baseURL}/e/shimokita-vinyl-preview`);
  await context.close();
});

test("390x844 preserves the compact group event card without horizontal overflow", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "zh-Hans", url: baseURL }]);
  const page = await context.newPage();
  await proxyPublicAPI(page);

  await page.goto(`${baseURL}/g/shimokita-one-record`, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("discovery-event")).toHaveCount(1);

  expectReadableEventCard(await eventCardGeometry(page), "mobile group detail");
  await page.screenshot({
    fullPage: true,
    path: testInfo.outputPath("group-event-card-mobile.png"),
  });
  await context.close();
});

test("390x844 keeps a meaningful part of the first community card above the mobile dock in every locale", async ({ browser }, testInfo) => {
  for (const locale of locales) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
    });
    await context.addCookies([{ name: "spott_locale", value: locale.cookie, url: baseURL }]);
    const page = await context.newPage();
    const consoleIssues: string[] = [];

    if (groupsAPIProxy) {
      await page.route("**/v1/groups?**", async (route) => {
        const requestURL = new URL(route.request().url());
        const upstream = await fetch(`${groupsAPIProxy}${requestURL.pathname}${requestURL.search}`);
        await route.fulfill({
          status: upstream.status,
          contentType: upstream.headers.get("content-type") ?? "application/json",
          body: await upstream.text(),
        });
      });
    }

    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        consoleIssues.push(`${message.type()}: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));

    await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", locale.lang);
    await expect(page.locator(".group-search-field input")).toBeVisible();
    await expect(page.locator(".group-category-rail button").first()).toBeVisible();
    await expect(page.locator(".group-tile").first()).toBeVisible();
    await expect.poll(
      () => page.locator(".mobile-dock").evaluate((dock) => getComputedStyle(dock.parentElement!).filter),
      { timeout: 10_000 },
    ).toBe("none");

    const geometry = await page.evaluate(() => {
      const firstCard = document.querySelector<HTMLElement>(".group-tile")?.getBoundingClientRect();
      const dock = document.querySelector<HTMLElement>(".mobile-dock")?.getBoundingClientRect();
      const root = document.documentElement;
      if (!firstCard || !dock) throw new Error("The first community card and mobile dock must both render");
      return {
        firstCardTop: firstCard.top,
        visibleBeforeDock: dock.top - firstCard.top,
        overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
      };
    });

    expect(geometry.firstCardTop, `${locale.lang}: first card top`).toBeLessThanOrEqual(620);
    expect(geometry.visibleBeforeDock, `${locale.lang}: visible card area before dock`).toBeGreaterThanOrEqual(140);
    expect(geometry.overflowX, `${locale.lang}: horizontal overflow`).toBe(0);
    expect(consoleIssues, `${locale.lang}: browser console`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`groups-mobile-${locale.screenshot}.png`) });
    await context.close();
  }
});
