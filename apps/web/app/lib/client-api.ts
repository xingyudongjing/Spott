"use client";

import type { EventView } from "./demo-data";

const SESSION_KEY = "spott.web.session.v1";
const DEVICE_KEY = "spott.web.device.v1";
let volatileDeviceId: string | null = null;
let volatileSession: WebSession | null = null;
let volatileSessionIsAuthoritative = false;

export interface SessionUser {
  id: string;
  publicHandle: string;
  phoneVerified: boolean;
  restrictions: string[];
}

export interface WebSession {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  sessionId: string;
  user: SessionUser;
}

type APIRequestInit = RequestInit & {
  authenticated?: boolean;
  idempotent?: boolean;
  idempotencyKey?: string;
  ifMatch?: number;
};

type SessionGeneration = { readonly marker: symbol };
type SessionState = { session: WebSession | null; generation: SessionGeneration };
type RequestSessionContext = { readonly generation: SessionGeneration };

let observedSessionKey: string | null | undefined;
let observedSessionGeneration: SessionGeneration = { marker: Symbol("spott-session-generation") };
const refreshesInFlight = new Map<SessionGeneration, Promise<WebSession | null>>();

export interface APIErrorBody {
  code?: string;
  message?: string;
  actions?: Array<{ type: string; label: string }>;
  fieldErrors?: Array<{ field: string; message: string }>;
  meta?: Record<string, unknown>;
}

type ClientCopyKey =
  | "authRequired"
  | "operationFailed"
  | "requestFailed"
  | "sessionChanged";

function currentClientLocale(): "zh-Hans" | "ja" | "en" {
  const language = typeof document !== "undefined"
    ? document.documentElement.lang
    : typeof navigator !== "undefined"
      ? navigator.language
      : "zh-Hans";
  if (language.toLowerCase().startsWith("ja")) return "ja";
  if (language.toLowerCase().startsWith("en")) return "en";
  return "zh-Hans";
}

function clientCopy(key: ClientCopyKey, status?: number): string {
  const locale = currentClientLocale();
  const copy = {
    "zh-Hans": {
      authRequired: "请先登录。",
      operationFailed: "操作没有成功，请稍后再试。",
      requestFailed: `请求失败（${status ?? "-"}）`,
      sessionChanged: "登录账号已切换，请重试当前操作。",
    },
    ja: {
      authRequired: "先にログインしてください。",
      operationFailed: "操作を完了できませんでした。しばらくしてからもう一度お試しください。",
      requestFailed: `リクエストに失敗しました（${status ?? "-"}）`,
      sessionChanged: "ログイン中のアカウントが変わりました。もう一度お試しください。",
    },
    en: {
      authRequired: "Please sign in first.",
      operationFailed: "We could not complete that action. Please try again shortly.",
      requestFailed: `Request failed (${status ?? "-"})`,
      sessionChanged: "The signed-in account changed. Please try that action again.",
    },
  } as const;
  return copy[locale][key];
}

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: APIErrorBody,
  ) {
    super(body.message ?? clientCopy("operationFailed"));
  }
}

export interface WalletView {
  paidBalance: number;
  freeBalance: number;
  totalBalance: number;
  version: number;
  nextFreeExpiry: string | null;
}

export interface WalletTransaction {
  id: string;
  type: string;
  status: string;
  paidDelta: number;
  freeDelta: number;
  occurredAt: string;
}

export interface RegistrationView {
  id: string;
  eventId: string;
  status: string;
  partySize: number;
  waitlistPosition?: number | null;
  event?: EventView;
  createdAt?: string;
}

export interface NotificationView {
  id: string;
  type: string;
  variables: Record<string, unknown>;
  resourceType: string | null;
  resourcePublicId: string | null;
  createdAt: string;
  readAt: string | null;
}

export interface GroupView {
  id: string;
  ownerId?: string;
  owner?: { id: string; name: string; handle: string };
  name: string;
  slug: string;
  description: string;
  coverURL?: string | null;
  joinMode?: "open" | "approval" | "invite_only";
  regionId?: string;
  categoryId?: string | null;
  tags?: string[];
  rules?: string;
  capacity: number;
  memberCount: number;
  status: string;
  membershipStatus?: "active" | "pending" | "muted" | null;
  membershipRole?: "owner" | "admin" | "member" | null;
  viewerFollowing?: boolean;
  announcementSummary?: GroupAnnouncement[];
  closingAt?: string | null;
  dissolveAfter?: string | null;
  availableActions: string[];
  version: number;
}

