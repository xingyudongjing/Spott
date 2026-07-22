"use client";

import {
  createSessionRefreshCoordinator,
  publishCrossContextSessionState,
  subscribeCrossContextSessionState,
  type CrossContextAnonymousTransition,
  type CrossContextLoginSwitchResumeSnapshot,
  type CrossContextSessionMetadata,
} from "./session-refresh-coordinator";
import { clearPrivateBrowserDrafts } from "./private-browser-drafts";
import {
  assertLoginDevicePlanCommitted,
  assertLoginDevicePlanCurrent,
  commitLoginDevicePlan,
  markCurrentDeviceBound,
  rollbackLoginDevicePlan,
  type LoginDevicePlan,
} from "./browser-device-identity";
import {
  captureSessionCompletionAttemptSnapshot,
  markSessionCompletionAttemptAccepting,
  markSessionCompletionAttemptDeviceCommitted,
  reconcileSessionCompletionAttempt,
  removeSessionCompletionAttempt,
  restoreSessionCompletionAttemptExactly,
  scanPendingSessionCompletionAttempts,
  SESSION_COMPLETION_ATTEMPT_STORAGE_KEY,
  SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION,
  storePreparedSessionCompletionAttempt,
  verifySessionCompletionAttemptSnapshot,
  type PendingSessionCompletionAttempt,
  type PreparedSessionCompletionAttempt,
  type SessionCompletionAttemptSnapshot,
} from "./session-completion-attempt-store";

const LEGACY_SESSION_KEY = "spott.web.session.v1";
const REFRESH_ATTEMPT_KEY = "spott.web.refresh-attempt.v1";
const LOGOUT_INTENT_KEY = "spott.web.logout-intent.v1";
const LOGIN_SWITCH_RESUME_PREFIX = "spott.web.login-switch-resume.v1.";
const SESSION_METADATA_KEY = "spott.web.session-metadata.v1";
const SESSION_EVENT = "spott:session";
const LOGOUT_INTENT_COOKIE = "__Host-spott_logout_intent";
const refreshAttemptLifetimeMilliseconds = 10 * 60 * 1000;
const loginSwitchResumeLifetimeMilliseconds = 10 * 60 * 1000;
const maximumSessionCompletionLifetimeMilliseconds = 120 * 1000;
const maximumSessionCompletionReconcileLifetimeMilliseconds = 31 * 24 * 60 * 60 * 1000;
const maximumBrowserSessionResponseLength = 65_536;
const maximumClockSkewMilliseconds = 30 * 1000;
const canonicalSessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const browserJSONContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

export interface SessionUser {
  id: string;
  publicHandle: string;
  phoneVerified: boolean;
  restrictions: string[];
}

export interface WebSession {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshGeneration: number;
  sessionId: string;
  user: SessionUser;
}

export type SessionMetadata =
  | { readonly state: "anonymous" }
  | {
      readonly state: "authenticated";
      readonly userId: string;
      readonly sessionId: string;
      readonly refreshGeneration: number;
    };

interface RefreshAttemptMetadata {
  readonly attemptId: string;
  readonly sessionId: string;
  readonly refreshGeneration: number;
  readonly createdAt: number;
}

interface RefreshAuthority {
  readonly userId: string;
  readonly sessionId: string;
  readonly refreshGeneration: number;
}

type PendingRefreshRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "blocked" }
  | {
      readonly kind: "pending";
      readonly authority: RefreshAuthority;
      readonly attempt: RefreshAttemptMetadata;
    };

interface LogoutIntentMetadata {
  readonly epoch: number;
  readonly scope: "current" | "all";
  readonly sessionId?: string;
  readonly origin?: "user" | "switch";
  readonly preservedSwitchChallengeId?: string;
  readonly createdAt: number;
}

interface LogoutIntentPersistence {
  readonly intent: LogoutIntentMetadata;
  readonly metadataRaw: string | null | undefined;
  readonly cookieValue: string | null;
}

interface LogoutCleanupSnapshot {
  readonly intent: LogoutIntentPersistence;
  readonly completion: SessionCompletionAttemptSnapshot;
  readonly resumes: StorageNamespaceSnapshot;
  readonly refreshRaw: string | null | undefined;
}

interface StorageNamespaceEntry {
  readonly key: string;
  readonly raw: string;
}

type StorageNamespaceSnapshot =
  | { readonly ok: true; readonly entries: readonly StorageNamespaceEntry[] }
  | { readonly ok: false };

interface LoginSwitchResumeMetadata {
  readonly version: 1;
  readonly challengeId: string;
  readonly predecessorDeviceId: string;
  readonly candidateDeviceId: string;
  readonly expectedUserId: string;
  readonly expectedSessionId: string;
  readonly createdAt: number;
}

type AnonymousSessionTransitionIntent =
  | { readonly kind: "user_logout" }
  | {
      readonly kind: "account_switch";
      readonly preservedSwitchChallengeId: string;
    };

let volatileSession: WebSession | null = null;
let sessionEpoch = 0;
let bootstrapInFlight: Promise<WebSession | null> | null = null;
let refreshInFlight: Promise<WebSession | null> | null = null;
let crossContextSynchronizationInFlight: Promise<void> | null = null;
let pendingCrossContextMetadata: Extract<SessionMetadata, { state: "authenticated" }> | null = null;
const cancelledLoginSwitchChallenges = new Set<string>();
const refreshCoordinator = createSessionRefreshCoordinator();

function metadataFor(session: WebSession | null): SessionMetadata {
  return session
    ? {
        state: "authenticated",
        userId: session.user.id,
        sessionId: session.sessionId,
        refreshGeneration: session.refreshGeneration,
      }
    : { state: "anonymous" };
}

function dispatchSessionChange(session: WebSession | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<SessionMetadata>(SESSION_EVENT, {
    detail: metadataFor(session),
  }));
}

function commitSession(
  session: WebSession | null,
  options: {
    readonly incrementEpoch: boolean;
    readonly broadcast: boolean;
    readonly anonymousTransition?: AnonymousSessionTransitionIntent;
  },
): boolean {
  if (session !== null && pendingLogoutIntent() !== null) return false;
  const previousUserId = storedAuthorityUserId();
  if (previousUserId !== null && (session === null || session.user.id !== previousUserId)) {
    clearPrivateBrowserDrafts();
  }
  volatileSession = session;
  if (session) markCurrentDeviceBound();
  if (options.incrementEpoch) sessionEpoch += 1;
  const metadata = metadataFor(session);
  storeMetadata(SESSION_METADATA_KEY, metadata);
  dispatchSessionChange(session);
  if (options.broadcast) {
    const anonymousTransition = session === null && options.anonymousTransition !== undefined
      ? captureCrossContextAnonymousTransition(options.anonymousTransition)
      : undefined;
    publishCrossContextSessionState(
      metadata,
      anonymousTransition,
    );
  }
  return true;
}

interface StagedSessionPublication {
  readonly session: WebSession;
  readonly metadata: Extract<SessionMetadata, { readonly state: "authenticated" }>;
}

function stageSessionPublication(session: WebSession): StagedSessionPublication {
  return {
    session,
    metadata: {
      state: "authenticated",
      userId: session.user.id,
      sessionId: session.sessionId,
      refreshGeneration: session.refreshGeneration,
    },
  };
}

function announceStagedSessionPublication(
  staged: StagedSessionPublication,
  canPublish: () => boolean,
  committedStateIsCurrent: (publishedEpoch: number) => boolean,
): number | null {
  if (!canPublish() || !storeMetadata(SESSION_METADATA_KEY, staged.metadata) || !canPublish()) {
    return null;
  }
  const previousUserId = storedAuthorityUserId();
  if (previousUserId !== null && staged.session.user.id !== previousUserId) {
    clearPrivateBrowserDrafts();
  }
  volatileSession = staged.session;
  markCurrentDeviceBound();
  sessionEpoch += 1;
  const publishedEpoch = sessionEpoch;
  if (!committedStateIsCurrent(publishedEpoch)) return null;
  dispatchSessionChange(staged.session);
  publishCrossContextSessionState(staged.metadata);
  return publishedEpoch;
}

function validUser(value: unknown): value is SessionUser {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const user = value as Record<string, unknown>;
  return typeof user.id === "string"
    && typeof user.publicHandle === "string"
    && typeof user.phoneVerified === "boolean"
    && Array.isArray(user.restrictions)
    && user.restrictions.every((restriction) => typeof restriction === "string");
}

function sessionFromPayload(value: unknown): WebSession | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const payload = value as Record<string, unknown>;
  if (payload.state !== undefined && payload.state !== "authenticated") return null;
  if (
    typeof payload.accessToken !== "string"
    || payload.accessToken.length === 0
    || typeof payload.accessTokenExpiresAt !== "string"
    || !Number.isFinite(Date.parse(payload.accessTokenExpiresAt))
    || typeof payload.refreshGeneration !== "number"
    || !Number.isSafeInteger(payload.refreshGeneration)
    || payload.refreshGeneration < 0
    || typeof payload.sessionId !== "string"
    || !validUser(payload.user)
  ) return null;
  return {
    accessToken: payload.accessToken,
    accessTokenExpiresAt: payload.accessTokenExpiresAt,
    refreshGeneration: payload.refreshGeneration,
    sessionId: payload.sessionId,
    user: payload.user,
  };
}

function sessionMetadataFromUnknown(value: unknown): SessionMetadata | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (metadata.state === "anonymous" && Object.keys(metadata).length === 1) {
    return { state: "anonymous" };
  }
  if (
    metadata.state !== "authenticated"
    || typeof metadata.userId !== "string"
    || !canonicalSessionIdPattern.test(metadata.userId)
    || typeof metadata.sessionId !== "string"
    || !canonicalSessionIdPattern.test(metadata.sessionId)
    || typeof metadata.refreshGeneration !== "number"
    || !Number.isSafeInteger(metadata.refreshGeneration)
    || metadata.refreshGeneration < 0
  ) return null;
  return {
    state: "authenticated",
    userId: metadata.userId,
    sessionId: metadata.sessionId,
    refreshGeneration: metadata.refreshGeneration,
  };
}

function storedAuthorityUserId(): string | null {
  if (volatileSession) return volatileSession.user.id;
  const metadata = sessionMetadataFromUnknown(parseStoredJSON<unknown>(SESSION_METADATA_KEY));
  return metadata?.state === "authenticated" ? metadata.userId : null;
}

function authorityForSession(session: WebSession): RefreshAuthority {
  return {
    userId: session.user.id,
    sessionId: session.sessionId,
    refreshGeneration: session.refreshGeneration,
  };
}

function storedAuthenticatedAuthority(): RefreshAuthority | null {
  const metadata = sessionMetadataFromUnknown(parseStoredJSON<unknown>(SESSION_METADATA_KEY));
  if (metadata?.state !== "authenticated") return null;
  return {
    userId: metadata.userId,
    sessionId: metadata.sessionId,
    refreshGeneration: metadata.refreshGeneration,
  };
}

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function removeStorageValue(key: string): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    if (storage.getItem(key) === null) return true;
  } catch {
    // Fall through to an overwrite tombstone. The credential must never be restored.
  }
  try {
    storage.setItem(key, "");
    return storage.getItem(key) === "";
  } catch {
    return false;
  }
}

function readStorageRaw(key: string): string | null | undefined {
  const storage = safeStorage();
  if (!storage) return undefined;
  try {
    return storage.getItem(key);
  } catch {
    return undefined;
  }
}

function removeStorageValueExactly(key: string, expected: string | null): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  const before = readStorageRaw(key);
  if (before !== expected) return false;
  if (expected === null) return true;
  try {
    storage.removeItem(key);
  } catch {
    // A later exact read is the only authority for terminal cleanup.
  }
  return readStorageRaw(key) === null;
}

function restoreStorageValueExactly(key: string, expected: string): boolean {
  const storage = safeStorage();
  if (!storage || readStorageRaw(key) !== null) return false;
  try {
    storage.setItem(key, expected);
  } catch {
    if (readStorageRaw(key) === expected) removeStorageValueExactly(key, expected);
    return false;
  }
  if (readStorageRaw(key) === expected) return true;
  return false;
}

function scrubLegacySession(): "absent" | "removed" | "blocked" {
  const storage = safeStorage();
  if (!storage) return "absent";
  let legacy: string | null;
  try {
    legacy = storage.getItem(LEGACY_SESSION_KEY);
  } catch {
    return "absent";
  }
  if (legacy === null || legacy === "") return "absent";
  return removeStorageValue(LEGACY_SESSION_KEY) ? "removed" : "blocked";
}

function randomUUID(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseStoredJSON<T>(key: string): T | null {
  const storage = safeStorage();
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    return value ? JSON.parse(value) as T : null;
  } catch {
    return null;
  }
}

function storeMetadata(key: string, value: unknown): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  try {
    const encoded = JSON.stringify(value);
    storage.setItem(key, encoded);
    return storage.getItem(key) === encoded;
  } catch {
    return false;
  }
}

