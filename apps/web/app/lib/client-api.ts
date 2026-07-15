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

const refreshesInFlight = new Map<string, Promise<WebSession | null>>();

export interface APIErrorBody {
  code?: string;
  message?: string;
  actions?: Array<{ type: string; label: string }>;
  fieldErrors?: Array<{ field: string; message: string }>;
  meta?: Record<string, unknown>;
}

export class APIError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: APIErrorBody,
  ) {
    super(body.message ?? "请求没有成功，请稍后重试。");
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
  volatileSession = session;
  try {
    window.localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    volatileSessionIsAuthoritative = false;
  } catch {
    volatileSessionIsAuthoritative = true;
  }
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
  window.dispatchEvent(new CustomEvent("spott:session", { detail: null }));
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

function sessionChangedError(): APIError {
  return new APIError(401, {
    code: "SESSION_CHANGED",
    message: "登录账号已切换，请重试当前操作。",
  });
}

function clearSessionIfCurrent(session: WebSession): void {
  if (sameSessionSnapshot(readSession(), session)) clearSession();
}

export function requireLogin(returnTo = window.location.pathname): never {
  window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  throw new APIError(401, { code: "AUTH_REQUIRED", message: "请先登录。" });
}

export async function apiRequest<T>(
  path: string,
  init: APIRequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.idempotencyKey) headers.set("Idempotency-Key", init.idempotencyKey);
  else if (init.idempotent && !headers.has("Idempotency-Key")) headers.set("Idempotency-Key", crypto.randomUUID());
  return apiRequestAttempt<T>(path, { ...init, headers }, true, null);
}

async function apiRequestAttempt<T>(
  path: string,
  init: APIRequestInit,
  allowRefresh: boolean,
  requestSession: WebSession | null,
): Promise<T> {
  const session = readSession();
  if (requestSession && !sameSessionIdentity(session, requestSession)) throw sessionChangedError();
  if (init.authenticated && !session) requireLogin();
  const ownerSession = requestSession ?? session;
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Spott-Device-Id", deviceId());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  if (init.ifMatch !== undefined) headers.set("If-Match", `\"${init.ifMatch}\"`);

  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, credentials: "include" });
  if (response.status === 401 && session && path !== "/auth/refresh") {
    if (allowRefresh) {
      const latestSession = readSession();
      if (ownerSession && !sameSessionIdentity(latestSession, ownerSession)) throw sessionChangedError();
      if (latestSession && !sameSessionSnapshot(latestSession, session)) {
        return apiRequestAttempt<T>(path, init, false, ownerSession);
      }
      if (latestSession) {
        const refreshed = await refreshSessionOnce(latestSession);
        if (ownerSession && !sameSessionIdentity(readSession(), ownerSession)) throw sessionChangedError();
        if (refreshed) return apiRequestAttempt<T>(path, init, false, ownerSession);
      }
    } else {
      clearSessionIfCurrent(session);
    }
  }
  if (!response.ok) {
    let body: APIErrorBody = {};
    try {
      const payload = (await response.json()) as APIErrorBody & { error?: APIErrorBody };
      body = payload.error ?? payload;
    } catch {
      body = { message: `请求失败（${response.status}）` };
    }
    throw new APIError(response.status, body);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

async function refreshSession(session: WebSession): Promise<WebSession | null> {
  const response = await fetch(`${apiBase()}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Spott-Device-Id": deviceId() },
    body: JSON.stringify({ refreshToken: session.refreshToken, deviceId: deviceId() }),
  });
  if (!response.ok) {
    const currentSession = readSession();
    if (!sameSessionSnapshot(currentSession, session) && sameSessionIdentity(currentSession, session)) {
      return currentSession;
    }
    clearSessionIfCurrent(session);
    return null;
  }
  const refreshed = (await response.json()) as WebSession;
  const currentSession = readSession();
  if (!sameSessionSnapshot(currentSession, session)) {
    return sameSessionIdentity(currentSession, session) ? currentSession : null;
  }
  if (!sameSessionIdentity(refreshed, session)) return null;
  saveSession(refreshed);
  return refreshed;
}

function refreshSessionOnce(session: WebSession): Promise<WebSession | null> {
  const generation = `${session.user.id}:${session.sessionId}:${session.refreshToken}`;
  let refresh = refreshesInFlight.get(generation);
  if (!refresh) {
    refresh = refreshSession(session).finally(() => {
      refreshesInFlight.delete(generation);
    });
    refreshesInFlight.set(generation, refresh);
  }
  return refresh;
}

export async function refreshCurrentSession(): Promise<WebSession | null> {
  const session = readSession();
  return session ? refreshSessionOnce(session) : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "操作没有成功，请稍后再试。";
}