export interface GroupAnnouncement {
  id: string;
  groupId: string;
  authorId?: string;
  authorName?: string | null;
  title: string;
  body: string;
  visibility: "public" | "members";
  commentsEnabled: boolean;
  pinnedAt?: string | null;
  likeCount: number;
  viewerLiked: boolean;
  commentCount?: number;
  version: number;
  createdAt: string;
  updatedAt?: string;
}

export interface GroupComment {
  id: string;
  announcementId: string;
  author: { id: string; name: string };
  body: string;
  parentId?: string | null;
  locale: "zh-Hans" | "ja" | "en";
  version: number;
  createdAt: string;
  updatedAt: string;
}

export function apiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, "");
  if (typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
    return "http://localhost:4100/v1";
  }
  return "https://api.spott.jp/v1";
}

export function deviceId(): string {
  if (typeof window === "undefined") return "00000000-0000-4000-8000-000000000000";
  try {
    const stored = window.localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const generated = volatileDeviceId ?? window.crypto.randomUUID();
    volatileDeviceId = generated;
    window.localStorage.setItem(DEVICE_KEY, generated);
    return generated;
  } catch {
    if (!volatileDeviceId) volatileDeviceId = window.crypto.randomUUID();
    return volatileDeviceId;
  }
}

export function readSession(): WebSession | null {
  if (typeof window === "undefined") return null;
  if (volatileSessionIsAuthoritative) return volatileSession;
  let value: string | null;
  try {
    value = window.localStorage.getItem(SESSION_KEY);
  } catch {
    return volatileSession;
  }
  if (!value) {
    volatileSession = null;
    return null;
  }
  try {
    const session = JSON.parse(value) as WebSession;
    volatileSession = session;
    return session;
  } catch {
    volatileSession = null;
    try {
      window.localStorage.removeItem(SESSION_KEY);
    } catch {
      // Ignore cleanup failures for malformed persistent state.
    }
    return null;
  }
}

export function saveSession(session: WebSession): void {
  persistSession(session, { marker: Symbol("spott-session-generation") });
}

function persistSession(session: WebSession, generation: SessionGeneration): void {
  volatileSession = session;
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    volatileSessionIsAuthoritative = false;
  } catch {
    volatileSessionIsAuthoritative = true;
  }
  observedSessionKey = sessionAuthenticationKey(session);
  observedSessionGeneration = generation;
  window.dispatchEvent(new CustomEvent("spott:session", { detail: session }));
}

export function clearSession(): void {
  volatileSession = null;
  try {
    window.localStorage.removeItem(SESSION_KEY);
    volatileSessionIsAuthoritative = false;
  } catch {
    try {
      // An empty persistent value is a logout tombstone that survives module reloads.
      window.localStorage.setItem(SESSION_KEY, "");
      volatileSessionIsAuthoritative = false;
    } catch {
      volatileSessionIsAuthoritative = true;
    }
  }
  observedSessionKey = null;
  observedSessionGeneration = { marker: Symbol("spott-session-generation") };
  window.dispatchEvent(new CustomEvent("spott:session", { detail: null }));
}

export function subscribeSessionChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onSession = () => listener();
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === SESSION_KEY) listener();
  };
  window.addEventListener("spott:session", onSession);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener("spott:session", onSession);
    window.removeEventListener("storage", onStorage);
  };
}

function sameSessionIdentity(left: WebSession | null, right: WebSession | null): boolean {
  return Boolean(
    left
      && right
      && left.user.id === right.user.id
      && left.sessionId === right.sessionId,
  );
}

function sameSessionSnapshot(left: WebSession | null, right: WebSession | null): boolean {
  return Boolean(
    sameSessionIdentity(left, right)
      && left?.accessToken === right?.accessToken
      && left?.refreshToken === right?.refreshToken,
  );
}

function sessionAuthenticationKey(session: WebSession | null): string | null {
  return session
    ? [session.user.id, session.sessionId, session.accessToken, session.refreshToken].join("\u0000")
    : null;
}

function currentSessionState(): SessionState {
  const session = readSession();
  const key = sessionAuthenticationKey(session);
  if (observedSessionKey === undefined) {
    observedSessionKey = key;
  } else if (observedSessionKey !== key) {
    observedSessionKey = key;
    observedSessionGeneration = { marker: Symbol("spott-session-generation") };
  }
  return { session, generation: observedSessionGeneration };
}

function assertRequestSession(context: RequestSessionContext): WebSession | null {
  const current = currentSessionState();
  if (current.generation !== context.generation) throw sessionChangedError();
  return current.session;
}

function sessionChangedError(): APIError {
  return new APIError(401, {
    code: "SESSION_CHANGED",
    message: clientCopy("sessionChanged"),
  });
}

