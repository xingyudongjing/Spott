import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { WebSession } from "../app/lib/client-api";

type MessageListener = (event: { readonly data: unknown }) => void;

class CrossContextBroadcastChannel {
  private static readonly channels = new Set<CrossContextBroadcastChannel>();
  private static readonly heldDeliveries: Array<{
    readonly channel: CrossContextBroadcastChannel;
    readonly message: unknown;
  }> = [];
  private static holdAnonymous = false;
  private readonly listeners = new Set<MessageListener>();

  constructor(private readonly name: string) {
    CrossContextBroadcastChannel.channels.add(this);
  }

  postMessage(message: unknown): void {
    for (const channel of CrossContextBroadcastChannel.channels) {
      if (channel === this || channel.name !== this.name) continue;
      if (
        CrossContextBroadcastChannel.holdAnonymous
        && (message as { readonly metadata?: { readonly state?: unknown } } | null)
          ?.metadata?.state === "anonymous"
      ) {
        CrossContextBroadcastChannel.heldDeliveries.push({ channel, message });
      } else {
        CrossContextBroadcastChannel.deliver(channel, message);
      }
    }
  }

  addEventListener(_type: "message", listener: MessageListener): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: MessageListener): void {
    this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    CrossContextBroadcastChannel.channels.delete(this);
  }

  static reset(): void {
    for (const channel of [...CrossContextBroadcastChannel.channels]) channel.close();
    CrossContextBroadcastChannel.heldDeliveries.length = 0;
    CrossContextBroadcastChannel.holdAnonymous = false;
  }

  static holdAnonymousMessages(): void {
    CrossContextBroadcastChannel.holdAnonymous = true;
  }

  static heldAnonymousMessageCount(): number {
    return CrossContextBroadcastChannel.heldDeliveries.length;
  }

  static latestHeldUpdatedAt(): number {
    const message = CrossContextBroadcastChannel.heldDeliveries.at(-1)?.message as {
      readonly updatedAt?: unknown;
    } | undefined;
    if (typeof message?.updatedAt !== "number") throw new Error("No held session message");
    return message.updatedAt;
  }

  static releaseHeldMessages(): void {
    CrossContextBroadcastChannel.holdAnonymous = false;
    for (const delivery of CrossContextBroadcastChannel.heldDeliveries.splice(0)) {
      CrossContextBroadcastChannel.deliver(delivery.channel, delivery.message);
    }
  }

  static sendExternal(message: unknown): void {
    const sender = new CrossContextBroadcastChannel("spott:web-session:v1");
    sender.postMessage(message);
    sender.close();
  }

  private static deliver(channel: CrossContextBroadcastChannel, message: unknown): void {
    queueMicrotask(() => {
      for (const listener of channel.listeners) listener({ data: message });
    });
  }
}

class CrossContextLockManager {
  private readonly active = new Set<string>();
  private readonly queues = new Map<string, Array<() => void>>();

  request<T>(
    name: string,
    _options: unknown,
    callback: () => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.active.add(name);
        let result: Promise<T>;
        try {
          result = callback();
        } catch (error) {
          this.release(name);
          reject(error);
          return;
        }
        void Promise.resolve(result).then(
          (value) => {
            this.release(name);
            resolve(value);
          },
          (error: unknown) => {
            this.release(name);
            reject(error);
          },
        );
      };
      const queue = this.queues.get(name) ?? [];
      queue.push(run);
      this.queues.set(name, queue);
      this.drain(name);
    });
  }

  private drain(name: string): void {
    if (this.active.has(name)) return;
    const queue = this.queues.get(name);
    const next = queue?.shift();
    if (!next) {
      this.queues.delete(name);
      return;
    }
    next();
  }

  private release(name: string): void {
    this.active.delete(name);
    this.drain(name);
  }
}

