import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const baseURL = process.env.SPOTT_WEB_BASE_URL ?? "http://127.0.0.1:3240";
const publicAPI = process.env.SPOTT_GROUPS_API_PROXY ?? "http://18.178.203.117/v1";

test.use({ channel: process.env.SPOTT_PLAYWRIGHT_CHANNEL });

const locales = [
  {
    cookie: "zh-Hans",
    lang: "zh-Hans",
    nav: "社群内容导航",
    owner: "主办方",
    comments: /0 评论/u,
    commentsEmpty: "还没有第一条评论。",
    commentsError: "评论暂时无法加载。",
    retry: "重试评论",
  },
  {
    cookie: "ja",
    lang: "ja",
    nav: "コミュニティ内ナビゲーション",
    owner: "主催者",
    comments: /コメント 0件/u,
    commentsEmpty: "最初のコメントはまだありません。",
    commentsError: "コメントを読み込めませんでした。",
    retry: "コメントを再読み込み",
  },
  {
    cookie: "en",
    lang: "en",
    nav: "Community sections",
    owner: "Host",
    comments: /0 comments/u,
    commentsEmpty: "No comments yet.",
    commentsError: "Comments could not be loaded.",
    retry: "Retry comments",
  },
] as const;

async function createReadOnlyPage(
  context: BrowserContext,
  locale: (typeof locales)[number],
  options: { failFirstComments?: boolean; firstCommentsDelayMs?: number; longGroup?: boolean } = {},
) {
  await context.addCookies([{ name: "spott_locale", value: locale.cookie, url: baseURL }]);
  const page = await context.newPage();
  const consoleIssues: string[] = [];
  const requestMethods: string[] = [];
  let commentAttempts = 0;

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleIssues.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => consoleIssues.push(`pageerror: ${error.message}`));
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const requestURL = new URL(request.url());
    requestMethods.push(request.method());
    const isComments = /\/groups\/[^/]+\/announcements\/[^/]+\/comments$/u.test(requestURL.pathname);
    if (isComments && options.failFirstComments && commentAttempts++ === 0) {
      if (options.firstCommentsDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, options.firstCommentsDelayMs));
      }
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        headers: { "access-control-allow-origin": "*" },
        body: JSON.stringify({ code: "COMMENTS_TEMPORARILY_UNAVAILABLE" }),
      });
      return;
    }

    const upstream = await fetch(`${publicAPI}${requestURL.pathname.replace(/^\/v1/u, "")}${requestURL.search}`);
    let body = await upstream.text();
    if (options.longGroup && requestURL.pathname.endsWith("/groups/shimokita-one-record")) {
      const payload = JSON.parse(body) as Record<string, unknown>;
      payload.name = "下北沢で一枚のレコードを最後まで聴きながら、世代や言語を越えて静かに感想を分かち合う小さなテーブルの会";
      payload.rules = "録音・配信・営業目的の参加はご遠慮ください。".repeat(16);
      body = JSON.stringify(payload);
    }
    await route.fulfill({
      status: upstream.status,
      contentType: upstream.headers.get("content-type") ?? "application/json",
      headers: { "access-control-allow-origin": "*" },
      body,
    });
  });

  return { page, consoleIssues, requestMethods };
}

async function mobileFirstFold(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const heading = document.querySelector<HTMLElement>("h1#group-title");
    const hero = heading?.closest<HTMLElement>("section");
    const facts = hero?.querySelector<HTMLElement>("ul");
    const owner = hero?.querySelector<HTMLElement>('a[href^="/u/"]');
    const highlight = hero?.querySelector<HTMLElement>('a[href^="/e/"], a[href="#discussion"]');
    const dock = document.querySelector<HTMLElement>(".mobile-dock");
    if (!heading || !hero || !facts || !owner || !highlight || !dock) {
      throw new Error("The mobile detail must expose heading, owner, facts, highlight, and dock");
    }
    const bounds = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: rect.height, width: rect.width };
    };
    return {
      dock: bounds(dock),
      facts: bounds(facts),
      heading: bounds(heading),
      highlight: bounds(highlight),
      owner: bounds(owner),
      overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
    };
  });
}

test("390x844 keeps identity, host, access facts, and the next gathering above the mobile dock in every locale", async ({ browser }, testInfo) => {
  for (const locale of locales) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
    });
    const { page, consoleIssues, requestMethods } = await createReadOnlyPage(context, locale);

    await page.goto(`${baseURL}/g/shimokita-one-record`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("html")).toHaveAttribute("lang", locale.lang);
    await expect(page.getByRole("heading", { level: 1, name: "下北沢一枚聴く会" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: locale.nav })).toBeVisible();
    await expect(page.getByRole("link", { name: "Shimokita Listening Table", exact: true })).toHaveAttribute(
      "href",
      "/u/spott_preview_weekend",
    );
    await expect(page.getByTestId("discovery-event")).toHaveCount(1);

    const geometry = await mobileFirstFold(page);
    expect(geometry.heading.bottom).toBeLessThan(geometry.dock.top);
    expect(geometry.owner.bottom).toBeLessThan(geometry.dock.top);
    expect(geometry.owner.height).toBeGreaterThanOrEqual(44);
    expect(geometry.facts.bottom).toBeLessThan(geometry.dock.top);
    expect(geometry.highlight.bottom).toBeLessThanOrEqual(geometry.dock.top - 8);
    expect(geometry.overflowX).toBe(0);
    expect(requestMethods.every((method) => method === "GET")).toBe(true);
    expect(consoleIssues).toEqual([]);

    await page.screenshot({
      path: testInfo.outputPath(`group-detail-mobile-${locale.cookie}.png`),
      fullPage: false,
    });
    await context.close();
  }
});

