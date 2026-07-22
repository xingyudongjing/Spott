import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  bootstrapSession,
  clearSession,
  completeEmailSession,
  logoutCurrentSession,
  prepareEmailLoginDevice,
  readSession,
  registerEmailSessionSwitch,
  saveSession,
  type WebSession,
} from "../app/lib/client-api";
import {
  listPendingSessionCompletionAttempts,
  storePreparedSessionCompletionAttempt,
} from "../app/lib/session-completion-attempt-store";

const challengeId = "019d0000-0000-7000-8000-000000000501";
const attemptId = "019d0000-0000-7000-8000-000000000502";
const bindingId = "019d0000-0000-7000-8000-000000000503";
const session: WebSession = {
  accessToken: "accepted-access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 0,
  sessionId: "019d0000-0000-7000-8000-000000000504",
  user: {
    id: "019d0000-0000-7000-8000-000000000505",
    publicHandle: "accepted-user",
    phoneVerified: true,
    restrictions: [],
  },
};

const predecessorSession: WebSession = {
  ...session,
  accessToken: "predecessor-access-token",
  refreshGeneration: 4,
  sessionId: "019d0000-0000-7000-8000-000000000506",
  user: {
    ...session.user,
    id: "019d0000-0000-7000-8000-000000000507",
    publicHandle: "predecessor-user",
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function anonymousInput() {
  return {
    challengeId,
    code: "123456",
    device: prepareEmailLoginDevice({ switching: false }),
    expectedSession: { state: "anonymous" as const },
  };
}

async function accountSwitchInput() {
  saveSession(predecessorSession);
  const input = {
    challengeId,
    code: "123456",
    device: prepareEmailLoginDevice({ switching: true }),
    expectedSession: {
      state: "authenticated" as const,
      userId: predecessorSession.user.id,
      sessionId: predecessorSession.sessionId,
    },
  };
  await expect(registerEmailSessionSwitch(input)).resolves.toBe(true);
  return input;
}

function completionReady(expiresAt = Date.now() + 120_000): Response {
  return json({
    state: "completion_ready",
    attemptId,
    expiresAt,
  }, 202);
}

function completionPending(deviceId: string): Response {
  return json({
    state: "completion_pending",
    attemptId,
    sessionId: session.sessionId,
    bindingId,
    deviceId,
    reconcileExpiresAt: Date.now() + 2_678_400_000,
  });
}

describe("durable browser session completion transaction", () => {
  beforeEach(() => {
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  test("persists every phase before accepting and publishes only accepted material", async () => {
    const input = anonymousInput();
    const requests: string[] = [];
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        const body = JSON.parse(String(init?.body)) as { attemptId?: string };
        if (completionCalls === 1) {
          expect(body.attemptId).toBeUndefined();
          return completionReady();
        }
        expect(body.attemptId).toBe(attemptId);
        expect(listPendingSessionCompletionAttempts()).toMatchObject([
          { attemptId, phase: "prepared" },
        ]);
        return completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        expect(JSON.parse(String(init?.body))).toEqual({ attemptId });
        expect(window.localStorage.getItem("spott.web.device.v1"))
          .toBe(input.device.deviceId);
        expect(listPendingSessionCompletionAttempts()).toMatchObject([
          { attemptId, phase: "accepting" },
        ]);
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).resolves.toEqual(session);

    expect(requests).toEqual([
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(readSession()).toEqual(session);
  });

  test("advances every durable completion phase under a fixed clock", async () => {
    const fixedNow = 1_700_000_000_000;
    vi.spyOn(Date, "now").mockReturnValue(fixedNow);
    const input = anonymousInput();
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).resolves.toEqual(session);
  });

  test("reconciles a response that arrives after prepare expiry but before reconcile expiry", async () => {
    const preparedAt = 1_700_000_000_000;
    let now = preparedAt;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const input = anonymousInput();
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        if (completionCalls === 1) return completionReady(preparedAt + 10);
        now = preparedAt + 20;
        return json({
          state: "completion_pending",
          attemptId,
          sessionId: session.sessionId,
          bindingId,
          deviceId: input.device.deviceId,
          reconcileExpiresAt: preparedAt + 100,
        });
      }
      if (url === "/api/session/completion/accept") {
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).resolves.toEqual(session);
  });

  test("discards the exact pending attempt when the device CAS cannot commit", async () => {
    const input = anonymousInput();
    const nativeSetItem = Storage.prototype.setItem;
    let pendingReturned = false;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      if (pendingReturned && key === "spott.web.device-binding-state.v1" && value === "bound") {
        throw new DOMException("Storage denied", "SecurityError");
      }
      return nativeSetItem.call(this, key, value);
    });
    const requests: string[] = [];
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        if (completionCalls === 1) return completionReady();
        pendingReturned = true;
        return completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/discard") {
        return json({ state: "discarded", attemptId, bindingId, deviceId: input.device.deviceId });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(requests).toEqual([
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/discard",
    ]);
    expect(requests).not.toContain("/api/session/logout");
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.predecessorId);
    expect(readSession()).toBeNull();
  });

  test("keeps an accepting attempt after response loss and recovers it before bootstrap", async () => {
    const input = anonymousInput();
    const requests: string[] = [];
    let completionCalls = 0;
    let acceptCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        acceptCalls += 1;
        if (acceptCalls === 1) throw new TypeError("response lost");
        return json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/bootstrap") {
        throw new Error("ordinary bootstrap must wait for attempt recovery");
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    expect(listPendingSessionCompletionAttempts()).toMatchObject([
      { attemptId, phase: "accepting" },
    ]);
    expect(window.localStorage.getItem("spott.web.device.v1"))
      .toBe(input.device.deviceId);

    await expect(bootstrapSession()).resolves.toEqual(session);

    expect(acceptCalls).toBe(2);
    expect(requests).not.toContain("/api/session/bootstrap");
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(readSession()).toEqual(session);
  });

  test("restores exact cold-recovery state when the fallback lease is replaced after attempt deletion", async () => {
    const input = await accountSwitchInput();
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    let completionCalls = 0;
    let acceptCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        acceptCalls += 1;
        if (acceptCalls === 1) throw new TypeError("accept response lost");
        return json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/bootstrap") {
        throw new Error("ordinary bootstrap must not run after fenced recovery");
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    const expectedAttemptRaw = window.localStorage.getItem(
      "spott.web.session-completion-attempt.v2",
    );
    const expectedResumeRaw = window.localStorage.getItem(resumeKey);
    expect(expectedAttemptRaw).not.toBeNull();
    expect(expectedResumeRaw).not.toBeNull();

    const leaseKey = "spott.web.session-mutation-lease.v1";
    const nativeRemoveItem = Storage.prototype.removeItem;
    const nativeSetItem = Storage.prototype.setItem;
    let recoveryArmed = false;
    let leaseReplaced = false;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeItem(
      this: Storage,
      key: string,
    ) {
      nativeRemoveItem.call(this, key);
      if (
        recoveryArmed
        && !leaseReplaced
        && key === "spott.web.session-completion-attempt.v2"
      ) {
        leaseReplaced = true;
        nativeSetItem.call(this, leaseKey, JSON.stringify({
          version: 1,
          ownerId: "cold-recovery-fencing-tab",
          nonce: "cold-recovery-fencing-lease",
          expiresAt: Date.now() + 10_000,
        }));
      }
    });
    recoveryArmed = true;

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(leaseReplaced).toBe(true);
    expect(window.localStorage.getItem("spott.web.session-completion-attempt.v2"))
      .toBe(expectedAttemptRaw);
    expect(window.localStorage.getItem(resumeKey)).toBe(expectedResumeRaw);
    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(document.cookie).not.toContain("__Host-spott_logout_intent=");
  });

  test("cold recovery discards a prepared attempt before ordinary bootstrap", async () => {
    const input = anonymousInput();
    expect(storePreparedSessionCompletionAttempt({
      challengeId,
      attemptId,
      predecessorDeviceId: input.device.predecessorId,
      candidateDeviceId: input.device.deviceId,
      createdAt: Date.now(),
      prepareExpiresAt: Date.now() + 120_000,
    })).not.toBeNull();
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/completion/discard") {
        return json({ state: "discarded", attemptId, bindingId, deviceId: input.device.deviceId });
      }
      if (url === "/api/session/bootstrap") return json({ state: "anonymous" });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(requests).toEqual([
      "/api/session/completion/discard",
      "/api/session/bootstrap",
    ]);
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
  });

  test("reconciles an accept conflict through idempotent discard-after-accept", async () => {
    const input = anonymousInput();
    let completionCalls = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        return json({
          error: { code: "SESSION_COMPLETION_DISPOSITION_CONFLICT", retryable: false },
        }, 409);
      }
      if (url === "/api/session/completion/discard") {
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).resolves.toEqual(session);

    expect(requests).toEqual([
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
      "/api/session/completion/discard",
    ]);
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
  });

  test("restores anonymous state when logout is armed during final accepted publication", async () => {
    const input = anonymousInput();
    let completionCalls = 0;
    let armDuringPublication = false;
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      nativeSetItem.call(this, key, value);
      if (
        armDuringPublication
        && key === "spott.web.session-metadata.v1"
        && value.includes('"state":"authenticated"')
      ) {
        armDuringPublication = false;
        nativeSetItem.call(this, "spott.web.logout-intent.v1", JSON.stringify({
          epoch: 1,
          scope: "current",
          sessionId: session.sessionId,
          createdAt: Date.now(),
        }));
      }
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        armDuringPublication = true;
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(readSession()).toBeNull();
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).not.toBeNull();
  });

  test("does not announce authentication when final publication loses mutation authority", async () => {
    const input = anonymousInput();
    const sessionEvents: unknown[] = [];
    const onSession = (event: Event) => {
      sessionEvents.push((event as CustomEvent).detail);
    };
    const broadcastSpy = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    window.addEventListener("spott:session", onSession);

    let completionCalls = 0;
    let fenceDuringPublication = false;
    const leaseKey = "spott.web.session-mutation-lease.v1";
    const nativeSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      nativeSetItem.call(this, key, value);
      if (
        fenceDuringPublication
        && key === "spott.web.session-metadata.v1"
        && value.includes('"state":"authenticated"')
      ) {
        fenceDuringPublication = false;
        nativeSetItem.call(this, leaseKey, JSON.stringify({
          version: 1,
          ownerId: "publication-fence-tab",
          nonce: "publication-fence-lease",
          expiresAt: Date.now() + 10_000,
        }));
      }
    });
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        fenceDuringPublication = true;
        return json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");

    expect(readSession()).toBeNull();
    expect(sessionEvents).not.toContainEqual(expect.objectContaining({ state: "authenticated" }));
    expect(broadcastSpy.mock.calls.map(([message]) => message)).not.toContainEqual(expect.objectContaining({
      kind: "session-state",
      metadata: expect.objectContaining({ state: "authenticated" }),
    }));
    expect(listPendingSessionCompletionAttempts()).toMatchObject([
      { attemptId, phase: "accepting" },
    ]);

    window.localStorage.removeItem(leaseKey);
    await expect(logoutCurrentSession("current")).resolves.toBe(true);
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(readSession()).toBeNull();

    window.removeEventListener("spott:session", onSession);
  });

  test.each([
    "resume-removal",
    "attempt-removal",
    "post-cleanup-final-fence",
  ] as const)(
    "restores an accepting switch and never publishes or redirects when authority is lost at %s",
    async (fencePoint) => {
      const input = await accountSwitchInput();
      const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
      const expectedResumeRaw = window.localStorage.getItem(resumeKey);
      expect(expectedResumeRaw).not.toBeNull();
      const sessionEvents: unknown[] = [];
      const onSession = (event: Event) => {
        sessionEvents.push((event as CustomEvent).detail);
      };
      const broadcastSpy = vi.spyOn(BroadcastChannel.prototype, "postMessage");
      window.addEventListener("spott:session", onSession);

      const leaseKey = "spott.web.session-mutation-lease.v1";
      const nativeGetItem = Storage.prototype.getItem;
      const nativeRemoveItem = Storage.prototype.removeItem;
      const nativeSetItem = Storage.prototype.setItem;
      let fenceArmed = false;
      let attemptRemoved = false;
      let fenced = false;
      const fence = (storage: Storage): void => {
        if (fenced) return;
        fenced = true;
        nativeSetItem.call(storage, leaseKey, JSON.stringify({
          version: 1,
          ownerId: `fence-${fencePoint}`,
          nonce: `nonce-${fencePoint}`,
          expiresAt: Date.now() + 10_000,
        }));
      };
      vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeItem(
        this: Storage,
        key: string,
      ) {
        nativeRemoveItem.call(this, key);
        if (!fenceArmed) return;
        if (fencePoint === "resume-removal" && key === resumeKey) fence(this);
        if (key === "spott.web.session-completion-attempt.v2") {
          attemptRemoved = true;
          if (fencePoint === "attempt-removal") fence(this);
        }
      });
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(function getItem(
        this: Storage,
        key: string,
      ) {
        if (
          fenceArmed
          && attemptRemoved
          && fencePoint === "post-cleanup-final-fence"
          && key === leaseKey
        ) fence(this);
        return nativeGetItem.call(this, key);
      });

      let completionCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = String(request);
        if (url === "/api/session/logout") return json({ state: "anonymous" });
        if (url === "/api/session/complete") {
          completionCalls += 1;
          return completionCalls === 1
            ? completionReady()
            : completionPending(input.device.deviceId);
        }
        if (url === "/api/session/completion/accept") {
          fenceArmed = true;
          return json({ state: "authenticated", ...session });
        }
        throw new Error(`Unexpected request: ${url} ${String(init?.body)}`);
      }));
      const redirect = vi.fn();

      await expect(completeEmailSession(input, { onCommitted: redirect }))
        .rejects.toThrow("Unable to complete sign in.");

      expect(fenced).toBe(true);
      expect(readSession()).toBeNull();
      expect(redirect).not.toHaveBeenCalled();
      expect(sessionEvents).not.toContainEqual(expect.objectContaining({ state: "authenticated" }));
      expect(broadcastSpy.mock.calls.map(([message]) => message)).not.toContainEqual(
        expect.objectContaining({
          kind: "session-state",
          metadata: expect.objectContaining({ state: "authenticated" }),
        }),
      );
      expect(listPendingSessionCompletionAttempts()).toMatchObject([
        { attemptId, phase: "accepting" },
      ]);
      expect(window.localStorage.getItem(resumeKey)).toBe(expectedResumeRaw);

      window.removeEventListener("spott:session", onSession);
    },
  );

  test("delivers the committed navigation callback exactly once as the final owned action", async () => {
    const input = await accountSwitchInput();
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const onCommitted = vi.fn(() => {
      expect(readSession()).toEqual(session);
      expect(listPendingSessionCompletionAttempts()).toEqual([]);
      expect(window.localStorage.getItem(resumeKey)).toBeNull();
      expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
      expect(window.localStorage.getItem("spott.web.session-mutation-lease.v1"))
        .not.toBeNull();
    });

    await expect(completeEmailSession(input, { onCommitted })).resolves.toEqual(session);

    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onCommitted).toHaveBeenCalledWith(session);
  });

  test("compensates and restores the accepting switch when the final callback throws", async () => {
    const input = await accountSwitchInput();
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const expectedResumeRaw = window.localStorage.getItem(resumeKey);
    let completionCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        return json({ state: "authenticated", ...session });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    const onCommitted = vi.fn(() => {
      throw new Error("navigation refused");
    });

    await expect(completeEmailSession(input, { onCommitted }))
      .rejects.toThrow("Unable to complete sign in.");

    expect(onCommitted).toHaveBeenCalledOnce();
    expect(readSession()).toBeNull();
    expect(listPendingSessionCompletionAttempts()).toMatchObject([
      { attemptId, phase: "accepting" },
    ]);
    expect(window.localStorage.getItem(resumeKey)).toBe(expectedResumeRaw);
  });

  test.each(["session-event", "broadcast"] as const)(
    "never delivers the navigation callback when logout appears during the final %s",
    async (fencePoint) => {
      const input = anonymousInput();
      const sessionEvents: unknown[] = [];
      const onSession = (event: Event) => {
        sessionEvents.push((event as CustomEvent).detail);
      };
      window.addEventListener("spott:session", onSession);
      let armed = false;
      const armLogout = (): void => {
        if (!armed) return;
        armed = false;
        window.localStorage.setItem("spott.web.logout-intent.v1", JSON.stringify({
          epoch: 1,
          scope: "current",
          sessionId: session.sessionId,
          createdAt: Date.now(),
        }));
      };
      const nativeDispatch = window.dispatchEvent.bind(window);
      vi.spyOn(window, "dispatchEvent").mockImplementation((event) => {
        if (
          fencePoint === "session-event"
          && event.type === "spott:session"
          && (event as unknown as CustomEvent<{ state?: unknown }>).detail?.state === "authenticated"
        ) armLogout();
        return nativeDispatch(event);
      });
      const nativePostMessage = BroadcastChannel.prototype.postMessage;
      const broadcastSpy = vi.spyOn(BroadcastChannel.prototype, "postMessage")
        .mockImplementation(function postMessage(this: BroadcastChannel, message: unknown) {
          if (
            fencePoint === "broadcast"
            && (message as { kind?: unknown }).kind === "session-state"
            && (message as { metadata?: { state?: unknown } }).metadata?.state === "authenticated"
          ) armLogout();
          nativePostMessage.call(this, message);
        });
      let completionCalls = 0;
      vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
        const url = String(request);
        if (url === "/api/session/complete") {
          completionCalls += 1;
          return completionCalls === 1
            ? completionReady()
            : completionPending(input.device.deviceId);
        }
        if (url === "/api/session/completion/accept") {
          armed = true;
          return json({ state: "authenticated", ...session });
        }
        throw new Error(`Unexpected request: ${url}`);
      }));
      const onCommitted = vi.fn();

      await expect(completeEmailSession(input, { onCommitted }))
        .rejects.toThrow("Unable to complete sign in.");

      expect(onCommitted).not.toHaveBeenCalled();
      expect(readSession()).toBeNull();
      expect(listPendingSessionCompletionAttempts()).toMatchObject([
        { attemptId, phase: "accepting" },
      ]);
      expect(sessionEvents.at(-1)).toEqual({ state: "anonymous" });
      const stateMessages = broadcastSpy.mock.calls
        .map(([message]) => message)
        .filter((message) => (message as { kind?: unknown }).kind === "session-state");
      expect(stateMessages.at(-1)).toEqual(
        expect.objectContaining({
          kind: "session-state",
          metadata: { state: "anonymous" },
        }),
      );

      window.removeEventListener("spott:session", onSession);
    },
  );

  test("an armed logout never starts another completion disposition after an accept response is in flight", async () => {
    const input = anonymousInput();
    let completionCalls = 0;
    let acceptCalls = 0;
    let resolveFirstAccept!: (response: Response) => void;
    const firstAccept = new Promise<Response>((resolve) => {
      resolveFirstAccept = resolve;
    });
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        acceptCalls += 1;
        return acceptCalls === 1
          ? firstAccept
          : json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/bootstrap") return json({ state: "anonymous" });
      throw new Error(`Unexpected request: ${url}`);
    }));

    const completion = completeEmailSession(input);
    await vi.waitFor(() => expect(requests).toContain("/api/session/completion/accept"));
    const logout = logoutCurrentSession("current");
    resolveFirstAccept(json({ error: { code: "SESSION_COMPLETION_DISPOSITION_CONFLICT" } }, 409));

    await expect(completion).rejects.toThrow("Unable to complete sign in.");
    await expect(logout).resolves.toBe(true);
    expect(requests).toEqual([
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
      "/api/session/logout",
    ]);
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(readSession()).toBeNull();

    await expect(bootstrapSession()).resolves.toBeNull();
    expect(requests.at(-1)).toBe("/api/session/bootstrap");
    expect(requests.filter((url) => url === "/api/session/completion/accept"))
      .toHaveLength(1);
    expect(requests).not.toContain("/api/session/completion/discard");
  });

  test("a durable logout revokes an ambiguous accepting attempt without completion recovery", async () => {
    const input = anonymousInput();
    let completionCalls = 0;
    let acceptCalls = 0;
    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/complete") {
        completionCalls += 1;
        return completionCalls === 1
          ? completionReady()
          : completionPending(input.device.deviceId);
      }
      if (url === "/api/session/completion/accept") {
        acceptCalls += 1;
        if (acceptCalls <= 2) throw new TypeError("accept response unavailable");
        return json({ state: "authenticated", ...session });
      }
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/bootstrap") {
        throw new Error("ordinary bootstrap must not run before durable logout");
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    await expect(completeEmailSession(input)).rejects.toThrow("Unable to complete sign in.");
    await expect(logoutCurrentSession("current")).resolves.toBe(true);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(listPendingSessionCompletionAttempts()).toEqual([]);

    await expect(bootstrapSession()).resolves.toBeNull();

    expect(acceptCalls).toBe(1);
    expect(requests.at(-1)).toBe("/api/session/bootstrap");
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(window.localStorage.getItem("spott.web.logout-intent.v1")).toBeNull();
    expect(readSession()).toBeNull();
  });
});
