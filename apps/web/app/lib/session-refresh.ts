import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

import {
  encodeRefreshEnvelope,
  issueRefreshCookie,
  parseDeviceBindingEnvelope,
  parseRefreshEnvelope,
  terminalSessionCookieClears,
  type DeviceBindingEnvelopeClaims,
  type RefreshEnvelopeClaims,
} from './session-cookie-codec';
import { parseSessionCookieHeader } from './session-cookie-header';
import { validateSessionMutationRequest } from './session-request-security';
import { parseSessionServerConfig, type SessionServerConfig } from './session-server-config';
import { createWebBFFAuthorityHeaders } from './web-bff-authority';
import { handleSessionBootstrap } from './session-bootstrap';

const canonicalUUIDSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
const browserRefreshSchema = z.object({
  attemptId: canonicalUUIDSchema,
  expectedSessionId: canonicalUUIDSchema,
  expectedUserId: canonicalUUIDSchema,
  expectedRefreshGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict();
const upstreamRefreshSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    accessTokenExpiresAt: z.iso.datetime({ offset: true }),
    refreshToken: z.string().min(1).max(512),
    refreshGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sessionId: canonicalUUIDSchema,
    user: z
      .object({
        id: canonicalUUIDSchema,
        publicHandle: z.string().min(1).max(128),
        phoneVerified: z.boolean(),
        restrictions: z.array(z.string().min(1).max(128)).max(64),
      })
      .strict(),
  })
  .strict();
const upstreamProblemSchema = z.object({
  error: z.object({ code: z.string().min(1).max(128) }).passthrough(),
}).strict();

const refreshPath = '/v1/auth/refresh';
const refreshAttemptContext = 'spott:web-refresh-attempt:v1';
const maximumBrowserBodyLength = 1_024;
const maximumUpstreamResponseLength = 65_536;
const jsonContentTypePattern = /^application\/json(?:\s*;\s*charset=utf-8)?$/iu;
const problemContentTypePattern = /^application\/problem\+json(?:\s*;\s*charset=utf-8)?$/iu;
const canonicalRefreshSecretPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface SessionRefreshDependencies {
  readonly loadConfig: () => SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly timeoutSignal: () => AbortSignal;
}

export interface RefreshAttemptDerivationInput {
  readonly config: SessionServerConfig;
  readonly refresh: RefreshEnvelopeClaims;
  readonly binding: DeviceBindingEnvelopeClaims;
  readonly callerAttemptId: string;
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
  return jsonResponse({ error: { code: 'SESSION_REFRESH_UNAVAILABLE', retryable: true } }, 503);
}

function reauthenticationRequired(): Response {
  return jsonResponse(
    { error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false } },
    401,
    terminalSessionCookieClears(),
  );
}

function invalidRequest(): Response {
  return jsonResponse(
    { error: { code: 'SESSION_REFRESH_REQUEST_INVALID', retryable: false } },
    400,
  );
}

