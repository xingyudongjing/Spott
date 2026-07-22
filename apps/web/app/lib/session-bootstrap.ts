import { z } from 'zod';

import {
  parseDeviceBindingEnvelope,
  parseRefreshEnvelope,
  terminalSessionCookieClears,
} from './session-cookie-codec';
import { parseSessionCookieHeader } from './session-cookie-header';
import { parseSessionServerConfig, type SessionServerConfig } from './session-server-config';
import { createWebBFFAuthorityHeaders } from './web-bff-authority';

const upstreamAuthSessionSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    accessTokenExpiresAt: z.iso.datetime({ offset: true }),
    refreshToken: z.string().min(1).max(512),
    refreshGeneration: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    sessionId: z.string().uuid(),
    user: z
      .object({
        id: z.string().uuid(),
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

const bootstrapPath = '/v1/auth/bootstrap';
const maximumUpstreamResponseLength = 65_536;
const maximumUpstreamProblemLength = 1_024;
const problemContentTypePattern = /^application\/problem\+json(?:\s*;\s*charset=utf-8)?$/iu;

export interface SessionBootstrapDependencies {
  readonly loadConfig: () => SessionServerConfig;
  readonly fetch: typeof globalThis.fetch;
  readonly now: () => number;
  readonly timeoutSignal: () => AbortSignal;
}

const responseHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  Vary: 'Cookie',
} as const;
function jsonResponse(body: unknown, status = 200, cookies: readonly string[] = []): Response {
  const headers = new Headers(responseHeaders);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return Response.json(body, { status, headers });
}

function reauthenticationRequired(): Response {
  return jsonResponse(
    { error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false } },
    401,
    terminalSessionCookieClears(),
  );
}

function bootstrapUnavailable(): Response {
  return jsonResponse({ error: { code: 'SESSION_BOOTSTRAP_UNAVAILABLE', retryable: true } }, 503);
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

async function tokenExpiredProblem(upstream: Response): Promise<boolean> {
  if (upstream.status !== 401) return false;
  const contentType = upstream.headers.get('content-type');
  if (contentType === null || !problemContentTypePattern.test(contentType)) return false;
  const text = await readBoundedUTF8(
    upstream.body,
    upstream.headers.get('content-length'),
    maximumUpstreamProblemLength,
  );
  if (text === null) return false;
  try {
    const parsed = upstreamProblemSchema.safeParse(JSON.parse(text) as unknown);
    return parsed.success && parsed.data.error.code === 'TOKEN_EXPIRED';
  } catch {
    return false;
  }
}

export async function handleSessionBootstrap(
  request: Request,
  dependencies: Partial<SessionBootstrapDependencies> = {},
): Promise<Response> {
  const cookies = parseSessionCookieHeader(request.headers.get('cookie'));
  if (cookies.kind === 'logout_intent_present') {
    return jsonResponse({ error: { code: 'LOGOUT_PENDING', retryable: true } }, 409);
  }
  if (cookies.kind === 'invalid') {
    return reauthenticationRequired();
  }
  const hasRefresh = cookies.refreshEnvelope !== null;
  const hasDeviceBinding = cookies.deviceBindingEnvelope !== null;
  if (!hasRefresh && !hasDeviceBinding) {
    return jsonResponse({ state: 'anonymous' });
  }
  if (hasRefresh !== hasDeviceBinding) {
    return reauthenticationRequired();
  }

  let config: SessionServerConfig;
  try {
    config = (dependencies.loadConfig ?? (() => parseSessionServerConfig(process.env)))();
  } catch {
    return bootstrapUnavailable();
  }
  const now = (dependencies.now ?? Date.now)();
  const refresh = parseRefreshEnvelope(cookies.refreshEnvelope, config, now);
  const binding = parseDeviceBindingEnvelope(cookies.deviceBindingEnvelope, config, now);
  if (
    refresh === null ||
    binding === null ||
    refresh.sessionId !== binding.sessionId ||
    refresh.persistentBindingId !== binding.bindingId ||
    refresh.persistentBindingGeneration !== binding.generation ||
    refresh.expiresAt > binding.expiresAt
  ) {
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
      path: bootstrapPath,
      body: new TextEncoder().encode(upstreamBody),
    });
    upstream = await (dependencies.fetch ?? globalThis.fetch)(
      `${config.apiInternalURL}/auth/bootstrap`,
      {
        method: 'POST',
        body: upstreamBody,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
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
    return bootstrapUnavailable();
  }

  if (await tokenExpiredProblem(upstream)) return reauthenticationRequired();
  if (upstream.status !== 200 && upstream.status !== 201) return bootstrapUnavailable();
  const contentType = upstream.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') return bootstrapUnavailable();

  let upstreamValue: unknown;
  try {
    const text = await upstream.text();
    if (text.length === 0 || text.length > maximumUpstreamResponseLength) {
      return bootstrapUnavailable();
    }
    upstreamValue = JSON.parse(text) as unknown;
  } catch {
    return bootstrapUnavailable();
  }
  const parsed = upstreamAuthSessionSchema.safeParse(upstreamValue);
  if (!parsed.success || Date.parse(parsed.data.accessTokenExpiresAt) <= now) {
    return bootstrapUnavailable();
  }
  if (
    parsed.data.sessionId !== refresh.sessionId ||
    parsed.data.user.id !== binding.userId ||
    parsed.data.refreshGeneration !== refresh.generation ||
    parsed.data.refreshToken !== refresh.refreshToken
  ) {
    return reauthenticationRequired();
  }

  return jsonResponse({
    state: 'authenticated',
    accessToken: parsed.data.accessToken,
    accessTokenExpiresAt: parsed.data.accessTokenExpiresAt,
    refreshGeneration: parsed.data.refreshGeneration,
    sessionId: parsed.data.sessionId,
    user: parsed.data.user,
  });
}
