import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";

test("two real browser tabs rotate one shared refresh predecessor exactly once", async ({
  context,
  page,
}) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/internal-e2e\/session-coordination$/u);
  await expect(page.getByTestId("session-coordination-state")).toHaveText("authenticated");

  const second = await context.newPage();
  await second.goto("/internal-e2e/session-coordination");
  await expect(second.getByTestId("session-coordination-state")).toHaveText("authenticated");

  const firstGeneration = Number(
    await page.getByTestId("session-coordination-generation").textContent(),
  );
  expect(Number.isSafeInteger(firstGeneration)).toBe(true);
  await expect(second.getByTestId("session-coordination-generation"))
    .toHaveText(String(firstGeneration));

  let refreshRequests = 0;
  context.on("request", (request) => {
    if (
      request.method() === "POST"
      && new URL(request.url()).pathname === "/api/session/refresh"
    ) refreshRequests += 1;
  });

  await Promise.all([
    page.getByRole("button", { name: "Coordinate refresh" }).click(),
    second.getByRole("button", { name: "Coordinate refresh" }).click(),
  ]);

  await expect(page.getByTestId("session-coordination-generation"))
    .toHaveText(String(firstGeneration + 1));
  await expect(second.getByTestId("session-coordination-generation"))
    .toHaveText(String(firstGeneration + 1));
  await expect(page.getByTestId("session-coordination-result")).toHaveText("refreshed");
  await expect(second.getByTestId("session-coordination-result")).toHaveText("refreshed");
  expect(refreshRequests).toBe(1);
});

test("a late refresh cannot restore a session after another tab starts logout", async ({
  context,
  page,
}) => {
  await signIn(page);
  const second = await authenticatedSecondTab(context);
  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let observeRefresh!: () => void;
  const refreshObserved = new Promise<void>((resolve) => { observeRefresh = resolve; });
  await context.route("**/api/session/refresh", async (route) => {
    observeRefresh();
    await refreshReleased;
    await route.continue();
  });

  try {
    await page.getByRole("button", { name: "Coordinate refresh" }).click();
    await refreshObserved;
    await second.getByRole("button", { name: "Log out current session" }).click();
    await expect(second.getByTestId("session-coordination-state")).toHaveText("anonymous");
  } finally {
    releaseRefresh();
  }
  await expect(second.getByTestId("session-coordination-result")).toHaveText("logged-out");
  await expect(page.getByTestId("session-coordination-state")).toHaveText("anonymous");
  await expect(page.getByTestId("session-coordination-result")).toHaveText("unavailable");
});

test("blocked Web Storage fails refresh closed without sending a mutation", async ({ page }) => {
  await page.addInitScript(({ key }) => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const nativeSetItem = Storage.prototype.setItem;
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      writable: true,
      value(this: Storage, candidate: string, value: string): void {
        if (candidate === key) throw new DOMException("blocked", "SecurityError");
        Reflect.apply(nativeSetItem, this, [candidate, value]);
      },
    });
  }, { key: "spott.web.refresh-attempt.v1" });
  await signIn(page);
  await expect.poll(() => page.evaluate(() => {
    try {
      window.localStorage.setItem("spott.web.refresh-attempt.v1", "probe");
      return "not-blocked";
    } catch (error) {
      return error instanceof DOMException ? error.name : "unexpected-error";
    }
  })).toBe("SecurityError");
  let refreshRequests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/session/refresh") refreshRequests += 1;
  });
  await page.getByRole("button", { name: "Coordinate refresh" }).click();

  await expect(page.getByTestId("session-coordination-result")).toHaveText("unavailable");
  await expect(page.getByTestId("session-coordination-state")).toHaveText("authenticated");
  expect(refreshRequests).toBe(0);
});

