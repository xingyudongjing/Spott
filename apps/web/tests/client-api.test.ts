import { beforeEach, describe, expect, test, vi } from "vitest";

import { APIError, apiRequest, readSession, saveSession, type WebSession } from "../app/lib/client-api";

const expiredSession: WebSession = {
  accessToken: "expired-access-token",
  accessTokenExpiresAt: "2026-07-15T00:00:00.000Z",
  refreshToken: "refresh-token",
  sessionId: "019b0000-0000-7000-8100-000000000091",
  user: {
    id: "019b0000-0000-7000-8100-000000000092",
    publicHandle: "viewer",
    phoneVerified: true,
    restrictions: [],
  },
};

const freshSession: WebSession = {
  ...expiredSession,
  accessToken: "fresh-access-token",
  accessTokenExpiresAt: "2026-07-17T00:00:00.000Z",
  refreshToken: "rotated-refresh-token",
};

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("spott.web.device.v1", "019b0000-0000-7000-8100-000000000099");
  vi.unstubAllGlobals();
});

describe("refresh-aware client requests", () => {
  test("shares one refresh across concurrent 401 responses and retries both once", async () => {
    saveSession(expiredSession);
    let protectedCalls = 0;
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return jsonResponse(freshSession);
      }
      protectedCalls += 1;
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer fresh-access-token"
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: { message: "expired" } }, 401);
    }));

    const [first, second] = await Promise.all([
      apiRequest<{ ok: boolean }>("/events/search?limit=24"),
      apiRequest<{ ok: boolean }>("/events/search?limit=24"),
    ]);

    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: true });
    expect(refreshCalls).toBe(1);
    expect(protectedCalls).toBe(4);
    expect(readSession()?.accessToken).toBe("fresh-access-token");
  });

  test("reuses the rotated session when a concurrent stale 401 arrives after refresh completes", async () => {
    saveSession(expiredSession);
    let releaseDelayedResponse!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { releaseDelayedResponse = resolve; });
    let expiredCalls = 0;
    let freshCalls = 0;
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return jsonResponse(freshSession);
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      if (authorization === "Bearer expired-access-token") {
        expiredCalls += 1;
        if (expiredCalls === 2) await delayedResponse;
        return jsonResponse({ error: { message: "expired" } }, 401);
      }
      freshCalls += 1;
      return jsonResponse({ ok: true });
    }));

    const first = apiRequest<{ ok: boolean }>("/events/search?limit=24");
    const delayed = apiRequest<{ ok: boolean }>("/events/search?limit=24");
    await expect(first).resolves.toEqual({ ok: true });
    releaseDelayedResponse();
    await expect(delayed).resolves.toEqual({ ok: true });

    expect(refreshCalls).toBe(1);
    expect(expiredCalls).toBe(2);
    expect(freshCalls).toBe(2);
  });

  test("stops after one refresh when the retried request is still unauthorized", async () => {
    saveSession(expiredSession);
    let protectedCalls = 0;
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/auth/refresh")) {
        refreshCalls += 1;
        return jsonResponse(freshSession);
      }
      protectedCalls += 1;
      return jsonResponse({ error: { message: "still unauthorized" } }, 401);
    }));

    await expect(apiRequest("/events/search?limit=24")).rejects.toBeInstanceOf(APIError);
    expect(refreshCalls).toBe(1);
    expect(protectedCalls).toBe(2);
    expect(readSession()).toBeNull();
  });
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
