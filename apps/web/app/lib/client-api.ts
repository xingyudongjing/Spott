"use client";

import type { EventView } from "./demo-data";
import {
  bootstrapSession,
  clearSession,
  readSession,
  refreshSessionFor,
  type WebSession,
} from "./session-runtime";
import { deviceId } from "./browser-device-identity";

export {
  abandonEmailSessionSwitch,
  bootstrapSession,
  clearSession,
  completeEmailSession,
  logoutCurrentSession,
  readSession,
  refreshCurrentSession,
  registerEmailSessionSwitch,
  saveSession,
  subscribeSessionChanges,
  type EmailLoginSessionExpectation,
  type SessionUser,
  type WebSession,
} from "./session-runtime";
export {
  DeviceIdentityStorageError,
  deviceId,
  prepareEmailLoginDevice,
  type LoginDevicePlan,
} from "./browser-device-identity";

type APIRequestInit = RequestInit & {
  authenticated?: boolean;
  deviceIdOverride?: string;
  idempotent?: boolean;
  idempotencyKey?: string;
  ifMatch?: number;
};

type SessionGeneration = { readonly marker: symbol };
type SessionState = { session: WebSession | null; generation: SessionGeneration };
type RequestSessionContext = { readonly generation: SessionGeneration };

let observedSessionKey: string | null | undefined;
let observedSessionGeneration: SessionGeneration = { marker: Symbol("spott-session-generation") };

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
      && left?.refreshGeneration === right?.refreshGeneration,
  );
}

function sessionAuthenticationKey(session: WebSession | null): string | null {
  return session
    ? [session.user.id, session.sessionId].join("\u0000")
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
  let initial = currentSessionState();
  if (init.authenticated && !initial.session) {
    await bootstrapSession();
    initial = currentSessionState();
  }
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
  headers.set("X-Spott-Device-Id", init.deviceIdOverride ?? deviceId());
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (session) headers.set("Authorization", `Bearer ${session.accessToken}`);
  if (init.ifMatch !== undefined) headers.set("If-Match", `\"${init.ifMatch}\"`);

  const response = await fetch(`${apiBase()}${path}`, { ...init, headers, credentials: "omit" });
  if (ownerContext) assertRequestSession(ownerContext);
  if (response.status === 401 && session) {
    if (allowRefresh) {
      const latestSession = ownerContext ? assertRequestSession(ownerContext) : readSession();
      if (latestSession && !sameSessionSnapshot(latestSession, session)) {
        return apiRequestAttempt<T>(path, init, false, ownerContext);
      }
      if (latestSession && ownerContext) {
        const refreshed = await refreshSessionFor(latestSession);
        const currentAfterRefresh = assertRequestSession(ownerContext);
        if (refreshed) return apiRequestAttempt<T>(path, init, false, ownerContext);
        if (currentAfterRefresh && !sameSessionSnapshot(currentAfterRefresh, latestSession)) {
          throw sessionChangedError();
        }
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : clientCopy("operationFailed");
}
