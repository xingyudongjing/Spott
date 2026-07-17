"use client";

import { apiRequest, APIError, deviceId, readSession } from "./client-api";

/**
 * Web consumer of the reliable incremental sync protocol (dev doc §6).
 *
 * The engine treats PostgreSQL (surfaced through `/sync/pull`) as the single
 * source of truth. WebSocket messages are only *wake-ups*: they carry a change
 * sequence and a topic and cause an incremental Pull — their payload is never
 * applied directly (§6.4). When no realtime channel is available the engine
 * degrades to short polling and manual refresh (§6.8).
 */

export interface SyncChange {
  seq: number;
  entityType: string;
  entityId: string;
  operation: "upsert" | "tombstone";
  version: number;
  changedFields: string[];
  payload: Record<string, unknown>;
}

export interface SyncPullResponse {
  nextCursor: number;
  hasMore: boolean;
  serverTime: string;
  changes: SyncChange[];
}

export interface SyncPullOutcome {
  applied: number;
  cursor: number;
}

export interface SyncPushOperation {
  operationId: string;
  entityType: string;
  entityId?: string | null;
  action: string;
  baseVersion?: number | null;
  patch?: Record<string, unknown>;
}

export interface SyncPushResponse {
  results: Array<{ operationId: string; state: string; result?: unknown; error?: unknown }>;
  serverTime: string;
}

export type SyncReason = "start" | "poll" | "realtime" | "manual" | "push" | "visible";

/**
 * Status transitions a UI can observe. `reset` is emitted when the server
 * reports `CURSOR_EXPIRED` and the client had to jump to a controlled snapshot
 * boundary — sensitive caches should be cleared on that signal (§6.9).
 */
export type SyncStatus = "connected" | "polling" | "offline" | "reset" | "error";

type ChangeListener = (changes: SyncChange[], reason: SyncReason) => void;
type StatusListener = (status: SyncStatus) => void;

type WebSocketFactory = ((url: string) => WebSocket) | null;

export interface SyncEngineOptions {
  /**
   * Milliseconds between polls when no realtime channel is open. Defaults to the
   * `NEXT_PUBLIC_SYNC_POLL_MS` runtime value, falling back to the documented
   * 30 000 ms degraded target (§6.8). Never hardcode business thresholds — this
   * stays overridable so operations can retune it without a client release.
   */
  pollIntervalMs?: number;
  /** Page size for `/sync/pull`. Defaults to `NEXT_PUBLIC_SYNC_PULL_LIMIT` or 500 (§6.4). */
  pullLimit?: number;
  /**
   * Realtime wake-up endpoint. Defaults to `NEXT_PUBLIC_SYNC_WS_URL`. When empty
   * the engine runs polling-only, which is the guaranteed degraded path.
   */
  webSocketUrl?: string | null;
  /** Injectable for tests; defaults to the global `WebSocket` (or null when absent). */
  webSocketFactory?: WebSocketFactory;
  /** Base reconnect backoff in ms. */
  reconnectBaseMs?: number;
  /** Maximum reconnect backoff in ms. */
  reconnectMaxMs?: number;
}

const CURSOR_KEY_PREFIX = "spott.web.sync.cursor.v1";
const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_PULL_LIMIT = 500;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

export function syncCursorStorageKey(userId: string): string {
  return `${CURSOR_KEY_PREFIX}:${userId}`;
}

function readNumericEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultWebSocketFactory(): WebSocketFactory {
  if (typeof WebSocket === "undefined") return null;
  return (url: string) => new WebSocket(url);
}

function defaultWebSocketUrl(): string | null {
  const configured = process.env.NEXT_PUBLIC_SYNC_WS_URL;
  return configured && configured.length > 0 ? configured : null;
}

function isCursorExpired(error: unknown): error is APIError {
  return error instanceof APIError && error.body.code === "CURSOR_EXPIRED";
}