function clearSessionIfCurrent(session: WebSession, context?: RequestSessionContext): void {
  const current = currentSessionState();
  if (
    (!context || current.generation === context.generation)
    && sameSessionSnapshot(current.session, session)
  ) clearSession();
}

export function requireLogin(returnTo = window.location.pathname): never {
  window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  throw new APIError(401, { code: "AUTH_REQUIRED", message: clientCopy("authRequired") });
}

export async function apiRequest<T>(
  path: string,
  init: APIRequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  else if (init.idempotent && !headers.has("Idempotency-Key")) headers.set("Idempotency-Key", crypto.randomUUID());
  const initial = currentSessionState();
  const requestContext = initial.session ? { generation: initial.generation } : null;
  return apiRequestAttempt<T>(path, { ...init, headers }, true, requestContext);
}

async function apiRequestAttempt<T>(
  path: string,
  init: APIRequestInit,
  allowRefresh: boolean,
  requestContext: RequestSessionContext | null,
): Promise<T> {
  const state = currentSessionState();
  if (requestContext && state.generation !== requestContext.generation) throw sessionChangedError();
  const session = state.session;
  if (init.authenticated && !session) requireLogin();
  const ownerContext = requestContext ?? (session ? { generation: state.generation } : null);
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Spott-Device-Id", deviceId());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  if (init.ifMatch !== undefined) headers.set("If-Match", `\"${init.ifMatch}\"`);

  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, credentials: "include" });
  if (ownerContext) assertRequestSession(ownerContext);
  if (response.status === 401 && session && path !== "/auth/refresh") {
    if (allowRefresh) {
      const latestSession = ownerContext ? assertRequestSession(ownerContext) : readSession();
      if (latestSession && !sameSessionSnapshot(latestSession, session)) {
        return apiRequestAttempt<T>(path, init, false, ownerContext);
      }
      if (latestSession && ownerContext) {
        const refreshed = await refreshSessionOnce(latestSession, ownerContext);
        assertRequestSession(ownerContext);
        if (refreshed) return apiRequestAttempt<T>(path, init, false, ownerContext);
      }
    } else {
      clearSessionIfCurrent(session, ownerContext ?? undefined);
    }
  }
  if (!response.ok) {
    let body: APIErrorBody = {};
    try {
      const payload = (await response.json()) as APIErrorBody & { error?: APIErrorBody };
      if (ownerContext) assertRequestSession(ownerContext);
      body = payload.error ?? payload;
    } catch {
      if (ownerContext) assertRequestSession(ownerContext);
      body = { message: clientCopy("requestFailed", response.status) };
    }
    throw new APIError(response.status, body);
  }
  if (response.status === 204) {
    if (ownerContext) assertRequestSession(ownerContext);
    return undefined as T;
  }
  const payload = (await response.json()) as T;
  if (ownerContext) assertRequestSession(ownerContext);
  return payload;
}

async function refreshSession(
  session: WebSession,
  context: RequestSessionContext,
): Promise<WebSession | null> {
  const response = await fetch(`${apiBase()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Spott-Device-Id": deviceId() },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: deviceId() }),
  });
  let currentSession: WebSession | null;
  try {
    currentSession = assertRequestSession(context);
  } catch {
    return null;
  }
  if (!response.ok) {
    if (!sameSessionSnapshot(currentSession, session) && sameSessionIdentity(currentSession, session)) {
      return currentSession;
    }
    clearSessionIfCurrent(session, context);
    return null;
  }
  const refreshed = (await response.json()) as WebSession;
  try {
    currentSession = assertRequestSession(context);
  } catch {
    return null;
  }
  if (!sameSessionSnapshot(currentSession, session)) {
    return sameSessionIdentity(currentSession, session) ? currentSession : null;
  }
  if (refreshed.user.id !== session.user.id) return null;
  persistSession(refreshed, context.generation);
  return refreshed;
}

function refreshSessionOnce(
  session: WebSession,
  context: RequestSessionContext,
): Promise<WebSession | null> {
  let refresh = refreshesInFlight.get(context.generation);
  if (!refresh) {
    refresh = refreshSession(session, context).finally(() => {
      refreshesInFlight.delete(context.generation);
    });
    refreshesInFlight.set(context.generation, refresh);
  }
  return refresh;
}

export async function refreshCurrentSession(): Promise<WebSession | null> {
  const current = currentSessionState();
  return current.session
    ? refreshSessionOnce(current.session, { generation: current.generation })
    : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : clientCopy("operationFailed");
}
