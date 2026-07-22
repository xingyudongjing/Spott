import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  captureSessionCompletionAttemptSnapshot,
  listPendingSessionCompletionAttempts,
  markSessionCompletionAttemptAccepting,
  markSessionCompletionAttemptDeviceCommitted,
  MAX_PENDING_SESSION_COMPLETION_ATTEMPTS,
  readSessionCompletionAttempt,
  reconcileSessionCompletionAttempt,
  removeSessionCompletionAttempt,
  restoreSessionCompletionAttemptExactly,
  scanPendingSessionCompletionAttempts,
  SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION,
  SESSION_COMPLETION_ATTEMPT_STORAGE_KEY,
  storePreparedSessionCompletionAttempt,
  verifySessionCompletionAttemptSnapshot,
  type PendingSessionCompletionAttempt,
  type PrepareSessionCompletionAttemptInput,
  type PreparedSessionCompletionAttempt,
} from "../app/lib/session-completion-attempt-store";

const now = 1_784_246_400_000;
const storageKey = "spott.web.session-completion-attempt.v2";
const legacyStorageKey = "spott.web.session-completion-attempt.v1.019d0000-0000-7000-8000-000000000402";

const firstInput = {
  challengeId: "019d0000-0000-7000-8000-000000000401",
  attemptId: "019d0000-0000-7000-8000-000000000402",
  predecessorDeviceId: "019d0000-0000-7000-8000-000000000403",
  candidateDeviceId: "019d0000-0000-7000-8000-000000000404",
  createdAt: now,
  prepareExpiresAt: now + 120_000,
} as const;

const secondInput = {
  challengeId: "019d0000-0000-7000-8000-000000000411",
  attemptId: "019d0000-0000-7000-8000-000000000412",
  predecessorDeviceId: "019d0000-0000-7000-8000-000000000413",
  candidateDeviceId: "019d0000-0000-7000-8000-000000000414",
  createdAt: now + 1,
  prepareExpiresAt: now + 240_000,
} as const;

const sessionId = "019d0000-0000-7000-8000-000000000405";
const reconcileLifetimeMs = 2_678_400_000;

function expectedPrepared(
  input: PrepareSessionCompletionAttemptInput = firstInput,
): PreparedSessionCompletionAttempt {
  return {
    schemaVersion: SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION,
    challengeId: input.challengeId,
    attemptId: input.attemptId,
    predecessorDeviceId: input.predecessorDeviceId,
    candidateDeviceId: input.candidateDeviceId,
    phase: "prepared",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    prepareExpiresAt: input.prepareExpiresAt,
  };
}

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  ignoredWriteKey: string | null = null;
  ignoredRemoveKey: string | null = null;
  throwAfterWriteKey: string | null = null;
  throwAfterRemoveKey: string | null = null;
  throwOnGetKey: string | null = null;
  throwOnKey = false;
  throwOnLength = false;

  get length(): number {
    if (this.throwOnLength) throw new DOMException("Storage length blocked", "SecurityError");
    return this.values.size;
  }

  clear(): void { this.values.clear(); }

  getItem(key: string): string | null {
    if (key === this.throwOnGetKey) {
      throw new DOMException("Storage read blocked", "SecurityError");
    }
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    if (this.throwOnKey) throw new DOMException("Storage index blocked", "SecurityError");
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    if (key === this.ignoredRemoveKey) return;
    this.values.delete(key);
    if (key === this.throwAfterRemoveKey) {
      this.throwAfterRemoveKey = null;
      throw new DOMException("Storage remove interrupted", "SecurityError");
    }
  }

  setItem(key: string, value: string): void {
    if (key === this.ignoredWriteKey) return;
    this.values.set(key, value);
    if (key === this.throwAfterWriteKey) {
      this.throwAfterWriteKey = null;
      throw new DOMException("Storage write interrupted", "SecurityError");
    }
  }
}

function reconcile(prepared: PreparedSessionCompletionAttempt) {
  return reconcileSessionCompletionAttempt({
    expected: prepared,
    sessionId,
    reconcileExpiresAt: now + 600_000,
    updatedAt: now + 1,
  });
}