function validLogoutIntent(value: unknown): value is LogoutIntentMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const intent = value as Record<string, unknown>;
  return typeof intent.epoch === "number"
    && Number.isSafeInteger(intent.epoch)
    && intent.epoch >= 0
    && (intent.scope === "current" || intent.scope === "all")
    && (intent.sessionId === undefined
      || (typeof intent.sessionId === "string" && canonicalSessionIdPattern.test(intent.sessionId)))
    && (
      intent.origin === undefined
        ? intent.preservedSwitchChallengeId === undefined
        : intent.origin === "user"
          ? intent.preservedSwitchChallengeId === undefined
          : intent.origin === "switch"
            && (
        intent.scope === "current"
        && typeof intent.sessionId === "string"
        && typeof intent.preservedSwitchChallengeId === "string"
        && canonicalSessionIdPattern.test(intent.preservedSwitchChallengeId)
      )
    )
    && typeof intent.createdAt === "number"
    && Number.isSafeInteger(intent.createdAt)
    && intent.createdAt >= 0;
}

function validLoginSwitchResume(
  value: unknown,
  now: number,
): value is LoginSwitchResumeMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const resume = value as Record<string, unknown>;
  return resume.version === 1
    && typeof resume.challengeId === "string"
    && canonicalSessionIdPattern.test(resume.challengeId)
    && typeof resume.predecessorDeviceId === "string"
    && canonicalSessionIdPattern.test(resume.predecessorDeviceId)
    && typeof resume.candidateDeviceId === "string"
    && canonicalSessionIdPattern.test(resume.candidateDeviceId)
    && resume.predecessorDeviceId !== resume.candidateDeviceId
    && typeof resume.expectedUserId === "string"
    && canonicalSessionIdPattern.test(resume.expectedUserId)
    && typeof resume.expectedSessionId === "string"
    && canonicalSessionIdPattern.test(resume.expectedSessionId)
    && typeof resume.createdAt === "number"
    && Number.isSafeInteger(resume.createdAt)
    && resume.createdAt >= 0
    && resume.createdAt <= now
    && now - resume.createdAt < loginSwitchResumeLifetimeMilliseconds;
}

function loginSwitchResumeMatches(
  resume: LoginSwitchResumeMetadata,
  input: {
    readonly challengeId: string;
    readonly device: LoginDevicePlan;
    readonly expectedSession: EmailLoginSessionExpectation;
  },
): boolean {
  return input.expectedSession.state === "authenticated"
    && resume.challengeId === input.challengeId
    && resume.predecessorDeviceId === input.device.predecessorId
    && resume.candidateDeviceId === input.device.deviceId
    && resume.expectedUserId === input.expectedSession.userId
    && resume.expectedSessionId === input.expectedSession.sessionId;
}

function loginSwitchResumeKey(challengeId: string): string {
  return `${LOGIN_SWITCH_RESUME_PREFIX}${challengeId}`;
}

function storedLoginSwitchResume(challengeId: string): LoginSwitchResumeMetadata | null {
  const value = parseStoredJSON<unknown>(loginSwitchResumeKey(challengeId));
  return validLoginSwitchResume(value, Date.now()) ? value : null;
}

function matchingLoginSwitchResumeRaw(input: {
  readonly challengeId: string;
  readonly device: LoginDevicePlan;
  readonly expectedSession: EmailLoginSessionExpectation;
}): string | null | undefined {
  const raw = readStorageRaw(loginSwitchResumeKey(input.challengeId));
  if (input.expectedSession.state === "anonymous") {
    return raw === null ? null : undefined;
  }
  if (raw === null || raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  return validLoginSwitchResume(parsed, Date.now())
    && loginSwitchResumeMatches(parsed, input)
    ? raw
    : undefined;
}

function removeMatchingLoginSwitchResumeExactly(
  input: {
    readonly challengeId: string;
    readonly device: LoginDevicePlan;
    readonly expectedSession: EmailLoginSessionExpectation;
  },
  expectedRaw: string | null,
): boolean {
  return input.expectedSession.state === "anonymous"
    ? expectedRaw === null && readStorageRaw(loginSwitchResumeKey(input.challengeId)) === null
    : removeStorageValueExactly(loginSwitchResumeKey(input.challengeId), expectedRaw);
}

function clearLoginSwitchResumes(preservedSwitchChallengeId?: string): boolean {
  const storage = safeStorage();
  if (!storage) return false;
  let keys: string[];
  try {
    keys = Array.from({ length: storage.length }, (_unused, index) => storage.key(index))
      .filter((key): key is string => key?.startsWith(LOGIN_SWITCH_RESUME_PREFIX) === true);
  } catch {
    return false;
  }
  const preservedKey = preservedSwitchChallengeId === undefined
    ? undefined
    : loginSwitchResumeKey(preservedSwitchChallengeId);
  const removableKeys = keys.filter((key) => key !== preservedKey);
  for (const key of removableKeys) {
    const challengeId = key.slice(LOGIN_SWITCH_RESUME_PREFIX.length);
    if (canonicalSessionIdPattern.test(challengeId)) {
      cancelledLoginSwitchChallenges.add(challengeId);
    }
  }
  return removableKeys.every((key) => removeStorageValue(key));
}

function captureCrossContextAnonymousTransition(
  intent: AnonymousSessionTransitionIntent,
): CrossContextAnonymousTransition | undefined {
  const namespace = captureStorageNamespace(LOGIN_SWITCH_RESUME_PREFIX);
  if (!namespace.ok || namespace.entries.length > 64) return undefined;
  const resumeSnapshots: Array<{
    readonly challengeId: string;
    readonly raw: string;
    readonly createdAt: number;
  }> = [];
  for (const entry of namespace.entries) {
    const challengeId = entry.key.slice(LOGIN_SWITCH_RESUME_PREFIX.length);
    let resume: unknown;
    try {
      resume = JSON.parse(entry.raw) as unknown;
    } catch {
      return undefined;
    }
    if (
      !canonicalSessionIdPattern.test(challengeId)
      || !validLoginSwitchResume(resume, Date.now())
      || resume.challengeId !== challengeId
    ) return undefined;
    resumeSnapshots.push({ challengeId, raw: entry.raw, createdAt: resume.createdAt });
  }
  if (intent.kind === "user_logout") return { kind: intent.kind, resumeSnapshots };
  if (
    !canonicalSessionIdPattern.test(intent.preservedSwitchChallengeId)
    || !resumeSnapshots.some(
      (snapshot) => snapshot.challengeId === intent.preservedSwitchChallengeId,
    )
  ) return undefined;
  return {
    kind: intent.kind,
    preservedSwitchChallengeId: intent.preservedSwitchChallengeId,
    resumeSnapshots,
  };
}

async function applyCrossContextAnonymousTransition(
  transition: CrossContextAnonymousTransition,
  updatedAt: number,
): Promise<void> {
  const removed: CrossContextLoginSwitchResumeSnapshot[] = [];
  await refreshCoordinator.coordinateCommittedMutation(async (
    _signal,
    ownsAuthority,
    stageCommit,
  ) => stageCommit(
    (finalOwnsAuthority) => {
      for (const snapshot of transition.resumeSnapshots) {
        if (
          !finalOwnsAuthority()
          || snapshot.createdAt > updatedAt
          || (
            transition.kind === "account_switch"
            && snapshot.challengeId === transition.preservedSwitchChallengeId
          )
        ) {
          if (!finalOwnsAuthority()) {
            throw new Error("Cross-context session mutation authority was lost.");
          }
          continue;
        }
        let resume: unknown;
        try {
          resume = JSON.parse(snapshot.raw) as unknown;
        } catch {
          continue;
        }
        if (
          !validLoginSwitchResume(resume, updatedAt)
          || resume.challengeId !== snapshot.challengeId
          || resume.createdAt !== snapshot.createdAt
        ) continue;
        const key = loginSwitchResumeKey(snapshot.challengeId);
        if (readStorageRaw(key) !== snapshot.raw) continue;
        if (!removeStorageValueExactly(key, snapshot.raw)) {
          if (readStorageRaw(key) === snapshot.raw) {
            throw new Error("Unable to remove the exact cross-context switch resume.");
          }
          continue;
        }
        removed.push(snapshot);
      }
      if (!ownsAuthority() || !finalOwnsAuthority()) {
        throw new Error("Cross-context session mutation authority was lost.");
      }
      for (const snapshot of removed) {
        cancelledLoginSwitchChallenges.add(snapshot.challengeId);
      }
    },
    () => {
      for (const snapshot of [...removed].reverse()) {
        restoreStorageValueExactly(loginSwitchResumeKey(snapshot.challengeId), snapshot.raw);
      }
    },
  ));
}

function captureStorageNamespace(prefix: string): StorageNamespaceSnapshot {
  const storage = safeStorage();
  if (!storage) return { ok: false };
  try {
    const entries: StorageNamespaceEntry[] = [];
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key === null) return { ok: false };
      if (!key.startsWith(prefix)) continue;
      const raw = storage.getItem(key);
      if (raw === null) return { ok: false };
      entries.push({ key, raw });
    }
    entries.sort((left, right) => left.key.localeCompare(right.key));
    return {
      ok: true,
      entries: entries.map((entry) => Object.freeze({ ...entry })),
    };
  } catch {
    return { ok: false };
  }
}

function verifyStorageNamespaceSnapshot(
  prefix: string,
  expected: StorageNamespaceSnapshot,
): boolean {
  if (!expected.ok) return false;
  const current = captureStorageNamespace(prefix);
  return current.ok
    && current.entries.length === expected.entries.length
    && current.entries.every((entry, index) => {
      const expectedEntry = expected.entries[index];
      return expectedEntry !== undefined
        && entry.key === expectedEntry.key
        && entry.raw === expectedEntry.raw;
    });
}

function verifyStorageNamespaceEntries(
  prefix: string,
  expectedEntries: readonly StorageNamespaceEntry[],
): boolean {
  const current = captureStorageNamespace(prefix);
  return current.ok
    && current.entries.length === expectedEntries.length
    && current.entries.every((entry, index) => {
      const expected = expectedEntries[index];
      return expected !== undefined
        && entry.key === expected.key
        && entry.raw === expected.raw;
    });
}

function markCapturedLoginSwitchChallengesCancelled(
  snapshot: StorageNamespaceSnapshot,
  preservedKey?: string,
): void {
  if (!snapshot.ok) return;
  for (const entry of snapshot.entries) {
    if (entry.key === preservedKey) continue;
    const challengeId = entry.key.slice(LOGIN_SWITCH_RESUME_PREFIX.length);
    if (canonicalSessionIdPattern.test(challengeId)) {
      cancelledLoginSwitchChallenges.add(challengeId);
    }
  }
}

function cookieValue(name: string): string | null {
  if (typeof document === "undefined") return null;
  for (const segment of document.cookie.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    return segment.slice(separator + 1).trim();
  }
  return null;
}

function encodedLogoutIntent(intent: LogoutIntentMetadata): string {
  if (intent.preservedSwitchChallengeId !== undefined) {
    return `v2.${intent.epoch}.current.${intent.sessionId}.${intent.preservedSwitchChallengeId}`;
  }
  const hint = intent.sessionId ? `.${intent.sessionId}` : "";
  return `v1.${intent.epoch}.${intent.scope}${hint}`;
}

function logoutIntentStillCurrent(intent: LogoutIntentMetadata): boolean {
  const expectedRaw = JSON.stringify(intent);
  const metadataRaw = readStorageRaw(LOGOUT_INTENT_KEY);
  const cookieMatches = cookieValue(LOGOUT_INTENT_COOKIE) === encodedLogoutIntent(intent);
  if (intent.origin === "user") {
    // An explicit user action outranks a stale switch reservation even when
    // only one of the two durable channels accepted the newer write.
    if (metadataRaw === expectedRaw) return true;
    if (typeof metadataRaw === "string" && metadataRaw.length > 0) {
      try {
        const current = JSON.parse(metadataRaw) as unknown;
        if (validLogoutIntent(current)) {
          return current.origin === "switch" && cookieMatches;
        }
      } catch {
        return false;
      }
      return false;
    }
    return cookieMatches;
  }
  if (metadataRaw !== null && metadataRaw !== undefined) {
    return metadataRaw === expectedRaw;
  }
  return cookieMatches;
}

function persistLogoutIntentCookie(intent: LogoutIntentMetadata): boolean {
  const value = encodedLogoutIntent(intent);
  document.cookie = `${LOGOUT_INTENT_COOKIE}=${value}; Path=/; Secure; SameSite=Strict; Max-Age=2678400; Priority=High`;
  return cookieValue(LOGOUT_INTENT_COOKIE) === value;
}

function clearLogoutIntentCookie(): boolean {
  document.cookie = `${LOGOUT_INTENT_COOKIE}=; Path=/; Secure; SameSite=Strict; Max-Age=0; Priority=High`;
  return cookieValue(LOGOUT_INTENT_COOKIE) === null;
}

function clearLogoutIntentCookieExactly(expected: string): boolean {
  const current = cookieValue(LOGOUT_INTENT_COOKIE);
  if (current === null) return true;
  if (current !== expected) return false;
  return clearLogoutIntentCookie();
}

