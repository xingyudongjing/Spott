import { z } from 'zod';

import {
  clearLoginIntentCookie,
  encodeDeviceBindingEnvelope,
  encodeRefreshEnvelope,
  issueDeviceBindingCookie,
  issueRefreshCookie,
  parseLoginIntentEnvelope,
  type LoginIntentEnvelopeClaims,
} from './session-cookie-codec';
import { parseAuthoritativeSessionCookieHeader } from './session-cookie-header';
import { validateSessionMutationRequest } from './session-request-security';
import { parseSessionServerConfig, type SessionServerConfig } from './session-server-config';
import { createWebBFFAuthorityHeaders } from './web-bff-authority';

const canonicalUUIDSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const browserDispositionSchema = z.object({ attemptId: canonicalUUIDSchema }).strict();
const completionMaterialSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  accessTokenExpiresAt: z.iso.datetime({ offset: true }),
  refreshToken: z.string().min(1).max(512),
  refreshGeneration: z.literal(0),
  sessionId: canonicalUUIDSchema,
  refreshFamilyId: canonicalUUIDSchema,
  refreshTokenExpiresAt: z.iso.datetime({ offset: true }),
  transportClass: z.literal('web_bff'),
  bindingId: canonicalUUIDSchema,
  bindingGeneration: z.literal(0),
  bindingIssuedAt: z.iso.datetime({ offset: true }),
  bindingAbsoluteExpiresAt: z.iso.datetime({ offset: true }),
  user: z.object({
    id: canonicalUUIDSchema,
    publicHandle: z.string().min(1).max(128),
    phoneVerified: z.boolean(),
    restrictions: z.array(z.string().min(1).max(128)).max(64),
  }).strict(),
}).strict();
const acceptedSchema = z.object({
  state: z.literal('accepted'),
  material: completionMaterialSchema,
}).strict();
const discardedSchema = z.object({
  state: z.literal('discarded'),
  sessionId: canonicalUUIDSchema.optional(),
  bindingId: canonicalUUIDSchema,
  deviceId: canonicalUUIDSchema,
}).strict();
const revokedSchema = z.object({
  state: z.literal('revoked'),
  sessionId: canonicalUUIDSchema,
  bindingId: canonicalUUIDSchema,
  deviceId: canonicalUUIDSchema,
}).strict();

const maximumBrowserBodyLength = 4_096;
const maximumUpstreamResponseLength = 65_536;
const maximumUpstreamClockLeadMilliseconds = 5_000;
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const canonicalRefreshSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

export type SessionCompletionDispositionOperation = 'accept' | 'discard';
type ServerSessionCompletionOperation = SessionCompletionDispositionOperation | 'revoke';
export type SessionCompletionMaterial = z.infer<typeof completionMaterialSchema>;

export interface SessionCompletionDispositionDependencies {
  readonly loadConfig: () => SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly timeoutSignal: () => AbortSignal;
}

export type ServerSessionCompletionDisposition =
  | { readonly kind: 'accepted'; readonly material: SessionCompletionMaterial }
  | {
    readonly kind: 'discarded';
    readonly sessionId?: string;
    readonly bindingId: string;
    readonly deviceId: string;
  }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'unavailable' };

export type ServerSessionCompletionRevocation =
  | {
    readonly kind: 'discarded';
    readonly sessionId?: string;
    readonly bindingId: string;
    readonly deviceId: string;
  }
  | {
    readonly kind: 'revoked';
    readonly sessionId: string;
    readonly bindingId: string;
    readonly deviceId: string;
  }
  | { readonly kind: 'rejected'; readonly status: number }
  | { readonly kind: 'unavailable' };

type ServerSessionCompletionResult =
  | ServerSessionCompletionDisposition
  | Extract<ServerSessionCompletionRevocation, { readonly kind: 'revoked' }>;

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie, Origin',
} as const;

function jsonResponse(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers(responseHeaders);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json(body, { status, headers });
}

function unavailable(): Response {
  return jsonResponse({ error: { code: 'SESSION_COMPLETION_DISPOSITION_UNAVAILABLE', retryable: true } }, 503);
}

function logoutPending(): Response {
  return jsonResponse({ error: { code: 'LOGOUT_PENDING', retryable: true } }, 409);
}

function invalidIntent(clear = false): Response {
  return jsonResponse(
    { error: { code: 'SESSION_COMPLETION_INTENT_INVALID', retryable: false } },
    401,
    clear ? [clearLoginIntentCookie()] : [],
  );
}