test("1440x1000 uses a readable event column and a real community sidebar", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  const locale = locales[2];
  const { page, consoleIssues, requestMethods } = await createReadOnlyPage(context, locale);

  await page.goto(`${baseURL}/g/shimokita-one-record`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "About this community" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Community guidelines" })).toBeVisible();
  await expect(page.getByText("音楽の知識は問いません。録音・配信・営業目的の参加はご遠慮ください。盤と互いの好みを丁寧に扱いましょう。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "下北沢 Listening Table · 一枚を聴く夜" })).toBeVisible();

  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const eventSection = document.getElementById("events");
    const eventCard = document.querySelector<HTMLElement>('[data-testid="discovery-event"]');
    const about = document.getElementById("about")?.closest<HTMLElement>("aside");
    if (!eventSection || !eventCard || !about) throw new Error("Desktop content columns are required");
    const eventBounds = eventSection.getBoundingClientRect();
    const cardBounds = eventCard.getBoundingClientRect();
    const aboutBounds = about.getBoundingClientRect();
    return {
      aboutLeft: aboutBounds.left,
      aboutWidth: aboutBounds.width,
      cardWidth: cardBounds.width,
      eventLeft: eventBounds.left,
      eventRight: eventBounds.right,
      overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
    };
  });
  expect(geometry.cardWidth).toBeGreaterThanOrEqual(640);
  expect(geometry.aboutWidth).toBeGreaterThanOrEqual(280);
  expect(geometry.aboutLeft).toBeGreaterThan(geometry.eventRight);
  expect(geometry.eventLeft).toBeGreaterThanOrEqual(80);
  expect(geometry.overflowX).toBe(0);
  expect(requestMethods.every((method) => method === "GET")).toBe(true);
  expect(consoleIssues).toEqual([]);

  await page.screenshot({ path: testInfo.outputPath("group-detail-desktop-en.png"), fullPage: true });
  await context.close();
});

test("discussion is keyboard reachable and comment failure stays expanded until a successful retry", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    forcedColors: "active",
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  const locale = locales[2];
  const { page, consoleIssues, requestMethods } = await createReadOnlyPage(context, locale, {
    failFirstComments: true,
    firstCommentsDelayMs: 250,
  });

  await page.goto(`${baseURL}/g/shimokita-one-record`, { waitUntil: "domcontentloaded" });
  const discussionLink = page.getByRole("navigation", { name: locale.nav }).getByRole("link", { name: "Discussion" });
  await discussionLink.focus();
  const focus = await discussionLink.evaluate((element) => {
    const style = getComputedStyle(element);
    return { outlineStyle: style.outlineStyle, outlineWidth: Number.parseFloat(style.outlineWidth) };
  });
  expect(focus.outlineStyle).toBe("solid");
  expect(focus.outlineWidth).toBeGreaterThanOrEqual(3);
  await discussionLink.press("Enter");
  await expect(page).toHaveURL(/#discussion$/u);

  const highlightMotion = await page
    .locator('section[aria-labelledby="group-title"] a[href^="/e/"]')
    .evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        durationSeconds: Number.parseFloat(style.transitionDuration),
        transform: style.transform,
      };
    });
  expect(highlightMotion.transform).toBe("none");
  expect(highlightMotion.durationSeconds).toBeLessThanOrEqual(0.001);

  const toggle = page.getByRole("button", { name: locale.comments });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const loadingStatus = page.locator("#discussion").getByRole("status");
  await expect(loadingStatus).toBeVisible();
  const spinnerMotion = await loadingStatus.locator('span[aria-hidden="true"]').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      durationSeconds: Number.parseFloat(style.animationDuration),
      iterationCount: style.animationIterationCount,
    };
  });
  expect(spinnerMotion.durationSeconds).toBeLessThanOrEqual(0.001);
  expect(spinnerMotion.iterationCount).toBe("1");
  await expect(page.getByText(locale.commentsError)).toBeVisible();
  await page.getByRole("button", { name: locale.retry }).click();
  await expect(page.getByText(locale.commentsEmpty)).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");

  const touchTarget = await toggle.evaluate((element) => element.getBoundingClientRect().height);
  expect(touchTarget).toBeGreaterThanOrEqual(44);
  expect(requestMethods.every((method) => method === "GET")).toBe(true);
  expect(consoleIssues).toHaveLength(1);
  expect(consoleIssues[0]).toContain("503 (Service Unavailable)");
  await page.screenshot({ path: testInfo.outputPath("group-detail-comments-retried-forced-colors.png") });
  await context.close();
});

test("long community content wraps without horizontal overflow", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
    extraHTTPHeaders: { "x-spott-preview-mode": "read-only" },
  });
  const { page, consoleIssues } = await createReadOnlyPage(context, locales[1], { longGroup: true });

  await page.goto(`${baseURL}/g/shimokita-one-record`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("h1#group-title")).toContainText("下北沢で一枚のレコード");
  await page.getByRole("navigation", { name: locales[1].nav }).getByRole("link", { name: "概要" }).click();
  const overflowX = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
  expect(overflowX).toBe(0);
  expect(consoleIssues).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("group-detail-mobile-long-content.png"), fullPage: true });
  await context.close();
});
