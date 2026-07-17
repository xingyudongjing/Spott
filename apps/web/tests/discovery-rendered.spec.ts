import { expect, test, type Page } from "@playwright/test";

const baseURL = process.env.SPOTT_WEB_BASE_URL ?? "http://127.0.0.1:3000";
const e2eMapStyleURL = `${baseURL}/__e2e-map-style.json`;
const emptyMapStyle = JSON.stringify({ version: 8, sources: {}, layers: [] });

const mobileViewports = [
  { width: 390, height: 844, latestEventTop: 330 },
  { width: 360, height: 800, latestEventTop: 360 },
] as const;

test.describe("rendered discovery safeguards", () => {
  test("keeps the Tokyo identity and language switcher usable on mobile and at 200 percent zoom", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/tokyo`);

    await expect(page.getByRole("heading", { level: 1, name: "东京，遇见真正想参加的活动" })).toBeVisible();
    const banner = page.getByRole("banner");
    const language = banner.getByRole("combobox", { name: "语言" });
    await expect(language).toBeVisible();
    const languageBox = await language.boundingBox();
    expect(languageBox?.width).toBeGreaterThanOrEqual(44);
    expect(languageBox?.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: testInfo.outputPath("tokyo-mobile-zh-Hans.png") });

    await language.selectOption("ja");
    await expect(page).toHaveURL(`${baseURL}/ja/tokyo`);
    await expect(page.getByRole("heading", { level: 1, name: "東京で、本当に参加したいイベントに出会う" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "ja");

    await banner.getByRole("combobox", { name: "言語" }).selectOption("en");
    await expect(page).toHaveURL(`${baseURL}/en/tokyo`);
    await expect(page.getByRole("heading", { level: 1, name: "Find Tokyo events you genuinely want to join" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");

    // A 1280 CSS-pixel desktop at 200% zoom has an effective layout width of 640px.
    await page.setViewportSize({ width: 640, height: 500 });
    await expect(page.getByRole("heading", { level: 1, name: "Find Tokyo events you genuinely want to join" })).toBeVisible();
    await expect(banner.getByRole("combobox", { name: "Language" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  });

  for (const viewport of mobileViewports) {
    test(`${viewport.width}x${viewport.height} exposes real results without overflow`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(`${baseURL}/discover`);

      const firstEvent = page.getByTestId("discovery-event").first();
      await expect(firstEvent).toBeVisible();
      const eventBox = await firstEvent.boundingBox();
      expect(eventBox?.y).toBeLessThanOrEqual(viewport.latestEventTop);

      const geometry = await page.evaluate(() => {
        const root = document.documentElement;
        const controls = [...document.querySelectorAll<HTMLElement>(
          "header a, header button, main button, main input, main select, nav a",
        )].filter((element) => {
          const bounds = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return bounds.width > 0
            && bounds.height > 0
            && style.display !== "none"
            && style.visibility !== "hidden";
        });
        return {
          overflowX: Math.max(0, root.scrollWidth - root.clientWidth),
          undersized: controls.map((element) => {
            const bounds = element.getBoundingClientRect();
            return {
              name: element.getAttribute("aria-label") ?? element.textContent?.trim() ?? element.tagName,
              width: bounds.width,
              height: bounds.height,
            };
          }).filter((control) => control.width < 44 || control.height < 44),
        };
      });

      expect(geometry.overflowX).toBe(0);
      expect(geometry.undersized).toEqual([]);
    });
  }

  test("initial SSR does not repeat discovery fetch and URL history restores filters", async ({ page }) => {
    const searchRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/v1/events/search")) searchRequests.push(request.url());
    });

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/discover`);
    await expect(page.getByTestId("discovery-event")).toHaveCount(3);
    expect(searchRequests).toEqual([]);

    await page.getByRole("button", { name: "只看有名额", exact: true }).click();
    await expect(page).toHaveURL(/availableOnly=true/);
    await expect.poll(() => searchRequests.length).toBe(1);

    await page.getByRole("searchbox", { name: "搜索活动", exact: true }).fill("Kiyosumi");
    await expect(page).toHaveURL(/q=Kiyosumi/);
    await expect(page.getByTestId("discovery-event")).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/discover`);
    await expect(page.getByRole("searchbox", { name: "搜索活动", exact: true })).toHaveValue("");
    await expect(page.getByTestId("discovery-event")).toHaveCount(3);

    await page.goForward();
    await expect(page).toHaveURL(/q=Kiyosumi.*availableOnly=true/);
    await expect(page.getByTestId("discovery-event")).toHaveCount(1);
  });

  test("mobile filter sheet restores focus and map markers open an actionable preview", async ({ page }, testInfo) => {
    await page.route(e2eMapStyleURL, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: emptyMapStyle,
    }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/discover`);

    const filterButton = page.getByRole("button", { name: "更多筛选", exact: true });
    await filterButton.click();
    const sheet = page.getByRole("dialog", { name: "更多筛选", exact: true });
    await expect(sheet).toBeVisible();
    await expect(page.getByLabel("开始日期", { exact: true })).toBeVisible();
    await expect(page.getByLabel("结束日期", { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("discovery-filter-sheet-mobile.png") });

    await sheet.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(filterButton).toBeFocused();

    await page.getByRole("button", { name: "地图", exact: true }).click();
    await clickRealMapMarker(page);
    await page.screenshot({ path: testInfo.outputPath("discovery-map-preview-mobile.png") });

    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`${baseURL}/discover`);
    await page.getByRole("button", { name: "地图", exact: true }).click();
    await clickRealMapMarker(page);
  });

  test("keeps Tokyo and discovery operable in forced-colors high-contrast mode", async ({ page }, testInfo) => {
    await page.emulateMedia({ forcedColors: "active", contrast: "more" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/tokyo`);

    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
    expect(await page.evaluate(() => matchMedia("(prefers-contrast: more)").matches)).toBe(true);
    await expect(page.getByRole("heading", { level: 1, name: "东京，遇见真正想参加的活动" })).toBeVisible();
    await expect(page.getByRole("banner").getByRole("combobox", { name: "语言" })).toBeVisible();
    await expect(page.getByTestId("discovery-event").first()).toBeVisible();

    await page.goto(`${baseURL}/discover`);
    const filterButton = page.getByRole("button", { name: "更多筛选", exact: true });
    await filterButton.click();
    const dialog = page.getByRole("dialog", { name: "更多筛选", exact: true });
    await expect(dialog).toBeVisible();
    const boundary = await dialog.evaluate((element) => getComputedStyle(element).borderColor);
    expect(boundary).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("discovery-forced-colors-mobile.png") });
  });

  test("invalid typed date ranges stay local, announce the field error, and never throw", async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/discover`);
    await page.getByRole("button", { name: "更多筛选", exact: true }).click();

    await page.getByLabel("开始日期", { exact: true }).fill("2026-08-03");
    await page.getByLabel("结束日期", { exact: true }).fill("2026-08-01");

    await expect(page.getByLabel("结束日期", { exact: true })).toHaveAttribute("aria-invalid", "true");
    await expect(page.getByText("结束日期不能早于开始日期。", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/startsAfter=2026-08-02T15%3A00%3A00\.000Z/);
    expect(new URL(page.url()).searchParams.has("startsBefore")).toBe(false);
    expect(pageErrors).toEqual([]);

    await page.getByLabel("结束日期", { exact: true }).fill("2026-08-05");
    await expect(page.getByLabel("结束日期", { exact: true })).toHaveAttribute("aria-invalid", "false");
    await expect(page.getByText("结束日期不能早于开始日期。", { exact: true })).toBeHidden();
    await expect(page).toHaveURL(/startsBefore=2026-08-05T15%3A00%3A00\.000Z/);
    expect(pageErrors).toEqual([]);
  });

  test("never stores root or cookie-personalized discovery documents in the public offline cache", async ({ page }) => {
    await page.goto(`${baseURL}/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.goto(`${baseURL}/discover`);

    await expect.poll(() => page.evaluate(async () => {
      const cacheNames = await caches.keys();
      const protectedDocuments = (
        await Promise.all(cacheNames.map(async (name) => {
          const cache = await caches.open(name);
          const entries = await Promise.all(["/", "/discover"].map(async (path) => (
            await cache.match(path, { ignoreVary: true }) ? `${name}:${path}` : null
          )));
          return entries.filter(Boolean);
        }))
      ).flat();
      return {
        hasCurrentCache: cacheNames.includes("spott-public-v8"),
        hasLegacyCache: cacheNames.some((name) => name.startsWith("spott-public-") && name !== "spott-public-v8"),
        protectedDocuments,
      };
    })).toEqual({
      hasCurrentCache: true,
      hasLegacyCache: false,
      protectedDocuments: [],
    });
  });

  test("uses a privacy-safe localized fallback for public and account navigation while offline", async ({ page, context }) => {
    await page.goto(`${baseURL}/en/tokyo`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await expect.poll(() => page.evaluate(async () => (
      await (await caches.open("spott-public-v8")).match("/__spott-locale__")
    )?.text())).toBe("en");

    await context.setOffline(true);
    try {
      await page.goto(`${baseURL}/me/events`);
      await expect(page.getByRole("heading", { level: 1, name: "You’re offline" })).toBeVisible();
      await expect(page.getByText(/Public event pages are not stored on this device/)).toBeVisible();
      await expect(page.getByRole("button", { name: "Retry connection" })).toBeVisible();
      await expect(page.getByRole("link", { name: "View cached events" })).toHaveCount(0);

      await page.goto(`${baseURL}/ja/tokyo`);
      await expect(page.getByRole("heading", { level: 1, name: "オフラインです" })).toBeVisible();
      await expect(page.getByRole("button", { name: "接続を再確認" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test("map style failure preserves results and offers retry or list mode", async ({ page }, testInfo) => {
    await page.route(e2eMapStyleURL, (route) => route.abort("failed"));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseURL}/discover`);
    await page.getByRole("button", { name: "地图", exact: true }).click();

    const fallback = page.locator('[role="alert"]').filter({ hasText: "地图暂时不可用" });
    await expect(fallback).toContainText("地图暂时不可用");
    await expect(page.getByTestId("discovery-event").first()).toBeVisible();
    await expect(fallback.getByRole("button", { name: "重试地图", exact: true })).toBeVisible();
    await expect(fallback.getByRole("button", { name: "查看列表", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("discovery-map-fallback-mobile.png") });

    await fallback.getByRole("button", { name: "重试地图", exact: true }).click();
    await expect(page.locator('[role="alert"]').filter({ hasText: "地图暂时不可用" })).toBeVisible();
    await page.locator('[role="alert"]').filter({ hasText: "地图暂时不可用" })
      .getByRole("button", { name: "查看列表", exact: true }).click();
    await expect(page.getByRole("button", { name: "列表", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("discovery-event").first()).toBeVisible();
  });
});

async function clickRealMapMarker(page: Page) {
  const markers = page.locator('button[aria-controls^="map-preview-"]');
  await expect(markers.first()).toBeVisible();
  const diagnostics = await markers.evaluateAll((elements) => elements.map((element) => {
    const marker = element.getBoundingClientRect();
    const map = element.closest('[role="region"]')?.getBoundingClientRect();
    const hit = document.elementFromPoint(marker.x + marker.width / 2, marker.y + marker.height / 2);
    return {
      width: marker.width,
      height: marker.height,
      contained: Boolean(map)
        && marker.left >= (map?.left ?? 0)
        && marker.top >= (map?.top ?? 0)
        && marker.right <= (map?.right ?? 0)
        && marker.bottom <= (map?.bottom ?? 0),
      hitTestable: hit === element || element.contains(hit),
    };
  }));

  expect(diagnostics.length).toBeGreaterThan(0);
  expect(diagnostics.every(({ width, height }) => width >= 44 && height >= 44)).toBe(true);
  expect(diagnostics.every(({ contained }) => contained)).toBe(true);
  const pointerIndex = diagnostics.findIndex(({ hitTestable }) => hitTestable);
  expect(pointerIndex).toBeGreaterThanOrEqual(0);
  await markers.nth(pointerIndex).click();

  const preview = page.getByRole("region", { name: /活动预览$/ });
  await expect(preview).toBeVisible();
  await expect(preview.getByRole("link", { name: "查看活动详情", exact: true })).toHaveAttribute("href", /^\/e\//);

  const keyboardMarker = markers.nth(pointerIndex === 0 && diagnostics.length > 1 ? 1 : 0);
  await keyboardMarker.focus();
  await expect(keyboardMarker).toBeFocused();
  await keyboardMarker.press("Enter");
  await expect(page.getByRole("region", { name: /活动预览$/ })).toBeVisible();
}