export class SyncEngine {
  private readonly pollIntervalMs: number;
  private readonly pullLimit: number;
  private readonly webSocketUrl: string | null;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  private readonly changeListeners = new Set<ChangeListener>();
  private readonly statusListeners = new Set<StatusListener>();

  private started = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private socket: WebSocket | null = null;
  private pullInFlight: Promise<SyncPullOutcome> | null = null;
  private pendingPullReason: SyncReason | null = null;
  private boundVisibility: (() => void) | null = null;

  constructor(options: SyncEngineOptions = {}) {
    this.pollIntervalMs =
      options.pollIntervalMs ??
      readNumericEnv(process.env.NEXT_PUBLIC_SYNC_POLL_MS, DEFAULT_POLL_INTERVAL_MS);
    this.pullLimit =
      options.pullLimit ??
      readNumericEnv(process.env.NEXT_PUBLIC_SYNC_PULL_LIMIT, DEFAULT_PULL_LIMIT);
    this.webSocketUrl =
      options.webSocketUrl !== undefined ? options.webSocketUrl : defaultWebSocketUrl();
    this.webSocketFactory =
      options.webSocketFactory !== undefined ? options.webSocketFactory : defaultWebSocketFactory();
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  }

  subscribe(listener: ChangeListener): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  subscribeStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  /** Begin realtime + polling. Runs only in the browser foreground. */
  start(): void {
    if (this.started) return;
    if (typeof window === "undefined") return;
    this.started = true;
    this.boundVisibility = () => this.handleVisibilityChange();
    document.addEventListener("visibilitychange", this.boundVisibility);
    if (this.isForeground()) this.activate();
  }

  stop(): void {
    this.started = false;
    if (this.boundVisibility) {
      document.removeEventListener("visibilitychange", this.boundVisibility);
      this.boundVisibility = null;
    }
    this.deactivate();
  }

  private isForeground(): boolean {
    return typeof document === "undefined" || document.visibilityState !== "hidden";
  }

  private handleVisibilityChange(): void {
    if (!this.started) return;
    if (this.isForeground()) this.activate();
    else this.deactivate();
  }

  /** Foreground: connect realtime, start the polling safety net, catch up now. */
  private activate(): void {
    if (!readSession()) return;
    this.startPolling();
    this.connectRealtime();
    void this.pull("start").catch(() => undefined);
  }