function persistLogoutIntent(intent: LogoutIntentMetadata): LogoutIntentPersistence | null {
  const metadataRaw = JSON.stringify(intent);
  const metadataPersisted = storeMetadata(LOGOUT_INTENT_KEY, intent)
    && readStorageRaw(LOGOUT_INTENT_KEY) === metadataRaw;
  const cookieValueForIntent = encodedLogoutIntent(intent);
  const cookiePersisted = persistLogoutIntentCookie(intent)
    && cookieValue(LOGOUT_INTENT_COOKIE) === cookieValueForIntent;
  if (!metadataPersisted && cookiePersisted && intent.origin === "user") {
    const staleRaw = readStorageRaw(LOGOUT_INTENT_KEY);
    if (typeof staleRaw === "string" && staleRaw.length > 0) {
      try {
        const stale = JSON.parse(staleRaw) as unknown;
        if (validLogoutIntent(stale) && stale.origin === "switch") {
          removeStorageValueExactly(LOGOUT_INTENT_KEY, staleRaw);
        }
      } catch {
        // Unknown metadata remains untouched; the exact user Cookie still
        // fences older switch writers and terminal cleanup will fail closed.
      }
    }
  }
  if (!metadataPersisted && !cookiePersisted) return null;
  return {
    intent,
    metadataRaw: metadataPersisted ? metadataRaw : undefined,
    cookieValue: cookiePersisted ? cookieValueForIntent : null,
  };
}

function persistSwitchLogoutIntentExactly(
  intent: LogoutIntentMetadata,
  ownsAuthority: () => boolean,
): LogoutIntentPersistence | null {
  if (
    intent.preservedSwitchChallengeId === undefined
    || !validLogoutIntent(intent)
    || !ownsAuthority()
    || readStorageRaw(LOGOUT_INTENT_KEY) !== null
    || cookieValue(LOGOUT_INTENT_COOKIE) !== null
  ) return null;
  const cookieValueForIntent = encodedLogoutIntent(intent);
  if (!persistLogoutIntentCookie(intent)) return null;
  if (
    !ownsAuthority()
    || cookieValue(LOGOUT_INTENT_COOKIE) !== cookieValueForIntent
    || readStorageRaw(LOGOUT_INTENT_KEY) !== null
  ) {
    if (readStorageRaw(LOGOUT_INTENT_KEY) === null) {
      clearLogoutIntentCookieExactly(cookieValueForIntent);
    }
    return null;
  }
  const metadataRaw = JSON.stringify(intent);
  const storage = safeStorage();
  if (!storage) {
    clearLogoutIntentCookieExactly(cookieValueForIntent);
    return null;
  }
  try {
    if (
      !ownsAuthority()
      || readStorageRaw(LOGOUT_INTENT_KEY) !== null
      || cookieValue(LOGOUT_INTENT_COOKIE) !== cookieValueForIntent
    ) return null;
    storage.setItem(LOGOUT_INTENT_KEY, metadataRaw);
  } catch {
    clearLogoutIntentCookieExactly(cookieValueForIntent);
    return null;
  }
  if (
    !ownsAuthority()
    || readStorageRaw(LOGOUT_INTENT_KEY) !== metadataRaw
    || cookieValue(LOGOUT_INTENT_COOKIE) !== cookieValueForIntent
  ) {
    removeStorageValueExactly(LOGOUT_INTENT_KEY, metadataRaw);
    if (readStorageRaw(LOGOUT_INTENT_KEY) === null) {
      clearLogoutIntentCookieExactly(cookieValueForIntent);
    }
    return null;
  }
  return {
    intent,
    metadataRaw,
    cookieValue: cookieValueForIntent,
  };
}

function rearmLogoutIntent(intent: LogoutIntentMetadata): void {
  const raw = readStorageRaw(LOGOUT_INTENT_KEY);
  let currentIntent: LogoutIntentMetadata | null = null;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const current = JSON.parse(raw) as unknown;
      if (validLogoutIntent(current)) currentIntent = current;
    } catch {
      // Unknown newer metadata remains untouched.
      return;
    }
  }
  if (currentIntent?.origin === "user") {
    persistLogoutIntent(currentIntent);
    return;
  }
  if (intent.origin === "user") {
    persistLogoutIntent(intent);
    return;
  }
  const cookieIntent = logoutIntentFromCookie();
  if (
    (intent.origin === "switch" || currentIntent?.origin === "switch")
    && cookieIntent !== null
    && cookieIntent.origin === undefined
    && cookieValue(LOGOUT_INTENT_COOKIE)?.startsWith("v1.") === true
  ) {
    persistLogoutIntent({ ...cookieIntent, origin: "user" });
    return;
  }
  if (typeof raw === "string" && raw.length > 0) {
    if (currentIntent !== null) persistLogoutIntent(currentIntent);
    return;
  }
  if (raw === null || raw === undefined) {
    persistLogoutIntent(intent);
  }
}

function logoutPersistenceStillExact(persistence: LogoutIntentPersistence): boolean {
  const currentMetadata = readStorageRaw(LOGOUT_INTENT_KEY);
  const metadataMatches = persistence.metadataRaw === undefined
    ? currentMetadata === null || currentMetadata === undefined
    : currentMetadata === persistence.metadataRaw;
  const currentCookie = cookieValue(LOGOUT_INTENT_COOKIE);
  const cookieMatches = persistence.cookieValue === null
    ? currentCookie === null
    : currentCookie === null || currentCookie === persistence.cookieValue;
  return metadataMatches && cookieMatches;
}

function completionResumeExpectationsStillExact(
  attempts: readonly PendingSessionCompletionAttempt[],
  resumes: StorageNamespaceSnapshot,
): boolean {
  if (!resumes.ok) return false;
  return attempts.every((attempt) => {
    const key = loginSwitchResumeKey(attempt.challengeId);
    const expected = resumes.entries.find((entry) => entry.key === key)?.raw ?? null;
    return readStorageRaw(key) === expected;
  });
}

function logoutIntentFromCookie(): LogoutIntentMetadata | null {
  const value = cookieValue(LOGOUT_INTENT_COOKIE);
  if (value === null) return null;
  const v1 = /^v1\.(0|[1-9][0-9]*)\.(current|all)(?:\.([0-9a-f-]+))?$/u.exec(value);
  const v2 = /^v2\.(0|[1-9][0-9]*)\.current\.([0-9a-f-]+)\.([0-9a-f-]+)$/u.exec(value);
  if (!v1 && !v2) return null;
  const epoch = Number((v2 ?? v1)![1]);
  const sessionId = v2?.[2] ?? v1?.[3];
  const preservedSwitchChallengeId = v2?.[3];
  const candidate: LogoutIntentMetadata = {
    epoch,
    scope: v2 ? "current" : v1![2] as "current" | "all",
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(v2 ? { origin: "switch" as const } : {}),
    ...(preservedSwitchChallengeId === undefined ? {} : { preservedSwitchChallengeId }),
    createdAt: Date.now(),
  };
  return validLogoutIntent(candidate) ? candidate : null;
}

function pendingLogoutIntent(): LogoutIntentMetadata | null {
  const stored = parseStoredJSON<unknown>(LOGOUT_INTENT_KEY);
  const fromCookie = logoutIntentFromCookie();
  if (validLogoutIntent(stored)) {
    if (stored.origin === "user") {
      persistLogoutIntent(stored);
      return stored;
    }
    if (
      stored.origin === "switch"
      && fromCookie !== null
      && fromCookie.origin === undefined
      && cookieValue(LOGOUT_INTENT_COOKIE)?.startsWith("v1.") === true
    ) {
      const userIntent = { ...fromCookie, origin: "user" as const };
      persistLogoutIntent(userIntent);
      return userIntent;
    }
    return stored;
  }
  if (fromCookie) {
    storeMetadata(LOGOUT_INTENT_KEY, fromCookie);
    return fromCookie;
  }
  return null;
}

function supersededSwitchResume(): {
  readonly challengeId: string;
  readonly resumeRaw: string | null | undefined;
} | null {
  const stored = parseStoredJSON<unknown>(LOGOUT_INTENT_KEY);
  const current = validLogoutIntent(stored) ? stored : logoutIntentFromCookie();
  if (current?.origin !== "switch" || current.preservedSwitchChallengeId === undefined) {
    return null;
  }
  return {
    challengeId: current.preservedSwitchChallengeId,
    resumeRaw: readStorageRaw(loginSwitchResumeKey(current.preservedSwitchChallengeId)),
  };
}

function validRefreshAttempt(
  value: unknown,
  authority: RefreshAuthority,
  now: number,
): value is RefreshAttemptMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const attempt = value as Record<string, unknown>;
  return typeof attempt.attemptId === "string"
    && canonicalSessionIdPattern.test(attempt.attemptId)
    && attempt.sessionId === authority.sessionId
    && attempt.refreshGeneration === authority.refreshGeneration
    && typeof attempt.createdAt === "number"
    && Number.isSafeInteger(attempt.createdAt)
    && attempt.createdAt >= 0
    && attempt.createdAt <= now
    && now - attempt.createdAt < refreshAttemptLifetimeMilliseconds;
}

function pendingRefreshRecovery(): PendingRefreshRecovery {
  const storage = safeStorage();
  if (!storage) return { kind: "none" };
  let encoded: string | null;
  try {
    encoded = storage.getItem(REFRESH_ATTEMPT_KEY);
  } catch {
    return { kind: "blocked" };
  }
  if (encoded === null || encoded === "") return { kind: "none" };
  const authority = storedAuthenticatedAuthority();
  if (!authority) return { kind: "blocked" };
  let value: unknown;
  try {
    value = JSON.parse(encoded) as unknown;
  } catch {
    return removeStorageValue(REFRESH_ATTEMPT_KEY) ? { kind: "none" } : { kind: "blocked" };
  }
  const now = Date.now();
  if (!validRefreshAttempt(value, authority, now)) {
    return removeStorageValue(REFRESH_ATTEMPT_KEY) ? { kind: "none" } : { kind: "blocked" };
  }
  return { kind: "pending", authority, attempt: value };
}

function currentRefreshAttempt(authority: RefreshAuthority): RefreshAttemptMetadata | null {
  const now = Date.now();
  const stored = parseStoredJSON<unknown>(REFRESH_ATTEMPT_KEY);
  if (validRefreshAttempt(stored, authority, now)) return stored;
  const attempt = {
    attemptId: randomUUID(),
    sessionId: authority.sessionId,
    refreshGeneration: authority.refreshGeneration,
    createdAt: now,
  };
  return storeMetadata(REFRESH_ATTEMPT_KEY, attempt) ? attempt : null;
}

async function safeJSON(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return null;
  }
}

type BrowserSessionResponsePayload =
  | { readonly kind: "json"; readonly value: unknown }
  | { readonly kind: "invalid" };

async function readBoundedBrowserUTF8(response: Response): Promise<string | null> {
  const contentLengthHeader = response.headers.get("content-length");
  let declaredLength: number | null = null;
  if (contentLengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLengthHeader)) return null;
    declaredLength = Number(contentLengthHeader);
    if (
      !Number.isSafeInteger(declaredLength)
      || declaredLength > maximumBrowserSessionResponseLength
    ) return null;
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumBrowserSessionResponseLength) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }
  if (length === 0 || (declaredLength !== null && declaredLength !== length)) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function browserSessionResponsePayload(
  response: Response,
): Promise<BrowserSessionResponsePayload> {
  const contentType = response.headers.get("content-type");
  if (contentType === null || !browserJSONContentTypePattern.test(contentType)) {
    return { kind: "invalid" };
  }
  const text = await readBoundedBrowserUTF8(response);
  if (text === null) return { kind: "invalid" };
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function exactBrowserReauthenticationRequired(value: unknown): boolean {
  if (!strictRecordWithKeys(value, ["error"])) return false;
  const error = value.error;
  return strictRecordWithKeys(error, ["code", "retryable"])
    && error.code === "SESSION_REAUTH_REQUIRED"
    && error.retryable === false;
}

export function readSession(): WebSession | null {
  return typeof window === "undefined" ? null : volatileSession;
}

export function saveSession(session: WebSession): void {
  if (typeof window === "undefined") return;
  if (scrubLegacySession() === "blocked") {
    commitSession(null, { incrementEpoch: true, broadcast: true });
    return;
  }
  commitSession(session, { incrementEpoch: true, broadcast: true });
}

export function clearSession(): void {
  if (typeof window === "undefined") return;
  scrubLegacySession();
  clearLoginSwitchResumes();
  clearPrivateBrowserDrafts();
  commitSession(null, { incrementEpoch: true, broadcast: true });
}

export function abandonEmailSessionSwitch(challengeId: string): boolean {
  if (typeof window === "undefined" || !canonicalSessionIdPattern.test(challengeId)) return false;
  cancelledLoginSwitchChallenges.add(challengeId);
  sessionEpoch += 1;
  return removeStorageValue(loginSwitchResumeKey(challengeId));
}

export function subscribeSessionChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onSession = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === SESSION_METADATA_KEY) {
      let metadata: SessionMetadata | null = null;
      try {
        metadata = sessionMetadataFromUnknown(event.newValue ? JSON.parse(event.newValue) : null);
      } catch {
        metadata = null;
      }
      if (metadata) synchronizeAnnouncedSession(metadata);
      listener();
      return;
    }
    if (
      event.key === REFRESH_ATTEMPT_KEY
      || event.key === LOGOUT_INTENT_KEY
      || event.key === SESSION_COMPLETION_ATTEMPT_STORAGE_KEY
    ) listener();
  };
  const unsubscribeChannel = subscribeCrossContextSessionState((
    metadata,
    anonymousTransition,
    updatedAt,
  ) => {
    const parsed = sessionMetadataFromUnknown(metadata);
    if (parsed) synchronizeAnnouncedSession(parsed, anonymousTransition, updatedAt);
    listener();
  });
  window.addEventListener(SESSION_EVENT, onSession);
  window.addEventListener("storage", onStorage);
  return () => {
    unsubscribeChannel();
    window.removeEventListener(SESSION_EVENT, onSession);
    window.removeEventListener("storage", onStorage);
  };
}

