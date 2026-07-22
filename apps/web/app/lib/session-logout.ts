import { z } from 'zod';

import {
  requestServerSessionCompletionDisposition,
  requestServerSessionCompletionRevocation,
} from './session-completion-disposition';
import {
  parseDeviceBindingEnvelope,
  parseLoginIntentEnvelope,
  parseLogoutIntent,
  parseRefreshEnvelope,
  terminalSessionCookieClears,
  type DeviceBindingEnvelopeClaims,
  type LoginIntentEnvelopeClaims,
  type RefreshEnvelopeClaims,
} from './session-cookie-codec';
import { parseAuthoritativeSessionCookieHeader } from './session-cookie-header';
import { validateSessionMutationRequest } from './session-request-security';
import { parseSessionServerConfig, type SessionServerConfig } from './session-server-config';
import { createWebBFFAuthorityHeaders } from './web-bff-authority';

export type SessionLogoutScope = 'current' | 'all';

export interface SessionLogoutDependencies {
  readonly loadConfig: () => SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly timeoutSignal: () => AbortSignal;
}

const maximumUpstreamResponseLength = 1_024;
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const problemContentTypePattern = /^application\/problem\+json(?:\s*;\s*charset=utf-8)?$/iu;
const logoutAllResponseSchema = z.object({
  revokedCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const upstreamProblemSchema = z.object({
  error: z.object({ code: z.string().min(1).max(128) }).passthrough(),
}).strict();
const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie, Origin',
} as const;

interface LogoutAuthority {
  readonly sessionId: string;
  readonly userId: string;
  readonly refreshToken: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly bindingSecret: string;
  readonly familyId: string;
  readonly refreshGeneration: number;
  readonly transportClass: 'web_bff';
}

type PersistentAuthorityResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'authority'; readonly authority: LogoutAuthority };

type AuthorityRevocationResult = 'confirmed' | 'reauthentication-required' | 'unavailable';

function jsonResponse(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers(responseHeaders);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json(body, { status, headers });
}

function unavailable(): Response {
  return jsonResponse({ error: { code: 'SESSION_LOGOUT_UNAVAILABLE', retryable: true } }, 503);
}

function intentRequired(): Response {
  return jsonResponse({ error: { code: 'LOGOUT_INTENT_REQUIRED', retryable: true } }, 409);
}

function invalidRequest(): Response {
  return jsonResponse({ error: { code: 'SESSION_LOGOUT_REQUEST_INVALID', retryable: false } }, 400);
}

function terminalAnonymous(): Response {
  return jsonResponse({ state: 'anonymous' }, 200, terminalSessionCookieClears());
}

function reauthenticationRequired(scope: SessionLogoutScope): Response {
  if (scope === 'all') {
    return jsonResponse(
      { error: { code: 'LOGOUT_ALL_UNCONFIRMED', retryable: false } },
      409,
      terminalSessionCookieClears(),
    );
  }
  return jsonResponse(
    { error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false } },
    401,
    terminalSessionCookieClears(),
  );
}

async function bodyIsEmpty(request: Request): Promise<boolean> {
  const contentLength = request.headers.get('content-length');
  if (request.headers.get('content-type') !== null || (contentLength !== null && contentLength !== '0')) {
    return false;
  }
  if (request.body === null) return true;
  if (contentLength !== '0') return false;
  const reader = request.body.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return true;
      if (next.value.byteLength !== 0) {
        await reader.cancel();
        return false;
      }
    }
  } catch {
    return false;
  } finally {
    reader.releaseLock();
  }
}

function validCookiePair(
  refresh: RefreshEnvelopeClaims,
  binding: DeviceBindingEnvelopeClaims,
): boolean {
  return refresh.sessionId === binding.sessionId
    && refresh.persistentBindingId === binding.bindingId
    && refresh.persistentBindingGeneration === binding.generation
    && refresh.expiresAt <= binding.expiresAt;
}