  private deactivate(): void {
    this.stopPolling();
    this.clearReconnect();
    this.closeSocket();
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.emitStatus("polling");
    this.pollTimer = setInterval(() => {
      void this.pull("poll").catch(() => undefined);
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private connectRealtime(): void {
    if (!this.webSocketFactory || !this.webSocketUrl) return;
    if (this.socket) return;
    let socket: WebSocket;
    try {
      socket = this.webSocketFactory(this.webSocketUrl);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.reconnectAttempts = 0;
      // Realtime is live: stop the polling safety net until it drops again.
      this.stopPolling();
      this.emitStatus("connected");
      // Catch up on anything missed while connecting.
      void this.pull("realtime").catch(() => undefined);
    };
    socket.onmessage = () => {
      // A hint only means "there is something new" — pull the authoritative
      // change log. We deliberately ignore the message payload (§6.4).
      void this.pull("realtime").catch(() => undefined);
    };
    socket.onerror = () => {
      this.handleSocketDown();
    };
    socket.onclose = () => {
      this.handleSocketDown();
    };
  }

  private handleSocketDown(): void {
    this.closeSocket();
    if (!this.started || !this.isForeground()) return;
    // Fall back to polling immediately, then try to restore realtime.
    this.startPolling();
    this.scheduleReconnect();
  }

  private closeSocket(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Closing a socket that never opened can throw; ignore.
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    if (!this.webSocketFactory || !this.webSocketUrl) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started && this.isForeground() && !this.socket) this.connectRealtime();
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
  }

  private readCursor(userId: string): number {
    if (typeof window === "undefined") return 0;
    try {
      const raw = window.localStorage.getItem(syncCursorStorageKey(userId));
      if (!raw) return 0;
      const parsed = Number(raw);
      return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private writeCursor(userId: string, cursor: number): void {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(syncCursorStorageKey(userId), String(cursor));
    } catch {
      // A read-only storage still lets the in-memory loop advance safely.
    }
  }

  /**
   * Pull and apply every pending change page. Single-flight per user: only one
   * Pull may advance the cursor at a time (§9.4 invariant, applied to Web).
   */
  pull(reason: SyncReason = "manual"): Promise<SyncPullOutcome> {
    if (this.pullInFlight) {
      // Remember that another wake-up arrived so we re-pull once the current
      // pass finishes; this coalesces bursts of hints into a bounded chase.
      this.pendingPullReason = reason;
      return this.pullInFlight;
    }
    const run = this.runPull(reason).finally(() => {
      this.pullInFlight = null;
      const pending = this.pendingPullReason;
      this.pendingPullReason = null;
      if (pending) void this.pull(pending).catch(() => undefined);
    });
    this.pullInFlight = run;
    return run;
  }

  private async runPull(reason: SyncReason): Promise<SyncPullOutcome> {
    const session = readSession();
    if (!session) return { applied: 0, cursor: 0 };
    const userId = session.user.id;
    let applied = 0;
    let cursor = this.readCursor(userId);

    for (;;) {
      let response: SyncPullResponse;
      try {
        response = await apiRequest<SyncPullResponse>(
          `/sync/pull?cursor=${cursor}&limit=${this.pullLimit}`,
          { authenticated: true },
        );
      } catch (error) {
        if (isCursorExpired(error)) {
          const minimum = this.minimumCursorFrom(error);
          cursor = minimum;
          this.writeCursor(userId, cursor);
          // Signal the UI to drop possibly stale sensitive caches and resync
          // from the controlled snapshot boundary.
          this.emitStatus("reset");
          continue;
        }
        this.emitStatus("error");
        throw error;
      }

      const changes = Array.isArray(response.changes) ? response.changes : [];
      if (changes.length > 0) {
        // Apply first; only advance the cursor once every listener succeeded so
        // an interrupted apply never leaves "cursor ahead, data behind" (§6.4).
        this.notifyChanges(changes, reason);
        applied += changes.length;
      }
      cursor = response.nextCursor;
      this.writeCursor(userId, cursor);
      if (!response.hasMore) break;
    }

    return { applied, cursor };
  }

  private minimumCursorFrom(error: APIError): number {
    const meta = error.body.meta;
    const raw = meta && typeof meta === "object" ? (meta as Record<string, unknown>).minimumCursor : undefined;
    const parsed = typeof raw === "number" ? raw : Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  }

  /** Enqueue offline-safe operations through `/sync/push`, then reconcile. */
  async push(operations: SyncPushOperation[]): Promise<SyncPushResponse> {
    if (operations.length === 0) return { results: [], serverTime: new Date().toISOString() };
    const response = await apiRequest<SyncPushResponse>("/sync/push", {
      method: "POST",
      authenticated: true,
      idempotent: true,
      body: JSON.stringify({ deviceId: deviceId(), operations }),
    });
    // Never treat the push response as the new local truth; pull authoritative
    // state so conflicts/tombstones resolved server-side land locally (§6.6).
    void this.pull("push").catch(() => undefined);
    return response;
  }

  private notifyChanges(changes: SyncChange[], reason: SyncReason): void {
    for (const listener of this.changeListeners) listener(changes, reason);
  }

  private emitStatus(status: SyncStatus): void {
    for (const listener of this.statusListeners) listener(status);
  }
}

let singleton: SyncEngine | null = null;

/** Process-wide engine used by the app registrar and feature components. */
export function getSyncEngine(): SyncEngine {
  if (!singleton) singleton = new SyncEngine();
  return singleton;
}