type BootstrapResult =
  | { readonly kind: "session"; readonly session: WebSession }
  | { readonly kind: "anonymous" }
  | { readonly kind: "unavailable" };

function sessionRequestSignal(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(3_000);
  return parent === undefined ? timeout : AbortSignal.any([parent, timeout]);
}

async function requestAuthoritativeBootstrap(parentSignal?: AbortSignal): Promise<BootstrapResult> {
  let response: Response;
  try {
    response = await fetch("/api/session/bootstrap", {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: sessionRequestSignal(parentSignal),
    });
  } catch {
    return { kind: "unavailable" };
  }
  const parsed = await browserSessionResponsePayload(response);
  if (parsed.kind !== "json") return { kind: "unavailable" };
  const payload = parsed.value;
  if (!response.ok) {
    return response.status === 401 && exactBrowserReauthenticationRequired(payload)
      ? { kind: "anonymous" }
      : { kind: "unavailable" };
  }
  if (strictRecordWithKeys(payload, ["state"]) && payload.state === "anonymous") {
    return { kind: "anonymous" };
  }
  const session = sessionFromPayload(payload);
  if (!session || Date.parse(session.accessTokenExpiresAt) <= Date.now()) {
    return { kind: "unavailable" };
  }
  return { kind: "session", session };
}

type CompletionRecoveryResult =
  | { readonly kind: "none" }
  | { readonly kind: "session"; readonly session: WebSession }
  | { readonly kind: "blocked" };

type PreparedCompletionRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "blocked" }
  | {
      readonly kind: "accepted";
      readonly attempt: PendingSessionCompletionAttempt;
      readonly session: WebSession;
    }
  | {
      readonly kind: "discarded";
      readonly attempt: PendingSessionCompletionAttempt;
    };

async function preparePendingSessionCompletionsUnderAuthority(
  attempts: readonly PendingSessionCompletionAttempt[],
  ownsAuthority: () => boolean,
): Promise<PreparedCompletionRecovery> {
  if (attempts.length > 1 || pendingLogoutIntent() !== null) return { kind: "blocked" };
  if (attempts.length === 0) return { kind: "none" };
  const accepting = attempts.filter((attempt) => attempt.phase === "accepting");
  if (accepting.length > 1) return { kind: "blocked" };
  const ordered = [
    ...attempts.filter((attempt) => attempt.phase !== "accepting"),
    ...accepting,
  ];
  for (const attempt of ordered) {
    if (!ownsAuthority()) return { kind: "blocked" };
    let disposition: CompletionDispositionResult;
    if (attempt.phase === "accepting") {
      if (!assertLoginDevicePlanCommitted(attemptPlan(attempt))) {
        return { kind: "blocked" };
      }
      disposition = await requestCompletionDisposition(attempt, "accept");
      if (disposition.kind === "terminal") {
        if (pendingLogoutIntent() !== null) return { kind: "blocked" };
        disposition = await requestCompletionDisposition(attempt, "discard");
      }
      if (disposition.kind === "terminal" && pendingLogoutIntent() === null) {
        const bootstrap = await requestAuthoritativeBootstrap();
        if (
          bootstrap.kind === "session"
          && bootstrap.session.sessionId === attempt.sessionId
        ) disposition = { kind: "accepted", session: bootstrap.session };
      }
    } else {
      disposition = await requestCompletionDisposition(attempt, "discard");
    }
    if (disposition.kind === "retryable" || disposition.kind === "terminal") {
      return { kind: "blocked" };
    }
    if (disposition.kind === "discarded") return { kind: "discarded", attempt };
    if (
      attempt.phase !== "accepting"
      || disposition.session.sessionId !== attempt.sessionId
      || pendingLogoutIntent() !== null
      || !ownsAuthority()
      || !assertLoginDevicePlanCommitted(attemptPlan(attempt))
    ) return { kind: "blocked" };
    return { kind: "accepted", attempt, session: disposition.session };
  }
  return { kind: "none" };
}

async function recoverPendingSessionCompletions(): Promise<CompletionRecoveryResult> {
  const inventory = scanPendingSessionCompletionAttempts();
  if (!inventory.ok) return { kind: "blocked" };
  if (inventory.attempts.length === 0) return { kind: "none" };
  try {
    const recovered = await refreshCoordinator.coordinateCommittedMutation<CompletionRecoveryResult>(async (
      _signal,
      ownsAuthority,
      stageCommit,
    ) => {
      const attemptSnapshot = captureSessionCompletionAttemptSnapshot();
      const current = attemptSnapshot.inventory;
      if (!current.ok) {
        return stageCommit<CompletionRecoveryResult>(
          () => ({ kind: "blocked" }),
          () => undefined,
        );
      }
      const expectedEpoch = sessionEpoch;
      const expectedSession = volatileSession;
      const expectedSessionMetadataRaw = readStorageRaw(SESSION_METADATA_KEY);
      const expectedLogoutMetadataRaw = readStorageRaw(LOGOUT_INTENT_KEY);
      const expectedLogoutCookie = cookieValue(LOGOUT_INTENT_COOKIE);
      if (
        expectedSessionMetadataRaw === undefined
        || expectedLogoutMetadataRaw !== null
        || expectedLogoutCookie !== null
      ) {
        return stageCommit<CompletionRecoveryResult>(
          () => ({ kind: "blocked" }),
          () => undefined,
        );
      }
      const prepared = await preparePendingSessionCompletionsUnderAuthority(
        current.attempts,
        ownsAuthority,
      );
      if (prepared.kind === "none" || prepared.kind === "blocked") {
        return stageCommit<CompletionRecoveryResult>(() => prepared, () => undefined);
      }

      const { attempt } = prepared;
      const plan = attemptPlan(attempt);
      const resumeKey = loginSwitchResumeKey(attempt.challengeId);
      const expectedResumeRaw = readStorageRaw(resumeKey);
      const expectedDeviceState = attempt.phase === "device_committed" || attempt.phase === "accepting"
        ? "committed" as const
        : "current" as const;
      let attemptRemoved = false;
      let resumeRemoved = false;
      let deviceRolledBack = false;
      const deviceIsExpected = (): boolean => (
        expectedDeviceState === "committed"
          ? assertLoginDevicePlanCommitted(plan)
          : assertLoginDevicePlanCurrent(plan)
      );
      const rollback = (): void => {
        let restored = true;
        if (prepared.kind === "discarded" && deviceRolledBack) {
          restored = (assertLoginDevicePlanCommitted(plan) || commitLoginDevicePlan(plan))
            && restored;
        }
        if (attemptRemoved) {
          restored = restoreSessionCompletionAttemptExactly(attempt) && restored;
        }
        if (
          prepared.kind === "accepted"
          && resumeRemoved
          && typeof expectedResumeRaw === "string"
        ) {
          restored = restoreStorageValueExactly(resumeKey, expectedResumeRaw) && restored;
        }
        if (
          !restored
          && prepared.kind === "accepted"
          && pendingLogoutIntent() === null
        ) {
          armLogoutIntent({
            epoch: sessionEpoch,
            scope: "current",
            sessionId: prepared.session.sessionId,
            origin: "user",
            createdAt: Date.now(),
          });
        }
      };
      return stageCommit<CompletionRecoveryResult>((finalOwnsAuthority) => {
        const sharedStateIsExact = (): boolean => (
          finalOwnsAuthority()
          && sessionEpoch === expectedEpoch
          && volatileSession === expectedSession
          && readStorageRaw(SESSION_METADATA_KEY) === expectedSessionMetadataRaw
          && readStorageRaw(LOGOUT_INTENT_KEY) === expectedLogoutMetadataRaw
          && cookieValue(LOGOUT_INTENT_COOKIE) === expectedLogoutCookie
          && verifySessionCompletionAttemptSnapshot(attemptSnapshot)
          && readStorageRaw(resumeKey) === expectedResumeRaw
          && deviceIsExpected()
        );
        if (expectedResumeRaw === undefined || !sharedStateIsExact()) {
          throw new Error("Unable to recover session completion.");
        }

        if (prepared.kind === "discarded") {
          if (!rollbackLoginDevicePlan(plan) && !assertLoginDevicePlanCurrent(plan)) {
            throw new Error("Unable to recover session completion.");
          }
          deviceRolledBack = expectedDeviceState === "committed";
          if (
            !finalOwnsAuthority()
            || readStorageRaw(LOGOUT_INTENT_KEY) !== expectedLogoutMetadataRaw
            || cookieValue(LOGOUT_INTENT_COOKIE) !== expectedLogoutCookie
            || !verifySessionCompletionAttemptSnapshot(attemptSnapshot)
            || readStorageRaw(resumeKey) !== expectedResumeRaw
            || !assertLoginDevicePlanCurrent(plan)
            || !removeSessionCompletionAttempt(attempt)
          ) throw new Error("Unable to recover session completion.");
          attemptRemoved = true;
          const cleared = scanPendingSessionCompletionAttempts();
          if (
            !finalOwnsAuthority()
            || !cleared.ok
            || cleared.attempts.length !== 0
            || readStorageRaw(resumeKey) !== expectedResumeRaw
            || readStorageRaw(LOGOUT_INTENT_KEY) !== expectedLogoutMetadataRaw
            || cookieValue(LOGOUT_INTENT_COOKIE) !== expectedLogoutCookie
            || !assertLoginDevicePlanCurrent(plan)
          ) throw new Error("Unable to recover session completion.");
          return { kind: "none" as const };
        }

        if (!removeSessionCompletionAttempt(attempt)) {
          throw new Error("Unable to recover session completion.");
        }
        attemptRemoved = true;
        if (
          !finalOwnsAuthority()
          || readStorageRaw(LOGOUT_INTENT_KEY) !== expectedLogoutMetadataRaw
          || cookieValue(LOGOUT_INTENT_COOKIE) !== expectedLogoutCookie
          || !scanPendingSessionCompletionAttempts().ok
          || readStorageRaw(resumeKey) !== expectedResumeRaw
          || !assertLoginDevicePlanCommitted(plan)
          || !removeStorageValueExactly(resumeKey, expectedResumeRaw)
        ) throw new Error("Unable to recover session completion.");
        resumeRemoved = typeof expectedResumeRaw === "string";
        const cleared = scanPendingSessionCompletionAttempts();
        if (
          !finalOwnsAuthority()
          || !cleared.ok
          || cleared.attempts.length !== 0
          || readStorageRaw(resumeKey) !== null
          || readStorageRaw(LOGOUT_INTENT_KEY) !== expectedLogoutMetadataRaw
          || cookieValue(LOGOUT_INTENT_COOKIE) !== expectedLogoutCookie
          || !assertLoginDevicePlanCommitted(plan)
        ) throw new Error("Unable to recover session completion.");
        return { kind: "session" as const, session: prepared.session };
      }, rollback);
    });
    return recovered ?? { kind: "blocked" };
  } catch {
    return { kind: "blocked" };
  }
}

function synchronizeAnnouncedSession(
  metadata: CrossContextSessionMetadata,
  anonymousTransition?: CrossContextAnonymousTransition,
  updatedAt?: number,
): void {
  if (metadata.state === "anonymous") {
    pendingCrossContextMetadata = null;
    if (anonymousTransition !== undefined && updatedAt !== undefined) {
      void applyCrossContextAnonymousTransition(anonymousTransition, updatedAt).catch(() => undefined);
    }
    if (volatileSession !== null || storedAuthorityUserId() !== null) {
      commitSession(null, { incrementEpoch: true, broadcast: false });
    }
    return;
  }
  const current = volatileSession;
  if (
    current
    && current.user.id === metadata.userId
    && current.sessionId === metadata.sessionId
    && current.refreshGeneration >= metadata.refreshGeneration
  ) return;
  pendingCrossContextMetadata = metadata;
  if (crossContextSynchronizationInFlight) return;
  crossContextSynchronizationInFlight = (async () => {
    while (pendingCrossContextMetadata) {
      const target = pendingCrossContextMetadata;
      pendingCrossContextMetadata = null;
      const currentSession = volatileSession;
      if (
        currentSession
        && currentSession.user.id === target.userId
        && currentSession.sessionId === target.sessionId
        && currentSession.refreshGeneration >= target.refreshGeneration
      ) continue;
      const epoch = sessionEpoch;
      const expectedSession = volatileSession;
      const result = await requestAuthoritativeBootstrap();
      if (sessionEpoch !== epoch || volatileSession !== expectedSession) {
        pendingCrossContextMetadata = null;
        return;
      }
      if (pendingCrossContextMetadata) continue;
      if (result.kind === "anonymous") {
        if (volatileSession !== null) {
          commitSession(null, { incrementEpoch: true, broadcast: false });
        }
        continue;
      }
      if (result.kind !== "session") continue;
      if (
        result.session.user.id === target.userId
        && result.session.sessionId === target.sessionId
        && result.session.refreshGeneration < target.refreshGeneration
      ) continue;
      const previous = volatileSession;
      const changedAuthority = !previous
        || previous.user.id !== result.session.user.id
        || previous.sessionId !== result.session.sessionId;
      commitSession(result.session, { incrementEpoch: changedAuthority, broadcast: false });
    }
  })().finally(() => {
    crossContextSynchronizationInFlight = null;
  });
}

