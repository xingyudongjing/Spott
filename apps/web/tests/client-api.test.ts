import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  APIError,
  apiRequest,
  clearSession,
  deviceId,
  errorMessage,
  readSession,
  refreshCurrentSession,
  saveSession,
  type WebSession,
} from "../app/lib/client-api";
import { fetchViewerEvent } from "../app/lib/events-client";
import { makeDetail } from "./event-fixtures";

const expiredSession: WebSession = {
  accessToken: "expired-access-token",
  accessTokenExpiresAt: "2026-07-15T00:00:00.000Z",
  refreshGeneration: 0,
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
  accessTokenExpiresAt: "2027-07-17T00:00:00.000Z",
  refreshGeneration: 1,
};

const rotatedSession: WebSession = {
  ...freshSession,
  user: {
    ...freshSession.user,
    phoneVerified: true,
  },
};

const newerSameUserSession: WebSession = {
  ...rotatedSession,
  accessToken: "newer-access-token",
  refreshGeneration: 2,
  sessionId: "019b0000-0000-7000-8100-000000000094",
};

const otherUserSession: WebSession = {
  accessToken: "other-user-access-token",
  accessTokenExpiresAt: "2027-07-17T00:00:00.000Z",
  refreshGeneration: 0,
  sessionId: "019b0000-0000-7000-8100-000000000191",
  user: {
    id: "019b0000-0000-7000-8100-000000000192",
    publicHandle: "other-viewer",
    phoneVerified: true,
    restrictions: [],
  },
};

function bootstrapSnapshot(session: WebSession = expiredSession): WebSession {
  return {
    ...session,
    accessToken: "bootstrap-access-token",
    accessTokenExpiresAt: "2027-07-17T00:00:00.000Z",
  };
}

function isSessionBootstrap(input: string | URL | Request): boolean {
  return String(input) === "/api/session/bootstrap";
}

beforeEach(() => {
  vi.restoreAllMocks();
  clearSession();
  window.localStorage.clear();
  window.localStorage.setItem("spott.web.device.v1", "019b0000-0000-7000-8100-000000000099");
  vi.unstubAllGlobals();
  document.documentElement.lang = "zh-Hans";
});

describe("browser device identity", () => {
  test("keeps public HTTP previews usable when randomUUID is unavailable", () => {
    window.localStorage.removeItem("spott.web.device.v1");
    const getRandomValues = vi.fn((target: Uint8Array) => {
      target.set([
        0x00, 0x11, 0x22, 0x33,
        0x44, 0x55, 0xff, 0x77,
        0xff, 0x99, 0xaa, 0xbb,
        0xcc, 0xdd, 0xee, 0xff,
      ]);
      return target;
    });
    vi.stubGlobal("crypto", { getRandomValues });

    expect(deviceId()).toBe("00112233-4455-4f77-bf99-aabbccddeeff");
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe("00112233-4455-4f77-bf99-aabbccddeeff");
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});

describe("localized client failure copy", () => {
  test.each([
    ["zh-Hans", "操作没有成功，请稍后再试。"],
    ["ja", "操作を完了できませんでした。しばらくしてからもう一度お試しください。"],
    ["en", "We could not complete that action. Please try again shortly."],
  ])("localizes the safe fallback in %s", (locale, expected) => {
    document.documentElement.lang = locale;

    expect(new APIError(500, {}).message).toBe(expected);
    expect(errorMessage({ not: "an error" })).toBe(expected);
  });

  test.each([
    ["zh-Hans", "请求失败（502）"],
    ["ja", "リクエストに失敗しました（502）"],
    ["en", "Request failed (502)"],
  ])("localizes an unreadable HTTP response in %s", async (locale, expected) => {
    document.documentElement.lang = locale;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 502 })));

    await expect(apiRequest("/events/search?limit=24")).rejects.toMatchObject({
      status: 502,
      message: expected,
    });
  });
});

