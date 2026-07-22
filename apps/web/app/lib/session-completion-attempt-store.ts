"use client";

export const SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION = 2 as const;
export const MAX_PENDING_SESSION_COMPLETION_ATTEMPTS = 1 as const;

const storageNamespacePrefix = "spott.web.session-completion-attempt.";
export const SESSION_COMPLETION_ATTEMPT_STORAGE_KEY =
  `${storageNamespacePrefix}v${SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION}` as const;
const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumReconcileLifetimeMs = 2_678_400_000;

export type SessionCompletionAttemptPhase =
  | "prepared"
  | "reconciled"
  | "device_committed"
  | "accepting";

interface SessionCompletionAttemptBase {
  readonly schemaVersion: typeof SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION;
  readonly challengeId: string;
  readonly attemptId: string;
  readonly predecessorDeviceId: string;
  readonly candidateDeviceId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly prepareExpiresAt: number;
}

export interface PreparedSessionCompletionAttempt extends SessionCompletionAttemptBase {
  readonly phase: "prepared";
}

interface AuthoritativeSessionCompletionAttempt extends SessionCompletionAttemptBase {
  readonly sessionId: string;
  readonly reconcileExpiresAt: number;
}

export interface ReconciledSessionCompletionAttempt
  extends AuthoritativeSessionCompletionAttempt {
  readonly phase: "reconciled";
}

export interface DeviceCommittedSessionCompletionAttempt
  extends AuthoritativeSessionCompletionAttempt {
  readonly phase: "device_committed";
}

export interface AcceptingSessionCompletionAttempt
  extends AuthoritativeSessionCompletionAttempt {
  readonly phase: "accepting";
}

export type PendingSessionCompletionAttempt =
  | PreparedSessionCompletionAttempt
  | ReconciledSessionCompletionAttempt
  | DeviceCommittedSessionCompletionAttempt
  | AcceptingSessionCompletionAttempt;

export interface PrepareSessionCompletionAttemptInput {
  readonly challengeId: string;
  readonly attemptId: string;
  readonly predecessorDeviceId: string;
  readonly candidateDeviceId: string;
  readonly createdAt: number;
  readonly prepareExpiresAt: number;
}

export interface SessionCompletionAttemptIdentity {
  readonly challengeId: string;
  readonly attemptId: string;
}

export interface ReconcileSessionCompletionAttemptInput {
  readonly expected: PreparedSessionCompletionAttempt;
  readonly sessionId: string;
  readonly reconcileExpiresAt: number;
  readonly updatedAt: number;
}

export interface CommitSessionCompletionAttemptInput<
  TExpected extends ReconciledSessionCompletionAttempt | DeviceCommittedSessionCompletionAttempt,
> {
  readonly expected: TExpected;
  readonly updatedAt: number;
}

export type SessionCompletionAttemptInventoryBlockedReason =
  | "invalid_time"
  | "storage_unavailable"
  | "storage_unreadable"
  | "legacy_schema"
  | "corrupt_record";

export type SessionCompletionAttemptInventory =
  | {
      readonly ok: true;
      readonly attempts: readonly PendingSessionCompletionAttempt[];
    }
  | {
      readonly ok: false;
      readonly reason: SessionCompletionAttemptInventoryBlockedReason;
    };

export interface SessionCompletionAttemptSnapshot {
  readonly inventory: SessionCompletionAttemptInventory;
}

interface CompletionNamespaceEntry {
  readonly key: string;
  readonly raw: string;
}

type CompletionNamespaceSnapshot =
  | { readonly ok: true; readonly entries: readonly CompletionNamespaceEntry[] }
  | { readonly ok: false };

const completionNamespaceSnapshots = new WeakMap<SessionCompletionAttemptSnapshot, CompletionNamespaceSnapshot>();

const prepareInputKeys = [
  "attemptId",
  "candidateDeviceId",
  "challengeId",
  "createdAt",
  "predecessorDeviceId",
  "prepareExpiresAt",
] as const;

const preparedRecordKeys = [
  "attemptId",
  "candidateDeviceId",
  "challengeId",
  "createdAt",
  "phase",
  "predecessorDeviceId",
  "prepareExpiresAt",
  "schemaVersion",
  "updatedAt",
] as const;

