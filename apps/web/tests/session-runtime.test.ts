import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  abandonEmailSessionSwitch,
  bootstrapSession,
  clearSession,
  completeEmailSession,
  logoutCurrentSession,
  prepareEmailLoginDevice,
  readSession,
  refreshCurrentSession,
  registerEmailSessionSwitch,
  saveSession,
  subscribeSessionChanges,
  type WebSession,
} from "../app/lib/client-api";
import { createSessionRefreshCoordinator } from "../app/lib/session-refresh-coordinator";
import {
  markSessionCompletionAttemptAccepting,
  markSessionCompletionAttemptDeviceCommitted,
  reconcileSessionCompletionAttempt,
  scanPendingSessionCompletionAttempts,
  SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION,
  SESSION_COMPLETION_ATTEMPT_STORAGE_KEY,
  storePreparedSessionCompletionAttempt,
  type PendingSessionCompletionAttempt,
  type SessionCompletionAttemptPhase,
} from "../app/lib/session-completion-attempt-store";
import { commitLoginDevicePlan } from "../app/lib/browser-device-identity";

const session: WebSession = {
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 3,
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function terminalBrowserReauthentication(
  contentType = "application/json",
): Response {
  return new Response(JSON.stringify({
    error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
  }), {
    status: 401,
    headers: { "Content-Type": contentType },
  });
}

function invalidUTF8TerminalBrowserReauthentication(): Response {
  return new Response(new Uint8Array([
    ...new TextEncoder().encode('{"error":{"code":"SESSION_REAUTH_REQUIRED","retryable":false,"detail":"'),
    0xff,
    ...new TextEncoder().encode('"}}'),
  ]), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

const runtimeCompletionAttemptId = "019b0000-0000-7000-8000-000000000501";
const runtimeCompletionBindingId = "019b0000-0000-7000-8000-000000000502";

interface CompletionProtocolHooks {
  readonly ready?: () => Response | Promise<Response>;
  readonly pending?: () => Response | Promise<Response>;
  readonly accept?: () => Response | Promise<Response>;
  readonly discard?: () => Response | Promise<Response>;
}

function completionProtocol(
  accepted: WebSession,
  hooks: CompletionProtocolHooks = {},
): (url: string, init?: RequestInit) => Promise<Response | null> {
  let candidateDeviceId: string | null = null;
  return async (url, init) => {
    if (url === "/api/session/complete") {
      const body = JSON.parse(String(init?.body)) as {
        deviceId?: unknown;
        attemptId?: unknown;
      };
      candidateDeviceId = typeof body.deviceId === "string" ? body.deviceId : null;
      if (body.attemptId === undefined) {
        return hooks.ready?.() ?? json({
          state: "completion_ready",
          attemptId: runtimeCompletionAttemptId,
          expiresAt: Date.now() + 120_000,
        }, 202);
      }
      return hooks.pending?.() ?? json({
        state: "completion_pending",
        attemptId: runtimeCompletionAttemptId,
        sessionId: accepted.sessionId,
        bindingId: runtimeCompletionBindingId,
        deviceId: candidateDeviceId,
        reconcileExpiresAt: Date.now() + 2_678_400_000,
      });
    }
    if (url === "/api/session/completion/accept") {
      return hooks.accept?.() ?? json({ state: "authenticated", ...accepted });
    }
    if (url === "/api/session/completion/discard") {
      return hooks.discard?.() ?? json({
        state: "discarded",
        attemptId: runtimeCompletionAttemptId,
        bindingId: runtimeCompletionBindingId,
        deviceId: candidateDeviceId,
      });
    }
    return null;
  };
}

async function accountSwitchInput(challengeId: string) {
  const input = {
    challengeId,
    code: "123456",
    device: prepareEmailLoginDevice({ switching: true }),
    expectedSession: {
      state: "authenticated" as const,
      userId: session.user.id,
      sessionId: session.sessionId,
    },
  };
  await expect(registerEmailSessionSwitch(input)).resolves.toBe(true);
  return input;
}

function anonymousLoginInput(challengeId: string) {
  return {
    challengeId,
    code: "123456",
    device: prepareEmailLoginDevice({ switching: false }),
    expectedSession: { state: "anonymous" as const },
  };
}

function seedCompletionPhase(
  phase: SessionCompletionAttemptPhase,
  challengeId: string,
): { readonly attempt: PendingSessionCompletionAttempt; readonly deviceId: string } {
  const input = anonymousLoginInput(challengeId);
  const createdAt = Date.now();
  const prepared = storePreparedSessionCompletionAttempt({
    challengeId,
    attemptId: runtimeCompletionAttemptId,
    predecessorDeviceId: input.device.predecessorId,
    candidateDeviceId: input.device.deviceId,
    createdAt,
    prepareExpiresAt: createdAt + 120_000,
  })!;
  if (phase === "prepared") return { attempt: prepared, deviceId: input.device.deviceId };
  const reconciled = reconcileSessionCompletionAttempt({
    expected: prepared,
    sessionId: session.sessionId,
    reconcileExpiresAt: createdAt + 600_000,
    updatedAt: createdAt + 1,
  })!;
  if (phase === "reconciled") return { attempt: reconciled, deviceId: input.device.deviceId };
  expect(commitLoginDevicePlan(input.device)).toBe(true);
  const committed = markSessionCompletionAttemptDeviceCommitted({
    expected: reconciled,
    updatedAt: createdAt + 2,
  })!;
  if (phase === "device_committed") return { attempt: committed, deviceId: input.device.deviceId };
  const accepting = markSessionCompletionAttemptAccepting({
    expected: committed,
    updatedAt: createdAt + 3,
  })!;
  return { attempt: accepting, deviceId: input.device.deviceId };
}

const registrationDraftKeys = [
  "spott.web.registration-draft.v1.019b0000-0000-7000-8000-000000000031.v1",
  "spott.web.registration-draft.v2.019b0000-0000-7000-8000-000000000032.v2",
] as const;
const localPrivateDraftKeys = [
  `spott.event-composer.v3.user.${session.user.id}`,
  "spott.event-composer.v3.anonymous",
  "spott.group-transfer.019b0000-0000-7000-8000-000000000033",
] as const;

function seedPrivateBrowserDrafts(): void {
  for (const key of registrationDraftKeys) window.sessionStorage.setItem(key, "private");
  for (const key of localPrivateDraftKeys) window.localStorage.setItem(key, "private");
  window.sessionStorage.setItem("spott.unrelated.session", "keep");
  window.localStorage.setItem("spott.unrelated.local", "keep");
}

function expectPrivateBrowserDraftsCleared(): void {
  for (const key of registrationDraftKeys) expect(window.sessionStorage.getItem(key)).toBeNull();
  for (const key of localPrivateDraftKeys) expect(window.localStorage.getItem(key)).toBeNull();
  expect(window.sessionStorage.getItem("spott.unrelated.session")).toBe("keep");
  expect(window.localStorage.getItem("spott.unrelated.local")).toBe("keep");
}

function expectPrivateBrowserDraftsPresent(): void {
  for (const key of registrationDraftKeys) expect(window.sessionStorage.getItem(key)).toBe("private");
  for (const key of localPrivateDraftKeys) expect(window.localStorage.getItem(key)).toBe("private");
}

describe("memory-only browser session runtime", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
    clearSession();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
  });

  test("restores a full-page reload only through credentialless same-origin bootstrap", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/session/bootstrap");
      expect(init).toMatchObject({
        credentials: "include",
        cache: "no-store",
        signal: timeoutSignal,
      });
      return json({ state: "authenticated", ...session });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapSession()).resolves.toEqual(session);

    expect(readSession()).toEqual(session);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledOnce();
    expect(timeout).toHaveBeenCalledWith(3_000);
    expect(window.localStorage.getItem("spott.web.session.v1")).toBeNull();
  });

  test("recovers a durable refresh attempt before bootstrap after a response-lost reload", async () => {
    const attemptId = "019b0000-0000-7000-8000-000000000091";
    const successor = {
      ...session,
      accessToken: "response-loss-recovered-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      refreshGeneration: session.refreshGeneration + 1,
    };
    window.localStorage.setItem("spott.web.session-metadata.v1", JSON.stringify({
      state: "authenticated",
      userId: session.user.id,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
    }));
    window.localStorage.setItem("spott.web.refresh-attempt.v1", JSON.stringify({
      attemptId,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
      createdAt: Date.now(),
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("/api/session/refresh");
      expect(JSON.parse(String(init?.body))).toEqual({
        attemptId,
        expectedSessionId: session.sessionId,
        expectedUserId: session.user.id,
        expectedRefreshGeneration: session.refreshGeneration,
      });
      return json({ state: "authenticated", ...successor });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapSession()).resolves.toEqual(successor);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readSession()).toEqual(successor);
    expect(window.localStorage.getItem("spott.web.refresh-attempt.v1")).toBeNull();
  });

  test("retains a durable refresh attempt and never bootstraps a possibly consumed predecessor", async () => {
    const attempt = {
      attemptId: "019b0000-0000-7000-8000-000000000092",
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
      createdAt: Date.now(),
    };
    window.localStorage.setItem("spott.web.session-metadata.v1", JSON.stringify({
      state: "authenticated",
      userId: session.user.id,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
    }));
    window.localStorage.setItem("spott.web.refresh-attempt.v1", JSON.stringify(attempt));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/session/refresh");
      throw new TypeError("response unavailable");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem("spott.web.refresh-attempt.v1"))
      .toBe(JSON.stringify(attempt));
  });

  test("scrubs a legacy localStorage refresh token before any network call and stays signed out", async () => {
    window.localStorage.setItem("spott.web.session.v1", JSON.stringify({
      ...session,
      refreshToken: "legacy-refresh-token-must-never-leave-this-process",
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("spott.web.session.v1")).toBeNull();
    expect(readSession()).toBeNull();
  });

  test("refreshes only through the same-origin BFF without browser credential material", async () => {
    saveSession(session);
    seedPrivateBrowserDrafts();
    const successor = {
      ...session,
      accessToken: "fresh-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      refreshGeneration: 4,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/session/bootstrap") {
        expect(init).toMatchObject({ method: "GET", credentials: "include" });
        return json({ state: "authenticated", ...session });
      }
      expect(String(input)).toBe("/api/session/refresh");
      expect(init).toMatchObject({ method: "POST", credentials: "include" });
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        attemptId: expect.any(String),
        expectedSessionId: session.sessionId,
        expectedUserId: session.user.id,
        expectedRefreshGeneration: session.refreshGeneration,
      });
      expect(JSON.stringify(init)).not.toContain("refresh-token");
      return json({ state: "authenticated", ...successor });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCurrentSession()).resolves.toEqual(successor);
    expect(readSession()).toEqual(successor);
    expectPrivateBrowserDraftsPresent();
  });

  test.each([
    ["unrelated JSON 401", () => json({ error: { code: "WEB_BFF_AUTHORITY_INVALID" } }, 401)],
    ["wrong-media terminal 401", () => terminalBrowserReauthentication("text/plain")],
    ["malformed JSON 401", () => new Response('{"error":', {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })],
    ["invalid UTF-8 terminal-looking 401", invalidUTF8TerminalBrowserReauthentication],
    ["length-mismatched terminal-looking 401", () => new Response(JSON.stringify({
      error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
    }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
    })],
  ] as const)("preserves the current session for a non-terminal bootstrap response: %s", async (_label, failure) => {
    saveSession(session);
    const metadataRaw = window.localStorage.getItem("spott.web.session-metadata.v1");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/session/bootstrap");
      return failure();
    }));

    await expect(refreshCurrentSession()).resolves.toBeNull();

    expect(readSession()).toBe(session);
    expect(window.localStorage.getItem("spott.web.session-metadata.v1")).toBe(metadataRaw);
  });

  test("accepts only the exact browser bootstrap reauthentication contract as terminal", async () => {
    saveSession(session);
    vi.stubGlobal("fetch", vi.fn(async () => terminalBrowserReauthentication()));

    await expect(refreshCurrentSession()).resolves.toBeNull();

    expect(readSession()).toBeNull();
  });

  test.each([
    ["validation 400", () => json({ error: { code: "SESSION_REFRESH_REQUEST_INVALID" } }, 400)],
    ["unrelated JSON 401", () => json({ error: { code: "WEB_BFF_AUTHORITY_INVALID" } }, 401)],
    ["wrong-media terminal 401", () => terminalBrowserReauthentication("text/plain")],
    ["malformed JSON 401", () => new Response('{"error":', {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })],
    ["invalid UTF-8 terminal-looking 401", invalidUTF8TerminalBrowserReauthentication],
    ["length-mismatched terminal-looking 401", () => new Response(JSON.stringify({
      error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
    }), {
      status: 401,
      headers: { "Content-Type": "application/json", "Content-Length": "1" },
    })],
    ["request-security 403", () => json({ error: { code: "SESSION_REQUEST_FORBIDDEN" } }, 403)],
    ["conflict 409", () => json({ error: { code: "REQUEST_IN_PROGRESS" } }, 409)],
    ["rate limit 429", () => json({ error: { code: "RATE_LIMITED" } }, 429)],
  ] as const)("preserves the session and exact refresh attempt for non-terminal refresh: %s", async (_label, failure) => {
    saveSession(session);
    let attemptRaw: string | null = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/session/bootstrap") return json({ state: "authenticated", ...session });
      if (url === "/api/session/refresh") {
        attemptRaw = window.localStorage.getItem("spott.web.refresh-attempt.v1");
        expect(attemptRaw).not.toBeNull();
        return failure();
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(refreshCurrentSession()).resolves.toBeNull();

    expect(readSession()).toBe(session);
    expect(window.localStorage.getItem("spott.web.refresh-attempt.v1")).toBe(attemptRaw);
  });

  test("never rotates when the durable refresh attempt cannot be read back", async () => {
    saveSession(session);
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === "spott.web.refresh-attempt.v1") return;
      nativeSetItem.call(this, key, value);
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/session/bootstrap") {
        return json({ state: "authenticated", ...session });
      }
      if (String(input) === "/api/session/refresh") {
        return json({
          state: "authenticated",
          ...session,
          accessToken: "must-not-be-used",
          refreshGeneration: session.refreshGeneration + 1,
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshCurrentSession()).resolves.toBeNull();

    expect(readSession()).toEqual(session);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/session/bootstrap",
    ]);
  });

  test("adopts the latest authoritative in-memory state announced by another tab", async () => {
    saveSession(session);
    const successor = {
      ...session,
      accessToken: "cross-tab-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      refreshGeneration: session.refreshGeneration + 1,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/session/bootstrap");
      return json({ state: "authenticated", ...successor });
    });
    vi.stubGlobal("fetch", fetchMock);
    const unsubscribe = subscribeSessionChanges(() => undefined);

    window.dispatchEvent(new StorageEvent("storage", {
      key: "spott.web.session-metadata.v1",
      newValue: JSON.stringify({
        state: "authenticated",
        userId: successor.user.id,
        sessionId: successor.sessionId,
        refreshGeneration: successor.refreshGeneration,
      }),
    }));

    await vi.waitFor(() => expect(readSession()).toEqual(successor));
    expect(fetchMock).toHaveBeenCalledOnce();
    unsubscribe();
  });

  test("never lets a late initial bootstrap restore a session after logout starts", async () => {
    let resolveBootstrap!: (response: Response) => void;
    const bootstrapResponse = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/session/bootstrap") return bootstrapResponse;
      if (String(input) === "/api/session/logout") return json({ state: "anonymous" });
      throw new Error(`Unexpected request: ${String(input)}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const bootstrap = bootstrapSession();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await expect(logoutCurrentSession("current")).resolves.toBe(true);
    resolveBootstrap(json({ state: "authenticated", ...session }));

    await expect(bootstrap).resolves.toBeNull();
    expect(readSession()).toBeNull();
  });

  test("never lets a late cross-tab bootstrap overwrite a newer account", async () => {
    saveSession(session);
    const announced = {
      ...session,
      accessToken: "announced-access-token",
      refreshGeneration: session.refreshGeneration + 1,
    };
    const newerAccount: WebSession = {
      ...session,
      accessToken: "newer-account-access-token",
      sessionId: "019b0000-0000-7000-8000-000000000011",
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000012" },
    };
    let resolveBootstrap!: (response: Response) => void;
    const bootstrapResponse = new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(async () => bootstrapResponse));
    const unsubscribe = subscribeSessionChanges(() => undefined);

    window.dispatchEvent(new StorageEvent("storage", {
      key: "spott.web.session-metadata.v1",
      newValue: JSON.stringify({
        state: "authenticated",
        userId: announced.user.id,
        sessionId: announced.sessionId,
        refreshGeneration: announced.refreshGeneration,
      }),
    }));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    saveSession(newerAccount);
    resolveBootstrap(json({ state: "authenticated", ...announced }));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(readSession()).toEqual(newerAccount);
    unsubscribe();
  });

  test("does not lose a newer cross-tab announcement while an older bootstrap is in flight", async () => {
    saveSession(session);
    const generationFour = {
      ...session,
      accessToken: "generation-four-access-token",
      refreshGeneration: 4,
    };
    const generationFive = {
      ...session,
      accessToken: "generation-five-access-token",
      refreshGeneration: 5,
    };
    let resolveFirst!: (response: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => firstResponse)
      .mockImplementationOnce(async () => json({ state: "authenticated", ...generationFive }));
    vi.stubGlobal("fetch", fetchMock);
    const unsubscribe = subscribeSessionChanges(() => undefined);

    const announce = (refreshGeneration: number) => window.dispatchEvent(new StorageEvent("storage", {
      key: "spott.web.session-metadata.v1",
      newValue: JSON.stringify({
        state: "authenticated",
        userId: session.user.id,
        sessionId: session.sessionId,
        refreshGeneration,
      }),
    }));
    announce(4);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    announce(5);
    resolveFirst(json({ state: "authenticated", ...generationFour }));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(readSession()).toEqual(generationFive));
    unsubscribe();
  });

  test.each(["current", "all"] as const)(
    "clears memory before terminal %s logout and uses the same-origin BFF",
    async (scope) => {
      saveSession(session);
      seedPrivateBrowserDrafts();
      let sessionObservedAtFetch: WebSession | null | undefined;
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sessionObservedAtFetch = readSession();
        expectPrivateBrowserDraftsCleared();
        expect(String(input)).toBe(`/api/session/${scope === "all" ? "logout-all" : "logout"}`);
        expect(init).toMatchObject({ method: "POST", credentials: "include" });
        return json({ state: "anonymous" });
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(logoutCurrentSession(scope)).resolves.toBe(true);

      expect(sessionObservedAtFetch).toBeNull();
      expect(readSession()).toBeNull();
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  test("keeps logout-all visibly unconfirmed while completing local terminal cleanup", async () => {
    saveSession(session);
    seedPrivateBrowserDrafts();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe("/api/session/logout-all");
      return json({ error: { code: "LOGOUT_ALL_UNCONFIRMED", retryable: false } }, 409);
    }));

    await expect(logoutCurrentSession("all")).resolves.toBe(false);

    expect(readSession()).toBeNull();
    expectPrivateBrowserDraftsCleared();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(document.cookie).not.toContain("__Host-spott_logout_intent=");
  });

  test("never treats logout-all reauthentication failure as global revocation", async () => {
    saveSession(session);
    vi.stubGlobal("fetch", vi.fn(async () => json({
      error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
    }, 401)));

    await expect(logoutCurrentSession("all")).resolves.toBe(false);

    expect(readSession()).toBeNull();
  });

  test.each([
    "prepared",
    "reconciled",
    "device_committed",
    "accepting",
  ] as const)("revokes a %s completion only through BFF logout", async (phase) => {
    const { attempt } = seedCompletionPhase(
      phase,
      `019b0000-0000-7000-8000-0000000005${phase.length.toString().padStart(2, "0")}`,
    );
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return json({ state: "anonymous" });
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(true);

    expect(requests).toEqual(["/api/session/logout"]);
    expect(requests).not.toContain("/api/session/completion/accept");
    expect(requests).not.toContain("/api/session/completion/discard");
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [] });
    expect(attempt.phase).toBe(phase);
  });

  test.each([
    ["corrupt", () => window.localStorage.setItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY, "{broken")],
    ["legacy", () => window.localStorage.setItem("spott.web.session-completion-attempt.v1", "legacy")],
    ["conflicting", () => {
      seedCompletionPhase("prepared", "019b0000-0000-7000-8000-000000000571");
      window.localStorage.setItem("spott.web.session-completion-attempt.v1", "conflict");
    }],
  ] as const)("runs BFF logout but preserves %s completion namespace", async (_label, seed) => {
    seed();
    const before = [...Array.from({ length: window.localStorage.length }, (_, index) => {
      const key = window.localStorage.key(index)!;
      return [key, window.localStorage.getItem(key)] as const;
    })].filter(([key]) => key.startsWith("spott.web.session-completion-attempt."));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ state: "anonymous" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual(["/api/session/logout"]);
    for (const [key, raw] of before) expect(window.localStorage.getItem(key)).toBe(raw);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("keeps current 401 unresolved when an exact completion attempt exists", async () => {
    const { attempt } = seedCompletionPhase(
      "prepared",
      "019b0000-0000-7000-8000-000000000572",
    );
    vi.stubGlobal("fetch", vi.fn(async () => json({
      error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
    }, 401)));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("serializes terminal logout behind an in-flight refresh mutation", async () => {
    saveSession(session);
    const successor = {
      ...session,
      accessToken: "late-refresh-access-token",
      refreshGeneration: session.refreshGeneration + 1,
    };
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/bootstrap") {
        return json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/refresh") return refreshResponse;
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const refresh = refreshCurrentSession();
    await vi.waitFor(() => expect(requests).toContain("/api/session/refresh"));
    const logout = logoutCurrentSession("current");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).not.toContain("/api/session/logout");

    resolveRefresh(json({ state: "authenticated", ...successor }));
    await expect(refresh).resolves.toBeNull();
    await expect(logout).resolves.toBe(true);
    expect(requests.indexOf("/api/session/logout"))
      .toBeGreaterThan(requests.indexOf("/api/session/refresh"));
    expect(readSession()).toBeNull();
  });

  test("does not overwrite a newer durable logout intent while queued behind refresh", async () => {
    saveSession(session);
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/bootstrap") return json({ state: "authenticated", ...session });
      if (url === "/api/session/refresh") return refreshResponse;
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const refresh = refreshCurrentSession();
    await vi.waitFor(() => expect(requests).toContain("/api/session/refresh"));
    const logout = logoutCurrentSession("current");
    const armed = JSON.parse(window.localStorage.getItem("spott.web.logout-intent.v1") ?? "null") as {
      createdAt: number;
    };
    const newer = { ...armed, createdAt: armed.createdAt + 1 };
    window.localStorage.setItem("spott.web.logout-intent.v1", JSON.stringify(newer));
    resolveRefresh(json({ error: { code: "SESSION_REFRESH_UNAVAILABLE" } }, 503));

    await expect(refresh).resolves.toBeNull();
    await expect(logout).resolves.toBe(false);
    expect(requests).not.toContain("/api/session/logout");
    expect(JSON.parse(window.localStorage.getItem("spott.web.logout-intent.v1") ?? "null"))
      .toEqual(newer);
  });

  test("preserves a newer full logout intent written while the response is in flight", async () => {
    saveSession(session);
    let resolveLogout!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const logout = logoutCurrentSession("current");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const armedRaw = window.localStorage.getItem("spott.web.logout-intent.v1")!;
    const armed = JSON.parse(armedRaw) as { createdAt: number };
    const newer = JSON.stringify({ ...armed, createdAt: armed.createdAt + 1 });
    window.localStorage.setItem("spott.web.logout-intent.v1", newer);
    resolveLogout(json({ state: "anonymous" }));

    await expect(logout).resolves.toBe(false);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBe(newer);
    expect(document.cookie).toContain("__Host-spott_logout_intent=");
  });

  test.each(["expected-null", "expected-non-null"] as const)(
    "preserves a newer refresh after an %s snapshot",
    async (initialState) => {
      const refreshKey = "spott.web.refresh-attempt.v1";
      if (initialState === "expected-non-null") {
        window.localStorage.setItem(refreshKey, JSON.stringify({
          attemptId: "019b0000-0000-7000-8000-000000000581",
          sessionId: session.sessionId,
          refreshGeneration: session.refreshGeneration,
          createdAt: Date.now(),
        }));
      }
      let resolveLogout!: (response: Response) => void;
      const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
      vi.stubGlobal("fetch", vi.fn(async () => response));
      const logout = logoutCurrentSession("current");
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      const newer = JSON.stringify({
        attemptId: initialState === "expected-null"
          ? "019b0000-0000-7000-8000-000000000582"
          : "019b0000-0000-7000-8000-000000000583",
        sessionId: session.sessionId,
        refreshGeneration: session.refreshGeneration + 1,
        createdAt: Date.now(),
      });
      window.localStorage.setItem(refreshKey, newer);
      resolveLogout(json({ state: "anonymous" }));

      await expect(logout).resolves.toBe(false);
      expect(window.localStorage.getItem(refreshKey)).toBe(newer);
      expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
    },
  );

  test("preserves a newer completion written after an exact-empty snapshot", async () => {
    let resolveLogout!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const logout = logoutCurrentSession("current");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const { attempt } = seedCompletionPhase(
      "prepared",
      "019b0000-0000-7000-8000-000000000584",
    );
    resolveLogout(json({ state: "anonymous" }));

    await expect(logout).resolves.toBe(false);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("revalidates exact-empty completion state before classifying current 401 terminal", async () => {
    let resolveLogout!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const logout = logoutCurrentSession("current");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const { attempt } = seedCompletionPhase(
      "prepared",
      "019b0000-0000-7000-8000-000000000587",
    );
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
    expect(document.cookie).not.toContain("__Host-spott_logout_intent=");
    resolveLogout(json({ error: { code: "SESSION_REAUTH_REQUIRED" } }, 401));

    await expect(logout).resolves.toBe(false);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
    expect(document.cookie).toContain("__Host-spott_logout_intent=");
  });

  test("preserves expected-null attempt resume and device state when a newer resume appears", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000585";
    const { attempt } = seedCompletionPhase("prepared", challengeId);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    let resolveLogout!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const logout = logoutCurrentSession("current");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const newerResume = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    window.localStorage.setItem(resumeKey, newerResume);
    resolveLogout(json({ state: "anonymous" }));

    await expect(logout).resolves.toBe(false);
    expect(window.localStorage.getItem(resumeKey)).toBe(newerResume);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("does not broadly clear or reconcile a changed resume namespace before terminal logout", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000586";
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const originalResume = JSON.stringify({ version: 1, challengeId, marker: "original" });
    window.localStorage.setItem(resumeKey, originalResume);
    let resumeObservedAtFetch: string | null = null;
    let resolveLogout!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => {
      resumeObservedAtFetch = window.localStorage.getItem(resumeKey);
      return response;
    }));
    const logout = logoutCurrentSession("current");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    const newerResume = JSON.stringify({ version: 1, challengeId, marker: "newer" });
    window.localStorage.setItem(resumeKey, newerResume);
    resolveLogout(json({ state: "anonymous" }));

    await expect(logout).resolves.toBe(false);
    expect(resumeObservedAtFetch).toBe(originalResume);
    expect(window.localStorage.getItem(resumeKey)).toBe(newerResume);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("keeps the logout tombstone and completion intact when a new resume is produced after cleanup preflight", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000588";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    const capturedResumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const capturedResume = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    window.localStorage.setItem(capturedResumeKey, capturedResume);
    const newerChallengeId = "019b0000-0000-7000-8000-000000000589";
    const newerResumeKey = `spott.web.login-switch-resume.v1.${newerChallengeId}`;
    const newerResume = JSON.stringify({
      version: 1,
      challengeId: newerChallengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeSetItem = Storage.prototype.setItem;
    let produced = false;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeItem(
      this: Storage,
      key: string,
    ) {
      nativeRemoveItem.call(this, key);
      if (!produced && key === capturedResumeKey) {
        produced = true;
        nativeSetItem.call(this, newerResumeKey, newerResume);
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "anonymous" })));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(produced).toBe(true);
    expect(window.localStorage.getItem(newerResumeKey)).toBe(newerResume);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("keeps the logout tombstone when a completion is produced after cleanup preflight", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-00000000058a");
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeSetItem = Storage.prototype.setItem;
    const createdAt = Date.now();
    const producedAttempt = {
      schemaVersion: SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION,
      challengeId: "019b0000-0000-7000-8000-00000000058b",
      attemptId: "019b0000-0000-7000-8000-00000000058c",
      predecessorDeviceId: input.device.predecessorId,
      candidateDeviceId: input.device.deviceId,
      phase: "prepared",
      createdAt,
      updatedAt: createdAt,
      prepareExpiresAt: createdAt + 120_000,
    } satisfies PendingSessionCompletionAttempt;
    let produced = false;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeItem(
      this: Storage,
      key: string,
    ) {
      nativeRemoveItem.call(this, key);
      if (!produced && key === "spott.web.logout-intent.v1") {
        produced = true;
        nativeSetItem.call(
          this,
          SESSION_COMPLETION_ATTEMPT_STORAGE_KEY,
          JSON.stringify(producedAttempt),
        );
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "anonymous" })));

    const result = await logoutCurrentSession("current");
    expect(produced).toBe(true);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [producedAttempt] });
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
    expect(result).toBe(false);
  });

  test("never rolls back a committed device before detecting an after-preflight attempt replacement", async () => {
    const challengeId = "019b0000-0000-7000-8000-00000000058d";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    window.localStorage.setItem(resumeKey, JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    }));
    const replacement = {
      ...attempt,
      attemptId: "019b0000-0000-7000-8000-00000000058e",
      updatedAt: attempt.updatedAt + 1,
    } satisfies PendingSessionCompletionAttempt;
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeSetItem = Storage.prototype.setItem;
    let replaced = false;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeItem(
      this: Storage,
      key: string,
    ) {
      nativeRemoveItem.call(this, key);
      if (!replaced && key === resumeKey) {
        replaced = true;
        nativeSetItem.call(
          this,
          SESSION_COMPLETION_ATTEMPT_STORAGE_KEY,
          JSON.stringify(replacement),
        );
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "anonymous" })));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(replaced).toBe(true);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [replacement] });
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("never performs terminal logout cleanup after another tab steals the fallback lease", async () => {
    const challengeId = "019b0000-0000-7000-8000-00000000058f";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    window.localStorage.setItem(resumeKey, resumeRaw);
    let resolveLogout!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => { resolveLogout = resolve; });
    const fetchMock = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetchMock);

    const logout = logoutCurrentSession("current");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const leaseKey = "spott.web.session-mutation-lease.v1";
    expect(window.localStorage.getItem(leaseKey)).not.toBeNull();
    window.localStorage.setItem(leaseKey, JSON.stringify({
      version: 1,
      ownerId: "lease-stealing-tab",
      nonce: "lease-stealing-nonce",
      expiresAt: Date.now() + 10_000,
    }));
    resolveLogout(json({ state: "anonymous" }));

    await expect(logout).resolves.toBe(false);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("performs zero cleanup when a committed device read is transiently unavailable", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000590";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    window.localStorage.setItem(resumeKey, resumeRaw);
    const nativeGetItem = Storage.prototype.getItem;
    let responseReturned = false;
    let committedReadFailed = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      if (
        responseReturned
        && !committedReadFailed
        && key === "spott.web.device.v1"
      ) {
        committedReadFailed = true;
        return attempt.predecessorDeviceId;
      }
      return nativeGetItem.call(this, key);
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      responseReturned = true;
      return json({ state: "anonymous" });
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(committedReadFailed).toBe(true);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("restores a committed device with its attempt when authority is fenced after rollback", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000591";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    window.localStorage.setItem(resumeKey, resumeRaw);
    const nativeGetItem = Storage.prototype.getItem;
    const nativeSetItem = Storage.prototype.setItem;
    const leaseKey = "spott.web.session-mutation-lease.v1";
    let responseReturned = false;
    let committedReadFailed = false;
    let fencedAfterRollback = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      if (
        responseReturned
        && !committedReadFailed
        && key === "spott.web.device.v1"
      ) {
        committedReadFailed = true;
        return attempt.predecessorDeviceId;
      }
      return nativeGetItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      nativeSetItem.call(this, key, value);
      if (
        committedReadFailed
        && !fencedAfterRollback
        && key === "spott.web.device.v1"
        && value === attempt.predecessorDeviceId
      ) {
        fencedAfterRollback = true;
        nativeSetItem.call(this, leaseKey, JSON.stringify({
          version: 1,
          ownerId: "post-rollback-fencing-tab",
          nonce: "post-rollback-fencing-lease",
          expiresAt: Date.now() + 10_000,
        }));
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      responseReturned = true;
      return json({ state: "anonymous" });
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(committedReadFailed).toBe(true);
    expect(fencedAfterRollback).toBe(false);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("restores the validated committed device and attempt after a real rollback fence", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000594";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: attempt.predecessorDeviceId,
      candidateDeviceId: attempt.candidateDeviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    window.localStorage.setItem(resumeKey, resumeRaw);
    const nativeSetItem = Storage.prototype.setItem;
    const leaseKey = "spott.web.session-mutation-lease.v1";
    let fencedAfterRollback = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      nativeSetItem.call(this, key, value);
      if (
        !fencedAfterRollback
        && key === "spott.web.device.v1"
        && value === attempt.predecessorDeviceId
      ) {
        fencedAfterRollback = true;
        nativeSetItem.call(this, leaseKey, JSON.stringify({
          version: 1,
          ownerId: "validated-rollback-fencing-tab",
          nonce: "validated-rollback-fencing-lease",
          expiresAt: Date.now() + 10_000,
        }));
      }
    });
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "anonymous" })));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(fencedAfterRollback).toBe(true);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("fails closed for a legacy v1 logout intent with an origin-ambiguous switch resume", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000592";
    const device = anonymousLoginInput(challengeId).device;
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = JSON.stringify({
      version: 1,
      challengeId,
      predecessorDeviceId: device.predecessorId,
      candidateDeviceId: device.deviceId,
      expectedUserId: session.user.id,
      expectedSessionId: session.sessionId,
      createdAt: Date.now(),
    });
    const intent = {
      epoch: 71,
      scope: "current",
      sessionId: session.sessionId,
      createdAt: Date.now(),
    };
    const intentRaw = JSON.stringify(intent);
    window.localStorage.setItem(resumeKey, resumeRaw);
    window.localStorage.setItem("spott.web.logout-intent.v1", intentRaw);
    document.cookie = `__Host-spott_logout_intent=v1.71.current.${session.sessionId}; Path=/; Secure; SameSite=Strict`;
    const fetchMock = vi.fn(async () => json({ state: "anonymous" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBe(intentRaw);
    expect(document.cookie).toContain("__Host-spott_logout_intent=v1.71.current");
  });

  test("fails closed when only a legacy v1 Cookie remains with a durable completion", async () => {
    const challengeId = "019b0000-0000-7000-8000-000000000593";
    const { attempt } = seedCompletionPhase("accepting", challengeId);
    document.cookie = `__Host-spott_logout_intent=v1.72.current.${session.sessionId}; Path=/; Secure; SameSite=Strict`;
    const fetchMock = vi.fn(async () => json({ state: "anonymous" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [attempt] });
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(attempt.candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
    expect(document.cookie).toContain("__Host-spott_logout_intent=v1.72.current");
  });

  test("rolls back a registered switch resume if a logout tombstone appears during its write", async () => {
    saveSession(session);
    const input = {
      challengeId: "019b0000-0000-7000-8000-00000000058f",
      code: "123456",
      device: prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    const logoutRaw = JSON.stringify({
      epoch: 999,
      scope: "current",
      sessionId: session.sessionId,
      createdAt: Date.now(),
    });
    const nativeSetItem = Storage.prototype.setItem;
    let armed = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      nativeSetItem.call(this, key, value);
      if (!armed && key === resumeKey) {
        armed = true;
        nativeSetItem.call(this, "spott.web.logout-intent.v1", logoutRaw);
      }
    });

    await expect(registerEmailSessionSwitch(input)).resolves.toBe(false);
    expect(armed).toBe(true);
    expect(window.localStorage.getItem(resumeKey)).toBeNull();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBe(logoutRaw);
  });

  test("re-checks a queued refresh attempt after obtaining cross-tab mutation authority", async () => {
    saveSession(session);
    window.localStorage.setItem("spott.web.refresh-attempt.v1", JSON.stringify({
      attemptId: "019b0000-0000-7000-8000-0000000000a1",
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
      createdAt: Date.now(),
    }));
    let releaseAuthority!: () => void;
    const authorityReleased = new Promise<void>((resolve) => {
      releaseAuthority = resolve;
    });
    let authorityObserved!: () => void;
    const authorityAcquired = new Promise<void>((resolve) => {
      authorityObserved = resolve;
    });
    const blocker = createSessionRefreshCoordinator();
    const blockingMutation = blocker.coordinateMutation(async () => {
      authorityObserved();
      await authorityReleased;
      return true;
    });
    await authorityAcquired;
    const successor = {
      ...session,
      accessToken: "queued-bootstrap-successor",
      refreshGeneration: session.refreshGeneration + 1,
    };
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/bootstrap") {
        return json({ state: "authenticated", ...successor });
      }
      if (url === "/api/session/refresh") {
        return json({ state: "authenticated", ...successor });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const refresh = refreshCurrentSession();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).toEqual([]);
    window.localStorage.removeItem("spott.web.refresh-attempt.v1");
    releaseAuthority();

    await expect(blockingMutation).resolves.toBe(true);
    await expect(refresh).resolves.toEqual(successor);
    expect(requests).toEqual(["/api/session/bootstrap"]);
  });

  test("serializes an account-switch completion behind an in-flight refresh mutation", async () => {
    saveSession(session);
    seedPrivateBrowserDrafts();
    const refreshSuccessor = {
      ...session,
      accessToken: "refresh-before-account-switch",
      refreshGeneration: session.refreshGeneration + 1,
    };
    const nextAccount: WebSession = {
      ...session,
      accessToken: "next-account-access-token",
      sessionId: "019b0000-0000-7000-8000-000000000021",
      refreshGeneration: 0,
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000022" },
    };
    let resolveRefresh!: (response: Response) => void;
    const refreshResponse = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    const requests: string[] = [];
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/bootstrap") {
        return json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/refresh") return refreshResponse;
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/complete") {
        expectPrivateBrowserDraftsCleared();
      }
      const response = await completion(url, init);
      if (response) return response;
      throw new Error(`Unexpected request: ${url}`);
    }));

    const refresh = refreshCurrentSession();
    await vi.waitFor(() => expect(requests).toContain("/api/session/refresh"));
    const switchInput = {
      challengeId: "019b0000-0000-7000-8000-000000000023",
      code: "123456",
      device: prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    const accountSwitch = (async () => {
      await expect(registerEmailSessionSwitch(switchInput)).resolves.toBe(true);
      return completeEmailSession(switchInput);
    })();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requests).not.toContain("/api/session/complete");
    expect(requests).not.toContain("/api/session/logout");

    resolveRefresh(json({ state: "authenticated", ...refreshSuccessor }));
    await expect(refresh).resolves.toEqual(refreshSuccessor);
    await expect(accountSwitch).resolves.toEqual(nextAccount);
    expect(requests.indexOf("/api/session/logout"))
      .toBeGreaterThan(requests.indexOf("/api/session/refresh"));
    expect(requests.indexOf("/api/session/complete"))
      .toBeGreaterThan(requests.indexOf("/api/session/logout"));
    expect(readSession()).toEqual(nextAccount);
    expectPrivateBrowserDraftsCleared();
  });

  test("never starts account completion when prior-session revocation is unconfirmed", async () => {
    saveSession(session);
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/logout") {
        return json({ error: { code: "SESSION_LOGOUT_UNAVAILABLE" } }, 503);
      }
      if (url === "/api/session/complete") {
        throw new Error("completion must not run");
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(
      await accountSwitchInput("019b0000-0000-7000-8000-000000000093"),
    )).rejects.toThrow("Unable to complete sign in.");

    expect(requests).toEqual(["/api/session/logout"]);
    expect(readSession()).toEqual(session);
  });

  test("retries a preserved account switch after prior-session logout is temporarily unavailable", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005a1");
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    const resumeRaw = window.localStorage.getItem(resumeKey);
    const nextAccount: WebSession = {
      ...session,
      accessToken: "logout-retry-switch-access-token",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000005a2",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000005a3" },
    };
    const requests: string[] = [];
    let logoutCalls = 0;
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") {
        logoutCalls += 1;
        return logoutCalls === 1
          ? json({ error: { code: "SESSION_LOGOUT_UNAVAILABLE" } }, 503)
          : json({ state: "anonymous" });
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    expect(readSession()).toEqual(session);
    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();

    await expect(completeEmailSession(input)).resolves.toEqual(nextAccount);

    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
    expect(window.localStorage.getItem(resumeKey)).toBeNull();
    expect(readSession()).toEqual(nextAccount);
  });

  test("recovers a v2 switch origin and preserved challenge from Cookie-only logout state", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005a4");
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    const resumeRaw = window.localStorage.getItem(resumeKey);
    const nextAccount: WebSession = {
      ...session,
      accessToken: "cookie-recovered-switch-access-token",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000005a5",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000005a6" },
    };
    let logoutCalls = 0;
    let recoveredIntent: Record<string, unknown> | null = null;
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url === "/api/session/logout") {
        logoutCalls += 1;
        if (logoutCalls === 1) {
          return json({ error: { code: "SESSION_LOGOUT_UNAVAILABLE" } }, 503);
        }
        recoveredIntent = JSON.parse(
          window.localStorage.getItem("spott.web.logout-intent.v1") ?? "null",
        ) as Record<string, unknown> | null;
        return json({ state: "anonymous" });
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    expect(document.cookie).toContain("__Host-spott_logout_intent=v2.");
    window.localStorage.removeItem("spott.web.logout-intent.v1");

    await expect(completeEmailSession(input)).resolves.toEqual(nextAccount);

    expect(recoveredIntent).toMatchObject({
      origin: "switch",
      preservedSwitchChallengeId: input.challengeId,
    });
    expect(window.localStorage.getItem(resumeKey)).toBeNull();
    expect(resumeRaw).not.toBeNull();
    expect(readSession()).toEqual(nextAccount);
  });

  test("marks a new explicit logout as user-originated and never preserves switch state", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005a7");
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    let capturedIntent: Record<string, unknown> | null = null;
    let capturedCookie = "";
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      expect(String(request)).toBe("/api/session/logout");
      capturedIntent = JSON.parse(
        window.localStorage.getItem("spott.web.logout-intent.v1") ?? "null",
      ) as Record<string, unknown> | null;
      capturedCookie = document.cookie;
      return json({ state: "anonymous" });
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(true);

    expect(capturedIntent).toMatchObject({ origin: "user", scope: "current" });
    expect(capturedIntent).not.toHaveProperty("preservedSwitchChallengeId");
    expect(capturedCookie).toContain("__Host-spott_logout_intent=v1.");
    expect(capturedCookie).not.toContain("__Host-spott_logout_intent=v2.");
    expect(window.localStorage.getItem(resumeKey)).toBeNull();
  });

  test("keeps a newer explicit user logout authoritative when an older switch rearm races it", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005aa");
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    const oldSwitchIntent = {
      epoch: 100,
      scope: "current",
      sessionId: session.sessionId,
      origin: "switch",
      preservedSwitchChallengeId: input.challengeId,
      createdAt: Date.now(),
    } as const;
    const oldSwitchRaw = JSON.stringify(oldSwitchIntent);
    window.localStorage.setItem("spott.web.logout-intent.v1", oldSwitchRaw);
    document.cookie = [
      `__Host-spott_logout_intent=v2.${oldSwitchIntent.epoch}.current`,
      oldSwitchIntent.sessionId,
      oldSwitchIntent.preservedSwitchChallengeId,
    ].join(".") + "; Path=/; Secure; SameSite=Strict";

    const nativeSetItem = Storage.prototype.setItem;
    let rejectedUserMetadataWrites = 0;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      if (
        key === "spott.web.logout-intent.v1"
        && value.includes('"origin":"user"')
      ) {
        rejectedUserMetadataWrites += 1;
        throw new DOMException("User logout metadata write denied", "SecurityError");
      }
      nativeSetItem.call(this, key, value);
    });

    let rejectOldSwitchLogout!: (reason: unknown) => void;
    const oldSwitchLogout = new Promise<Response>((_resolve, reject) => {
      rejectOldSwitchLogout = reject;
    });
    let resolveUserLogout!: (response: Response) => void;
    const userLogout = new Promise<Response>((resolve) => {
      resolveUserLogout = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      expect(url).toBe("/api/session/logout");
      return requests.length === 1 ? oldSwitchLogout : userLogout;
    }));

    const oldRecovery = completeEmailSession(input);
    await vi.waitFor(() => expect(requests).toEqual(["/api/session/logout"]));
    const explicitLogout = logoutCurrentSession("current");
    rejectOldSwitchLogout(new TypeError("old switch logout response lost"));
    await expect(oldRecovery).rejects.toThrow("Unable to complete sign in.");
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The old writer has finished rearming, while the newer user request is
    // still awaiting its terminal response. Cookie authority must stay user.
    expect(rejectedUserMetadataWrites).toBeGreaterThan(0);
    await vi.waitFor(() => expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/logout",
    ]));
    expect(document.cookie).toContain("__Host-spott_logout_intent=v1.");
    expect(document.cookie).not.toContain("__Host-spott_logout_intent=v2.");
    expect(window.localStorage.getItem(resumeKey)).toBeNull();

    resolveUserLogout(json({ state: "anonymous" }));
    await expect(explicitLogout).resolves.toBe(true);

    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(document.cookie).not.toContain("__Host-spott_logout_intent=");
    expect(window.localStorage.getItem(resumeKey)).toBeNull();
    expect(readSession()).toBeNull();
  });

  test("never lets a switch reservation overwrite a newer explicit logout intent", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005b1");
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    const newerIntentRaw = JSON.stringify({
      epoch: 999,
      scope: "all",
      sessionId: session.sessionId,
      createdAt: Date.now() + 1,
    });
    const leaseKey = "spott.web.session-mutation-lease.v1";
    const nativeGetItem = Storage.prototype.getItem;
    const nativeSetItem = Storage.prototype.setItem;
    let injected = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      const current = nativeGetItem.call(this, key);
      if (!injected && key === resumeKey) {
        injected = true;
        nativeSetItem.call(this, leaseKey, JSON.stringify({
          version: 1,
          ownerId: "explicit-logout-tab",
          nonce: "explicit-logout-lease",
          expiresAt: Date.now() + 10_000,
        }));
        nativeSetItem.call(this, "spott.web.logout-intent.v1", newerIntentRaw);
      }
      return current;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("logout must not start after the switch loses authority");
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(injected).toBe(true);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBe(newerIntentRaw);
    expect(window.localStorage.getItem(resumeKey)).not.toBeNull();
    expect(readSession()).toEqual(session);
  });

  test("blocks a newer session publication after losing preliminary switch authority", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005b2");
    const resumeKey = `spott.web.login-switch-resume.v1.${input.challengeId}`;
    const newerSession: WebSession = {
      ...session,
      accessToken: "newer-session-must-survive",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000005b3",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000005b4" },
    };
    const expectedMetadataRaw = JSON.stringify({
      state: "authenticated",
      userId: session.user.id,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
    });
    const leaseKey = "spott.web.session-mutation-lease.v1";
    const nativeGetItem = Storage.prototype.getItem;
    const nativeSetItem = Storage.prototype.setItem;
    let resumeReads = 0;
    let injected = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      const current = nativeGetItem.call(this, key);
      if (key === resumeKey) {
        resumeReads += 1;
        if (!injected && resumeReads === 2) {
          injected = true;
          nativeSetItem.call(this, leaseKey, JSON.stringify({
            version: 1,
            ownerId: "new-session-tab",
            nonce: "new-session-lease",
            expiresAt: Date.now() + 10_000,
          }));
          saveSession(newerSession);
        }
      }
      return current;
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("logout must not start after the switch loses authority");
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(injected).toBe(true);
    expect(readSession()).toEqual(session);
    expect(window.localStorage.getItem("spott.web.session-metadata.v1"))
      .toBe(expectedMetadataRaw);
    expect(window.localStorage.getItem(resumeKey)).not.toBeNull();
  });

  test("blocks an authenticated publication inside the terminal anonymous commit window", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000005b5");
    const nextAccount: WebSession = {
      ...session,
      accessToken: "terminal-window-next-account",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000005b6",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000005b7" },
    };
    const competingSession: WebSession = {
      ...session,
      accessToken: "terminal-window-competing-session",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000005b8",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000005b9" },
    };
    const completion = completionProtocol(nextAccount);
    const nativeGetItem = Storage.prototype.getItem;
    let logoutResponseReturned = false;
    let sessionMetadataReads = 0;
    let competingPublicationAttempted = false;
    let competingPublicationBecameVisible = false;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(
      this: Storage,
      key: string,
    ) {
      const current = nativeGetItem.call(this, key);
      if (logoutResponseReturned && key === "spott.web.session-metadata.v1") {
        sessionMetadataReads += 1;
        if (!competingPublicationAttempted && sessionMetadataReads === 3) {
          competingPublicationAttempted = true;
          saveSession(competingSession);
          competingPublicationBecameVisible = readSession() === competingSession;
        }
      }
      return current;
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      if (url === "/api/session/logout") {
        logoutResponseReturned = true;
        return json({ state: "anonymous" });
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).resolves.toEqual(nextAccount);

    expect(competingPublicationAttempted).toBe(true);
    expect(competingPublicationBecameVisible).toBe(false);
    expect(readSession()).toEqual(nextAccount);
  });

  test("finishes a pending logout before signing in again without a reload", async () => {
    saveSession(session);
    const requests: string[] = [];
    let logoutCalls = 0;
    const nextAccount: WebSession = {
      ...session,
      accessToken: "same-page-relogin-access-token",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000000d1",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000000d2" },
    };
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") {
        logoutCalls += 1;
        return logoutCalls === 1
          ? json({ error: { code: "LOGOUT_PENDING", retryable: true } }, 409)
          : json({ state: "anonymous" });
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();

    const input = anonymousLoginInput("019b0000-0000-7000-8000-0000000000d3");
    await expect(completeEmailSession(input)).resolves.toEqual(nextAccount);

    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(readSession()).toEqual(nextAccount);
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(input.device.deviceId);
  });

  test("never signs in over a durable logout tombstone that cannot be cleared", async () => {
    saveSession(session);
    let blockTombstoneClear = false;
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (blockTombstoneClear && key === "spott.web.logout-intent.v1") {
        throw new DOMException("Storage denied", "SecurityError");
      }
      return nativeRemoveItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (
        blockTombstoneClear
        && key === "spott.web.logout-intent.v1"
        && value === ""
      ) throw new DOMException("Storage denied", "SecurityError");
      return nativeSetItem.call(this, key, value);
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") {
        blockTombstoneClear = true;
        return json({ state: "anonymous" });
      }
      if (url === "/api/session/complete") {
        throw new Error("completion must not run over a pending logout");
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();

    const input = anonymousLoginInput("019b0000-0000-7000-8000-0000000000d4");
    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(requests).toEqual(["/api/session/logout", "/api/session/logout"]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("keeps logout recovery armed when an earlier refresh attempt cannot be cleared", async () => {
    saveSession(session);
    window.localStorage.setItem("spott.web.refresh-attempt.v1", JSON.stringify({
      attemptId: "019b0000-0000-7000-8000-0000000000d8",
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
      createdAt: Date.now(),
    }));
    let blockRefreshClear = false;
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (blockRefreshClear && key === "spott.web.refresh-attempt.v1") {
        throw new DOMException("Storage denied", "SecurityError");
      }
      return nativeRemoveItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (blockRefreshClear && key === "spott.web.refresh-attempt.v1" && value === "") {
        throw new DOMException("Storage denied", "SecurityError");
      }
      return nativeSetItem.call(this, key, value);
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") {
        blockRefreshClear = true;
        return json({ state: "anonymous" });
      }
      if (url === "/api/session/complete") {
        throw new Error("completion must not run over refresh cleanup failure");
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(false);
    expect(window.localStorage.getItem("spott.web.refresh-attempt.v1")).not.toBeNull();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();

    const input = anonymousLoginInput("019b0000-0000-7000-8000-0000000000d9");
    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    expect(requests).toEqual(["/api/session/logout", "/api/session/logout"]);
    expect(readSession()).toBeNull();
  });

  test("never restores a completed account after logout starts while completion holds the lock", async () => {
    saveSession(session);
    const nextAccount: WebSession = {
      ...session,
      accessToken: "late-completion-access-token",
      sessionId: "019b0000-0000-7000-8000-000000000061",
      refreshGeneration: 0,
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000062" },
    };
    let resolveCompletion!: (response: Response) => void;
    const completionResponse = new Promise<Response>((resolve) => {
      resolveCompletion = resolve;
    });
    const requests: string[] = [];
    const completionProtocolHandler = completionProtocol(nextAccount, {
      ready: () => completionResponse,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      const completionResult = await completionProtocolHandler(url, init);
      if (completionResult) return completionResult;
      throw new Error(`Unexpected request: ${url}`);
    }));

    const completion = completeEmailSession(
      await accountSwitchInput("019b0000-0000-7000-8000-000000000063"),
    );
    await vi.waitFor(() => expect(requests).toContain("/api/session/complete"));
    const logout = logoutCurrentSession("current");
    expect(readSession()).toBeNull();
    expect(requests.filter((request) => request === "/api/session/logout")).toHaveLength(1);

    resolveCompletion(json({
      state: "completion_ready",
      attemptId: runtimeCompletionAttemptId,
      expiresAt: Date.now() + 120_000,
    }, 202));
    await expect(completion).rejects.toThrow("Unable to complete sign in.");
    await expect(logout).resolves.toBe(true);
    expect(requests.filter((request) => request === "/api/session/logout").length)
      .toBeGreaterThanOrEqual(2);
    expect(requests).not.toContain("/api/session/completion/discard");
    expect(requests).not.toContain("/api/session/completion/accept");
    expect(readSession()).toBeNull();
  });

  test("abandoning a paused account switch fences its in-flight completion", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000000d5");
    const nextAccount: WebSession = {
      ...session,
      accessToken: "abandoned-switch-access-token",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000000d6",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000000d7" },
    };
    let resolveCompletion!: (response: Response) => void;
    const completionResponse = new Promise<Response>((resolve) => {
      resolveCompletion = resolve;
    });
    const requests: string[] = [];
    const completionProtocolHandler = completionProtocol(nextAccount, {
      ready: () => completionResponse,
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      const completionResult = await completionProtocolHandler(url, init);
      if (completionResult) return completionResult;
      throw new Error(`Unexpected request: ${url}`);
    }));

    const completion = completeEmailSession(input);
    await vi.waitFor(() => expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
    ]));
    expect(abandonEmailSessionSwitch(input.challengeId)).toBe(true);
    resolveCompletion(json({
      state: "completion_ready",
      attemptId: runtimeCompletionAttemptId,
      expiresAt: Date.now() + 120_000,
    }, 202));

    await expect(completion).rejects.toThrow("Unable to complete sign in.");
    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/completion/discard",
    ]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);
  });

  test("lets only the first of two stale account-switch plans publish a session", async () => {
    saveSession(session);
    const firstPlan = prepareEmailLoginDevice({ switching: true });
    const secondPlan = prepareEmailLoginDevice({ switching: true });
    const firstAccount: WebSession = {
      ...session,
      accessToken: "first-switch-wins",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-000000000071",
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000072" },
    };
    let resolveCompletion!: (response: Response) => void;
    const completionResponse = new Promise<Response>((resolve) => {
      resolveCompletion = resolve;
    });
    const requests: string[] = [];
    const completionProtocolHandler = completionProtocol(firstAccount, {
      ready: () => completionResponse,
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      const completionResult = await completionProtocolHandler(url, init);
      if (completionResult) return completionResult;
      throw new Error(`Unexpected request: ${url}`);
    }));
    const expectedSession = {
      state: "authenticated" as const,
      userId: session.user.id,
      sessionId: session.sessionId,
    };
    const firstInput = {
      challengeId: "019b0000-0000-7000-8000-000000000073",
      code: "123456",
      device: firstPlan,
      expectedSession,
    };
    const secondInput = {
      challengeId: "019b0000-0000-7000-8000-000000000074",
      code: "654321",
      device: secondPlan,
      expectedSession,
    };
    await expect(registerEmailSessionSwitch(firstInput)).resolves.toBe(true);
    await expect(registerEmailSessionSwitch(secondInput)).resolves.toBe(true);

    const first = completeEmailSession(firstInput);
    await vi.waitFor(() => expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
    ]));
    const second = completeEmailSession(secondInput);

    resolveCompletion(json({
      state: "completion_ready",
      attemptId: runtimeCompletionAttemptId,
      expiresAt: Date.now() + 120_000,
    }, 202));

    await expect(first).resolves.toEqual(firstAccount);
    await expect(second).rejects.toThrow("Unable to complete sign in.");
    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
    expect(readSession()).toEqual(firstAccount);
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(firstPlan.deviceId);
  });

  test("terminates an unpublished completion when the final device write cannot be verified", async () => {
    const input = anonymousLoginInput("019b0000-0000-7000-8000-000000000081");
    let completionReturned = false;
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (completionReturned && key === "spott.web.device-binding-state.v1") {
        throw new DOMException("Storage denied", "SecurityError");
      }
      return originalSetItem.call(this, key, value);
    });
    const requests: string[] = [];
    const completion = completionProtocol(session);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (
        url === "/api/session/complete"
        && (JSON.parse(String(init?.body)) as { attemptId?: unknown }).attemptId !== undefined
      ) {
        completionReturned = true;
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(requests).toEqual([
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/discard",
    ]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(input.device.predecessorId);
    const retryPlan = prepareEmailLoginDevice({ switching: false });
    expect(retryPlan).toMatchObject({
      kind: "rotate",
      predecessorId: input.device.predecessorId,
    });
    expect(retryPlan.deviceId).not.toBe(input.device.deviceId);
  });

  test("never publishes an account switch when the candidate device write is rejected", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000000e1");
    const nextAccount: WebSession = {
      ...session,
      accessToken: "rejected-device-write",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000000e2",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000000e3" },
    };
    let completionReturned = false;
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (
        completionReturned
        && key === "spott.web.device.v1"
        && value === input.device.deviceId
      ) throw new DOMException("Storage denied", "SecurityError");
      return nativeSetItem.call(this, key, value);
    });
    const requests: string[] = [];
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (
        url === "/api/session/complete"
        && (JSON.parse(String(init?.body)) as { attemptId?: unknown }).attemptId !== undefined
      ) {
        completionReturned = true;
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/discard",
    ]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);
    expect(window.localStorage.getItem("spott.web.device-binding-state.v1")).toBe("bound");
  });

  test("rolls back a candidate written before its storage readback fails", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000000f1");
    const nextAccount: WebSession = {
      ...session,
      accessToken: "failed-device-readback",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-0000000000f2",
      user: { ...session.user, id: "019b0000-0000-7000-8000-0000000000f3" },
    };
    let completionReturned = false;
    let candidateWritten = false;
    let candidateReadbackFailed = false;
    const nativeSetItem = Storage.prototype.setItem;
    const nativeGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      const result = nativeSetItem.call(this, key, value);
      if (
        completionReturned
        && key === "spott.web.device.v1"
        && value === input.device.deviceId
      ) candidateWritten = true;
      return result;
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (
      this: Storage,
      key,
    ) {
      if (
        candidateWritten
        && !candidateReadbackFailed
        && key === "spott.web.device.v1"
      ) {
        candidateReadbackFailed = true;
        throw new DOMException("Storage readback denied", "SecurityError");
      }
      return nativeGetItem.call(this, key);
    });
    const requests: string[] = [];
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (
        url === "/api/session/complete"
        && (JSON.parse(String(init?.body)) as { attemptId?: unknown }).attemptId !== undefined
      ) {
        completionReturned = true;
      }
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(candidateWritten).toBe(true);
    expect(candidateReadbackFailed).toBe(true);
    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/discard",
    ]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);
    expect(window.localStorage.getItem("spott.web.device-binding-state.v1")).toBe("bound");
  });

  test("retries the same account-switch plan after a transient completion failure", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-000000000091");
    const nextAccount: WebSession = {
      ...session,
      accessToken: "retry-switch-success",
      refreshGeneration: 0,
      sessionId: "019b0000-0000-7000-8000-000000000092",
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000093" },
    };
    let completionCalls = 0;
    const requests: string[] = [];
    const completion = completionProtocol(nextAccount, {
      ready: () => {
        completionCalls += 1;
        return completionCalls === 1
          ? json({ error: { code: "SESSION_COMPLETION_UNAVAILABLE", retryable: true } }, 503)
          : json({
              state: "completion_ready",
              attemptId: runtimeCompletionAttemptId,
              expiresAt: Date.now() + 120_000,
            }, 202);
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);

    await expect(completeEmailSession(input)).resolves.toEqual(nextAccount);
    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(input.device.deviceId);
  });

  test("never accepts a stale switch challenge after an explicit logout completes", async () => {
    saveSession(session);
    const input = await accountSwitchInput("019b0000-0000-7000-8000-0000000000b1");
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/complete") return json({ state: "authenticated", ...session });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(logoutCurrentSession("current")).resolves.toBe(true);
    expect(readSession()).toBeNull();
    requests.length = 0;

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    expect(requests).toEqual([]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);
  });

  test("never publishes a completed session after fallback mutation authority is fenced", async () => {
    expect("locks" in navigator).toBe(false);
    const input = anonymousLoginInput("019b0000-0000-7000-8000-0000000000c1");
    let resolveCompletion!: (response: Response) => void;
    const completionResponse = new Promise<Response>((resolve) => {
      resolveCompletion = resolve;
    });
    const requests: string[] = [];
    const completionProtocolHandler = completionProtocol(session, {
      ready: () => completionResponse,
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      const completionResult = await completionProtocolHandler(url, init);
      if (completionResult) return completionResult;
      throw new Error(`Unexpected request: ${url}`);
    }));

    const completion = completeEmailSession(input);
    await vi.waitFor(() => expect(requests).toEqual(["/api/session/complete"]));
    const leaseKey = "spott.web.session-mutation-lease.v1";
    const activeLease = JSON.parse(window.localStorage.getItem(leaseKey) ?? "null") as {
      version?: unknown;
      expiresAt?: unknown;
    } | null;
    expect(activeLease?.version).toBe(1);
    window.localStorage.setItem(leaseKey, JSON.stringify({
      version: 1,
      ownerId: "fencing-tab",
      nonce: "fencing-lease",
      expiresAt: Date.now() + 10_000,
    }));
    resolveCompletion(json({
      state: "completion_ready",
      attemptId: runtimeCompletionAttemptId,
      expiresAt: Date.now() + 120_000,
    }, 202));

    await expect(completion).rejects.toThrow("Unable to complete sign in.");
    expect(requests).toEqual([
      "/api/session/complete",
      "/api/session/completion/discard",
    ]);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);
  });

  test("clears private drafts when a cold-start stored authority switches accounts", async () => {
    const nextAccount: WebSession = {
      ...session,
      accessToken: "cold-switch-access-token",
      sessionId: "019b0000-0000-7000-8000-000000000041",
      refreshGeneration: 0,
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000042" },
    };
    window.localStorage.setItem("spott.web.session-metadata.v1", JSON.stringify({
      state: "authenticated",
      userId: session.user.id,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
    }));
    seedPrivateBrowserDrafts();
    const requests: string[] = [];
    const completion = completionProtocol(nextAccount);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      const completionResponse = await completion(url, init);
      if (completionResponse) return completionResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(
      await accountSwitchInput("019b0000-0000-7000-8000-000000000043"),
    )).resolves.toEqual(nextAccount);

    expectPrivateBrowserDraftsCleared();
    expect(requests).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
  });

  test("preserves an anonymous registration draft through first sign-in", async () => {
    const anonymousDraftKey = registrationDraftKeys[1];
    const firstSession = { ...session, refreshGeneration: 0 };
    window.sessionStorage.setItem(anonymousDraftKey, "anonymous-registration-draft");
    const completion = completionProtocol(firstSession);
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const response = await completion(String(request), init);
      if (response) return response;
      throw new Error(`Unexpected request: ${String(request)}`);
    }));

    await expect(completeEmailSession(
      anonymousLoginInput("019b0000-0000-7000-8000-000000000045"),
    )).resolves.toEqual(firstSession);

    expect(window.sessionStorage.getItem(anonymousDraftKey))
      .toBe("anonymous-registration-draft");
  });

  test("clears private drafts after a terminal refresh authority rejection", async () => {
    saveSession(session);
    seedPrivateBrowserDrafts();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/session/bootstrap") {
        return json({ state: "authenticated", ...session });
      }
      if (String(input) === "/api/session/refresh") {
        return terminalBrowserReauthentication();
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    }));

    await expect(refreshCurrentSession()).resolves.toBeNull();

    expect(readSession()).toBeNull();
    expectPrivateBrowserDraftsCleared();
  });

  test("refuses to call logout authority when neither durable intent channel can be read back", async () => {
    saveSession(session);
    const nativeGetItem = Storage.prototype.getItem;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(this: Storage, key: string) {
      if (key === "spott.web.logout-intent.v1") return null;
      return nativeGetItem.call(this, key);
    });
    vi.spyOn(document, "cookie", "set").mockImplementation(() => undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(logoutCurrentSession("current")).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(readSession()).toBeNull();
  });

  test("keeps the logout-intent Cookie armed when local completion inventory is unavailable", async () => {
    saveSession(session);
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const fetchMock = vi.fn()
      .mockImplementationOnce(async () => { throw new TypeError("offline"); })
      .mockImplementationOnce(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/session/logout");
        return json({ state: "anonymous" });
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(logoutCurrentSession("current")).resolves.toBe(false);
    expect(document.cookie).toContain("__Host-spott_logout_intent=");
    await expect(bootstrapSession()).resolves.toBeNull();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.cookie).toContain("__Host-spott_logout_intent=");
    expect(readSession()).toBeNull();
  });

  test.each([
    ["409 LOGOUT_PENDING", async () => json({
      error: { code: "LOGOUT_PENDING", retryable: true },
    }, 409)],
    ["network loss", async () => { throw new TypeError("offline"); }],
  ] as const)("recovers a durable logout after %s on the next bootstrap", async (_label, first) => {
    saveSession(session);
    seedPrivateBrowserDrafts();
    const fetchMock = vi.fn()
      .mockImplementationOnce(first)
      .mockImplementationOnce(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/session/logout");
        return json({ state: "anonymous" });
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(logoutCurrentSession("current")).resolves.toBe(false);
    expectPrivateBrowserDraftsCleared();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
    expect(document.cookie).toContain("__Host-spott_logout_intent=");

    seedPrivateBrowserDrafts();

    await expect(bootstrapSession()).resolves.toBeNull();
    expectPrivateBrowserDraftsCleared();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(document.cookie).not.toContain("__Host-spott_logout_intent=");
  });
});
