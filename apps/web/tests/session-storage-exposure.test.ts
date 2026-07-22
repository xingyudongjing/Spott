import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { saveSession, clearSession, type WebSession } from "../app/lib/client-api";

const session: WebSession = {
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 0,
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

describe("browser session credential isolation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  test("keeps access material in memory and writes no session credentials to Web Storage", () => {
    saveSession(session);

    expect(window.localStorage.getItem("spott.web.session.v1")).toBeNull();
    expect(window.sessionStorage.getItem("spott.web.session.v1")).toBeNull();
  });

  test("broadcasts metadata only and never includes the access token", () => {
    const payloads: unknown[] = [];
    const listener = (event: Event) => payloads.push((event as CustomEvent).detail);
    window.addEventListener("spott:session", listener);

    saveSession(session);
    window.removeEventListener("spott:session", listener);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      state: "authenticated",
      userId: session.user.id,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
    });
    expect(JSON.stringify(payloads)).not.toContain(session.accessToken);
  });

  test("publishes the latest in-memory metadata through BroadcastChannel without credentials", () => {
    const messages: unknown[] = [];
    class CapturingBroadcastChannel {
      constructor() {}
      postMessage(message: unknown) { messages.push(message); }
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    vi.stubGlobal("BroadcastChannel", CapturingBroadcastChannel);

    saveSession(session);
    saveSession({ ...session, accessToken: "rotated-access", refreshGeneration: 1 });

    expect(messages.at(-1)).toEqual(expect.objectContaining({
      kind: "session-state",
      metadata: {
        state: "authenticated",
        userId: session.user.id,
        sessionId: session.sessionId,
        refreshGeneration: 1,
      },
    }));
    expect(JSON.stringify(messages)).not.toContain(session.accessToken);
    expect(JSON.stringify(messages)).not.toContain("rotated-access");
  });
});