test("recovers the exact refresh successor after response loss and reload", async ({
  browser,
  context,
  page,
}, testInfo) => {
  await signIn(page);
  const initialGeneration = Number(
    await page.getByTestId("session-coordination-generation").textContent(),
  );
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") throw new Error("E2E baseURL is required");
  const predecessorCookies = await context.cookies(baseURL);
  const predecessorCookie = predecessorCookies
    .find((cookie) => cookie.name === "__Host-spott_refresh")?.value;
  expect(predecessorCookie).toBeTruthy();
  const lossContext = await browser.newContext({ baseURL });
  await lossContext.addCookies(predecessorCookies);
  const lossPage = await lossContext.newPage();
  await lossPage.goto("/internal-e2e/session-coordination");
  await expect(lossPage.getByTestId("session-coordination-state")).toHaveText("authenticated");
  let firstRefresh = true;
  let refreshRequests = 0;
  const attemptIds: string[] = [];
  await context.route("**/api/session/refresh", async (route) => {
    refreshRequests += 1;
    const original = route.request();
    const body = JSON.parse(original.postData() ?? "null") as { attemptId?: unknown } | null;
    if (typeof body?.attemptId === "string") attemptIds.push(body.attemptId);
    if (!firstRefresh) {
      await route.continue();
      return;
    }
    firstRefresh = false;
    const target = new URL(original.url());
    expect(target.protocol).toBe("https:");
    expect(target.hostname).toBe("127.0.0.1");
    const postData = original.postData();
    expect(postData).not.toBeNull();
    try {
      const committed = await lossPage.evaluate(async (body) => {
        const response = await fetch("/api/session/refresh", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body,
        });
        let payload: unknown = null;
        try {
          payload = await response.json() as unknown;
        } catch {
          // The assertions below retain only non-sensitive structural diagnostics.
        }
        const value = payload as {
          error?: { code?: unknown };
          refreshGeneration?: unknown;
        } | null;
        return {
          status: response.status,
          errorCode: typeof value?.error?.code === "string" ? value.error.code : null,
          refreshGeneration: typeof value?.refreshGeneration === "number"
            ? value.refreshGeneration
            : null,
        };
      }, postData!);
      expect(committed).toEqual({
        status: 200,
        errorCode: null,
        refreshGeneration: initialGeneration + 1,
      });
      const isolatedSuccessor = (await lossContext.cookies(baseURL))
        .find((cookie) => cookie.name === "__Host-spott_refresh")?.value;
      expect(isolatedSuccessor).toBeTruthy();
      expect(isolatedSuccessor).not.toBe(predecessorCookie);
      const originalStillPredecessor = (await context.cookies(baseURL))
        .find((cookie) => cookie.name === "__Host-spott_refresh")?.value;
      expect(originalStillPredecessor).toBe(predecessorCookie);
    } finally {
      await route.abort("failed");
    }
  });
  try {
    await page.getByRole("button", { name: "Coordinate refresh" }).click();
    await expect(page.getByTestId("session-coordination-result")).toHaveText("unavailable");
    expect((await context.cookies())
      .find((cookie) => cookie.name === "__Host-spott_refresh")?.value)
      .toBe(predecessorCookie);

    await page.reload();
    await expect(page.getByTestId("session-coordination-state")).toHaveText("authenticated");
    await expect(page.getByTestId("session-coordination-generation"))
      .toHaveText(String(initialGeneration + 1));
    await expect.poll(() => refreshRequests).toBe(2);
    expect(attemptIds).toHaveLength(2);
    expect(attemptIds[1]).toBe(attemptIds[0]);
  } finally {
    await lossContext.close();
  }
});

test("logout-all revokes a second real browser device", async ({ browser, page }, testInfo) => {
  await signIn(page);
  const otherContext = await browser.newContext({
    baseURL: testInfo.project.use.baseURL as string,
  });
  try {
    const otherDevice = await otherContext.newPage();
    await signIn(otherDevice);
    await page.getByRole("button", { name: "Log out every session" }).click();
    await expect(page.getByTestId("session-coordination-result")).toHaveText("logged-out");

    await otherDevice.reload();
    await expect(otherDevice.getByTestId("session-coordination-state")).toHaveText("anonymous");
  } finally {
    await otherContext.close();
  }
});