async function performBootstrap(): Promise<WebSession | null> {
  if (typeof window === "undefined") return null;
  const legacy = scrubLegacySession();
  if (legacy !== "absent") {
    commitSession(null, { incrementEpoch: true, broadcast: true });
    return null;
  }
  const logoutIntent = pendingLogoutIntent();
  if (logoutIntent) {
    clearPrivateBrowserDrafts();
    await coordinateLogoutIntent(logoutIntent);
    return null;
  }
  const recoveryEpoch = sessionEpoch;
  const recoveryExpectedSession = volatileSession;
  const completionRecovery = await recoverPendingSessionCompletions();
  if (sessionEpoch !== recoveryEpoch || volatileSession !== recoveryExpectedSession) {
    return volatileSession;
  }
  const lateLogoutIntent = pendingLogoutIntent();
  if (lateLogoutIntent) {
    clearPrivateBrowserDrafts();
    await coordinateLogoutIntent(lateLogoutIntent);
    return null;
  }
  if (completionRecovery.kind === "blocked") return null;
  if (completionRecovery.kind === "session") {
    return commitSession(completionRecovery.session, { incrementEpoch: true, broadcast: true })
      ? completionRecovery.session
      : null;
  }
  const recovery = pendingRefreshRecovery();
  if (recovery.kind === "blocked") return null;
  if (recovery.kind === "pending") {
    const epoch = sessionEpoch;
    const expectedSession = volatileSession;
    const recovered = await refreshCoordinator.coordinateMutation(
      (signal) => requestAuthoritativeRefresh(
        recovery.authority,
        signal,
        recovery.attempt,
      ),
    );
    if (sessionEpoch !== epoch || volatileSession !== expectedSession) return volatileSession;
    if (!recovered) return null;
    removeStorageValue(REFRESH_ATTEMPT_KEY);
    return commitSession(recovered, { incrementEpoch: true, broadcast: true })
      ? recovered
      : null;
  }
  const epoch = sessionEpoch;
  const expectedSession = volatileSession;
  const result = await requestAuthoritativeBootstrap();
  if (sessionEpoch !== epoch || volatileSession !== expectedSession) return volatileSession;
  if (result.kind === "anonymous") {
    commitSession(null, { incrementEpoch: true, broadcast: true });
    return null;
  }
  if (result.kind !== "session") return null;
  return commitSession(result.session, { incrementEpoch: true, broadcast: true })
    ? result.session
    : null;
}

export function bootstrapSession(): Promise<WebSession | null> {
  if (volatileSession) return Promise.resolve(volatileSession);
  if (!bootstrapInFlight) {
    bootstrapInFlight = performBootstrap().finally(() => {
      bootstrapInFlight = null;
    });
  }
  return bootstrapInFlight;
}

async function requestAuthoritativeRefresh(
  expected: RefreshAuthority,
  parentSignal?: AbortSignal,
  persistedAttempt?: RefreshAttemptMetadata,
): Promise<WebSession | null> {
  const attempt = persistedAttempt ?? currentRefreshAttempt(expected);
  if (!attempt) return null;
  const expectedAttemptRaw = JSON.stringify(attempt);
  if (readStorageRaw(REFRESH_ATTEMPT_KEY) !== expectedAttemptRaw) return null;
  let response: Response;
  try {
    response = await fetch("/api/session/refresh", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        attemptId: attempt.attemptId,
        expectedSessionId: expected.sessionId,
        expectedUserId: expected.userId,
        expectedRefreshGeneration: expected.refreshGeneration,
      }),
      signal: sessionRequestSignal(parentSignal),
    });
  } catch {
    return null;
  }
  const parsed = await browserSessionResponsePayload(response);
  if (parsed.kind !== "json") return null;
  const payload = parsed.value;
  if (!response.ok) {
    if (
      response.status === 401
      && exactBrowserReauthenticationRequired(payload)
      && removeStorageValueExactly(REFRESH_ATTEMPT_KEY, expectedAttemptRaw)
    ) {
      if (
        volatileSession?.user.id === expected.userId
        && volatileSession.sessionId === expected.sessionId
        && volatileSession.refreshGeneration === expected.refreshGeneration
      ) commitSession(null, { incrementEpoch: true, broadcast: true });
    }
    return null;
  }
  const successor = sessionFromPayload(payload);
  if (
    !successor
    || successor.user.id !== expected.userId
    || successor.sessionId !== expected.sessionId
    || successor.refreshGeneration !== expected.refreshGeneration + 1
    || Date.parse(successor.accessTokenExpiresAt) <= Date.now()
  ) return null;
  return successor;
}

async function performCoordinatedRefresh(expected: WebSession): Promise<WebSession | null> {
  const epoch = sessionEpoch;
  const authority = authorityForSession(expected);
  const result = await refreshCoordinator.coordinateRefresh(
    authority,
    {
      synchronize: async (signal) => {
        // Re-read only after obtaining mutation authority. Another tab may have
        // completed and removed the shared attempt while this caller was queued.
        const recovery = pendingRefreshRecovery();
        if (recovery.kind === "blocked") return null;
        if (
          recovery.kind === "pending"
          && recovery.authority.userId === authority.userId
          && recovery.authority.sessionId === authority.sessionId
          && recovery.authority.refreshGeneration === authority.refreshGeneration
        ) {
          return requestAuthoritativeRefresh(authority, signal, recovery.attempt);
        }
        const bootstrap = await requestAuthoritativeBootstrap(signal);
        if (bootstrap.kind === "anonymous") {
          if (
            volatileSession?.user.id === expected.user.id
            && volatileSession.sessionId === expected.sessionId
          ) commitSession(null, { incrementEpoch: true, broadcast: true });
          return null;
        }
        return bootstrap.kind === "session" ? bootstrap.session : null;
      },
      rotate: async (signal) => {
        const successor = await requestAuthoritativeRefresh(authority, signal);
        return signal.aborted ? null : successor;
      },
    },
  );
  if (!result) return null;

  const current = volatileSession;
  if (
    current
    && current.user.id === result.user.id
    && current.sessionId === result.sessionId
    && current.refreshGeneration === result.refreshGeneration
  ) return current;
  if (sessionEpoch !== epoch || current !== expected) return null;
  removeStorageValue(REFRESH_ATTEMPT_KEY);
  return commitSession(result, { incrementEpoch: false, broadcast: true }) ? result : null;
}

export function refreshSessionFor(expected: WebSession): Promise<WebSession | null> {
  if (volatileSession !== expected) return Promise.resolve(null);
  if (!refreshInFlight) {
    refreshInFlight = performCoordinatedRefresh(expected).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

export async function refreshCurrentSession(): Promise<WebSession | null> {
  const session = readSession() ?? await bootstrapSession();
  return session ? refreshSessionFor(session) : null;
}

interface CompletionReadyPayload {
  readonly state: "completion_ready";
  readonly attemptId: string;
  readonly expiresAt: number;
}

interface CompletionPendingPayload {
  readonly state: "completion_pending";
  readonly attemptId: string;
  readonly sessionId: string;
  readonly bindingId: string;
  readonly deviceId: string;
  readonly reconcileExpiresAt: number;
}

type CompletionDispositionResult =
  | { readonly kind: "accepted"; readonly session: WebSession }
  | { readonly kind: "discarded" }
  | { readonly kind: "retryable" }
  | { readonly kind: "terminal" };

class SessionCompletionFlowError extends Error {
  constructor(readonly retryable: boolean) {
    super("Unable to complete sign in.");
    this.name = "SessionCompletionFlowError";
  }
}

function strictRecordWithKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function completionFailureIsRetryable(response: Response, payload: unknown): boolean {
  const retryable = payload !== null
    && typeof payload === "object"
    && !Array.isArray(payload)
    && (payload as { error?: { retryable?: unknown } }).error?.retryable === true;
  return retryable || response.status >= 500;
}

function validCompletionReady(value: unknown, now: number): value is CompletionReadyPayload {
  if (!strictRecordWithKeys(value, ["attemptId", "expiresAt", "state"])) {
    return false;
  }
  return value.state === "completion_ready"
    && typeof value.attemptId === "string"
    && canonicalSessionIdPattern.test(value.attemptId)
    && typeof value.expiresAt === "number"
    && Number.isSafeInteger(value.expiresAt)
    && value.expiresAt > now
    && value.expiresAt - now
      <= maximumSessionCompletionLifetimeMilliseconds + maximumClockSkewMilliseconds;
}

function validCompletionPending(
  value: unknown,
  attempt: PendingSessionCompletionAttempt,
): value is CompletionPendingPayload {
  if (!strictRecordWithKeys(
    value,
    ["attemptId", "bindingId", "deviceId", "reconcileExpiresAt", "sessionId", "state"],
  )) return false;
  const now = Date.now();
  return value.state === "completion_pending"
    && value.attemptId === attempt.attemptId
    && typeof value.sessionId === "string"
    && canonicalSessionIdPattern.test(value.sessionId)
    && typeof value.bindingId === "string"
    && canonicalSessionIdPattern.test(value.bindingId)
    && value.deviceId === attempt.candidateDeviceId
    && typeof value.reconcileExpiresAt === "number"
    && Number.isSafeInteger(value.reconcileExpiresAt)
    && value.reconcileExpiresAt > now
    && value.reconcileExpiresAt - now
      <= maximumSessionCompletionReconcileLifetimeMilliseconds + maximumClockSkewMilliseconds;
}

type CompletionAttemptLookup =
  | { readonly kind: "match"; readonly attempt: PendingSessionCompletionAttempt }
  | { readonly kind: "none" }
  | { readonly kind: "blocked" };

function matchingCompletionAttempt(input: {
  readonly challengeId: string;
  readonly device: LoginDevicePlan;
}): CompletionAttemptLookup {
  const inventory = scanPendingSessionCompletionAttempts();
  if (!inventory.ok || inventory.attempts.length > 1) return { kind: "blocked" };
  const attempt = inventory.attempts[0];
  if (attempt === undefined) return { kind: "none" };
  return attempt.challengeId === input.challengeId
    && attempt.predecessorDeviceId === input.device.predecessorId
    && attempt.candidateDeviceId === input.device.deviceId
    ? { kind: "match", attempt }
    : { kind: "blocked" };
}

function completionAttemptMatchesExactly(
  input: { readonly challengeId: string; readonly device: LoginDevicePlan },
  expected: PendingSessionCompletionAttempt,
): boolean {
  const lookup = matchingCompletionAttempt(input);
  return lookup.kind === "match"
    && JSON.stringify(lookup.attempt) === JSON.stringify(expected);
}

async function requestCompletionReady(input: {
  readonly challengeId: string;
  readonly code: string;
  readonly deviceId: string;
}, parentSignal?: AbortSignal): Promise<CompletionReadyPayload> {
  const body = JSON.stringify({
    credential: { provider: "email", challengeId: input.challengeId, code: input.code },
    deviceId: input.deviceId,
  });
  let reauthenticationResetObserved = false;
  while (true) {
    let response: Response;
    try {
      response = await fetch("/api/session/complete", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body,
        signal: sessionRequestSignal(parentSignal),
      });
    } catch {
      throw new SessionCompletionFlowError(true);
    }
    const payload = await safeJSON(response);
    const errorCode = (payload as { error?: { code?: unknown } } | null)?.error?.code;
    if (
      response.status === 401
      && errorCode === "SESSION_REAUTH_REQUIRED"
      && !reauthenticationResetObserved
    ) {
      reauthenticationResetObserved = true;
      continue;
    }
    const observedAt = Date.now();
    if (response.status === 202 && validCompletionReady(payload, observedAt)) return payload;
    throw new SessionCompletionFlowError(completionFailureIsRetryable(response, payload));
  }
}

async function requestCompletionPending(input: {
  readonly challengeId: string;
  readonly code: string;
}, attempt: PreparedSessionCompletionAttempt, parentSignal?: AbortSignal): Promise<CompletionPendingPayload> {
  let response: Response;
  try {
    response = await fetch("/api/session/complete", {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        credential: { provider: "email", challengeId: input.challengeId, code: input.code },
        deviceId: attempt.candidateDeviceId,
        attemptId: attempt.attemptId,
      }),
      signal: sessionRequestSignal(parentSignal),
    });
  } catch {
    throw new SessionCompletionFlowError(true);
  }
  const payload = await safeJSON(response);
  if (response.ok && validCompletionPending(payload, attempt)) return payload;
  throw new SessionCompletionFlowError(completionFailureIsRetryable(response, payload));
}