const authoritativeRecordKeys = [
  ...preparedRecordKeys,
  "reconcileExpiresAt",
  "sessionId",
] as const;

const reconcileInputKeys = [
  "expected",
  "reconcileExpiresAt",
  "sessionId",
  "updatedAt",
] as const;

const commitInputKeys = ["expected", "updatedAt"] as const;

function localStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  const actualKeys = Object.keys(value).sort();
  const orderedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === orderedExpectedKeys.length
    && actualKeys.every((key, index) => key === orderedExpectedKeys[index]);
}

function validTimestamp(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0;
}

function validCanonicalUUID(value: unknown): value is string {
  return typeof value === "string" && canonicalUUIDPattern.test(value);
}

function validBaseFields(value: Record<string, unknown>): boolean {
  return value.schemaVersion === SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION
    && validCanonicalUUID(value.challengeId)
    && validCanonicalUUID(value.attemptId)
    && validCanonicalUUID(value.predecessorDeviceId)
    && validCanonicalUUID(value.candidateDeviceId)
    && value.predecessorDeviceId !== value.candidateDeviceId
    && validTimestamp(value.createdAt)
    && validTimestamp(value.updatedAt)
    && validTimestamp(value.prepareExpiresAt)
    && value.createdAt <= value.updatedAt
    && value.createdAt < value.prepareExpiresAt;
}

function validAttempt(value: unknown): value is PendingSessionCompletionAttempt {
  if (!isRecord(value) || !validBaseFields(value)) return false;
  if (value.phase === "prepared") {
    return hasExactKeys(value, preparedRecordKeys)
      && value.updatedAt === value.createdAt;
  }
  if (
    value.phase !== "reconciled"
    && value.phase !== "device_committed"
    && value.phase !== "accepting"
  ) return false;
  if (!validTimestamp(value.updatedAt) || !validTimestamp(value.prepareExpiresAt)) {
    return false;
  }
  return hasExactKeys(value, authoritativeRecordKeys)
    && validCanonicalUUID(value.sessionId)
    && validTimestamp(value.reconcileExpiresAt)
    && value.updatedAt < value.reconcileExpiresAt
    && value.reconcileExpiresAt - value.updatedAt <= maximumReconcileLifetimeMs;
}

function validPrepareInput(value: unknown): value is PrepareSessionCompletionAttemptInput {
  if (!isRecord(value) || !hasExactKeys(value, prepareInputKeys)) return false;
  return validCanonicalUUID(value.challengeId)
    && validCanonicalUUID(value.attemptId)
    && validCanonicalUUID(value.predecessorDeviceId)
    && validCanonicalUUID(value.candidateDeviceId)
    && value.predecessorDeviceId !== value.candidateDeviceId
    && validTimestamp(value.createdAt)
    && validTimestamp(value.prepareExpiresAt)
    && value.createdAt < value.prepareExpiresAt;
}

function frozen<T extends PendingSessionCompletionAttempt>(record: T): T {
  return Object.freeze({ ...record }) as unknown as T;
}

function frozenAttempts(
  attempts: readonly PendingSessionCompletionAttempt[],
): readonly PendingSessionCompletionAttempt[] {
  return Object.freeze(attempts.map((attempt) => frozen(attempt)));
}

function readableInventory(
  attempts: readonly PendingSessionCompletionAttempt[],
): SessionCompletionAttemptInventory {
  return Object.freeze({ ok: true as const, attempts: frozenAttempts(attempts) });
}

function blockedInventory(
  reason: SessionCompletionAttemptInventoryBlockedReason,
): SessionCompletionAttemptInventory {
  return Object.freeze({ ok: false as const, reason });
}

function encodeAttempt(record: PendingSessionCompletionAttempt): string {
  if (record.phase === "prepared") {
    return JSON.stringify({
      schemaVersion: record.schemaVersion,
      challengeId: record.challengeId,
      attemptId: record.attemptId,
      predecessorDeviceId: record.predecessorDeviceId,
      candidateDeviceId: record.candidateDeviceId,
      phase: record.phase,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      prepareExpiresAt: record.prepareExpiresAt,
    });
  }
  return JSON.stringify({
    schemaVersion: record.schemaVersion,
    challengeId: record.challengeId,
    attemptId: record.attemptId,
    predecessorDeviceId: record.predecessorDeviceId,
    candidateDeviceId: record.candidateDeviceId,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    prepareExpiresAt: record.prepareExpiresAt,
    sessionId: record.sessionId,
    reconcileExpiresAt: record.reconcileExpiresAt,
  });
}