function frameFields(fields: readonly (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const bytes = typeof field === 'string'
      ? Buffer.from(field.normalize('NFC'), 'utf8')
      : Buffer.from(field);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function uuidFromDigest(digest: Uint8Array): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function deriveUpstreamRefreshAttemptId(input: RefreshAttemptDerivationInput): string {
  const key = input.config.bffKeys.getKey(input.refresh.bffAttemptKid);
  if (key === undefined) throw new Error('Refresh attempt KID is unavailable');
  const tokenHash = createHash('sha256').update(input.refresh.refreshToken, 'utf8').digest();
  const bindingSecretHash = createHash('sha256').update(input.binding.secret, 'utf8').digest();
  const digest = createHmac('sha256', key)
    .update(frameFields([
      refreshAttemptContext,
      tokenHash,
      input.callerAttemptId,
      input.refresh.sessionId,
      input.refresh.familyId,
      String(input.refresh.generation),
      input.refresh.transportClass,
      input.refresh.persistentBindingId,
      String(input.refresh.persistentBindingGeneration),
      input.binding.bindingId,
      input.binding.deviceId,
      input.binding.userId,
      input.binding.sessionId,
      String(input.binding.generation),
      bindingSecretHash,
    ]))
    .digest();
  return uuidFromDigest(digest);
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

async function parseBrowserRefresh(request: Request): Promise<z.infer<typeof browserRefreshSchema> | null> {
  const contentType = request.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return null;
  const text = await readBoundedUTF8(
    request.body,
    request.headers.get('content-length'),
    maximumBrowserBodyLength,
  );
  if (text === null) return null;
  try {
    const parsed = browserRefreshSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function terminalRefreshProblem(upstream: Response): Promise<boolean> {
  if (upstream.status !== 401) return false;
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !problemContentTypePattern.test(contentType)) return false;
  const text = await readBoundedUTF8(
    upstream.body,
    upstream.headers.get('content-length'),
    maximumUpstreamResponseLength,
  );
  if (text === null) return false;
  try {
    const parsed = upstreamProblemSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success
      && (parsed.data.error.code === 'TOKEN_EXPIRED'
        || parsed.data.error.code === 'REFRESH_TOKEN_REUSED');
  } catch {
    return false;
  }
}

function canonicalSuccessorToken(token: string, expectedSessionId: string, expectedGeneration: number): boolean {
  const parts = token.split('.');
  return parts.length === 4
    && parts[0] === 's2'
    && parts[1] === expectedSessionId
    && parts[2] === String(expectedGeneration)
    && canonicalRefreshSecretPattern.test(parts[3] ?? '');
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

export async function handleSessionRefresh(
  request: Request,
  dependencies: Partial<SessionRefreshDependencies> = {},
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

  const cookies = parseSessionCookieHeader(request.headers.get('cookie'));
  if (cookies.kind !== 'parsed' || cookies.refreshEnvelope === null || cookies.deviceBindingEnvelope === null) {
    return reauthenticationRequired();
  }
  const currentTime = (dependencies.now ?? Date.now)();
  const refresh = parseRefreshEnvelope(cookies.refreshEnvelope, config, currentTime);
  const binding = parseDeviceBindingEnvelope(cookies.deviceBindingEnvelope, config, currentTime);
  if (refresh === null || binding === null || !validCookiePair(refresh, binding)) {
    return reauthenticationRequired();
  }

  const browserInput = await parseBrowserRefresh(request);
  if (browserInput === null) return invalidRequest();
  if (
    refresh.sessionId !== browserInput.expectedSessionId
    || binding.userId !== browserInput.expectedUserId
    || refresh.generation < browserInput.expectedRefreshGeneration
    || refresh.generation > browserInput.expectedRefreshGeneration + 1
  ) {
    return reauthenticationRequired();
  }
  if (refresh.generation === browserInput.expectedRefreshGeneration + 1) {
    const recovered = await handleSessionBootstrap(request, {
      loadConfig: () => config,
      fetch: dependencies.fetch,
      now: dependencies.now,
      timeoutSignal: dependencies.timeoutSignal,
    });
    recovered.headers.set('Vary', responseHeaders.Vary);
    return recovered;
  }

  let upstreamAttemptId: string;
  try {
    upstreamAttemptId = deriveUpstreamRefreshAttemptId({
      config,
      refresh,
      binding,
      callerAttemptId: browserInput.attemptId,
    });
  } catch {
    return reauthenticationRequired();
  }
  const upstreamBody = JSON.stringify({
    refreshToken: refresh.refreshToken,
    deviceId: binding.deviceId,
    deviceBindingProof: {
      bindingId: binding.bindingId,
      generation: binding.generation,
      proof: binding.secret,
      proofClass: 'persistent',
    },
    refreshEnvelopeClaims: {
      sessionId: refresh.sessionId,
      familyId: refresh.familyId,
      generation: refresh.generation,
      transportClass: refresh.transportClass,
      persistentBindingId: refresh.persistentBindingId,
      persistentBindingGeneration: refresh.persistentBindingGeneration,
    },
  });

  let upstream: Response;
  try {
    const authority = createWebBFFAuthorityHeaders({
      config,
      method: 'POST',
      path: refreshPath,
      body: new TextEncoder().encode(upstreamBody),
    });
    upstream = await (dependencies.fetch ?? globalThis.fetch)(
      `${config.apiInternalURL}/auth/refresh`,
      {
        method: 'POST',
        body: upstreamBody,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Idempotency-Key': upstreamAttemptId,
          'X-Spott-Device-Id': binding.deviceId,
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

  if (await terminalRefreshProblem(upstream)) return reauthenticationRequired();
  if (upstream.status !== 200 && upstream.status !== 201) return unavailable();
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !jsonContentTypePattern.test(contentType)) return unavailable();
  const text = await readBoundedUTF8(
    upstream.body,
    upstream.headers.get('content-length'),
    maximumUpstreamResponseLength,
  );
  if (text === null) return unavailable();

  let upstreamValue: unknown;
  try {
    upstreamValue = JSON.parse(text) as unknown;
  } catch {
    return unavailable();
  }
  const parsed = upstreamRefreshSchema.safeParse(upstreamValue);
  if (!parsed.success) return unavailable();
  const successor = parsed.data;
  const expectedGeneration = refresh.generation + 1;
  if (
    successor.sessionId !== refresh.sessionId
    || successor.user.id !== binding.userId
    || successor.refreshGeneration !== expectedGeneration
    || successor.refreshToken === refresh.refreshToken
    || !canonicalSuccessorToken(successor.refreshToken, refresh.sessionId, expectedGeneration)
    || Date.parse(successor.accessTokenExpiresAt) <= currentTime
  ) {
    return reauthenticationRequired();
  }

  let successorEnvelope: string;
  try {
    successorEnvelope = encodeRefreshEnvelope({
      ...refresh,
      refreshToken: successor.refreshToken,
      generation: successor.refreshGeneration,
      bffAttemptKid: config.bffKeys.currentKid,
      issuedAt: currentTime,
    }, config);
  } catch {
    return unavailable();
  }

  return jsonResponse({
    state: 'authenticated',
    accessToken: successor.accessToken,
    accessTokenExpiresAt: successor.accessTokenExpiresAt,
    refreshGeneration: successor.refreshGeneration,
    sessionId: successor.sessionId,
    user: successor.user,
  }, 200, [issueRefreshCookie(successorEnvelope)]);
}
