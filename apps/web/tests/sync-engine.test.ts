import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { saveSession, clearSession, type WebSession } from "../app/lib/client-api";
import {
  SyncEngine,
  syncCursorStorageKey,
  type SyncChange,
} from "../app/lib/sync-engine";

const session: WebSession = {
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  refreshGeneration: 0,
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

function change(seq: number, overrides: Partial<SyncChange> = {}): SyncChange {
  return {
    seq,
    entityType: "registration",
    entityId: `019b0000-0000-7000-8000-0000000${seq.toString().padStart(5, "0")}`,
    operation: "upsert",
    version: 1,
    changedFields: ["status"],
    payload: { status: "confirmed" },
    ...overrides,
  };
}

function pullResponse(body: {
  changes: SyncChange[];
  nextCursor: number;
  hasMore?: boolean;
}): Response {
  return new Response(
    JSON.stringify({
      nextCursor: body.nextCursor,
      hasMore: body.hasMore ?? false,
      serverTime: new Date().toISOString(),
      changes: body.changes,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * A minimal WebSocket double that captures instances so a test can drive open,
 * message and close events deterministically.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  url: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = this.OPEN;
    this.onopen?.();
  }

  emit(data: unknown) {
    this.onmessage?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }

  fail() {
    this.readyState = this.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }

  close() {
    this.closed = true;
    this.readyState = this.CLOSED;
    this.onclose?.();
  }
}

describe("web sync engine", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    saveSession(session);
    FakeWebSocket.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    window.localStorage.clear();
    clearSession();
  });

  test("pull consumes /sync/pull, applies changes and advances the persisted cursor", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        urls.push(url);
        return pullResponse({ changes: [change(41)], nextCursor: 41, hasMore: false });
      }),
    );

    const applied: SyncChange[][] = [];
    const engine = new SyncEngine({ webSocketFactory: null });
    engine.subscribe((changes) => applied.push(changes));

    const result = await engine.pull("manual");

    expect(result.applied).toBe(1);
    expect(applied.flat().map((c) => c.seq)).toEqual([41]);
    expect(urls.some((u) => u.includes("/sync/pull?cursor=0&limit="))).toBe(true);
    expect(window.localStorage.getItem(syncCursorStorageKey(session.user.id))).toBe("41");
  });

  test("pull drains every page while hasMore is true before resolving", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) return pullResponse({ changes: [change(10)], nextCursor: 10, hasMore: true });
        return pullResponse({ changes: [change(11)], nextCursor: 11, hasMore: false });
      }),
    );

    const engine = new SyncEngine({ webSocketFactory: null });
    const result = await engine.pull("manual");

    expect(call).toBe(2);
    expect(result.applied).toBe(2);
    expect(window.localStorage.getItem(syncCursorStorageKey(session.user.id))).toBe("11");
  });

  test("a subscriber failure aborts the apply and does not advance the cursor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => pullResponse({ changes: [change(7)], nextCursor: 7, hasMore: false })),
    );

    const engine = new SyncEngine({ webSocketFactory: null });
    engine.subscribe(() => {
      throw new Error("apply failed");
    });

    await expect(engine.pull("manual")).rejects.toThrow("apply failed");
    expect(window.localStorage.getItem(syncCursorStorageKey(session.user.id))).toBeNull();
  });

  test("CURSOR_EXPIRED resets the cursor to the server minimum and emits a reset", async () => {
    window.localStorage.setItem(syncCursorStorageKey(session.user.id), "5");
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        if (call === 1) {
          return new Response(
            JSON.stringify({
              error: {
                code: "CURSOR_EXPIRED",
                message: "expired",
                meta: { minimumCursor: 800 },
              },
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          );
        }
        return pullResponse({ changes: [change(801)], nextCursor: 801, hasMore: false });
      }),
    );

    const resets: string[] = [];
    const engine = new SyncEngine({ webSocketFactory: null });
    engine.subscribeStatus((status) => {
      if (status === "reset") resets.push(status);
    });

    await engine.pull("manual");

    expect(resets).toEqual(["reset"]);
    expect(window.localStorage.getItem(syncCursorStorageKey(session.user.id))).toBe("801");
  });

  test("push posts to /sync/push with the device id and an idempotency key", async () => {
    let pushBody: unknown;
    let idempotencyKey: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/sync/push")) {
          idempotencyKey = new Headers(init?.headers).get("Idempotency-Key");
          pushBody = JSON.parse(String(init?.body));
          return new Response(
            JSON.stringify({ results: [{ operationId: "op", state: "applied" }], serverTime: "t" }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return pullResponse({ changes: [], nextCursor: 0, hasMore: false });
      }),
    );

    const engine = new SyncEngine({ webSocketFactory: null });
    const result = await engine.push([
      { operationId: "019b0000-0000-7000-8000-0000000000aa", entityType: "favorite", entityId: "019b0000-0000-7000-8000-0000000000bb", action: "put" },
    ]);

    expect(idempotencyKey).toBeTruthy();
    expect(pushBody).toMatchObject({ deviceId: expect.any(String), operations: expect.any(Array) });
    expect(result.results).toHaveLength(1);
  });

  test("without a websocket the engine falls back to short polling on an interval", async () => {
    vi.useFakeTimers();
    let pulls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pulls += 1;
        return pullResponse({ changes: [], nextCursor: 0, hasMore: false });
      }),
    );

    const engine = new SyncEngine({ webSocketFactory: null, pollIntervalMs: 30_000 });
    engine.start();
    await vi.advanceTimersByTimeAsync(0); // initial catch-up pull
    const afterStart = pulls;
    expect(afterStart).toBeGreaterThanOrEqual(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(pulls).toBeGreaterThan(afterStart);
    engine.stop();
  });

  test("a websocket hint only triggers an incremental pull; the payload is never applied directly", async () => {
    let pulls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        pulls += 1;
        return pullResponse({ changes: [change(99)], nextCursor: 99, hasMore: false });
      }),
    );

    const flush = async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const applied: SyncChange[][] = [];
    const engine = new SyncEngine({
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
      webSocketUrl: "wss://example.test/sync",
    });
    engine.subscribe((changes) => applied.push(changes));
    engine.start();
    await flush();

    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeTruthy();
    socket.open();
    await flush(); // drain the on-open catch-up pull
    const beforeHint = pulls;

    // The hint carries a poisoned payload that must never be treated as fact.
    socket.emit({ seq: 99, topic: "registration", payload: { status: "HACKED" } });
    await flush();

    expect(pulls).toBe(beforeHint + 1);
    // Applied changes come only from the authoritative pull, not the socket payload.
    expect(applied.flat().every((c) => c.payload.status !== "HACKED")).toBe(true);
    engine.stop();
  });
});
