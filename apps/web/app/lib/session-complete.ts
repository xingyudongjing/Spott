import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';

import { handleSessionBootstrap } from './session-bootstrap';
import {
  clearLoginIntentCookie,
  encodeLoginIntentEnvelope,
  issueLoginIntentCookie,
  parseDeviceBindingEnvelope,
  parseLoginIntentEnvelope,
  terminalSessionCookieClears,
  type LoginIntentEnvelopeClaims,
} from './session-cookie-codec';
import { parseAuthoritativeSessionCookieHeader } from './session-cookie-header';
import { validateSessionMutationRequest } from './session-request-security';
import { parseSessionServerConfig, type SessionServerConfig } from './session-server-config';
import { createWebBFFAuthorityHeaders } from './web-bff-authority';

const canonicalUUIDSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const browserCompletionSchema = z.object({
  credential: z.object({
    provider: z.literal('email'),
    challengeId: canonicalUUIDSchema,
    code: z.string().regex(/^[0-9]{6}$/u),
  }).strict(),
  deviceId: canonicalUUIDSchema,
  attemptId: canonicalUUIDSchema.optional(),
}).strict();
const upstreamCompletionSchema = z.object({
  state: z.literal('pending'),
  sessionId: canonicalUUIDSchema,
  bindingId: canonicalUUIDSchema,
  deviceId: canonicalUUIDSchema,
}).strict();

const completionPath = '/v1/auth/web/complete';
const maximumBrowserBodyLength = 4_096;
const maximumUpstreamResponseLength = 65_536;
const reconciliationSeconds = 2_678_400;
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;

export interface SessionCompleteDependencies {
  readonly loadConfig: () => SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly timeoutSignal: () => AbortSignal;
  readonly randomUUID: () => string;
  readonly randomSecret: () => string;
}

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
  return jsonResponse({ error: { code: 'SESSION_COMPLETION_UNAVAILABLE', retryable: true } }, 503);
}

function inProgress(): Response {
  return jsonResponse({ error: { code: 'SESSION_COMPLETION_IN_PROGRESS', retryable: true } }, 409);
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

function reauthenticationRequired(): Response {
  return jsonResponse(
    { error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false } },
    401,
    terminalSessionCookieClears(),
  );
}

