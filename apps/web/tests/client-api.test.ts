import { beforeEach, describe, expect, test, vi } from "vitest";

import { APIError, apiRequest, clearSession, readSession, saveSession, type WebSession } from "../app/lib/client-api";

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

const otherUserSession: WebSession = {
  accessToken: "other-user-access-token",
  accessTokenExpiresAt: "2026-07-17T00:00:00.000Z",
  refreshToken: "other-user-refresh-token",
  sessionId: "019b0000-0000-7000-8100-000000000191",
  user: {
    id: "019b0000-0000-7000-8100-000000000192",
    publicHandle: "other-viewer",
    phoneVerified: true,
    restrictions: [],
  },
};

beforeEach(() => {
  vi.restoreAllMocks();
  clearSession();
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

  test("never replays a stale request into a different signed-in account", async () => {
    saveSession(expiredSession);
    let releaseResponse!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const calls: Array<{ authorization: string | null; idempotencyKey: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push({
        authorization: new Headers(init?.headers).get("Authorization"),
        idempotencyKey: new Headers(init?.headers).get("Idempotency-Key"),
      });
      await delayedResponse;
      return jsonResponse({ error: { message: "expired" } }, 401);
    }));

    const request = apiRequest("/events/event-a/registrations", {
      method: "POST",
      authenticated: true,
      idempotent: true,
      body: JSON.stringify({ partySize: 1 }),
    });
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    saveSession(otherUserSession);
    releaseResponse();

    await expect(request).rejects.toBeInstanceOf(APIError);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer expired-access-token");
    expect(calls[0]?.idempotencyKey).toBeTruthy();
    expect(readSession()).toEqual(otherUserSession);
  });

  test("reuses a caller-owned idempotency key across an authenticated refresh retry", async () => {
    saveSession(expiredSession);
    const callerKey = "019b0000-0000-7000-8400-000000000001";
    const keys: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/auth/refresh")) return jsonResponse(freshSession);
      const headers = new Headers(init?.headers);
      keys.push(headers.get("Idempotency-Key"));
      return headers.get("Authorization") === "Bearer fresh-access-token"
        ? jsonResponse({ id: "registration" })
        : jsonResponse({ error: { message: "expired" } }, 401);
    }));

    await expect(apiRequest("/events/event-a/registrations", {
      method: "POST",
      authenticated: true,
      idempotencyKey: callerKey,
      body: JSON.stringify({ partySize: 1 }),
    })).resolves.toEqual({ id: "registration" });

    expect(keys).toEqual([callerKey, callerKey]);
  });

  test("does not let a stale refresh success overwrite a newly signed-in account", async () => {
    saveSession(expiredSession);
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let protectedCalls = 0;
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await delayedRefresh;
        return jsonResponse(freshSession);
      }
      protectedCalls += 1;
      return jsonResponse({ error: { message: "expired" } }, 401);
    }));

    const request = apiRequest("/me/favorite-events", { authenticated: true });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    saveSession(otherUserSession);
    releaseRefresh();

    await expect(request).rejects.toBeInstanceOf(APIError);
    expect(protectedCalls).toBe(1);
    expect(refreshCalls).toBe(1);
    expect(readSession()).toEqual(otherUserSession);
  });

  test("does not let a stale refresh failure clear a newly signed-in account", async () => {
    saveSession(expiredSession);
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/auth/refresh")) {
        refreshCalls += 1;
        await delayedRefresh;
        return jsonResponse({ error: { message: "refresh rejected" } }, 401);
      }
      return jsonResponse({ error: { message: "expired" } }, 401);
    }));

    const request = apiRequest("/me/favorite-events", { authenticated: true });
    await vi.waitFor(() => expect(refreshCalls).toBe(1));
    saveSession(otherUserSession);
    releaseRefresh();

    await expect(request).rejects.toBeInstanceOf(APIError);
    expect(readSession()).toEqual(otherUserSession);
  });

  test("reuses a same-session token rotated elsewhere while an older refresh fails", async () => {
    saveSession(expiredSession);
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const authorizations: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/auth/refresh")) {
        await delayedRefresh;
        return jsonResponse({ error: { message: "old refresh rejected" } }, 401);
      }
      const authorization = new Headers(init?.headers).get("Authorization");
      authorizations.push(authorization);
      return authorization === "Bearer fresh-access-token"
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: { message: "expired" } }, 401);
    }));

    const request = apiRequest<{ ok: boolean }>("/me/favorite-events", { authenticated: true });
    await vi.waitFor(() => expect(authorizations).toEqual(["Bearer expired-access-token"]));
    saveSession(freshSession);
    releaseRefresh();

    await expect(request).resolves.toEqual({ ok: true });
    expect(authorizations).toEqual(["Bearer expired-access-token", "Bearer fresh-access-token"]);
    expect(readSession()).toEqual(freshSession);
  });

  test("keeps the in-memory login authoritative when persistent storage is readable but not writable", () => {
    window.localStorage.clear();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    saveSession(expiredSession);

    expect(window.localStorage.getItem("spott.web.session.v1")).toBeNull();
    expect(readSession()).toEqual(expiredSession);
  });

  test("persists a logout tombstone across module reload when storage refuses removal", async () => {
    saveSession(expiredSession);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    clearSession();

    expect(window.localStorage.getItem("spott.web.session.v1")).toBe("");
    expect(readSession()).toBeNull();
    vi.resetModules();
    const reloadedClient = await import("../app/lib/client-api");
    expect(reloadedClient.readSession()).toBeNull();
  });

  test("keeps public requests usable when persistent browser storage is denied", async () => {
    window.localStorage.clear();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("X-Spott-Device-Id")).toMatch(/^[0-9a-f-]{36}$/i);
      return jsonResponse({ items: [] });
    }));

    await expect(apiRequest("/events/search?limit=24")).resolves.toEqual({ items: [] });
    expect(readSession()).toBeNull();
  });
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