async function requestCompletionDisposition(
  attempt: PendingSessionCompletionAttempt,
  operation: "accept" | "discard",
): Promise<CompletionDispositionResult> {
  let response: Response;
  try {
    response = await fetch(`/api/session/completion/${operation}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ attemptId: attempt.attemptId }),
      // Once a durable phase has been published, reconciliation must outlive
      // the caller's expiring mutation signal.
      signal: sessionRequestSignal(),
    });
  } catch {
    return { kind: "retryable" };
  }
  const payload = await safeJSON(response);
  if (response.ok) {
    const accepted = sessionFromPayload(payload);
    if (
      accepted
      && (payload as { state?: unknown }).state === "authenticated"
      && Date.parse(accepted.accessTokenExpiresAt) > Date.now()
    ) return { kind: "accepted", session: accepted };
    if (
      strictRecordWithKeys(payload, ["attemptId", "bindingId", "deviceId", "state"])
      && payload.state === "discarded"
      && payload.attemptId === attempt.attemptId
      && typeof payload.bindingId === "string"
      && canonicalSessionIdPattern.test(payload.bindingId)
      && payload.deviceId === attempt.candidateDeviceId
    ) return { kind: "discarded" };
    if (
      strictRecordWithKeys(payload, ["attemptId", "bindingId", "deviceId", "sessionId", "state"])
      && payload.state === "discarded"
      && payload.attemptId === attempt.attemptId
      && typeof payload.sessionId === "string"
      && canonicalSessionIdPattern.test(payload.sessionId)
      && typeof payload.bindingId === "string"
      && canonicalSessionIdPattern.test(payload.bindingId)
      && payload.deviceId === attempt.candidateDeviceId
    ) return { kind: "discarded" };
    return { kind: "terminal" };
  }
  return completionFailureIsRetryable(response, payload)
    ? { kind: "retryable" }
    : { kind: "terminal" };
}

function attemptPlan(attempt: PendingSessionCompletionAttempt): LoginDevicePlan {
  return {
    kind: attempt.predecessorDeviceId === attempt.candidateDeviceId ? "reuse" : "rotate",
    predecessorId: attempt.predecessorDeviceId,
    deviceId: attempt.candidateDeviceId,
  };
}

function nextCompletionAttemptTimestamp(
  attempt: PendingSessionCompletionAttempt,
  expiresAt: number,
): number | null {
  const candidate = Math.max(Date.now(), attempt.updatedAt + 1);
  return Number.isSafeInteger(candidate)
    && candidate > attempt.updatedAt
    && candidate < expiresAt
    ? candidate
    : null;
}

function removeDiscardedCompletionAttempt(attempt: PendingSessionCompletionAttempt): boolean {
  const plan = attemptPlan(attempt);
  if (!rollbackLoginDevicePlan(plan) && !assertLoginDevicePlanCurrent(plan)) return false;
  return removeSessionCompletionAttempt(attempt);
}

async function discardCompletionAttempt(
  attempt: PendingSessionCompletionAttempt,
): Promise<CompletionDispositionResult> {
  const disposition = await requestCompletionDisposition(attempt, "discard");
  if (disposition.kind !== "discarded") return disposition;
  return removeDiscardedCompletionAttempt(attempt)
    ? disposition
    : { kind: "retryable" };
}

export type EmailLoginSessionExpectation =
  | { readonly state: "anonymous" }
  | {
      readonly state: "authenticated";
      readonly userId: string;
      readonly sessionId: string;
    };

function switchResumeMetadata(input: {
  readonly challengeId: string;
  readonly device: LoginDevicePlan;
  readonly expectedSession: Extract<EmailLoginSessionExpectation, { state: "authenticated" }>;
}): LoginSwitchResumeMetadata {
  return {
    version: 1,
    challengeId: input.challengeId,
    predecessorDeviceId: input.device.predecessorId,
    candidateDeviceId: input.device.deviceId,
    expectedUserId: input.expectedSession.userId,
    expectedSessionId: input.expectedSession.sessionId,
    createdAt: Date.now(),
  };
}

function registeredSwitchIsCurrent(input: {
  readonly challengeId: string;
  readonly device: LoginDevicePlan;
  readonly expectedSession: EmailLoginSessionExpectation;
}): boolean {
  if (input.expectedSession.state === "anonymous") return true;
  if (cancelledLoginSwitchChallenges.has(input.challengeId)) return false;
  const resume = storedLoginSwitchResume(input.challengeId);
  return resume !== null && loginSwitchResumeMatches(resume, input);
}

export async function registerEmailSessionSwitch(input: {
  readonly challengeId: string;
  readonly device: LoginDevicePlan;
  readonly expectedSession: EmailLoginSessionExpectation;
}): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const expectedSession = input.expectedSession;
  if (expectedSession.state === "anonymous") return true;
  const registered = await refreshCoordinator.coordinateMutation(async (_signal, ownsAuthority) => {
    const authority = volatileSession
      ? authorityForSession(volatileSession)
      : storedAuthenticatedAuthority();
    const expectedEpoch = sessionEpoch;
    const logoutMetadataBefore = readStorageRaw(LOGOUT_INTENT_KEY);
    const logoutCookieBefore = cookieValue(LOGOUT_INTENT_COOKIE);
    if (
      !ownsAuthority()
      || authority === null
      || authority.userId !== expectedSession.userId
      || authority.sessionId !== expectedSession.sessionId
      || !assertLoginDevicePlanCurrent(input.device)
      || logoutMetadataBefore !== null
      || logoutCookieBefore !== null
    ) return false;
    const key = loginSwitchResumeKey(input.challengeId);
    const metadata = switchResumeMetadata({ ...input, expectedSession });
    const raw = JSON.stringify(metadata);
    if (!storeMetadata(key, metadata) || readStorageRaw(key) !== raw) return false;
    const stillCurrent = ownsAuthority()
      && sessionEpoch === expectedEpoch
      && readStorageRaw(LOGOUT_INTENT_KEY) === logoutMetadataBefore
      && cookieValue(LOGOUT_INTENT_COOKIE) === logoutCookieBefore
      && assertLoginDevicePlanCurrent(input.device)
      && readStorageRaw(key) === raw;
    if (!stillCurrent) {
      removeStorageValueExactly(key, raw);
      return false;
    }
    cancelledLoginSwitchChallenges.delete(input.challengeId);
    return true;
  });
  return registered === true;
}

type EmailCompletionBoundary =
  | { readonly kind: "ready" }
  | { readonly kind: "logout"; readonly intent: LogoutIntentMetadata };

async function coordinateEmailCompletionBoundary(input: {
  readonly challengeId: string;
  readonly device: LoginDevicePlan;
  readonly expectedSession: EmailLoginSessionExpectation;
}): Promise<EmailCompletionBoundary | null> {
  let stagedIntent: LogoutIntentMetadata | null = null;
  return refreshCoordinator.coordinateCommittedMutation(async (
    _signal,
    _ownsAuthority,
    stageCommit,
  ) => stageCommit((ownsAuthority) => {
    if (!ownsAuthority() || pendingLogoutIntent() !== null) {
      throw new Error("Unable to complete sign in.");
    }
    const lookup = matchingCompletionAttempt(input);
    if (lookup.kind === "blocked") throw new Error("Unable to complete sign in.");
    const attempt = lookup.kind === "match" ? lookup.attempt : null;
    const devicePlanRemainsCurrent = (): boolean => (
      attempt?.phase === "device_committed" || attempt?.phase === "accepting"
        ? assertLoginDevicePlanCommitted(input.device)
        : assertLoginDevicePlanCurrent(input.device)
    );
    if (!devicePlanRemainsCurrent() || !registeredSwitchIsCurrent(input)) {
      throw new Error("Unable to complete sign in.");
    }
    const switchAuthority = volatileSession
      ? authorityForSession(volatileSession)
      : storedAuthenticatedAuthority();
    if (switchAuthority === null) return { kind: "ready" };
    const expectedSession = input.expectedSession;
    if (
      expectedSession.state !== "authenticated"
      || switchAuthority.userId !== expectedSession.userId
      || switchAuthority.sessionId !== expectedSession.sessionId
    ) throw new Error("Unable to complete sign in.");
    const expectedEpoch = sessionEpoch;
    const intent: LogoutIntentMetadata = {
      epoch: expectedEpoch,
      scope: "current",
      sessionId: switchAuthority.sessionId,
      origin: "switch",
      preservedSwitchChallengeId: input.challengeId,
      createdAt: Date.now(),
    };
    if (!persistSwitchLogoutIntentExactly(intent, ownsAuthority)) {
      throw new Error("Unable to complete sign in.");
    }
    stagedIntent = intent;
    const authorityAfterIntent = volatileSession
      ? authorityForSession(volatileSession)
      : storedAuthenticatedAuthority();
    if (
      !ownsAuthority()
      || sessionEpoch !== expectedEpoch
      || authorityAfterIntent === null
      || authorityAfterIntent.userId !== switchAuthority.userId
      || authorityAfterIntent.sessionId !== switchAuthority.sessionId
      || !registeredSwitchIsCurrent(input)
      || !devicePlanRemainsCurrent()
      || !ownsAuthority()
      || !logoutIntentStillCurrent(intent)
    ) throw new Error("Unable to complete sign in.");
    return { kind: "logout", intent };
  }, () => {
    if (stagedIntent) rearmLogoutIntent(stagedIntent);
  }));
}

export async function completeEmailSession(input: {
  readonly challengeId: string;
  readonly code: string;
  readonly device: LoginDevicePlan;
  readonly expectedSession: EmailLoginSessionExpectation;
}, options: {
  readonly onCommitted?: (session: WebSession) => void;
} = {}): Promise<WebSession> {
  try {
    const pendingLogout = pendingLogoutIntent();
    if (pendingLogout && !await coordinateLogoutIntent(pendingLogout)) {
      throw new Error("Unable to complete sign in.");
    }
    const boundary = await coordinateEmailCompletionBoundary(input);
    if (!boundary) throw new Error("Unable to complete sign in.");
    if (
      boundary.kind === "logout"
      && !await coordinateLogoutIntent(boundary.intent)
    ) throw new Error("Unable to complete sign in.");
    const completed = await refreshCoordinator.coordinateCommittedMutation(async (
      signal,
      ownsAuthority,
      stageCommit,
    ) => {
      const lookup = matchingCompletionAttempt(input);
      if (!ownsAuthority() || lookup.kind === "blocked") {
        throw new Error("Unable to complete sign in.");
      }
      let attempt = lookup.kind === "match" ? lookup.attempt : null;
      const switchAuthority = volatileSession
        ? authorityForSession(volatileSession)
        : storedAuthenticatedAuthority();
      const devicePlanIsCurrent = attempt?.phase === "device_committed" || attempt?.phase === "accepting"
        ? assertLoginDevicePlanCommitted(input.device)
        : assertLoginDevicePlanCurrent(input.device);
      if (!devicePlanIsCurrent) {
        throw new Error("Unable to complete sign in.");
      }
      const registeredSwitch = registeredSwitchIsCurrent(input);
      const isResumableSwitch = input.expectedSession.state === "authenticated"
        && registeredSwitch
        && switchAuthority === null;
      const isAnonymousLogin = input.expectedSession.state === "anonymous"
        && switchAuthority === null;
      if (!isResumableSwitch && !isAnonymousLogin) {
        throw new Error("Unable to complete sign in.");
      }
      if (
        !ownsAuthority()
        || pendingLogoutIntent() !== null
        || !registeredSwitchIsCurrent(input)
      ) {
        throw new Error("Unable to complete sign in.");
      }
      const expectedEpoch = sessionEpoch;
      let disposition: CompletionDispositionResult;

      if (attempt === null) {
        const ready = await requestCompletionReady({
          challengeId: input.challengeId,
          code: input.code,
          deviceId: input.device.deviceId,
        }, signal);
        if (pendingLogoutIntent() !== null) throw new Error("Unable to complete sign in.");
        const authorityLostAfterReady = !ownsAuthority()
          || sessionEpoch !== expectedEpoch
          || !registeredSwitchIsCurrent(input);
        const createdAt = Date.now();
        const prepared = storePreparedSessionCompletionAttempt({
          challengeId: input.challengeId,
          attemptId: ready.attemptId,
          predecessorDeviceId: input.device.predecessorId,
          candidateDeviceId: input.device.deviceId,
          createdAt,
          prepareExpiresAt: ready.expiresAt,
        });
        if (prepared === null) {
          const unpersisted: PreparedSessionCompletionAttempt = {
            schemaVersion: SESSION_COMPLETION_ATTEMPT_SCHEMA_VERSION,
            challengeId: input.challengeId,
            attemptId: ready.attemptId,
            predecessorDeviceId: input.device.predecessorId,
            candidateDeviceId: input.device.deviceId,
            phase: "prepared",
            createdAt,
            updatedAt: createdAt,
            prepareExpiresAt: ready.expiresAt,
          };
          if (pendingLogoutIntent() === null) {
            await requestCompletionDisposition(unpersisted, "discard");
          }
          throw new Error("Unable to complete sign in.");
        }
        attempt = prepared;
        if (authorityLostAfterReady) {
          await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
      }

      if (attempt.phase === "prepared") {
        if (pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        if (
          !ownsAuthority()
          || sessionEpoch !== expectedEpoch
          || volatileSession !== null
          || !registeredSwitchIsCurrent(input)
          || !assertLoginDevicePlanCurrent(input.device)
        ) {
          await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
        let pending: CompletionPendingPayload;
        try {
          pending = await requestCompletionPending({
            challengeId: input.challengeId,
            code: input.code,
          }, attempt, signal);
        } catch (error) {
          if (
            error instanceof SessionCompletionFlowError
            && !error.retryable
            && pendingLogoutIntent() === null
          ) {
            await discardCompletionAttempt(attempt);
          }
          throw error;
        }
        const reconciledAt = nextCompletionAttemptTimestamp(attempt, pending.reconcileExpiresAt);
        if (reconciledAt === null || pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        const reconciled = reconcileSessionCompletionAttempt({
          expected: attempt,
          sessionId: pending.sessionId,
          reconcileExpiresAt: pending.reconcileExpiresAt,
          updatedAt: reconciledAt,
        });
        if (reconciled === null) {
          if (pendingLogoutIntent() === null) await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
        attempt = reconciled;
      }

      if (attempt.phase === "reconciled") {
        if (pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        if (
          !ownsAuthority()
          || sessionEpoch !== expectedEpoch
          || volatileSession !== null
          || !registeredSwitchIsCurrent(input)
          || !assertLoginDevicePlanCurrent(input.device)
        ) {
          await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }

        if (!commitLoginDevicePlan(input.device)) {
          if (pendingLogoutIntent() === null) await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
        const deviceCommittedAt = nextCompletionAttemptTimestamp(attempt, attempt.reconcileExpiresAt);
        if (deviceCommittedAt === null || pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        const deviceCommitted = markSessionCompletionAttemptDeviceCommitted({
          expected: attempt,
          updatedAt: deviceCommittedAt,
        });
        if (deviceCommitted === null) {
          if (pendingLogoutIntent() === null) await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
        attempt = deviceCommitted;
      }

      if (attempt.phase === "device_committed") {
        if (pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        if (
          !ownsAuthority()
          || sessionEpoch !== expectedEpoch
          || volatileSession !== null
          || !registeredSwitchIsCurrent(input)
          || !assertLoginDevicePlanCommitted(input.device)
        ) {
          await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
        const acceptingAt = nextCompletionAttemptTimestamp(attempt, attempt.reconcileExpiresAt);
        if (acceptingAt === null || pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        const accepting = markSessionCompletionAttemptAccepting({
          expected: attempt,
          updatedAt: acceptingAt,
        });
        if (accepting === null) {
          if (pendingLogoutIntent() === null) await discardCompletionAttempt(attempt);
          throw new Error("Unable to complete sign in.");
        }
        attempt = accepting;
      }

      if (pendingLogoutIntent() !== null) {
        throw new Error("Unable to complete sign in.");
      }
      if (
        attempt.phase !== "accepting"
        || !ownsAuthority()
        || sessionEpoch !== expectedEpoch
        || volatileSession !== null
        || !registeredSwitchIsCurrent(input)
        || !assertLoginDevicePlanCommitted(input.device)
      ) {
        await discardCompletionAttempt(attempt);
        throw new Error("Unable to complete sign in.");
      }
      disposition = await requestCompletionDisposition(attempt, "accept");
      if (disposition.kind === "terminal") {
        if (pendingLogoutIntent() !== null) {
          throw new Error("Unable to complete sign in.");
        }
        disposition = await discardCompletionAttempt(attempt);
      }
      if (disposition.kind === "terminal" && pendingLogoutIntent() === null) {
        const bootstrap = await requestAuthoritativeBootstrap();
        if (
          bootstrap.kind === "session"
          && bootstrap.session.sessionId === attempt.sessionId
        ) disposition = { kind: "accepted", session: bootstrap.session };
      }

      if (disposition.kind === "discarded") {
        removeDiscardedCompletionAttempt(attempt);
        throw new Error("Unable to complete sign in.");
      }
      if (disposition.kind !== "accepted") {
        throw new Error("Unable to complete sign in.");
      }
      const finalAttemptLookup = matchingCompletionAttempt(input);
      const expectedResumeRaw = matchingLoginSwitchResumeRaw(input);
      if (
        !ownsAuthority()
        || sessionEpoch !== expectedEpoch
        || volatileSession !== null
        || pendingLogoutIntent() !== null
        || !registeredSwitchIsCurrent(input)
        || !assertLoginDevicePlanCommitted(input.device)
        || disposition.session.sessionId !== attempt.sessionId
        || finalAttemptLookup.kind !== "match"
        || JSON.stringify(finalAttemptLookup.attempt) !== JSON.stringify(attempt)
        || expectedResumeRaw === undefined
      ) {
        // Acceptance is the final server commit. Keep the durable accepting
        // record for authoritative recovery; never issue a broad logout here.
        throw new Error("Unable to complete sign in.");
      }
      const stagedPublication = stageSessionPublication(disposition.session);
      const sessionMetadataRaw = JSON.stringify(stagedPublication.metadata);
      const resumeKey = loginSwitchResumeKey(input.challengeId);
      let resumeRemoved = false;
      let attemptRemoved = false;
      const cleanupWasReplaced = (): boolean => {
        const inventory = scanPendingSessionCompletionAttempts();
        return !inventory.ok
          || inventory.attempts.length !== 0
          || readStorageRaw(resumeKey) !== null;
      };
      const rollback = (): void => {
        if (
          readSession() === disposition.session
          || readStorageRaw(SESSION_METADATA_KEY) === sessionMetadataRaw
        ) commitSession(null, { incrementEpoch: true, broadcast: true });
        let restored = true;
        if (attemptRemoved) restored = restoreSessionCompletionAttemptExactly(attempt) && restored;
        if (resumeRemoved && typeof expectedResumeRaw === "string") {
          restored = restoreStorageValueExactly(resumeKey, expectedResumeRaw) && restored;
        }
        if (!restored) {
          armLogoutIntent({
            epoch: sessionEpoch,
            scope: "current",
            sessionId: disposition.session.sessionId,
            origin: "user",
            createdAt: Date.now(),
          });
        }
      };
      return stageCommit((finalOwnsAuthority) => {
        const preCleanupIsCurrent = (): boolean => (
          finalOwnsAuthority()
          && sessionEpoch === expectedEpoch
          && volatileSession === null
          && pendingLogoutIntent() === null
          && registeredSwitchIsCurrent(input)
          && assertLoginDevicePlanCommitted(input.device)
          && completionAttemptMatchesExactly(input, attempt)
          && matchingLoginSwitchResumeRaw(input) === expectedResumeRaw
        );
        if (!preCleanupIsCurrent()) throw new Error("Unable to complete sign in.");
        if (!removeMatchingLoginSwitchResumeExactly(input, expectedResumeRaw)) {
          throw new Error("Unable to complete sign in.");
        }
        resumeRemoved = input.expectedSession.state === "authenticated";
        if (
          !finalOwnsAuthority()
          || pendingLogoutIntent() !== null
          || readStorageRaw(resumeKey) !== null
          || !completionAttemptMatchesExactly(input, attempt)
          || !assertLoginDevicePlanCommitted(input.device)
        ) throw new Error("Unable to complete sign in.");
        if (!removeSessionCompletionAttempt(attempt)) {
          throw new Error("Unable to complete sign in.");
        }
        attemptRemoved = true;
        if (
          !finalOwnsAuthority()
          || pendingLogoutIntent() !== null
          || cleanupWasReplaced()
          || !assertLoginDevicePlanCommitted(input.device)
        ) throw new Error("Unable to complete sign in.");
        const canPublish = (): boolean => (
          finalOwnsAuthority()
          && sessionEpoch === expectedEpoch
          && volatileSession === null
          && pendingLogoutIntent() === null
          && !cleanupWasReplaced()
          && assertLoginDevicePlanCommitted(input.device)
        );
        const committedStateIsCurrent = (epoch: number): boolean => (
          finalOwnsAuthority()
          && epoch === expectedEpoch + 1
          && sessionEpoch === epoch
          && readSession() === disposition.session
          && readStorageRaw(SESSION_METADATA_KEY) === sessionMetadataRaw
          && pendingLogoutIntent() === null
          && !cleanupWasReplaced()
          && assertLoginDevicePlanCommitted(input.device)
        );
        const publishedEpoch = announceStagedSessionPublication(
          stagedPublication,
          canPublish,
          committedStateIsCurrent,
        );
        if (publishedEpoch === null || !committedStateIsCurrent(publishedEpoch)) {
          throw new Error("Unable to complete sign in.");
        }
        if (options.onCommitted) {
          const callbackResult = options.onCommitted(disposition.session) as unknown;
          if (
            callbackResult !== null
            && typeof callbackResult === "object"
            && "then" in callbackResult
            && typeof (callbackResult as { readonly then?: unknown }).then === "function"
          ) throw new TypeError("The committed session callback must be synchronous.");
        }
        return disposition.session;
      }, rollback);
    });
    if (
      !completed
      || readSession() !== completed
      || pendingLogoutIntent() !== null
    ) {
      throw new Error("Unable to complete sign in.");
    }
    return completed;
  } catch {
    throw new Error("Unable to complete sign in.");
  }
}

type PreparedLogoutIntent =
  | {
      readonly kind: "blocked" | "network_failure";
      readonly intent: LogoutIntentMetadata;
    }
  | {
      readonly kind: "response";
      readonly intent: LogoutIntentMetadata;
      readonly cleanupSnapshot: LogoutCleanupSnapshot;
      readonly preservedResumeKey?: string;
      readonly reauthenticationRequired: boolean;
      readonly serverTerminal: boolean;
      readonly logoutAllUnconfirmed: boolean;
    };

async function prepareLogoutIntent(
  intent: LogoutIntentMetadata,
  parentSignal?: AbortSignal,
): Promise<PreparedLogoutIntent> {
  if (!logoutIntentStillCurrent(intent) && pendingLogoutIntent() !== null) {
    return { kind: "blocked", intent };
  }
  const persisted = persistLogoutIntent(intent);
  if (!persisted) return { kind: "blocked", intent };
  const completion = captureSessionCompletionAttemptSnapshot();
  const resumes = captureStorageNamespace(LOGIN_SWITCH_RESUME_PREFIX);
  const preservedResumeKey = intent.preservedSwitchChallengeId === undefined
    ? undefined
    : loginSwitchResumeKey(intent.preservedSwitchChallengeId);
  const cleanupSnapshot: LogoutCleanupSnapshot = {
    intent: persisted,
    completion,
    resumes,
    refreshRaw: readStorageRaw(REFRESH_ATTEMPT_KEY),
  };
  let response: Response;
  try {
    response = await fetch(`/api/session/${intent.scope === "all" ? "logout-all" : "logout"}`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: sessionRequestSignal(parentSignal),
    });
  } catch {
    return { kind: "network_failure", intent };
  }
  const payload = await safeJSON(response);
  const errorCode = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  const reauthenticationRequired = response.status === 401
    && errorCode === "SESSION_REAUTH_REQUIRED";
  const serverTerminal = response.ok
    ? (payload as { state?: unknown } | null)?.state === "anonymous"
    : false;
  const logoutAllUnconfirmed = intent.scope === "all"
    && (
      reauthenticationRequired
      || (response.status === 409 && errorCode === "LOGOUT_ALL_UNCONFIRMED")
    );
  return {
    kind: "response",
    intent,
    cleanupSnapshot,
    ...(preservedResumeKey === undefined ? {} : { preservedResumeKey }),
    reauthenticationRequired,
    serverTerminal,
    logoutAllUnconfirmed,
  };
}

function commitPreparedLogoutIntent(
  prepared: PreparedLogoutIntent,
  signal: AbortSignal,
  ownsAuthority: () => boolean,
): boolean {
  const intent = prepared.intent;
  const mutationAuthorityIsCurrent = (): boolean => ownsAuthority() && !signal.aborted;
  if (!mutationAuthorityIsCurrent()) {
    rearmLogoutIntent(intent);
    return false;
  }
  if (prepared.kind !== "response") {
    rearmLogoutIntent(intent);
    return false;
  }
  const { cleanupSnapshot, preservedResumeKey } = prepared;
  const completionInventory = cleanupSnapshot.completion.inventory;
  const completionSnapshotExact = verifySessionCompletionAttemptSnapshot(
    cleanupSnapshot.completion,
  );
  const resumeSnapshotExact = verifyStorageNamespaceSnapshot(
    LOGIN_SWITCH_RESUME_PREFIX,
    cleanupSnapshot.resumes,
  );
  const completionResumesExact = completionInventory.ok
    && completionResumeExpectationsStillExact(
      completionInventory.attempts,
      cleanupSnapshot.resumes,
    );
  const refreshSnapshotExact = cleanupSnapshot.refreshRaw !== undefined
    && readStorageRaw(REFRESH_ATTEMPT_KEY) === cleanupSnapshot.refreshRaw;
  const intentSnapshotExact = logoutPersistenceStillExact(cleanupSnapshot.intent);
  const cleanupPreflightExact = mutationAuthorityIsCurrent()
    && completionSnapshotExact
    && resumeSnapshotExact
    && completionResumesExact
    && refreshSnapshotExact
    && intentSnapshotExact;
  const currentReauthenticationTerminal = intent.scope === "current"
    && prepared.reauthenticationRequired
    && cleanupPreflightExact
    && completionInventory.ok
    && completionInventory.attempts.length === 0;
  const terminal = prepared.serverTerminal || currentReauthenticationTerminal;
  if (!terminal && !prepared.logoutAllUnconfirmed) {
    if (
      intent.scope === "current"
      && prepared.reauthenticationRequired
      && !cleanupPreflightExact
    ) {
      rearmLogoutIntent(intent);
    }
    return false;
  }
  if (!cleanupPreflightExact || !completionInventory.ok) {
    rearmLogoutIntent(intent);
    return false;
  }
  if (!cleanupSnapshot.resumes.ok) {
    rearmLogoutIntent(intent);
    return false;
  }
  if (
    intent.origin === undefined
    && (
      completionInventory.attempts.length > 0
      || cleanupSnapshot.resumes.entries.length > 0
    )
  ) {
    rearmLogoutIntent(intent);
    return false;
  }
  const expectedDeviceState = (attempt: PendingSessionCompletionAttempt): "committed" | "current" => (
    attempt.phase === "device_committed" || attempt.phase === "accepting"
      ? "committed"
      : "current"
  );
  const completionDevicesExact = completionInventory.attempts.every((attempt) => {
    const plan = attemptPlan(attempt);
    return expectedDeviceState(attempt) === "committed"
      ? assertLoginDevicePlanCommitted(plan)
      : assertLoginDevicePlanCurrent(plan);
  });
  if (!completionDevicesExact || !mutationAuthorityIsCurrent()) {
    rearmLogoutIntent(intent);
    return false;
  }
  if (terminal) {
    const expectedEpoch = sessionEpoch;
    const expectedSession = volatileSession;
    const expectedSessionMetadataRaw = readStorageRaw(SESSION_METADATA_KEY);
    const storedAuthority = storedAuthenticatedAuthority();
    const expectedAuthenticatedMetadataRaw = expectedSession === null
      ? storedAuthority === null
        ? null
        : JSON.stringify({
            state: "authenticated",
            userId: storedAuthority.userId,
            sessionId: storedAuthority.sessionId,
            refreshGeneration: storedAuthority.refreshGeneration,
          })
      : JSON.stringify(metadataFor(expectedSession));
    const localAuthority = expectedSession === null
      ? storedAuthority
      : authorityForSession(expectedSession);
    const alreadyAnonymous = localAuthority === null
      && (
        expectedSessionMetadataRaw === null
        || expectedSessionMetadataRaw === JSON.stringify({ state: "anonymous" })
      );
    if (
      !alreadyAnonymous
      && (
        localAuthority === null
        || intent.sessionId === undefined
        || localAuthority.sessionId !== intent.sessionId
        || expectedSessionMetadataRaw !== expectedAuthenticatedMetadataRaw
      )
    ) {
      rearmLogoutIntent(intent);
      return false;
    }
    if (!alreadyAnonymous) {
      if (
        !mutationAuthorityIsCurrent()
        || sessionEpoch !== expectedEpoch
        || volatileSession !== expectedSession
        || readStorageRaw(SESSION_METADATA_KEY) !== expectedSessionMetadataRaw
        || !logoutPersistenceStillExact(cleanupSnapshot.intent)
        || !mutationAuthorityIsCurrent()
      ) {
        rearmLogoutIntent(intent);
        return false;
      }
      commitSession(null, {
        incrementEpoch: true,
        broadcast: true,
        anonymousTransition: intent.origin === "switch"
          && intent.preservedSwitchChallengeId !== undefined
          ? {
              kind: "account_switch",
              preservedSwitchChallengeId: intent.preservedSwitchChallengeId,
            }
          : { kind: "user_logout" },
      });
      if (
        !mutationAuthorityIsCurrent()
        || sessionEpoch !== expectedEpoch + 1
        || volatileSession !== null
        || readStorageRaw(SESSION_METADATA_KEY) !== JSON.stringify({ state: "anonymous" })
      ) {
        rearmLogoutIntent(intent);
        return false;
      }
    }
    if (
      !mutationAuthorityIsCurrent()
      || !verifySessionCompletionAttemptSnapshot(cleanupSnapshot.completion)
      || !verifyStorageNamespaceSnapshot(LOGIN_SWITCH_RESUME_PREFIX, cleanupSnapshot.resumes)
      || readStorageRaw(REFRESH_ATTEMPT_KEY) !== cleanupSnapshot.refreshRaw
      || !logoutPersistenceStillExact(cleanupSnapshot.intent)
    ) {
      rearmLogoutIntent(intent);
      return false;
    }
  }
  const remainingResumeEntries = cleanupSnapshot.resumes.entries
    .filter((entry) => entry.key === preservedResumeKey);
  const removedResumeEntries: StorageNamespaceEntry[] = [];
  const removedAttempts: Array<{
    readonly attempt: PendingSessionCompletionAttempt;
    readonly expectedDeviceState: "committed" | "current";
  }> = [];
  let refreshRemoved = false;
  const cleanupAuthorityStillExact = (expectedResumes: readonly StorageNamespaceEntry[]): boolean => (
    mutationAuthorityIsCurrent()
    && verifyStorageNamespaceEntries(LOGIN_SWITCH_RESUME_PREFIX, expectedResumes)
    && readStorageRaw(REFRESH_ATTEMPT_KEY) === cleanupSnapshot.refreshRaw
    && logoutPersistenceStillExact(cleanupSnapshot.intent)
  );
  const restoreInterruptedCleanup = (): void => {
    if (refreshRemoved && typeof cleanupSnapshot.refreshRaw === "string") {
      restoreStorageValueExactly(REFRESH_ATTEMPT_KEY, cleanupSnapshot.refreshRaw);
    }
    for (const removed of [...removedAttempts].reverse()) {
      const plan = attemptPlan(removed.attempt);
      const deviceRestored = removed.expectedDeviceState === "committed"
        ? assertLoginDevicePlanCommitted(plan) || commitLoginDevicePlan(plan)
        : assertLoginDevicePlanCurrent(plan);
      if (deviceRestored) restoreSessionCompletionAttemptExactly(removed.attempt);
    }
    for (const entry of [...removedResumeEntries].reverse()) {
      restoreStorageValueExactly(entry.key, entry.raw);
    }
    rearmLogoutIntent(intent);
  };
  let expectedResumeEntries = [...cleanupSnapshot.resumes.entries];
  for (const entry of cleanupSnapshot.resumes.entries) {
    if (entry.key === preservedResumeKey) continue;
    if (
      !verifySessionCompletionAttemptSnapshot(cleanupSnapshot.completion)
      || !cleanupAuthorityStillExact(expectedResumeEntries)
      || !removeStorageValueExactly(entry.key, entry.raw)
    ) {
      restoreInterruptedCleanup();
      return false;
    }
    removedResumeEntries.push(entry);
    expectedResumeEntries = expectedResumeEntries.filter((candidate) => candidate.key !== entry.key);
    if (
      !verifySessionCompletionAttemptSnapshot(cleanupSnapshot.completion)
      || !cleanupAuthorityStillExact(expectedResumeEntries)
    ) {
      restoreInterruptedCleanup();
      return false;
    }
  }
  if (
    !verifySessionCompletionAttemptSnapshot(cleanupSnapshot.completion)
    || !cleanupAuthorityStillExact(remainingResumeEntries)
  ) {
    restoreInterruptedCleanup();
    return false;
  }
  for (const attempt of completionInventory.attempts) {
    const plan = attemptPlan(attempt);
    if (!mutationAuthorityIsCurrent() || !removeSessionCompletionAttempt(attempt)) {
      restoreInterruptedCleanup();
      return false;
    }
    removedAttempts.push({ attempt, expectedDeviceState: expectedDeviceState(attempt) });
    const currentInventory = scanPendingSessionCompletionAttempts();
    if (
      !mutationAuthorityIsCurrent()
      || !currentInventory.ok
      || currentInventory.attempts.length !== 0
    ) {
      restoreInterruptedCleanup();
      return false;
    }
    if (
      !mutationAuthorityIsCurrent()
      || (!rollbackLoginDevicePlan(plan) && !assertLoginDevicePlanCurrent(plan))
      || !mutationAuthorityIsCurrent()
    ) {
      restoreInterruptedCleanup();
      return false;
    }
    if (
      !cleanupAuthorityStillExact(remainingResumeEntries)
      || !scanPendingSessionCompletionAttempts().ok
    ) {
      restoreInterruptedCleanup();
      return false;
    }
  }
  const clearedInventory = scanPendingSessionCompletionAttempts();
  if (
    !clearedInventory.ok
    || clearedInventory.attempts.length !== 0
    || !cleanupAuthorityStillExact(remainingResumeEntries)
    || !mutationAuthorityIsCurrent()
    || !removeStorageValueExactly(REFRESH_ATTEMPT_KEY, cleanupSnapshot.refreshRaw!)
    || !mutationAuthorityIsCurrent()
  ) {
    restoreInterruptedCleanup();
    return false;
  }
  refreshRemoved = cleanupSnapshot.refreshRaw !== null;
  const afterRefreshInventory = scanPendingSessionCompletionAttempts();
  if (
    !mutationAuthorityIsCurrent()
    || !afterRefreshInventory.ok
    || afterRefreshInventory.attempts.length !== 0
    || !verifyStorageNamespaceEntries(LOGIN_SWITCH_RESUME_PREFIX, remainingResumeEntries)
    || readStorageRaw(REFRESH_ATTEMPT_KEY) !== null
    || !logoutPersistenceStillExact(cleanupSnapshot.intent)
  ) {
    restoreInterruptedCleanup();
    return false;
  }
  if (!mutationAuthorityIsCurrent()) {
    restoreInterruptedCleanup();
    return false;
  }
  const cookieCleared = cleanupSnapshot.intent.cookieValue === null
    || clearLogoutIntentCookieExactly(cleanupSnapshot.intent.cookieValue);
  if (!cookieCleared || !mutationAuthorityIsCurrent()) {
    restoreInterruptedCleanup();
    return false;
  }
  if (!mutationAuthorityIsCurrent()) {
    restoreInterruptedCleanup();
    return false;
  }
  const metadataCleared = cleanupSnapshot.intent.metadataRaw === undefined
    || removeStorageValueExactly(LOGOUT_INTENT_KEY, cleanupSnapshot.intent.metadataRaw);
  const finalInventory = scanPendingSessionCompletionAttempts();
  const cleanupCommitted = metadataCleared
    && mutationAuthorityIsCurrent()
    && cookieValue(LOGOUT_INTENT_COOKIE) === null
    && (readStorageRaw(LOGOUT_INTENT_KEY) === null || readStorageRaw(LOGOUT_INTENT_KEY) === undefined)
    && finalInventory.ok
    && finalInventory.attempts.length === 0
    && verifyStorageNamespaceEntries(LOGIN_SWITCH_RESUME_PREFIX, remainingResumeEntries)
    && readStorageRaw(REFRESH_ATTEMPT_KEY) === null;
  if (!cleanupCommitted) {
    restoreInterruptedCleanup();
    return false;
  }
  markCapturedLoginSwitchChallengesCancelled(cleanupSnapshot.resumes, preservedResumeKey);
  return terminal;
}

function armLogoutIntent(intent: LogoutIntentMetadata): boolean {
  return persistLogoutIntent(intent) !== null;
}

async function coordinateLogoutIntent(
  intent: LogoutIntentMetadata,
): Promise<boolean> {
  const result = await refreshCoordinator.coordinateCommittedMutation(async (
    signal,
    ownsAuthority,
    stageCommit,
  ) => {
    if (!ownsAuthority() || !logoutIntentStillCurrent(intent)) {
      return stageCommit(() => false, () => undefined);
    }
    const prepared = await prepareLogoutIntent(intent, signal);
    return stageCommit(
      (finalOwnsAuthority) => commitPreparedLogoutIntent(
        prepared,
        signal,
        finalOwnsAuthority,
      ),
      () => rearmLogoutIntent(intent),
    );
  });
  return result === true;
}

export async function logoutCurrentSession(scope: "current" | "all" = "current"): Promise<boolean> {
  const current = volatileSession;
  const supersededSwitch = supersededSwitchResume();
  scrubLegacySession();
  clearPrivateBrowserDrafts();
  commitSession(null, {
    incrementEpoch: true,
    broadcast: true,
    anonymousTransition: { kind: "user_logout" },
  });
  const intent: LogoutIntentMetadata = {
    epoch: sessionEpoch,
    scope,
    ...(current ? { sessionId: current.sessionId } : {}),
    origin: "user",
    createdAt: Date.now(),
  };
  if (!armLogoutIntent(intent)) return false;
  if (supersededSwitch !== null) {
    cancelledLoginSwitchChallenges.add(supersededSwitch.challengeId);
    if (supersededSwitch.resumeRaw !== undefined) {
      removeStorageValueExactly(
        loginSwitchResumeKey(supersededSwitch.challengeId),
        supersededSwitch.resumeRaw,
      );
    }
  }
  return coordinateLogoutIntent(intent);
}