describe("refresh-aware client requests", () => {
  test("never attaches browser cookies to a direct API request", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe("omit");
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiRequest<{ ok: boolean }>("/events/search?limit=24"))
      .resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("uses the same-origin Cookie BFF for refresh", async () => {
    saveSession(expiredSession);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      expect(String(input)).toBe("/api/session/refresh");
      expect(init?.credentials).toBe("include");
      return jsonResponse(freshSession);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCurrentSession()).resolves.toEqual(freshSession);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("accepts an authoritative same-user refresh that advances generation", async () => {
    const initial = {
      ...expiredSession,
      user: { ...expiredSession.user, phoneVerified: false },
    };
    saveSession(initial);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      jsonResponse(isSessionBootstrap(input) ? bootstrapSnapshot(initial) : rotatedSession)));

    await expect(refreshCurrentSession()).resolves.toEqual(rotatedSession);
    expect(readSession()).toEqual(rotatedSession);
  });

  test("replays an authenticated request after a same-user refresh rotates the session id", async () => {
    saveSession(expiredSession);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (String(input).endsWith("/api/session/refresh")) return jsonResponse(rotatedSession);
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer fresh-access-token"
        ? jsonResponse({ ok: true })
        : jsonResponse({ error: { message: "expired" } }, 401);
    }));

    await expect(apiRequest<{ ok: boolean }>("/me/registrations", { authenticated: true }))
      .resolves.toEqual({ ok: true });
    expect(readSession()).toEqual(rotatedSession);
  });

  test("refreshes a viewer event request and strictly parses the rotated-session response", async () => {
    const viewerEvent = makeDetail({ exactAddress: "东京都江东区平野 1-2-3" });
    saveSession(expiredSession);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (url.endsWith("/api/session/refresh")) return jsonResponse(rotatedSession);
      return new Headers(init?.headers).get("Authorization") === "Bearer fresh-access-token"
        ? jsonResponse(viewerEvent)
        : jsonResponse({ error: { message: "expired" } }, 401);
    }));

    await expect(fetchViewerEvent(viewerEvent.id)).resolves.toMatchObject({
      id: viewerEvent.id,
      exactAddress: "东京都江东区平野 1-2-3",
    });
    expect(readSession()).toEqual(rotatedSession);
  });

  test("rejects a refresh response for a different user", async () => {
    saveSession(expiredSession);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) =>
      jsonResponse(isSessionBootstrap(input) ? bootstrapSnapshot() : otherUserSession)));

    await expect(refreshCurrentSession()).resolves.toBeNull();
    expect(readSession()).toEqual(expiredSession);
  });

  test("preserves a different account selected while refresh is in flight", async () => {
    saveSession(expiredSession);
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      await delayedRefresh;
      return jsonResponse(rotatedSession);
    }));

    const refresh = refreshCurrentSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    saveSession(otherUserSession);
    releaseRefresh();

    await expect(refresh).resolves.toBeNull();
    expect(readSession()).toEqual(otherUserSession);
  });

  test("does not let an old refresh overwrite a newer same-user session", async () => {
    saveSession(expiredSession);
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      await delayedRefresh;
      return jsonResponse(rotatedSession);
    }));

    const refresh = refreshCurrentSession();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    saveSession(newerSameUserSession);
    releaseRefresh();

    await expect(refresh).resolves.toBeNull();
    expect(readSession()).toEqual(newerSameUserSession);
  });

  test("shares one refresh across concurrent 401 responses and retries both once", async () => {
    saveSession(expiredSession);
    let protectedCalls = 0;
    let refreshCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (url.endsWith("/api/session/refresh")) {
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
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (url.endsWith("/api/session/refresh")) {
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
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (url.endsWith("/api/session/refresh")) {
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

  test("rejects a late 200 response after the same user starts a new session", async () => {
    saveSession(expiredSession);
    let releaseResponse!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await delayedResponse;
      return jsonResponse({ privateEvent: "session-one-only" });
    }));

    const request = apiRequest("/me/registrations", { authenticated: true });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    saveSession(newerSameUserSession);
    releaseResponse();

    await expect(request).rejects.toMatchObject({
      status: 401,
      body: { code: "SESSION_CHANGED" },
    });
    expect(readSession()).toEqual(newerSameUserSession);
  });

  test("rejects a late 204 response after the account changes", async () => {
    saveSession(expiredSession);
    let releaseResponse!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await delayedResponse;
      return new Response(null, { status: 204 });
    }));

    const request = apiRequest("/me/favorite-events/event-a", {
      method: "DELETE",
      authenticated: true,
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    saveSession(otherUserSession);
    releaseResponse();

    await expect(request).rejects.toMatchObject({
      status: 401,
      body: { code: "SESSION_CHANGED" },
    });
    expect(readSession()).toEqual(otherUserSession);
  });

  test("never replays a stale 401 POST into a new session for the same user", async () => {
    saveSession(expiredSession);
    let releaseResponse!: () => void;
    const delayedResponse = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const authorizations: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      await delayedResponse;
      return jsonResponse({ error: { message: "expired" } }, 401);
    }));

    const request = apiRequest("/events/event-a/registrations", {
      method: "POST",
      authenticated: true,
      idempotencyKey: "019b0000-0000-7000-8400-000000000001",
      body: JSON.stringify({ partySize: 1 }),
    });
    await vi.waitFor(() => expect(authorizations).toHaveLength(1));
    saveSession(newerSameUserSession);
    releaseResponse();

    await expect(request).rejects.toMatchObject({
      status: 401,
      body: { code: "SESSION_CHANGED" },
    });
    expect(authorizations).toEqual(["Bearer expired-access-token"]);
    expect(readSession()).toEqual(newerSameUserSession);
  });

  test("reuses a caller-owned idempotency key across an authenticated refresh retry", async () => {
    saveSession(expiredSession);
    const callerKey = "019b0000-0000-7000-8400-000000000001";
    const keys: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (String(input).endsWith("/api/session/refresh")) return jsonResponse(freshSession);
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
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (String(input).endsWith("/api/session/refresh")) {
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
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (String(input).endsWith("/api/session/refresh")) {
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

  test("rejects an externally replaced token while an older refresh is in flight", async () => {
    saveSession(expiredSession);
    let releaseRefresh!: () => void;
    const delayedRefresh = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const authorizations: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (isSessionBootstrap(input)) return jsonResponse(bootstrapSnapshot());
      if (String(input).endsWith("/api/session/refresh")) {
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

    await expect(request).rejects.toMatchObject({
      status: 401,
      body: { code: "SESSION_CHANGED" },
    });
    expect(authorizations).toEqual(["Bearer expired-access-token"]);
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

  test("overwrites a legacy credential with a logout tombstone when removal is denied", async () => {
    saveSession(expiredSession);
    window.localStorage.setItem("spott.web.session.v1", JSON.stringify({
      ...expiredSession,
      refreshToken: "legacy-refresh-must-be-scrubbed",
    }));
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