test("account switch waits for refresh authority and wins in every tab", async ({
  context,
  page,
}) => {
  await signIn(page);
  const second = await authenticatedSecondTab(context);
  const originalUserId = await page.getByTestId("session-coordination-user").textContent();
  await second.goto("/login?returnTo=%2Finternal-e2e%2Fsession-coordination");
  await waitForSessionReady(second);
  const originalDeviceId = await second.evaluate(() =>
    window.localStorage.getItem("spott.web.device.v1"));
  expect(originalDeviceId).toBeTruthy();
  await second.locator('form.login-form input[type="email"]')
    .fill("session-account-switch@e2e.spott.test");
  const challengeResponse = second.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/v1/auth/email/challenges");
  await second.locator("form.login-form button.primary-action").click();
  const challengeNetworkResponse = await challengeResponse;
  expect(challengeNetworkResponse.ok()).toBe(true);
  const challengeRequest = challengeNetworkResponse.request();
  const challengeBody = challengeRequest.postDataJSON() as { deviceId?: unknown };
  expect(typeof challengeBody.deviceId).toBe("string");
  expect(challengeBody.deviceId).not.toBe(originalDeviceId);
  expect(await challengeRequest.headerValue("x-spott-device-id")).toBe(challengeBody.deviceId);
  expect(await second.evaluate(() => window.localStorage.getItem("spott.web.device.v1")))
    .toBe(originalDeviceId);
  const code = second.locator('form.login-form input[inputmode="numeric"]');
  await expect(code).toHaveValue(/^\d{6}$/u);

  let releaseRefresh!: () => void;
  const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  let observeRefresh!: () => void;
  const refreshObserved = new Promise<void>((resolve) => { observeRefresh = resolve; });
  let completionRequests = 0;
  let completionDeviceId: string | null = null;
  const mutationOrder: string[] = [];
  context.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/session/complete") {
      completionRequests += 1;
      const body = JSON.parse(request.postData() ?? "null") as { deviceId?: unknown } | null;
      completionDeviceId = typeof body?.deviceId === "string" ? body.deviceId : null;
    }
    if (["/api/session/refresh", "/api/session/logout", "/api/session/complete"].includes(pathname)) {
      mutationOrder.push(pathname);
    }
  });
  await context.route("**/api/session/refresh", async (route) => {
    observeRefresh();
    await refreshReleased;
    await route.continue();
  });

  try {
    await page.getByRole("button", { name: "Coordinate refresh" }).click();
    await refreshObserved;
    await second.locator("form.login-form button.primary-action").click();
    await expect.poll(() => second.evaluate(async () => {
      const snapshot = await navigator.locks.query();
      return snapshot.pending?.some((lock) => lock.name === "spott:web-session-mutation:v1")
        ?? false;
    })).toBe(true);
    expect(completionRequests).toBe(0);
  } finally {
    releaseRefresh();
  }
  await expect(second).toHaveURL(/\/internal-e2e\/session-coordination$/u);
  await expect(second.getByTestId("session-coordination-state")).toHaveText("authenticated");
  const switchedUserId = await second.getByTestId("session-coordination-user").textContent();
  expect(switchedUserId).not.toBe(originalUserId);
  await expect(page.getByTestId("session-coordination-user")).toHaveText(switchedUserId!);
  expect(completionDeviceId).toBe(challengeBody.deviceId);
  expect(await second.evaluate(() => window.localStorage.getItem("spott.web.device.v1")))
    .toBe(challengeBody.deviceId);
  expect(mutationOrder.indexOf("/api/session/logout"))
    .toBeGreaterThan(mutationOrder.indexOf("/api/session/refresh"));
  expect(mutationOrder.indexOf("/api/session/complete"))
    .toBeGreaterThan(mutationOrder.indexOf("/api/session/logout"));
});