describe("session completion attempt store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(now);
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  test("stores one frozen metadata-only prepared attempt in shared localStorage", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput);

    expect(prepared).toEqual(expectedPrepared());
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(MAX_PENDING_SESSION_COMPLETION_ATTEMPTS).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(window.localStorage.length).toBe(1);
    const raw = window.localStorage.getItem(storageKey);
    expect(raw).toBe(JSON.stringify(expectedPrepared()));
    expect(raw).not.toMatch(/token|bearer|secret|capability/iu);
  });

  test("exports the fixed metadata key for cross-context storage synchronization", () => {
    expect(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY).toBe(storageKey);
    let observedKey: string | null = null;
    const listener = (event: StorageEvent) => {
      if (event.key === SESSION_COMPLETION_ATTEMPT_STORAGE_KEY) observedKey = event.key;
    };
    window.addEventListener("storage", listener);
    window.dispatchEvent(new StorageEvent("storage", {
      key: SESSION_COMPLETION_ATTEMPT_STORAGE_KEY,
      newValue: JSON.stringify(expectedPrepared()),
      storageArea: window.localStorage,
    }));
    window.removeEventListener("storage", listener);

    expect(observedKey).toBe(storageKey);
  });

  test("rejects unknown secret-bearing prepare fields without persisting their values", () => {
    const secret = "v1.completion.this-must-never-reach-storage";
    const secretBearingInput = {
      ...firstInput,
      completionToken: secret,
    } as PrepareSessionCompletionAttemptInput;

    expect(storePreparedSessionCompletionAttempt(secretBearingInput)).toBeNull();
    expect(window.localStorage.getItem(storageKey)).toBeNull();
    expect(JSON.stringify(scanPendingSessionCompletionAttempts())).not.toContain(secret);
  });

  test("shares the same unresolved attempt across tab-like window storage access", () => {
    const sharedLocalStorage = new MemoryStorage();
    const firstTabSessionStorage = new MemoryStorage();
    const secondTabSessionStorage = new MemoryStorage();
    const local = vi.spyOn(window, "localStorage", "get");
    const session = vi.spyOn(window, "sessionStorage", "get");
    local.mockReturnValue(sharedLocalStorage);
    session.mockReturnValue(firstTabSessionStorage);

    const prepared = storePreparedSessionCompletionAttempt(firstInput);

    session.mockReturnValue(secondTabSessionStorage);
    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: true,
      attempts: [prepared],
    });
    expect(firstTabSessionStorage.length).toBe(0);
    expect(secondTabSessionStorage.length).toBe(0);
  });

  test("reports an empty readable inventory distinctly from blocked storage", () => {
    const emptyInventory = scanPendingSessionCompletionAttempts();
    expect(emptyInventory).toEqual({ ok: true, attempts: [] });
    if (!emptyInventory.ok) throw new Error("expected readable inventory");
    expect(Object.isFrozen(emptyInventory.attempts)).toBe(true);

    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage unavailable", "SecurityError");
    });

    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "storage_unavailable",
    });
  });

  test("captures exact expected-empty completion namespace state", () => {
    const snapshot = captureSessionCompletionAttemptSnapshot();

    expect(snapshot.inventory).toEqual({ ok: true, attempts: [] });
    expect(verifySessionCompletionAttemptSnapshot(snapshot)).toBe(true);

    window.localStorage.setItem(storageKey, JSON.stringify(expectedPrepared()));
    expect(verifySessionCompletionAttemptSnapshot(snapshot)).toBe(false);
  });

  test("rejects exact completion snapshots after raw replacement removal or namespace conflict", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const raw = window.localStorage.getItem(storageKey)!;
    const snapshot = captureSessionCompletionAttemptSnapshot();

    expect(snapshot.inventory).toEqual({ ok: true, attempts: [prepared] });
    expect(verifySessionCompletionAttemptSnapshot(snapshot)).toBe(true);

    window.localStorage.setItem(storageKey, `${raw} `);
    expect(verifySessionCompletionAttemptSnapshot(snapshot)).toBe(false);
    window.localStorage.setItem(storageKey, raw);
    window.localStorage.setItem(legacyStorageKey, "conflict");
    expect(verifySessionCompletionAttemptSnapshot(snapshot)).toBe(false);
    window.localStorage.removeItem(legacyStorageKey);
    window.localStorage.removeItem(storageKey);
    expect(verifySessionCompletionAttemptSnapshot(snapshot)).toBe(false);
  });

  test("captures corrupt and legacy namespaces without treating them as readable authority", () => {
    window.localStorage.setItem(storageKey, "{broken");
    const corrupt = captureSessionCompletionAttemptSnapshot();
    expect(corrupt.inventory).toEqual({ ok: false, reason: "corrupt_record" });
    expect(verifySessionCompletionAttemptSnapshot(corrupt)).toBe(true);
    window.localStorage.setItem(storageKey, "{newer-broken");
    expect(verifySessionCompletionAttemptSnapshot(corrupt)).toBe(false);

    window.localStorage.clear();
    window.localStorage.setItem(legacyStorageKey, "legacy-metadata");
    const legacy = captureSessionCompletionAttemptSnapshot();
    expect(legacy.inventory).toEqual({ ok: false, reason: "legacy_schema" });
    expect(verifySessionCompletionAttemptSnapshot(legacy)).toBe(true);
    window.localStorage.setItem(`${legacyStorageKey}.conflict`, "unknown");
    expect(verifySessionCompletionAttemptSnapshot(legacy)).toBe(false);
  });

  test("fails a second global prepare closed without eviction even after expiry", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput);
    vi.mocked(Date.now).mockReturnValue(firstInput.prepareExpiresAt + 1);

    expect(storePreparedSessionCompletionAttempt(secondInput)).toBeNull();
    const inventory = scanPendingSessionCompletionAttempts(firstInput.prepareExpiresAt + 1);
    expect(inventory).toEqual({ ok: true, attempts: [prepared] });
    expect(window.localStorage.getItem(storageKey)).toBe(JSON.stringify(prepared));
  });

  test("keeps an expired attempt visible for explicit reconciliation", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput);

    const inventory = scanPendingSessionCompletionAttempts(firstInput.prepareExpiresAt);

    expect(inventory).toEqual({ ok: true, attempts: [prepared] });
    expect(readSessionCompletionAttempt(firstInput)).toEqual(prepared);
    expect(window.localStorage.getItem(storageKey)).not.toBeNull();
  });

  test("preserves corrupt and legacy unresolved data while returning blocked", () => {
    window.localStorage.setItem(storageKey, "{broken");
    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "corrupt_record",
    });
    expect(window.localStorage.getItem(storageKey)).toBe("{broken");
    expect(storePreparedSessionCompletionAttempt(firstInput)).toBeNull();
    expect(window.localStorage.getItem(storageKey)).toBe("{broken");

    window.localStorage.clear();
    window.localStorage.setItem(legacyStorageKey, "legacy-metadata");
    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "legacy_schema",
    });
    expect(window.localStorage.getItem(legacyStorageKey)).toBe("legacy-metadata");
  });

  test("blocks a legacy schema at the current key without deleting it", () => {
    const raw = JSON.stringify({ ...expectedPrepared(), schemaVersion: 1 });
    window.localStorage.setItem(storageKey, raw);

    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "legacy_schema",
    });
    expect(window.localStorage.getItem(storageKey)).toBe(raw);
  });

  test("reports namespace and read failures as blocked without mutating storage", () => {
    const storage = new MemoryStorage();
    storage.values.set(storageKey, JSON.stringify(expectedPrepared()));
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    storage.throwOnKey = true;

    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "storage_unreadable",
    });
    expect(storage.values.get(storageKey)).toBe(JSON.stringify(expectedPrepared()));

    storage.throwOnKey = false;
    storage.throwOnGetKey = storageKey;
    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "storage_unreadable",
    });
    expect(storage.values.get(storageKey)).toBe(JSON.stringify(expectedPrepared()));
  });

  test("requires exact canonical metadata and timestamps before the first write", () => {
    const malformed: PrepareSessionCompletionAttemptInput[] = [
      { ...firstInput, challengeId: firstInput.challengeId.toUpperCase() },
      { ...firstInput, attemptId: "00000000-0000-0000-0000-000000000000" },
      { ...firstInput, predecessorDeviceId: "not-a-uuid" },
      { ...firstInput, candidateDeviceId: firstInput.predecessorDeviceId },
      { ...firstInput, createdAt: now + 0.5 },
      { ...firstInput, prepareExpiresAt: now },
      { ...firstInput, createdAt: now - 2, prepareExpiresAt: now - 1 },
    ];

    for (const input of malformed) {
      expect(storePreparedSessionCompletionAttempt(input)).toBeNull();
    }
    expect(window.localStorage.length).toBe(0);
  });

  test("rolls back a prepared write that throws after mutation", () => {
    const storage = new MemoryStorage();
    storage.throwAfterWriteKey = storageKey;
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);

    expect(storePreparedSessionCompletionAttempt(firstInput)).toBeNull();
    expect(storage.values.has(storageKey)).toBe(false);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [] });
  });

  test("rejects a prepared write whose exact readback cannot be verified", () => {
    const storage = new MemoryStorage();
    storage.ignoredWriteKey = storageKey;
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);

    expect(storePreparedSessionCompletionAttempt(firstInput)).toBeNull();
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [] });
  });

  test("CAS-reconciles authoritative session metadata before device commit", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const reconciled = reconcile(prepared);

    expect(reconciled).toEqual({
      ...prepared,
      phase: "reconciled",
      sessionId,
      reconcileExpiresAt: now + 600_000,
      updatedAt: now + 1,
    });
    expect(Object.isFrozen(reconciled)).toBe(true);
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);
  });

  test("accepts the exact 31-day authoritative recovery capability window", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const updatedAt = now + 1;

    expect(reconcileSessionCompletionAttempt({
      expected: prepared,
      sessionId,
      reconcileExpiresAt: updatedAt + reconcileLifetimeMs,
      updatedAt,
    })).toMatchObject({
      phase: "reconciled",
      reconcileExpiresAt: updatedAt + reconcileLifetimeMs,
    });
  });

  test("rejects stale or conflicting reconcile CAS and preserves immutable metadata", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const reconciled = reconcile(prepared)!;

    expect(reconcileSessionCompletionAttempt({
      expected: prepared,
      sessionId: "019d0000-0000-7000-8000-000000000499",
      reconcileExpiresAt: now + 700_000,
      updatedAt: now + 2,
    })).toBeNull();
    expect(reconcileSessionCompletionAttempt({
      expected: {
        ...prepared,
        candidateDeviceId: "019d0000-0000-7000-8000-000000000498",
      },
      sessionId,
      reconcileExpiresAt: now + 600_000,
      updatedAt: now + 2,
    })).toBeNull();
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);
  });

  test("allows only reconciled to device_committed to accepting exact CAS phases", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;

    expect(markSessionCompletionAttemptDeviceCommitted({
      expected: prepared as never,
      updatedAt: now + 2,
    })).toBeNull();

    const reconciled = reconcile(prepared)!;
    const committed = markSessionCompletionAttemptDeviceCommitted({
      expected: reconciled,
      updatedAt: now + 2,
    });
    expect(committed).toEqual({
      ...reconciled,
      phase: "device_committed",
      updatedAt: now + 2,
    });
    expect(markSessionCompletionAttemptAccepting({
      expected: reconciled as never,
      updatedAt: now + 3,
    })).toBeNull();

    const accepting = markSessionCompletionAttemptAccepting({
      expected: committed!,
      updatedAt: now + 3,
    });
    expect(accepting).toEqual({
      ...committed,
      phase: "accepting",
      updatedAt: now + 3,
    });
    expect(Object.isFrozen(accepting)).toBe(true);
    expect(readSessionCompletionAttempt(firstInput)).toEqual(accepting);
  });

  test("reconciles an exact request whose authoritative response arrives after prepare expiry", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    vi.mocked(Date.now).mockReturnValue(firstInput.prepareExpiresAt);
    const reconciled = reconcileSessionCompletionAttempt({
      expected: prepared,
      sessionId,
      reconcileExpiresAt: firstInput.prepareExpiresAt + 120_000,
      updatedAt: firstInput.prepareExpiresAt,
    });

    expect(reconciled).toMatchObject({
      phase: "reconciled",
      sessionId,
      updatedAt: firstInput.prepareExpiresAt,
      reconcileExpiresAt: firstInput.prepareExpiresAt + 120_000,
    });
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);
  });

  test("does not advance after authoritative reconcile expiry and keeps the record", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const reconciled = reconcile(prepared)!;
    vi.mocked(Date.now).mockReturnValue(reconciled.reconcileExpiresAt);
    expect(markSessionCompletionAttemptDeviceCommitted({
      expected: reconciled,
      updatedAt: now + 2,
    })).toBeNull();
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);
  });

  test("rolls back a transition when persistence throws or readback mismatches", () => {
    const storage = new MemoryStorage();
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    storage.throwAfterWriteKey = storageKey;

    expect(reconcile(prepared)).toBeNull();
    expect(readSessionCompletionAttempt(firstInput)).toEqual(prepared);

    storage.ignoredWriteKey = storageKey;
    expect(reconcile(prepared)).toBeNull();
    expect(readSessionCompletionAttempt(firstInput)).toEqual(prepared);
  });

  test("removes only the exact expected record and verifies deletion", () => {
    const storage = new MemoryStorage();
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const reconciled = reconcile(prepared)!;

    expect(removeSessionCompletionAttempt(prepared)).toBe(false);
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);

    storage.ignoredRemoveKey = storageKey;
    expect(removeSessionCompletionAttempt(reconciled)).toBe(false);
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);

    storage.ignoredRemoveKey = null;
    storage.throwAfterRemoveKey = storageKey;
    expect(removeSessionCompletionAttempt(reconciled)).toBe(true);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [] });
  });

  test("restores an exactly removed durable attempt only into an unchanged empty namespace", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const reconciled = reconcile(prepared)!;

    expect(removeSessionCompletionAttempt(reconciled)).toBe(true);
    expect(restoreSessionCompletionAttemptExactly(reconciled)).toBe(true);
    expect(readSessionCompletionAttempt(firstInput)).toEqual(reconciled);
  });

  test("never overwrites a newer durable attempt while restoring an older removal", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    expect(removeSessionCompletionAttempt(prepared)).toBe(true);
    vi.mocked(Date.now).mockReturnValue(now + 1);
    const newer = storePreparedSessionCompletionAttempt(secondInput)!;

    expect(restoreSessionCompletionAttemptExactly(prepared)).toBe(false);
    expect(scanPendingSessionCompletionAttempts()).toEqual({ ok: true, attempts: [newer] });
  });

  test("returns frozen records and arrays from scan, read, and diagnostic list helpers", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const inventory = scanPendingSessionCompletionAttempts();
    const read = readSessionCompletionAttempt(firstInput);
    const diagnostic = listPendingSessionCompletionAttempts();

    expect(inventory).toEqual({ ok: true, attempts: [prepared] });
    if (!inventory.ok) throw new Error("expected readable inventory");
    expect(Object.isFrozen(inventory.attempts)).toBe(true);
    expect(inventory.attempts.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(diagnostic.every(Object.isFrozen)).toBe(true);
  });

  test("contains storage exceptions across every helper without deleting unresolved data", () => {
    const storage = new MemoryStorage();
    vi.spyOn(window, "localStorage", "get").mockReturnValue(storage);
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    storage.throwOnGetKey = storageKey;

    expect(readSessionCompletionAttempt(firstInput)).toBeNull();
    expect(reconcile(prepared)).toBeNull();
    expect(removeSessionCompletionAttempt(prepared)).toBe(false);
    expect(listPendingSessionCompletionAttempts()).toEqual([]);
    expect(storage.values.get(storageKey)).toBe(JSON.stringify(prepared));
  });

  test("rejects invalid authoritative reconciliation metadata before mutation", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const malformed = [
      { sessionId: sessionId.toUpperCase(), reconcileExpiresAt: now + 600_000, updatedAt: now + 1 },
      { sessionId, reconcileExpiresAt: now + 600_000.5, updatedAt: now + 1 },
      { sessionId, reconcileExpiresAt: now + 1, updatedAt: now + 1 },
      { sessionId, reconcileExpiresAt: now + 600_000, updatedAt: now },
      {
        sessionId,
        reconcileExpiresAt: now + 1 + reconcileLifetimeMs + 1,
        updatedAt: now + 1,
      },
    ];

    for (const input of malformed) {
      expect(reconcileSessionCompletionAttempt({ expected: prepared, ...input })).toBeNull();
    }
    expect(readSessionCompletionAttempt(firstInput)).toEqual(prepared);
  });

  test("never returns mutable storage-owned objects", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const returned = readSessionCompletionAttempt(firstInput)!;
    expect(() => {
      (returned as { phase: string }).phase = "accepting";
    }).toThrow();
    expect(readSessionCompletionAttempt(firstInput)).toEqual(prepared);
  });

  test("accepts only the exact schema keys for every persisted phase", () => {
    const unexpected = JSON.stringify({ ...expectedPrepared(), debug: true });
    window.localStorage.setItem(storageKey, unexpected);

    expect(scanPendingSessionCompletionAttempts()).toEqual({
      ok: false,
      reason: "corrupt_record",
    });
    expect(window.localStorage.getItem(storageKey)).toBe(unexpected);
  });

  test("types every inventory item as a pending attempt without widening storage data", () => {
    const prepared = storePreparedSessionCompletionAttempt(firstInput)!;
    const inventory = scanPendingSessionCompletionAttempts();
    if (!inventory.ok) throw new Error("expected readable inventory");
    const typed: readonly PendingSessionCompletionAttempt[] = inventory.attempts;
    expect(typed).toEqual([prepared]);
  });
});
