import { expect, test } from "@playwright/test";

const baseURL = process.env.SPOTT_WEB_BASE_URL ?? "http://127.0.0.1:3000";

test.use({ channel: "chrome" });

const mobileViewports = [
  { width: 390, height: 844, latestEventTop: 330 },
  { width: 360, height: 800, latestEventTop: 360 },
] as const;

test.describe("rendered discovery safeguards", () => {
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

    await page.getByRole("searchbox", { name: "搜索活动", exact: true }).fill("黑胶");
    await expect(page).toHaveURL(/q=%E9%BB%91%E8%83%B6/);
    await expect(page.getByTestId("discovery-event")).toHaveCount(1);

    await page.goBack();
    await expect(page).toHaveURL(`${baseURL}/discover`);
    await expect(page.getByRole("searchbox", { name: "搜索活动", exact: true })).toHaveValue("");
    await expect(page.getByTestId("discovery-event")).toHaveCount(3);

    await page.goForward();
    await expect(page).toHaveURL(/q=%E9%BB%91%E8%83%B6.*availableOnly=true/);
    await expect(page.getByTestId("discovery-event")).toHaveCount(1);
  });

  test("mobile filter sheet restores focus and map markers open an actionable preview", async ({ page }, testInfo) => {
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
    const marker = page.locator('button[aria-controls^="map-preview-"]').first();
    await expect(marker).toBeVisible();
    const markerBox = await marker.boundingBox();
    expect(markerBox?.width).toBeGreaterThanOrEqual(44);
    expect(markerBox?.height).toBeGreaterThanOrEqual(44);
    await marker.click();

    const preview = page.getByRole("region", { name: /活动预览$/ });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("link", { name: "查看活动详情", exact: true })).toHaveAttribute("href", /^\/e\//);
    await page.screenshot({ path: testInfo.outputPath("discovery-map-preview-mobile.png") });
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
        hasCurrentCache: cacheNames.includes("spott-public-v4"),
        hasLegacyCache: cacheNames.some((name) => name.startsWith("spott-public-") && name !== "spott-public-v4"),
        protectedDocuments,
      };
    })).toEqual({
      hasCurrentCache: true,
      hasLegacyCache: false,
      protectedDocuments: [],
    });
  });

  test("map style failure preserves results and offers retry or list mode", async ({ page }, testInfo) => {
    await page.route("http://127.0.0.1:4201/**", (route) => route.abort("failed"));
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