async function readBoundedUTF8(
  body: ReadableStream<Uint8Array> | null,
  contentLengthHeader: string | null,
  maximumLength: number,
): Promise<string | null> {
  let declaredLength: number | null = null;
  if (contentLengthHeader !== null) {
    if (!/^(0|[1-9][0-9]*)$/u.test(contentLengthHeader)) return null;
    declaredLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumLength) return null;
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
      if (length > maximumLength) {
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

async function parseBrowserDisposition(request: Request): Promise<z.infer<typeof browserDispositionSchema> | null> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return null;
  const text = await readBoundedUTF8(
    request.body,
    request.headers.get('content-length'),
    maximumBrowserBodyLength,
  );
  if (text === null) return null;
  try {
    const parsed = browserDispositionSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function validAcceptedMaterial(
  material: SessionCompletionMaterial,
  intent: LoginIntentEnvelopeClaims,
  now: number,
): boolean {
  const accessExpiresAt = Date.parse(material.accessTokenExpiresAt);
  const refreshExpiresAt = Date.parse(material.refreshTokenExpiresAt);
  const bindingIssuedAt = Date.parse(material.bindingIssuedAt);
  const bindingExpiresAt = Date.parse(material.bindingAbsoluteExpiresAt);
  const refreshParts = material.refreshToken.split('.');
  return intent.phase === 'reconcile'
    && intent.sessionId !== null
    && material.sessionId === intent.sessionId
    && material.bindingId === intent.bindingId
    && Number.isSafeInteger(accessExpiresAt)
    && Number.isSafeInteger(refreshExpiresAt)
    && Number.isSafeInteger(bindingIssuedAt)
    && Number.isSafeInteger(bindingExpiresAt)
    && accessExpiresAt > now
    && refreshExpiresAt > now
    && bindingIssuedAt <= now + maximumUpstreamClockLeadMilliseconds
    && bindingExpiresAt > now
    && bindingIssuedAt < bindingExpiresAt
    && refreshExpiresAt <= bindingExpiresAt
    && refreshParts.length === 4
    && refreshParts[0] === 's2'
    && refreshParts[1] === material.sessionId
    && refreshParts[2] === '0'
    && canonicalRefreshSecretPattern.test(refreshParts[3] ?? '');
}

async function requestServerSessionCompletionOperation(input: {
  readonly operation: ServerSessionCompletionOperation;
  readonly intent: LoginIntentEnvelopeClaims;
  readonly config: SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutSignal: () => AbortSignal;
  readonly now: number;
}): Promise<ServerSessionCompletionResult> {
  const { operation, intent, config } = input;
  const path = `/v1/auth/web/completion-attempts/${intent.attemptId}/${operation}`;
  const upstreamBody = JSON.stringify({
    challengeId: intent.challengeId,
    deviceId: intent.deviceId,
    binding: {
      bindingId: intent.bindingId,
      generation: 0,
      proof: intent.bindingSecret,
      proofClass: 'persistent',
    },
  });
  let upstream: Response;
  try {
    const authority = createWebBFFAuthorityHeaders({
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
        'X-Spott-Device-Id': intent.deviceId,
        ...authority,
      },
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
      signal: input.timeoutSignal(),
    });
  } catch {
    return { kind: 'unavailable' };
  }
  if (upstream.status !== 200) {
    return upstream.status >= 400 && upstream.status < 500
      ? { kind: 'rejected', status: upstream.status }
      : { kind: 'unavailable' };
  }
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return { kind: 'unavailable' };
  const text = await readBoundedUTF8(
    upstream.body,
    upstream.headers.get('content-length'),
    maximumUpstreamResponseLength,
  );
  if (text === null) return { kind: 'unavailable' };
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { kind: 'unavailable' };
  }
  const accepted = acceptedSchema.safeParse(value);
  if (accepted.success) {
    return operation !== 'revoke' && validAcceptedMaterial(accepted.data.material, intent, input.now)
      ? { kind: 'accepted', material: accepted.data.material }
      : { kind: 'unavailable' };
  }
  const revoked = revokedSchema.safeParse(value);
  if (revoked.success) {
    return operation === 'revoke'
      && intent.phase === 'reconcile'
      && intent.sessionId !== null
      && revoked.data.sessionId === intent.sessionId
      && revoked.data.bindingId === intent.bindingId
      && revoked.data.deviceId === intent.deviceId
      ? {
        kind: 'revoked',
        sessionId: revoked.data.sessionId,
        bindingId: revoked.data.bindingId,
        deviceId: revoked.data.deviceId,
      }
      : { kind: 'unavailable' };
  }
  const discarded = discardedSchema.safeParse(value);
  if (
    !discarded.success
    || discarded.data.bindingId !== intent.bindingId
    || discarded.data.deviceId !== intent.deviceId
    || (
      intent.phase === 'reconcile'
      && discarded.data.sessionId !== intent.sessionId
    )
  ) return { kind: 'unavailable' };
  return {
    kind: 'discarded',
    ...(discarded.data.sessionId === undefined ? {} : { sessionId: discarded.data.sessionId }),
    bindingId: discarded.data.bindingId,
    deviceId: discarded.data.deviceId,
  };
}

export async function requestServerSessionCompletionDisposition(input: {
  readonly operation: SessionCompletionDispositionOperation;
  readonly intent: LoginIntentEnvelopeClaims;
  readonly config: SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutSignal: () => AbortSignal;
  readonly now: number;
}): Promise<ServerSessionCompletionDisposition> {
  const result = await requestServerSessionCompletionOperation(input);
  return result.kind === 'revoked' ? { kind: 'unavailable' } : result;
}

export async function requestServerSessionCompletionRevocation(input: {
  readonly intent: LoginIntentEnvelopeClaims;
  readonly config: SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutSignal: () => AbortSignal;
  readonly now: number;
}): Promise<ServerSessionCompletionRevocation> {
  const result = await requestServerSessionCompletionOperation({ ...input, operation: 'revoke' });
  return result.kind === 'accepted' ? { kind: 'unavailable' } : result;
}

function acceptedBrowserResponse(
  material: SessionCompletionMaterial,
  intent: LoginIntentEnvelopeClaims,
  config: SessionServerConfig,
  responseTime: number,
): Response {
  let refreshEnvelope: string;
  let bindingEnvelope: string;
  try {
    refreshEnvelope = encodeRefreshEnvelope({
      purpose: 'refresh',
      audience: config.canonicalOrigin,
      refreshToken: material.refreshToken,
      sessionId: material.sessionId,
      familyId: material.refreshFamilyId,
      generation: 0,
      transportClass: 'web_bff',
      persistentBindingId: material.bindingId,
      persistentBindingGeneration: 0,
      bffAttemptKid: config.bffKeys.currentKid,
      issuedAt: responseTime,
      expiresAt: Date.parse(material.refreshTokenExpiresAt),
    }, config);
    bindingEnvelope = encodeDeviceBindingEnvelope({
      purpose: 'device_binding',
      audience: config.canonicalOrigin,
      bindingId: material.bindingId,
      deviceId: intent.deviceId,
      userId: material.user.id,
      sessionId: material.sessionId,
      generation: 0,
      secret: intent.bindingSecret,
      issuedAt: Math.min(Date.parse(material.bindingIssuedAt), responseTime),
      expiresAt: Date.parse(material.bindingAbsoluteExpiresAt),
    }, config);
  } catch {
    return unavailable();
  }
  return jsonResponse({
    state: 'authenticated',
    accessToken: material.accessToken,
    accessTokenExpiresAt: material.accessTokenExpiresAt,
    refreshGeneration: 0,
    sessionId: material.sessionId,
    user: material.user,
  }, 200, [
    issueRefreshCookie(refreshEnvelope),
    issueDeviceBindingCookie(bindingEnvelope),
    clearLoginIntentCookie(),
  ]);
}

function upstreamFailure(status: number): Response {
  if (status === 400) {
    return jsonResponse({ error: { code: 'SESSION_COMPLETION_DISPOSITION_REQUEST_INVALID', retryable: false } }, 400);
  }
  if (status === 401 || status === 403) {
    return jsonResponse({ error: { code: 'SESSION_COMPLETION_DISPOSITION_REJECTED', retryable: false } }, 401);
  }
  if (status === 409) {
    return jsonResponse({ error: { code: 'SESSION_COMPLETION_DISPOSITION_CONFLICT', retryable: false } }, 409);
  }
  return unavailable();
}

export async function handleSessionCompletionDisposition(
  request: Request,
  operation: SessionCompletionDispositionOperation,
  dependencies: Partial<SessionCompletionDispositionDependencies> = {},
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
  if (cookies.logoutIntent.kind !== 'absent') return logoutPending();
  const browserInput = await parseBrowserDisposition(request);
  if (browserInput === null) {
    return jsonResponse({ error: { code: 'SESSION_COMPLETION_DISPOSITION_REQUEST_INVALID', retryable: false } }, 400);
  }
  if (cookies.loginIntentEnvelope.kind === 'invalid') return invalidIntent(true);
  if (cookies.loginIntentEnvelope.kind !== 'value') return invalidIntent();
  const requestTime = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(requestTime) || requestTime < 0) return unavailable();
  const intent = parseLoginIntentEnvelope(cookies.loginIntentEnvelope.value, config, requestTime);
  if (intent === null) return invalidIntent(true);
  if (browserInput.attemptId !== intent.attemptId) return invalidIntent();
  if (operation === 'accept' && intent.phase !== 'reconcile') {
    return jsonResponse({ error: { code: 'SESSION_COMPLETION_IN_PROGRESS', retryable: true } }, 409);
  }

  const result = await requestServerSessionCompletionDisposition({
    operation,
    intent,
    config,
    fetch: dependencies.fetch ?? globalThis.fetch,
    timeoutSignal: dependencies.timeoutSignal ?? (() => AbortSignal.timeout(3_000)),
    now: requestTime,
  });
  if (result.kind === 'unavailable') return unavailable();
  if (result.kind === 'rejected') return upstreamFailure(result.status);
  if (result.kind === 'accepted') {
    return acceptedBrowserResponse(result.material, intent, config, requestTime);
  }
  return jsonResponse({
    state: 'discarded',
    attemptId: intent.attemptId,
    ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    bindingId: result.bindingId,
    deviceId: result.deviceId,
  }, 200, [clearLoginIntentCookie()]);
}