function persistentAuthority(
  cookies: ReturnType<typeof parseAuthoritativeSessionCookieHeader>,
  config: SessionServerConfig,
  now: number,
): PersistentAuthorityResult {
  if (cookies.refreshEnvelope.kind === 'invalid' || cookies.deviceBindingEnvelope.kind === 'invalid') {
    return { kind: 'invalid' };
  }
  if (cookies.refreshEnvelope.kind === 'absent' && cookies.deviceBindingEnvelope.kind === 'absent') {
    return { kind: 'none' };
  }
  if (cookies.refreshEnvelope.kind !== 'value' || cookies.deviceBindingEnvelope.kind !== 'value') {
    return { kind: 'invalid' };
  }
  const refresh = parseRefreshEnvelope(cookies.refreshEnvelope.value, config, now);
  const binding = parseDeviceBindingEnvelope(cookies.deviceBindingEnvelope.value, config, now);
  if (refresh === null || binding === null || !validCookiePair(refresh, binding)) {
    return { kind: 'invalid' };
  }
  return {
    kind: 'authority',
    authority: {
      sessionId: refresh.sessionId,
      userId: binding.userId,
      refreshToken: refresh.refreshToken,
      deviceId: binding.deviceId,
      bindingId: binding.bindingId,
      bindingGeneration: binding.generation,
      bindingSecret: binding.secret,
      familyId: refresh.familyId,
      refreshGeneration: refresh.generation,
      transportClass: refresh.transportClass,
    },
  };
}

async function readBoundedUTF8(
  body: ReadableStream<Uint8Array> | null,
  contentLengthHeader: string | null,
): Promise<string | null> {
  let declaredLength: number | null = null;
  if (contentLengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLengthHeader)) return null;
    declaredLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumUpstreamResponseLength) return null;
  }
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maximumUpstreamResponseLength) {
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
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function terminalLogoutResponse(upstream: Response, scope: SessionLogoutScope): Promise<boolean> {
  if (scope === 'current') return upstream.status === 204 && upstream.body === null;
  if (upstream.status !== 200) return false;
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return false;
  const text = await readBoundedUTF8(upstream.body, upstream.headers.get('content-length'));
  if (text === null) return false;
  try {
    return logoutAllResponseSchema.safeParse(JSON.parse(text) as unknown).success;
  } catch {
    return false;
  }
}

async function tokenExpiredProblem(upstream: Response): Promise<boolean> {
  if (upstream.status !== 401) return false;
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !problemContentTypePattern.test(contentType)) return false;
  const text = await readBoundedUTF8(upstream.body, upstream.headers.get('content-length'));
  if (text === null) return false;
  try {
    const parsed = upstreamProblemSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success && parsed.data.error.code === 'TOKEN_EXPIRED';
  } catch {
    return false;
  }
}

async function revokeAuthority(input: {
  readonly authority: LogoutAuthority;
  readonly scope: SessionLogoutScope;
  readonly config: SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutSignal: () => AbortSignal;
}): Promise<AuthorityRevocationResult> {
  const { authority, scope, config } = input;
  const upstreamBody = JSON.stringify({
    refreshToken: authority.refreshToken,
    deviceId: authority.deviceId,
    deviceBindingProof: {
      bindingId: authority.bindingId,
      generation: authority.bindingGeneration,
      proof: authority.bindingSecret,
      proofClass: 'persistent',
    },
    refreshEnvelopeClaims: {
      sessionId: authority.sessionId,
      familyId: authority.familyId,
      generation: authority.refreshGeneration,
      transportClass: authority.transportClass,
      persistentBindingId: authority.bindingId,
      persistentBindingGeneration: authority.bindingGeneration,
    },
  });
  const path = scope === 'all' ? '/v1/auth/logout-all' : '/v1/auth/logout';
  let upstream: Response;
  try {
    const signed = createWebBFFAuthorityHeaders({
      config,
      method: 'POST',
      path,
      body: new TextEncoder().encode(upstreamBody),
    });
    upstream = await input.fetch(`${config.apiInternalURL}${path.slice('/v1'.length)}`, {
      method: 'POST',
      body: upstreamBody,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Spott-Device-Id': authority.deviceId,
        ...signed,
      },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: input.timeoutSignal(),
    });
  } catch {
    return 'unavailable';
  }
  if (await terminalLogoutResponse(upstream, scope)) return 'confirmed';
  return await tokenExpiredProblem(upstream)
    ? 'reauthentication-required'
    : 'unavailable';
}

