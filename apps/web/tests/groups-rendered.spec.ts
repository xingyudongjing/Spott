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
      headers: { "access-control-allow-origin": "*" },
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

async function groupDirectoryFirstFoldGeometry(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const firstCard = document.querySelector<HTMLElement>(".group-tile");
    const artwork = firstCard?.querySelector<HTMLElement>(".group-artwork");
    const title = firstCard?.querySelector<HTMLElement>("h2");
    const facts = firstCard?.querySelector<HTMLElement>(".group-tile-meta");
    const dock = document.querySelector<HTMLElement>(".mobile-dock");
    if (!firstCard || !artwork || !title || !facts) {
      throw new Error("The first community card must render artwork, title, and key facts");
    }
    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height };
    };
    return {
      artwork: bounds(artwork),
      card: bounds(firstCard),
      dock: dock ? bounds(dock) : null,
      facts: bounds(facts),
      title: bounds(title),
      overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
      viewportHeight: window.innerHeight,
    };
  });
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
          headers: { "access-control-allow-origin": "*" },
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

    const geometry = await groupDirectoryFirstFoldGeometry(page);
    expect(geometry.dock, `${locale.lang}: mobile dock`).not.toBeNull();
    const dockTop = geometry.dock?.top ?? geometry.viewportHeight;
    expect(geometry.card.top, `${locale.lang}: first card top`).toBeLessThanOrEqual(540);
    expect(geometry.artwork.height, `${locale.lang}: artwork height`).toBeLessThanOrEqual(150);
    expect(geometry.title.bottom, `${locale.lang}: title above dock`).toBeLessThanOrEqual(dockTop - 8);
    expect(geometry.facts.bottom, `${locale.lang}: key facts above dock`).toBeLessThanOrEqual(dockTop - 8);
    expect(geometry.overflowX, `${locale.lang}: horizontal overflow`).toBe(0);
    expect(consoleIssues, `${locale.lang}: browser console`).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`groups-mobile-${locale.screenshot}.png`) });
    await context.close();
  }
});

test("390x844 keeps community discovery controls touchable and key facts readable", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "en", url: baseURL }]);
  const page = await context.newPage();
  await proxyPublicAPI(page);
  await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".group-tile").first()).toBeVisible();

  const geometry = await page.evaluate(() => {
    const search = document.querySelector<HTMLElement>(".group-search-field input")?.getBoundingClientRect();
    const categoryButtons = Array.from(document.querySelectorAll<HTMLElement>(".group-category-rail button"));
    const facts = document.querySelector<HTMLElement>(".group-tile-meta");
    if (!search || !categoryButtons.length || !facts) {
      throw new Error("Community controls and key facts must render");
    }
    return {
      searchHeight: search.height,
      minimumCategoryHeight: Math.min(...categoryButtons.map((button) => button.getBoundingClientRect().height)),
      factsFontSize: Number.parseFloat(getComputedStyle(facts).fontSize),
    };
  });

  expect(geometry.searchHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.minimumCategoryHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.factsFontSize).toBeGreaterThanOrEqual(11);
  await context.close();
});

test("390x844 keeps a wrapped community title and key facts above the mobile dock", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "en", url: baseURL }]);
  const page = await context.newPage();
  await page.route("**/v1/groups?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({
      items: [{
        id: "long-title-community",
        ownerId: "long-title-owner",
        owner: { id: "long-title-owner", name: "Tokyo Neighbours", handle: "tokyo-neighbours" },
        name: "Tokyo Neighbourhood Photo Walks and Slow Coffee Circle",
        slug: "tokyo-neighbourhood-photo-walks",
        description: "A welcoming local circle for slow walks, photography, and unhurried conversation.",
        coverURL: null,
        joinMode: "approval",
        regionId: "tokyo",
        categoryId: "photography",
        tags: ["photography", "city-walk"],
        rules: "Be kind.",
        capacity: 100,
        memberCount: 28,
        status: "active",
        membershipStatus: null,
        membershipRole: null,
        viewerFollowing: false,
        announcementSummary: [],
        closingAt: null,
        dissolveAfter: null,
        availableActions: ["joinGroup"],
        version: 1,
        updatedAt: "2026-07-19T00:00:00.000Z",
      }],
    }),
  }));

  await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".group-tile").first()).toBeVisible();
  await expect.poll(
    () => page.locator(".mobile-dock").evaluate((dock) => getComputedStyle(dock.parentElement!).filter),
    { timeout: 10_000 },
  ).toBe("none");
  const geometry = await groupDirectoryFirstFoldGeometry(page);
  expect(geometry.dock, "mobile dock").not.toBeNull();
  const dockTop = geometry.dock?.top ?? geometry.viewportHeight;
  expect(dockTop, "mobile dock inside viewport").toBeLessThan(geometry.viewportHeight);
  expect(geometry.title.height, "long title wraps onto multiple lines").toBeGreaterThan(40);
  expect(geometry.title.bottom, "long title above dock").toBeLessThanOrEqual(dockTop - 8);
  expect(geometry.facts.bottom, "key facts after long title above dock").toBeLessThanOrEqual(dockTop - 8);
  expect(geometry.overflowX).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("groups-mobile-long-title.png") });
  await context.close();
});

