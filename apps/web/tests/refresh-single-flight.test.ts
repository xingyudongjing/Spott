import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { apiRequest, saveSession, clearSession, type WebSession } from "../app/lib/client-api";

const session: WebSession = {
  accessToken: "expired-access",
  accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
  refreshToken: "refresh-token",
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

describe("refresh concurrency and retry bounds", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  test("collapses concurrent 401s into a single refresh call", async () => {
    let refreshCalls = 0;
    let protectedCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/auth/refresh")) {
          refreshCalls += 1;
          // Hold the refresh open so every caller must queue behind it.
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(
            JSON.stringify({ ...session, accessToken: "fresh-access", refreshToken: "next-refresh" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        protectedCalls += 1;
        // First attempt per request is unauthorised; the replay succeeds.
        return protectedCalls <= 3
          ? new Response(JSON.stringify({ error: { code: "TOKEN_EXPIRED" } }), { status: 401 })
          : new Response(JSON.stringify({ ok: true }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
      }),
    );

    saveSession(session);
    await Promise.all([
      apiRequest("/me", { authenticated: true }).catch(() => undefined),
      apiRequest("/notifications", { authenticated: true }).catch(() => undefined),
      apiRequest("/registrations", { authenticated: true }).catch(() => undefined),
    ]);

    expect(refreshCalls).toBe(1);
  });

  test("retries a request at most once and never recurses when refresh keeps failing", async () => {
    let refreshCalls = 0;
    let protectedCalls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/auth/refresh")) {
          refreshCalls += 1;
          // Refresh "succeeds" but the protected route still 401s, which is the
          // shape that would drive an unbounded recursive retry loop.
          return new Response(
            JSON.stringify({ ...session, accessToken: `rotated-${refreshCalls}` }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        protectedCalls += 1;
        return new Response(JSON.stringify({ error: { code: "TOKEN_EXPIRED" } }), { status: 401 });
      }),
    );

    saveSession(session);
    await apiRequest("/me", { authenticated: true }).catch(() => undefined);

    // One original attempt plus at most one replay. No recursion.
    expect(protectedCalls).toBeLessThanOrEqual(2);
    expect(refreshCalls).toBeLessThanOrEqual(1);
  });
});