export async function handleSessionLogout(
  request: Request,
  scope: SessionLogoutScope,
  dependencies: Partial<SessionLogoutDependencies> = {},
): Promise<Response> {
  let config: SessionServerConfig;
  try {
    config = (dependencies.loadConfig ?? (() => parseSessionServerConfig(process.env)))();
  } catch {
    return unavailable();
  }
  const requestSecurity = validateSessionMutationRequest(
    Object.fromEntries(request.headers.entries()),
    config.canonicalOrigin,
  );
  if (!requestSecurity.ok) {
    return jsonResponse({ error: { code: requestSecurity.code, retryable: false } }, 403);
  }
  const cookies = parseAuthoritativeSessionCookieHeader(request.headers.get('cookie'));
  const logoutIntent = cookies.logoutIntent.kind === 'value'
    ? parseLogoutIntent(cookies.logoutIntent.value)
    : null;
  if (logoutIntent === null) {
    return intentRequired();
  }
  if (!(await bodyIsEmpty(request))) return invalidRequest();

  const currentTime = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) return unavailable();
  const fetchUpstream = dependencies.fetch ?? globalThis.fetch;
  const timeoutSignal = dependencies.timeoutSignal ?? (() => AbortSignal.timeout(3_000));
  const persistent = persistentAuthority(cookies, config, currentTime);

  let completionIntent: LoginIntentEnvelopeClaims | null = null;
  let completionInvalid = false;
  if (cookies.loginIntentEnvelope.kind === 'value') {
    completionIntent = parseLoginIntentEnvelope(cookies.loginIntentEnvelope.value, config, currentTime);
    completionInvalid = completionIntent === null;
  } else if (cookies.loginIntentEnvelope.kind === 'invalid') {
    completionInvalid = true;
  }

  const authority = persistent.kind === 'authority' ? persistent.authority : null;
  if (completionInvalid) {
    if (authority !== null) {
      const revocation = await revokeAuthority({
        authority,
        scope,
        config,
        fetch: fetchUpstream,
        timeoutSignal,
      });
      if (revocation === 'unavailable') return unavailable();
    }
    return reauthenticationRequired(scope);
  }
  const logoutAllBeforeCompletion = scope === 'all'
    && authority !== null
    && completionIntent?.phase === 'reconcile'
    && completionIntent.sessionId === authority.sessionId;
  let earlyAuthorityRevocation: AuthorityRevocationResult | null = null;
  if (logoutAllBeforeCompletion) {
    earlyAuthorityRevocation = await revokeAuthority({
      authority,
      scope,
      config,
      fetch: fetchUpstream,
      timeoutSignal,
    });
    if (earlyAuthorityRevocation === 'unavailable') return unavailable();
  }

  let completionRevokedSessionId: string | null = null;
  let completionConcreteSessionId: string | null = null;
  if (completionIntent !== null) {
    const disposition = completionIntent.phase === 'prepare'
      ? await requestServerSessionCompletionDisposition({
        operation: 'discard',
        intent: completionIntent,
        config,
        fetch: fetchUpstream,
        timeoutSignal,
        now: currentTime,
      })
      : await requestServerSessionCompletionRevocation({
        intent: completionIntent,
        config,
        fetch: fetchUpstream,
        timeoutSignal,
        now: currentTime,
      });
    if (disposition.kind === 'unavailable' || disposition.kind === 'rejected') return unavailable();
    if (disposition.kind === 'accepted') return unavailable();
    if (disposition.kind === 'revoked') {
      completionRevokedSessionId = disposition.sessionId;
      completionConcreteSessionId = disposition.sessionId;
    } else if (disposition.sessionId !== undefined) {
      completionConcreteSessionId = disposition.sessionId;
    }
  }

  if (persistent.kind === 'invalid') return reauthenticationRequired(scope);
  if (logoutAllBeforeCompletion) {
    return earlyAuthorityRevocation === 'confirmed'
      ? terminalAnonymous()
      : reauthenticationRequired(scope);
  }
  if (
    scope === 'current'
    && authority !== null
    && completionRevokedSessionId === authority.sessionId
  ) {
    return terminalAnonymous();
  }

  if (authority === null) {
    return scope === 'all' && (
      logoutIntent.sessionHint !== undefined
      || completionConcreteSessionId !== null
    )
      ? reauthenticationRequired(scope)
      : terminalAnonymous();
  }
  const revocation = await revokeAuthority({
    authority,
    scope,
    config,
    fetch: fetchUpstream,
    timeoutSignal,
  });
  if (revocation === 'unavailable') return unavailable();
  return revocation === 'confirmed'
    ? terminalAnonymous()
    : reauthenticationRequired(scope);
}