const session: WebSession = {
  accessToken: "cross-context-access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 3,
  sessionId: "019b0000-0000-7000-8000-000000000601",
  user: {
    id: "019b0000-0000-7000-8000-000000000602",
    publicHandle: "cross-context-user",
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

async function loadTwoRuntimes() {
  vi.resetModules();
  const switchingTab = await import("../app/lib/client-api");
  vi.resetModules();
  const observingTab = await import("../app/lib/client-api");
  return { switchingTab, observingTab };
}

async function loadThreeRuntimes() {
  const { switchingTab, observingTab } = await loadTwoRuntimes();
  vi.resetModules();
  const producingTab = await import("../app/lib/client-api");
  return { switchingTab, observingTab, producingTab };
}

function installCrossContextLocks(): void {
  const navigatorWithLocks = Object.create(navigator) as Navigator;
  Object.defineProperty(navigatorWithLocks, "locks", {
    configurable: true,
    value: new CrossContextLockManager(),
  });
  vi.stubGlobal("navigator", navigatorWithLocks);
}

describe("cross-context anonymous session transitions", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
    CrossContextBroadcastChannel.reset();
    vi.stubGlobal("BroadcastChannel", CrossContextBroadcastChannel);
  });

  afterEach(() => {
    CrossContextBroadcastChannel.reset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
  });

  test("an internal account-switch anonymous publication preserves its exact challenge in another runtime", async () => {
    const { switchingTab, observingTab } = await loadTwoRuntimes();
    switchingTab.saveSession(session);
    observingTab.saveSession(session);
    const unsubscribe = observingTab.subscribeSessionChanges(() => undefined);
    const challengeId = "019b0000-0000-7000-8000-000000000603";
    const input = {
      challengeId,
      code: "123456",
      device: switchingTab.prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(switchingTab.registerEmailSessionSwitch(input)).resolves.toBe(true);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = window.localStorage.getItem(resumeKey);
    expect(resumeRaw).not.toBeNull();

    const requests: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      const url = String(request);
      requests.push(url);
      if (url === "/api/session/logout") return json({ state: "anonymous" });
      if (url === "/api/session/complete") {
        return json({ error: { code: "SESSION_COMPLETION_UNAVAILABLE" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    const completion = switchingTab.completeEmailSession(input).then(
      () => "resolved" as const,
      () => "rejected" as const,
    );
    await vi.waitFor(() => expect(requests).toContain("/api/session/logout"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    await expect(completion).resolves.toBe("rejected");
    unsubscribe();
  });

  test("an explicit user logout publication cancels the preserved challenge across runtimes", async () => {
    const { switchingTab, observingTab } = await loadTwoRuntimes();
    switchingTab.saveSession(session);
    observingTab.saveSession(session);
    const unsubscribe = observingTab.subscribeSessionChanges(() => undefined);
    const challengeId = "019b0000-0000-7000-8000-000000000604";
    const input = {
      challengeId,
      device: switchingTab.prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(switchingTab.registerEmailSessionSwitch(input)).resolves.toBe(true);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    expect(window.localStorage.getItem(resumeKey)).not.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "anonymous" })));

    await expect(switchingTab.logoutCurrentSession("current")).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem(resumeKey)).toBeNull();
    unsubscribe();
  });

  test("a delayed account-switch publication never deletes a challenge created after publication", async () => {
    const { switchingTab, observingTab } = await loadTwoRuntimes();
    switchingTab.saveSession(session);
    observingTab.saveSession(session);
    const unsubscribe = observingTab.subscribeSessionChanges(() => undefined);
    const firstChallengeId = "019b0000-0000-7000-8000-000000000605";
    const firstInput = {
      challengeId: firstChallengeId,
      code: "123456",
      device: switchingTab.prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(switchingTab.registerEmailSessionSwitch(firstInput)).resolves.toBe(true);
    CrossContextBroadcastChannel.holdAnonymousMessages();
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === "/api/session/logout") return json({ state: "anonymous" });
      return json({ error: { code: "SESSION_COMPLETION_UNAVAILABLE" } }, 503);
    }));

    await expect(switchingTab.completeEmailSession(firstInput)).rejects
      .toThrow("Unable to complete sign in.");
    expect(CrossContextBroadcastChannel.heldAnonymousMessageCount()).toBeGreaterThan(0);
    const publishedAt = CrossContextBroadcastChannel.latestHeldUpdatedAt();
    vi.spyOn(Date, "now").mockReturnValue(publishedAt + 1);
    const laterChallengeId = "019b0000-0000-7000-8000-000000000606";
    const laterInput = {
      challengeId: laterChallengeId,
      device: observingTab.prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(observingTab.registerEmailSessionSwitch(laterInput)).resolves.toBe(true);
    const laterKey = `spott.web.login-switch-resume.v1.${laterChallengeId}`;
    const laterRaw = window.localStorage.getItem(laterKey);
    expect(laterRaw).not.toBeNull();

    CrossContextBroadcastChannel.releaseHeldMessages();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem(laterKey)).toBe(laterRaw);
    unsubscribe();
  });

  test("a delayed explicit-logout publication never deletes a challenge created after publication", async () => {
    const { switchingTab, observingTab } = await loadTwoRuntimes();
    switchingTab.saveSession(session);
    observingTab.saveSession(session);
    const unsubscribe = observingTab.subscribeSessionChanges(() => undefined);
    CrossContextBroadcastChannel.holdAnonymousMessages();
    vi.stubGlobal("fetch", vi.fn(async () => json({ state: "anonymous" })));

    await expect(switchingTab.logoutCurrentSession("current")).resolves.toBe(true);
    expect(CrossContextBroadcastChannel.heldAnonymousMessageCount()).toBeGreaterThan(0);
    const publishedAt = CrossContextBroadcastChannel.latestHeldUpdatedAt();
    vi.spyOn(Date, "now").mockReturnValue(publishedAt + 1);
    const laterChallengeId = "019b0000-0000-7000-8000-000000000607";
    const laterInput = {
      challengeId: laterChallengeId,
      device: observingTab.prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(observingTab.registerEmailSessionSwitch(laterInput)).resolves.toBe(true);
    const laterKey = `spott.web.login-switch-resume.v1.${laterChallengeId}`;
    const laterRaw = window.localStorage.getItem(laterKey);
    expect(laterRaw).not.toBeNull();

    CrossContextBroadcastChannel.releaseHeldMessages();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem(laterKey)).toBe(laterRaw);
    unsubscribe();
  });

  test.each([
    "account_switch",
    "user_logout",
  ] as const)("serializes %s cleanup with a same-challenge replacement producer", async (kind) => {
    installCrossContextLocks();
    const { switchingTab, observingTab, producingTab } = await loadThreeRuntimes();
    switchingTab.saveSession(session);
    observingTab.saveSession(session);
    producingTab.saveSession(session);
    const unsubscribe = observingTab.subscribeSessionChanges(() => undefined);
    const targetChallengeId = kind === "account_switch"
      ? "019b0000-0000-7000-8000-000000000609"
      : "019b0000-0000-7000-8000-000000000610";
    const device = switchingTab.prepareEmailLoginDevice({ switching: true });
    const targetInput = {
      challengeId: targetChallengeId,
      device,
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(switchingTab.registerEmailSessionSwitch(targetInput)).resolves.toBe(true);
    const targetKey = `spott.web.login-switch-resume.v1.${targetChallengeId}`;
    const targetRaw = window.localStorage.getItem(targetKey);
    expect(targetRaw).not.toBeNull();
    CrossContextBroadcastChannel.holdAnonymousMessages();
    vi.stubGlobal("fetch", vi.fn(async (request: RequestInfo | URL) => {
      if (String(request) === "/api/session/logout") return json({ state: "anonymous" });
      return json({ error: { code: "SESSION_COMPLETION_UNAVAILABLE" } }, 503);
    }));

    if (kind === "account_switch") {
      const preservedInput = {
        ...targetInput,
        challengeId: "019b0000-0000-7000-8000-000000000611",
        code: "123456",
      };
      await expect(switchingTab.registerEmailSessionSwitch(preservedInput)).resolves.toBe(true);
      await expect(switchingTab.completeEmailSession(preservedInput)).rejects
        .toThrow("Unable to complete sign in.");
    } else {
      await expect(switchingTab.logoutCurrentSession("current")).resolves.toBe(true);
    }
    expect(CrossContextBroadcastChannel.heldAnonymousMessageCount()).toBeGreaterThan(0);

    // The publishing tab has already completed its own terminal cleanup. Restore
    // the publication-time raw value to model a receiver that observed it before
    // the publisher's later local removal.
    window.localStorage.setItem(targetKey, targetRaw!);
    const publishedAt = CrossContextBroadcastChannel.latestHeldUpdatedAt();
    const replacementCreatedAt = publishedAt + 1;
    vi.spyOn(Date, "now").mockReturnValue(replacementCreatedAt);
    const expectedReplacementRaw = JSON.stringify({
      ...(JSON.parse(targetRaw!) as Record<string, unknown>),
      createdAt: replacementCreatedAt,
    });
    const nativeRemoveItem = Storage.prototype.removeItem;
    let replacement: Promise<boolean> | null = null;
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function removeItem(
      this: Storage,
      key: string,
    ) {
      if (key === targetKey && replacement === null) {
        replacement = producingTab.registerEmailSessionSwitch(targetInput);
      }
      nativeRemoveItem.call(this, key);
    });

    CrossContextBroadcastChannel.releaseHeldMessages();
    await vi.waitFor(() => expect(replacement).not.toBeNull());
    await expect(replacement!).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(window.localStorage.getItem(targetKey)).toBe(expectedReplacementRaw);
    });
    unsubscribe();
  });

  test("rejects a non-canonical preserved challenge before any cross-context cleanup", async () => {
    const { observingTab } = await loadTwoRuntimes();
    observingTab.saveSession(session);
    const unsubscribe = observingTab.subscribeSessionChanges(() => undefined);
    const challengeId = "019b0000-0000-7000-8000-000000000608";
    const input = {
      challengeId,
      device: observingTab.prepareEmailLoginDevice({ switching: true }),
      expectedSession: {
        state: "authenticated" as const,
        userId: session.user.id,
        sessionId: session.sessionId,
      },
    };
    await expect(observingTab.registerEmailSessionSwitch(input)).resolves.toBe(true);
    const resumeKey = `spott.web.login-switch-resume.v1.${challengeId}`;
    const resumeRaw = window.localStorage.getItem(resumeKey);
    expect(resumeRaw).not.toBeNull();
    const createdAt = (JSON.parse(resumeRaw!) as { readonly createdAt: number }).createdAt;

    CrossContextBroadcastChannel.sendExternal({
      version: 1,
      kind: "session-state",
      sourceId: "external-invalid-transition",
      metadata: { state: "anonymous" },
      anonymousTransition: {
        kind: "account_switch",
        preservedSwitchChallengeId: "not-a-canonical-challenge",
        resumeSnapshots: [{
          challengeId,
          raw: resumeRaw,
          createdAt,
        }],
      },
      updatedAt: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(window.localStorage.getItem(resumeKey)).toBe(resumeRaw);
    unsubscribe();
  });
});