function parseAttempt(
  raw: string,
):
  | { readonly ok: true; readonly attempt: PendingSessionCompletionAttempt }
  | { readonly ok: false; readonly reason: "legacy_schema" | "corrupt_record" } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "corrupt_record" };
  }
  if (
    isRecord(parsed)
    && "schemaVersion" in parsed
    && parsed.schemaVersion !== SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION
  ) {
    return { ok: false, reason: "legacy_schema" };
  }
  return validAttempt(parsed)
    ? { ok: true, attempt: parsed }
    : { ok: false, reason: "corrupt_record" };
}

function captureNamespace(storage: Storage): CompletionNamespaceSnapshot {
  try {
    const entries: CompletionNamespaceEntry[] = [];
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key === null) return { ok: false };
      if (!key.startsWith(storageNamespacePrefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) return { ok: false };
      entries.push({ key, raw });
    }
    entries.sort((left, right) => left.key.localeCompare(right.key));
    return Object.freeze({
      ok: true as const,
      entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    });
  } catch {
    return { ok: false };
  }
}

function inventoryFromNamespace(
  namespace: CompletionNamespaceSnapshot,
  now: number,
): SessionCompletionAttemptInventory {
  if (!validTimestamp(now)) return blockedInventory("invalid_time");
  if (!namespace.ok) return blockedInventory("storage_unreadable");
  if (namespace.entries.some((entry) => entry.key !== SESSION_COMPLETION_ATTEMPT_STORAGE_KEY)) {
    return blockedInventory("legacy_schema");
  }
  if (namespace.entries.length === 0) return readableInventory([]);
  if (namespace.entries.length !== 1) return blockedInventory("storage_unreadable");
  const parsed = parseAttempt(namespace.entries[0]!.raw);
  return parsed.ok
    ? readableInventory([parsed.attempt])
    : blockedInventory(parsed.reason);
}

function captureStorageSnapshot(storage: Storage, now: number): SessionCompletionAttemptSnapshot {
  const namespace = captureNamespace(storage);
  const snapshot = Object.freeze({ inventory: inventoryFromNamespace(namespace, now) });
  completionNamespaceSnapshots.set(snapshot, namespace);
  return snapshot;
}

function scanStorage(storage: Storage, now: number): SessionCompletionAttemptInventory {
  return captureStorageSnapshot(storage, now).inventory;
}

/**
 * Security-sensitive callers must use this inventory API and treat `ok: false`
 * as unresolved authority. Expired attempts remain present for explicit server
 * reconciliation; this function never prunes or repairs storage.
 */
export function scanPendingSessionCompletionAttempts(
  now: number = Date.now(),
): SessionCompletionAttemptInventory {
  const storage = localStorageOrNull();
  return storage
    ? scanStorage(storage, now)
    : blockedInventory("storage_unavailable");
}

export function captureSessionCompletionAttemptSnapshot(
  now: number = Date.now(),
): SessionCompletionAttemptSnapshot {
  const storage = localStorageOrNull();
  if (storage) return captureStorageSnapshot(storage, now);
  const snapshot = Object.freeze({ inventory: blockedInventory("storage_unavailable") });
  completionNamespaceSnapshots.set(snapshot, { ok: false });
  return snapshot;
}

export function verifySessionCompletionAttemptSnapshot(
  snapshot: SessionCompletionAttemptSnapshot,
): boolean {
  const expected = completionNamespaceSnapshots.get(snapshot);
  if (!expected?.ok) return false;
  const storage = localStorageOrNull();
  if (!storage) return false;
  const current = captureNamespace(storage);
  return current.ok
    && current.entries.length === expected.entries.length
    && current.entries.every((entry, index) => {
      const expectedEntry = expected.entries[index];
      return expectedEntry !== undefined
        && entry.key === expectedEntry.key
        && entry.raw === expectedEntry.raw;
    });
}