test("1440x1000 reveals the first community title and key facts without scrolling in every locale", async ({ browser }, testInfo) => {
  for (const locale of locales) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
    });
    await context.addCookies([{ name: "spott_locale", value: locale.cookie, url: baseURL }]);
    const page = await context.newPage();
    await proxyPublicAPI(page);

    await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", locale.lang);
    await expect(page.locator(".group-tile").first()).toBeVisible();

    const geometry = await groupDirectoryFirstFoldGeometry(page);
    expect(geometry.card.top, `${locale.lang}: first card top`).toBeLessThanOrEqual(600);
    expect(geometry.artwork.height, `${locale.lang}: artwork height`).toBeLessThanOrEqual(235);
    expect(geometry.title.bottom, `${locale.lang}: title in first viewport`).toBeLessThanOrEqual(geometry.viewportHeight - 12);
    expect(geometry.facts.bottom, `${locale.lang}: key facts in first viewport`).toBeLessThanOrEqual(geometry.viewportHeight - 12);
    expect(geometry.overflowX, `${locale.lang}: horizontal overflow`).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`groups-desktop-${locale.screenshot}.png`) });
    await context.close();
  }
});

test("empty directory keeps its primary action clear of the fixed mobile dock", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "zh-Hans", url: baseURL }]);
  const page = await context.newPage();
  await page.route("**/v1/groups?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ items: [] }),
  }));

  await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
  const cta = page.locator(".empty-state .primary-action");
  await expect(cta).toBeVisible();
  const geometry = await page.evaluate(() => {
    const action = document.querySelector<HTMLElement>(".empty-state .primary-action")?.getBoundingClientRect();
    const dock = document.querySelector<HTMLElement>(".mobile-dock")?.getBoundingClientRect();
    if (!action || !dock) throw new Error("The empty-state action and mobile dock must both render");
    return {
      actionBottom: action.bottom,
      dockTop: dock.top,
      overflowX: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
    };
  });
  expect(geometry.actionBottom).toBeLessThanOrEqual(geometry.dockTop - 12);
  expect(geometry.overflowX).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("groups-empty-mobile.png") });
  await context.close();
});

test("keyboard focus gives community search a clear branded focus ring", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "en", url: baseURL }]);
  const page = await context.newPage();
  await proxyPublicAPI(page);
  await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
  const search = page.locator(".group-search-field input");
  await expect(search).toBeVisible();
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("Tab");
    if (await search.evaluate((input) => document.activeElement === input)) break;
  }
  await expect(search).toBeFocused();

  const focusStyle = await page.locator(".group-search-field").evaluate((field) => {
    const style = getComputedStyle(field);
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      shadow: style.boxShadow,
    };
  });
  expect(focusStyle.outlineStyle).toBe("solid");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focusStyle.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(focusStyle.shadow).not.toBe("none");
  await page.screenshot({ path: testInfo.outputPath("groups-search-keyboard-focus.png") });
  await context.close();
});

test("forced colors keeps the community search focus outline visible without a shadow", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    forcedColors: "active",
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "en", url: baseURL }]);
  const page = await context.newPage();
  await proxyPublicAPI(page);
  await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
  const search = page.locator(".group-search-field input");
  await expect(search).toBeVisible();
  await search.focus();

  const focusStyle = await page.locator(".group-search-field").evaluate((field) => {
    const style = getComputedStyle(field);
    return {
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      shadow: style.boxShadow,
    };
  });
  expect(focusStyle.outlineStyle).toBe("solid");
  expect(focusStyle.outlineWidth).toBeGreaterThanOrEqual(2);
  expect(focusStyle.outlineColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(focusStyle.shadow).toBe("none");
  await context.close();
});

test("reduced motion keeps the compact directory stable without decorative movement", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  await context.addCookies([{ name: "spott_locale", value: "ja", url: baseURL }]);
  const page = await context.newPage();
  await proxyPublicAPI(page);
  await page.goto(`${baseURL}/groups`, { waitUntil: "domcontentloaded" });
  await expect(page.locator(".group-tile").first()).toBeVisible();
  const motion = await page.locator(".group-tile").first().evaluate((tile) => ({
    animationDuration: getComputedStyle(tile).animationDuration,
    transitionDuration: getComputedStyle(tile).transitionDuration,
  }));
  expect(Number.parseFloat(motion.animationDuration)).toBeLessThanOrEqual(0.01);
  expect(Number.parseFloat(motion.transitionDuration)).toBeLessThanOrEqual(0.01);
  expect((await groupDirectoryFirstFoldGeometry(page)).overflowX).toBe(0);
  await context.close();
});