test("two account-switch challenges commit exactly one private device candidate", async ({
  context,
  page,
}) => {
  await signIn(page);
  const second = await authenticatedSecondTab(context);
  const originalDeviceId = await page.evaluate(() =>
    window.localStorage.getItem("spott.web.device.v1"));
  expect(originalDeviceId).toBeTruthy();

  await Promise.all([
    page.goto("/login?returnTo=%2Finternal-e2e%2Fsession-coordination"),
    second.goto("/login?returnTo=%2Finternal-e2e%2Fsession-coordination"),
  ]);
  await Promise.all([waitForSessionReady(page), waitForSessionReady(second)]);

  const firstChallengeResponse = page.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/v1/auth/email/challenges");
  await page.locator('form.login-form input[type="email"]')
    .fill("session-switch-first@e2e.spott.test");
  await page.locator("form.login-form button.primary-action").click();
  const firstChallengeRequest = (await firstChallengeResponse).request();
  const firstChallengeBody = firstChallengeRequest.postDataJSON() as { deviceId?: unknown };
  expect(typeof firstChallengeBody.deviceId).toBe("string");

  const secondChallengeResponse = second.waitForResponse((response) =>
    response.request().method() === "POST"
    && new URL(response.url()).pathname === "/v1/auth/email/challenges");
  await second.locator('form.login-form input[type="email"]')
    .fill("session-switch-second@e2e.spott.test");
  await second.locator("form.login-form button.primary-action").click();
  const secondChallengeRequest = (await secondChallengeResponse).request();
  const secondChallengeBody = secondChallengeRequest.postDataJSON() as { deviceId?: unknown };
  const secondChallengeMessage = await second.getByRole("status").textContent();
  if (!secondChallengeMessage) throw new Error("Second switch challenge message is required");
  expect(typeof secondChallengeBody.deviceId).toBe("string");
  expect(secondChallengeBody.deviceId).not.toBe(firstChallengeBody.deviceId);
  expect(firstChallengeBody.deviceId).not.toBe(originalDeviceId);
  expect(secondChallengeBody.deviceId).not.toBe(originalDeviceId);
  expect(await page.evaluate(() => window.localStorage.getItem("spott.web.device.v1")))
    .toBe(originalDeviceId);

  let releaseFirstCompletion!: () => void;
  const firstCompletionReleased = new Promise<void>((resolve) => {
    releaseFirstCompletion = resolve;
  });
  let observeFirstCompletion!: () => void;
  const firstCompletionObserved = new Promise<void>((resolve) => {
    observeFirstCompletion = resolve;
  });
  await page.route("**/api/session/complete", async (route) => {
    observeFirstCompletion();
    await firstCompletionReleased;
    await route.continue();
  });

  const mutationOrder: string[] = [];
  const completionCandidates: string[] = [];
  context.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (["/api/session/logout", "/api/session/complete"].includes(pathname)) {
      mutationOrder.push(pathname);
    }
    if (pathname === "/api/session/complete") {
      const body = JSON.parse(request.postData() ?? "null") as { deviceId?: unknown } | null;
      if (typeof body?.deviceId === "string") completionCandidates.push(body.deviceId);
    }
  });

  try {
    await page.locator("form.login-form button.primary-action").click();
    await firstCompletionObserved;
    await second.locator("form.login-form button.primary-action").click();
    await expect.poll(() => second.evaluate(async () => {
      const snapshot = await navigator.locks.query();
      return snapshot.pending?.some((lock) => lock.name === "spott:web-session-mutation:v1")
        ?? false;
    })).toBe(true);
  } finally {
    releaseFirstCompletion();
  }

  await expect(page).toHaveURL(/\/internal-e2e\/session-coordination$/u);
  await expect(page.getByTestId("session-coordination-state")).toHaveText("authenticated");
  await expect(second).toHaveURL(/\/login\?/u);
  await expect(second.getByRole("status")).not.toHaveText(secondChallengeMessage);
  expect(new Set(completionCandidates)).toEqual(new Set([firstChallengeBody.deviceId as string]));
  expect(mutationOrder.filter((path) => path === "/api/session/logout")).toHaveLength(1);
  expect(await page.evaluate(() => window.localStorage.getItem("spott.web.device.v1")))
    .toBe(firstChallengeBody.deviceId);
});

async function signIn(page: Page): Promise<void> {
  await page.goto("/login?returnTo=%2Finternal-e2e%2Fsession-coordination");
  await waitForSessionReady(page);
  await page.locator('form.login-form input[type="email"]')
    .fill("session-multitab@e2e.spott.test");
  await page.locator("form.login-form button.primary-action").click();
  const code = page.locator('form.login-form input[inputmode="numeric"]');
  await expect(code).toHaveValue(/^\d{6}$/u);
  await page.locator("form.login-form button.primary-action").click();
  await expect(page).toHaveURL(/\/internal-e2e\/session-coordination$/u);
  await expect(page.getByTestId("session-coordination-state")).toHaveText("authenticated");
}

async function authenticatedSecondTab(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/internal-e2e/session-coordination");
  await expect(page.getByTestId("session-coordination-state")).toHaveText("authenticated");
  return page;
}

async function waitForSessionReady(page: Page): Promise<void> {
  const shell = page.locator("[aria-busy]").filter({
    has: page.locator("#spott-main-content"),
  });
  await expect(shell).toHaveAttribute("aria-busy", "false");
}