function readRaw(storage: Storage): string | null | undefined {
  try {
    return storage.getItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY);
  } catch {
    return undefined;
  }
}

function removeAndVerifyExact(
  storage: Storage,
  expectedRaw: string,
): boolean {
  const before = readRaw(storage);
  if (before !== expectedRaw) return false;
  try {
    storage.removeItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY);
  } catch {
    // A Storage implementation may mutate before reporting an interruption.
  }
  return readRaw(storage) === null;
}

function restoreExpectedAfterFailedWrite(
  storage: Storage,
  attemptedRaw: string,
  previousRaw: string | null,
): void {
  if (readRaw(storage) !== attemptedRaw) return;
  try {
    if (previousRaw === null) storage.removeItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY);
    else storage.setItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY, previousRaw);
  } catch {
    // The caller will fail closed; a later scan exposes any unresolved record.
  }
}

function writeWithCas(
  storage: Storage,
  previousRaw: string | null,
  next: PendingSessionCompletionAttempt,
): PendingSessionCompletionAttempt | null {
  if (readRaw(storage) !== previousRaw) return null;
  const nextRaw = encodeAttempt(next);
  try {
    storage.setItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY, nextRaw);
  } catch {
    restoreExpectedAfterFailedWrite(storage, nextRaw, previousRaw);
    return null;
  }
  if (readRaw(storage) !== nextRaw) {
    restoreExpectedAfterFailedWrite(storage, nextRaw, previousRaw);
    return null;
  }
  return frozen(next);
}

export function storePreparedSessionCompletionAttempt(
  input: PrepareSessionCompletionAttemptInput,
): PreparedSessionCompletionAttempt | null {
  if (!validPrepareInput(input)) return null;
  const now = Date.now();
  if (!validTimestamp(now) || input.createdAt > now || input.prepareExpiresAt <= now) {
    return null;
  }
  const record: PreparedSessionCompletionAttempt = {
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
  const storage = localStorageOrNull();
  if (!storage) return null;
  const inventory = scanStorage(storage, now);
  if (!inventory.ok) return null;
  if (inventory.attempts.length > 0) {
    const existing = inventory.attempts[0];
    return existing !== undefined && encodeAttempt(existing) === encodeAttempt(record)
      ? frozen(record)
      : null;
  }
  return writeWithCas(storage, null, record) as PreparedSessionCompletionAttempt | null;
}

export function readSessionCompletionAttempt(
  identity: SessionCompletionAttemptIdentity,
  now: number = Date.now(),
): PendingSessionCompletionAttempt | null {
  if (
    !validCanonicalUUID(identity.challengeId)
    || !validCanonicalUUID(identity.attemptId)
  ) return null;
  const inventory = scanPendingSessionCompletionAttempts(now);
  if (!inventory.ok) return null;
  const attempt = inventory.attempts[0];
  return attempt !== undefined
    && attempt.challengeId === identity.challengeId
    && attempt.attemptId === identity.attemptId
    ? frozen(attempt)
    : null;
}

function transitionWithCas<TNext extends PendingSessionCompletionAttempt>(
  expected: PendingSessionCompletionAttempt,
  next: TNext,
): TNext | null {
  if (!validAttempt(expected) || !validAttempt(next)) return null;
  const storage = localStorageOrNull();
  if (!storage) return null;
  const inventory = scanStorage(storage, Date.now());
  if (!inventory.ok || inventory.attempts.length !== 1) return null;
  const expectedRaw = encodeAttempt(expected);
  if (encodeAttempt(inventory.attempts[0]!) !== expectedRaw) return null;
  return writeWithCas(storage, expectedRaw, next) as TNext | null;
}

export function reconcileSessionCompletionAttempt(
  input: ReconcileSessionCompletionAttemptInput,
): ReconciledSessionCompletionAttempt | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, reconcileInputKeys)
    || !validAttempt(input.expected)
    || input.expected.phase !== "prepared"
    || !validCanonicalUUID(input.sessionId)
    || !validTimestamp(input.updatedAt)
    || !validTimestamp(input.reconcileExpiresAt)
    || input.updatedAt <= input.expected.updatedAt
    || input.reconcileExpiresAt <= input.updatedAt
    || input.reconcileExpiresAt - input.updatedAt > maximumReconcileLifetimeMs
  ) return null;
  const now = Date.now();
  if (!validTimestamp(now) || now >= input.reconcileExpiresAt) return null;
  return transitionWithCas(input.expected, {
    ...input.expected,
    phase: "reconciled",
    sessionId: input.sessionId,
    reconcileExpiresAt: input.reconcileExpiresAt,
    updatedAt: input.updatedAt,
  });
}