function invalidCredential(status: number): Response {
  return jsonResponse({
    error: {
      code: status === 429 ? 'OTP_RATE_LIMITED' : 'AUTH_CHALLENGE_UNAVAILABLE',
      retryable: false,
    },
  }, status === 429 ? 429 : 401);
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

async function parseBrowserCompletion(request: Request): Promise<z.infer<typeof browserCompletionSchema> | null> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return null;
  const text = await readBoundedUTF8(
    request.body,
    request.headers.get('content-length'),
    maximumBrowserBodyLength,
  );
  if (text === null) return null;
  try {
    const parsed = browserCompletionSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function completionReady(intent: LoginIntentEnvelopeClaims): Response {
  return jsonResponse({
    state: 'completion_ready',
    attemptId: intent.attemptId,
    expiresAt: intent.expiresAt,
  }, 202);
}

function completionPending(intent: LoginIntentEnvelopeClaims): Response {
  if (intent.phase !== 'reconcile' || intent.sessionId === null) return unavailable();
  return jsonResponse({
    state: 'completion_pending',
    attemptId: intent.attemptId,
    sessionId: intent.sessionId,
    bindingId: intent.bindingId,
    deviceId: intent.deviceId,
    reconcileExpiresAt: intent.expiresAt,
  });
}

function createPrepareIntent(
  input: z.infer<typeof browserCompletionSchema>,
  config: SessionServerConfig,
  now: number,
  dependencies: Partial<SessionCompleteDependencies>,
): LoginIntentEnvelopeClaims | null {
  try {
    const intent: LoginIntentEnvelopeClaims = {
      purpose: 'login_intent',
      audience: config.canonicalOrigin,
      phase: 'prepare',
      challengeId: input.credential.challengeId,
      deviceId: input.deviceId,
      attemptId: (dependencies.randomUUID ?? randomUUID)(),
      sessionId: null,
      bindingId: (dependencies.randomUUID ?? randomUUID)(),
      bindingGeneration: 0,
      bindingSecret: (dependencies.randomSecret ?? (() => randomBytes(32).toString('base64url')))(),
      issuedAt: now,
      expiresAt: now + config.recoverySeconds * 1_000,
    };
    encodeLoginIntentEnvelope(intent, config);
    return intent;
  } catch {
    return null;
  }
}

async function completeThroughUpstream(
  input: z.infer<typeof browserCompletionSchema>,
  intent: LoginIntentEnvelopeClaims,
  config: SessionServerConfig,
  requestTime: number,
  dependencies: Partial<SessionCompleteDependencies>,
): Promise<Response> {
  const upstreamBody = JSON.stringify({
    credential: input.credential,
    deviceId: input.deviceId,
    attemptId: intent.attemptId,
    newBinding: {
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
      path: completionPath,
      body: new TextEncoder().encode(upstreamBody),
    });
    upstream = await (dependencies.fetch ?? globalThis.fetch)(
      `${config.apiInternalURL}/auth/web/complete`,
      {
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
        signal: (dependencies.timeoutSignal ?? (() => AbortSignal.timeout(3_000)))(),
      },
    );
  } catch {
    return unavailable();
  }
  if (upstream.status >= 400 && upstream.status < 500) return invalidCredential(upstream.status);
  if (upstream.status !== 200) return unavailable();
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return unavailable();
  const text = await readBoundedUTF8(
    upstream.body,
    upstream.headers.get('content-length'),
    maximumUpstreamResponseLength,
  );
  if (text === null) return unavailable();
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return unavailable();
  }
  const parsed = upstreamCompletionSchema.safeParse(value);
  if (
    !parsed.success
    || parsed.data.bindingId !== intent.bindingId
    || parsed.data.deviceId !== intent.deviceId
  ) return unavailable();

  const reconcileExpiresAt = requestTime + reconciliationSeconds * 1_000;
  const reconcileIntent: LoginIntentEnvelopeClaims = {
    ...intent,
    phase: 'reconcile',
    sessionId: parsed.data.sessionId,
    expiresAt: reconcileExpiresAt,
  };
  let envelope: string;
  try {
    envelope = encodeLoginIntentEnvelope(reconcileIntent, config);
  } catch {
    return unavailable();
  }
  return jsonResponse({
    state: 'completion_pending',
    attemptId: intent.attemptId,
    sessionId: parsed.data.sessionId,
    bindingId: parsed.data.bindingId,
    deviceId: parsed.data.deviceId,
    reconcileExpiresAt,
  }, 200, [issueLoginIntentCookie(envelope, reconciliationSeconds)]);
}

export async function handleSessionComplete(
  request: Request,
  dependencies: Partial<SessionCompleteDependencies> = {},
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
  const input = await parseBrowserCompletion(request);
  if (input === null) {
    return jsonResponse({ error: { code: 'SESSION_COMPLETION_REQUEST_INVALID', retryable: false } }, 400);
  }
  if (cookies.loginIntentEnvelope.kind === 'invalid') return invalidIntent(true);

  const currentTime = (dependencies.now ?? Date.now)();
  if (!Number.isSafeInteger(currentTime) || currentTime < 0) return unavailable();
  const intent = cookies.loginIntentEnvelope.kind === 'value'
    ? parseLoginIntentEnvelope(cookies.loginIntentEnvelope.value, config, currentTime)
    : null;
  if (cookies.loginIntentEnvelope.kind === 'value' && intent === null) return invalidIntent(true);

  const persistentInvalid = cookies.refreshEnvelope.kind === 'invalid'
    || cookies.deviceBindingEnvelope.kind === 'invalid'
    || (cookies.refreshEnvelope.kind === 'value') !== (cookies.deviceBindingEnvelope.kind === 'value');
  if (persistentInvalid) {
    return intent === null ? reauthenticationRequired() : inProgress();
  }
  const hasPersistentPair = cookies.refreshEnvelope.kind === 'value'
    && cookies.deviceBindingEnvelope.kind === 'value';

  if (intent === null) {
    if (input.attemptId !== undefined) return invalidIntent();
    if (hasPersistentPair) {
      const binding = parseDeviceBindingEnvelope(
        cookies.deviceBindingEnvelope.kind === 'value' ? cookies.deviceBindingEnvelope.value : null,
        config,
        currentTime,
      );
      if (binding === null || binding.deviceId !== input.deviceId) return reauthenticationRequired();
      return handleSessionBootstrap(request, {
        loadConfig: () => config,
        fetch: dependencies.fetch,
        now: () => currentTime,
        timeoutSignal: dependencies.timeoutSignal,
      });
    }
    const created = createPrepareIntent(input, config, currentTime, dependencies);
    if (created === null) return unavailable();
    let envelope: string;
    try {
      envelope = encodeLoginIntentEnvelope(created, config);
    } catch {
      return unavailable();
    }
    return jsonResponse({
      state: 'completion_ready',
      attemptId: created.attemptId,
      expiresAt: created.expiresAt,
    }, 202, [issueLoginIntentCookie(envelope, config.recoverySeconds)]);
  }

  if (hasPersistentPair) return inProgress();
  const exactCandidate = input.credential.challengeId === intent.challengeId
    && input.deviceId === intent.deviceId;
  if (input.attemptId === undefined) {
    return exactCandidate && intent.phase === 'prepare' ? completionReady(intent) : inProgress();
  }
  if (!exactCandidate || input.attemptId !== intent.attemptId) return invalidIntent();
  if (intent.phase === 'reconcile') return completionPending(intent);
  return completeThroughUpstream(input, intent, config, currentTime, dependencies);
}