export function markSessionCompletionAttemptDeviceCommitted(
  input: CommitSessionCompletionAttemptInput<ReconciledSessionCompletionAttempt>,
): DeviceCommittedSessionCompletionAttempt | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, commitInputKeys)
    || !validAttempt(input.expected)
    || input.expected.phase !== "reconciled"
    || !validTimestamp(input.updatedAt)
    || input.updatedAt <= input.expected.updatedAt
    || input.updatedAt >= input.expected.reconcileExpiresAt
  ) return null;
  const now = Date.now();
  if (!validTimestamp(now) || now >= input.expected.reconcileExpiresAt) return null;
  return transitionWithCas(input.expected, {
    ...input.expected,
    phase: "device_committed",
    updatedAt: input.updatedAt,
  });
}

export function markSessionCompletionAttemptAccepting(
  input: CommitSessionCompletionAttemptInput<DeviceCommittedSessionCompletionAttempt>,
): AcceptingSessionCompletionAttempt | null {
  if (
    !isRecord(input)
    || !hasExactKeys(input, commitInputKeys)
    || !validAttempt(input.expected)
    || input.expected.phase !== "device_committed"
    || !validTimestamp(input.updatedAt)
    || input.updatedAt <= input.expected.updatedAt
    || input.updatedAt >= input.expected.reconcileExpiresAt
  ) return null;
  const now = Date.now();
  if (!validTimestamp(now) || now >= input.expected.reconcileExpiresAt) return null;
  return transitionWithCas(input.expected, {
    ...input.expected,
    phase: "accepting",
    updatedAt: input.updatedAt,
  });
}

export function removeSessionCompletionAttempt(
  expected: PendingSessionCompletionAttempt,
): boolean {
  if (!validAttempt(expected)) return false;
  const storage = localStorageOrNull();
  if (!storage) return false;
  const inventory = scanStorage(storage, Date.now());
  if (!inventory.ok) return false;
  if (inventory.attempts.length === 0) return true;
  const expectedRaw = encodeAttempt(expected);
  if (encodeAttempt(inventory.attempts[0]!) !== expectedRaw) return false;
  return removeAndVerifyExact(storage, expectedRaw);
}

export function restoreSessionCompletionAttemptExactly(
  expected: PendingSessionCompletionAttempt,
): boolean {
  if (!validAttempt(expected)) return false;
  const storage = localStorageOrNull();
  if (!storage) return false;
  const before = captureNamespace(storage);
  if (!before.ok || before.entries.length !== 0) return false;
  const expectedRaw = encodeAttempt(expected);
  try {
    storage.setItem(SESSION_COMPLETION_ATTEMPT_STORAGE_KEY, expectedRaw);
  } catch {
    if (readRaw(storage) === expectedRaw) removeAndVerifyExact(storage, expectedRaw);
    return false;
  }
  const after = captureNamespace(storage);
  const restored = after.ok
    && after.entries.length === 1
    && after.entries[0]?.key === SESSION_COMPLETION_ATTEMPT_STORAGE_KEY
    && after.entries[0]?.raw === expectedRaw;
  if (restored) return true;
  if (readRaw(storage) === expectedRaw) removeAndVerifyExact(storage, expectedRaw);
  return false;
}

/**
 * Diagnostic compatibility helper. It intentionally maps a blocked inventory
 * to an empty list and therefore MUST NOT be used for authorization or cleanup
 * decisions. Security-sensitive runtime code must use
 * `scanPendingSessionCompletionAttempts` instead.
 */
export function listPendingSessionCompletionAttempts(
  now: number = Date.now(),
): readonly PendingSessionCompletionAttempt[] {
  const inventory = scanPendingSessionCompletionAttempts(now);
  return inventory.ok ? inventory.attempts : frozenAttempts([]);
}
