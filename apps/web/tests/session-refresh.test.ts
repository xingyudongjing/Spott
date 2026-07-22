import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import {
  deriveUpstreamRefreshAttemptId,
  handleSessionRefresh,
} from '../app/lib/session-refresh';
import {
  encodeDeviceBindingEnvelope,
  encodeRefreshEnvelope,
  parseRefreshEnvelope,
  type DeviceBindingEnvelopeClaims,
  type RefreshEnvelopeClaims,
} from '../app/lib/session-cookie-codec';
import { parseSessionServerConfig } from '../app/lib/session-server-config';
import { signWebBFFAuthority } from '../app/lib/web-bff-authority';

const now = 1_784_246_400_000;
const oldKey = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');
const newKey = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64url');
const sharedEnvironment = {
  NODE_ENV: 'test',
  SPOTT_WEB_BFF_KEYS: `bff-old:${oldKey},bff-new:${newKey}`,
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.example',
  API_INTERNAL_URL: 'http://api.internal:4100/v1',
  WEB_SESSION_RECOVERY_SECONDS: '120',
} as const;
const oldConfig = parseSessionServerConfig({
  ...sharedEnvironment,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-old',
});
const rotatedConfig = parseSessionServerConfig({
  ...sharedEnvironment,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-new',
});
const sessionId = '11111111-1111-4111-8111-111111111111';
const familyId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const deviceId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const callerAttemptId = '66666666-6666-4666-8666-666666666666';
const bindingGeneration = 2;
const refreshGeneration = 3;
const refreshToken = `s2.${sessionId}.${refreshGeneration}.${Buffer.alloc(32, 0x41).toString('base64url')}`;
const successorToken = `s2.${sessionId}.${refreshGeneration + 1}.${Buffer.alloc(32, 0x43).toString('base64url')}`;
const refreshClaims: RefreshEnvelopeClaims = {
  purpose: 'refresh',
  audience: oldConfig.canonicalOrigin,
  refreshToken,
  sessionId,
  familyId,
  generation: refreshGeneration,
  transportClass: 'web_bff',
  persistentBindingId: bindingId,
  persistentBindingGeneration: bindingGeneration,
  bffAttemptKid: 'bff-old',
  issuedAt: now - 1_000,
  expiresAt: now + 2_500_000_000,
};
const bindingClaims: DeviceBindingEnvelopeClaims = {
  purpose: 'device_binding',
  audience: oldConfig.canonicalOrigin,
  bindingId,
  deviceId,
  userId,
  sessionId,
  generation: bindingGeneration,
  secret: Buffer.alloc(32, 0x42).toString('base64url'),
  issuedAt: now - 1_000,
  expiresAt: now + 2_600_000_000,
};
const validUpstreamSession = {
  accessToken: 'header.payload.signature',
  accessTokenExpiresAt: new Date(now + 900_000).toISOString(),
  refreshToken: successorToken,
  refreshGeneration: refreshGeneration + 1,
  sessionId,
  user: {
    id: userId,
    publicHandle: 'city-walker',
    phoneVerified: true,
    restrictions: ['postingLimited'],
  },
};
const validBrowserRefresh = {
  attemptId: callerAttemptId,
  expectedSessionId: sessionId,
  expectedUserId: userId,
  expectedRefreshGeneration: refreshGeneration,
} as const;

function sessionCookies(
  refresh: RefreshEnvelopeClaims = refreshClaims,
  binding: DeviceBindingEnvelopeClaims = bindingClaims,
): string {
  return (
    `__Host-spott_refresh=${encodeRefreshEnvelope(refresh, oldConfig)}; `
    + `__Host-spott_device_binding=${encodeDeviceBindingEnvelope(binding, oldConfig)}`
  );
}

function browserRequest(options: {
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Request {
  return new Request('https://spott.example/api/session/refresh', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: oldConfig.canonicalOrigin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    body: JSON.stringify(options.body ?? validBrowserRefresh),
  });
}

function jsonUpstream(value: unknown, status = 200, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': contentType,
      'set-cookie': 'upstream=must-not-pass; Path=/',
    },
  });
}

function problemUpstream(
  code: string,
  status = 401,
  contentType = 'application/problem+json',
): Response {
  return new Response(JSON.stringify({
    error: {
      code,
      message: 'upstream detail must not pass',
      retryable: false,
    },
  }), {
    status,
    headers: {
      'content-type': contentType,
      'set-cookie': 'upstream=must-not-pass; Path=/',
    },
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

const allSessionCookieNames = [
  '__Host-spott_refresh',
  '__Host-spott_device_binding',
  '__Host-spott_login_intent',
  '__Host-spott_migration_intent',
  '__Host-spott_logout_intent',
] as const;

const allSessionCookieClears = [
  '__Host-spott_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_device_binding=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_migration_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0; Priority=High',
] as const;

function expectAtomicSessionClear(response: Response): void {
  const cookies = setCookies(response);
  expect(cookies).toEqual(allSessionCookieClears);
  expect(new Set(cookies.map((cookie) => cookie.slice(0, cookie.indexOf('=')))))
    .toEqual(new Set(allSessionCookieNames));
}

function cookieValue(setCookieHeaders: readonly string[], name: string): string | undefined {
  const header = setCookieHeaders.find((value) => value.startsWith(`${name}=`));
  return header?.split(';', 1)[0]?.slice(name.length + 1);
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('vary')).toBe('Cookie, Origin');
}

describe('same-origin Web session refresh', () => {
  test('derives a deterministic RFC 4122 UUID from the pinned KID, token hash, caller attempt, and binding/session context', () => {
    const first = deriveUpstreamRefreshAttemptId({
      config: oldConfig,
      refresh: refreshClaims,
      binding: bindingClaims,
      callerAttemptId,
    });
    const afterCurrentKidChange = deriveUpstreamRefreshAttemptId({
      config: rotatedConfig,
      refresh: refreshClaims,
      binding: bindingClaims,
      callerAttemptId,
    });

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(first).toBe(afterCurrentKidChange);
    expect(first).not.toBe(callerAttemptId);
    expect(deriveUpstreamRefreshAttemptId({
      config: oldConfig,
      refresh: refreshClaims,
      binding: bindingClaims,
      callerAttemptId: '77777777-7777-4777-8777-777777777777',
    })).not.toBe(first);
    expect(deriveUpstreamRefreshAttemptId({
      config: oldConfig,
      refresh: refreshClaims,
      binding: { ...bindingClaims, secret: Buffer.alloc(32, 0x44).toString('base64url') },
      callerAttemptId,
    })).not.toBe(first);
    expect(deriveUpstreamRefreshAttemptId({
      config: oldConfig,
      refresh: {
        ...refreshClaims,
        refreshToken: `s2.${sessionId}.${refreshGeneration}.${Buffer.alloc(32, 0x45).toString('base64url')}`,
      },
      binding: bindingClaims,
      callerAttemptId,
    })).not.toBe(first);
  });

  test.each([
    ['missing Origin', { origin: '' }],
    ['cross-site Origin', { origin: 'https://evil.example' }],
    ['cross-site fetch site', { 'sec-fetch-site': 'cross-site' }],
    ['navigate mode', { 'sec-fetch-mode': 'navigate' }],
    ['no-cors mode', { 'sec-fetch-mode': 'no-cors' }],
    ['non-empty destination', { 'sec-fetch-dest': 'document' }],
  ])('rejects %s before reading session credentials or calling upstream', async (_label, headers) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionRefresh(browserRequest({
      cookie: sessionCookies(),
      headers,
    }), {
      loadConfig: () => oldConfig,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
    expectPrivateResponse(response);
  });

  test.each([
    ['missing both', undefined],
    ['refresh only', sessionCookies().split('; ', 1)[0]],
    ['binding only', sessionCookies().split('; ', 2)[1]],
    ['duplicate refresh', `${sessionCookies()}; ${sessionCookies().split('; ', 1)[0]}`],
    ['tampered MAC', `${sessionCookies()}x`],
  ])('atomically clears every session Cookie for invalid session Cookie state: %s', async (_label, cookie) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionRefresh(browserRequest({ cookie }), {
      loadConfig: () => oldConfig,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectAtomicSessionClear(response);
  });

  test.each([
    ['session', { sessionId: '88888888-8888-4888-8888-888888888888' }],
    ['binding ID', { bindingId: '88888888-8888-4888-8888-888888888888' }],
    ['binding generation', { generation: bindingGeneration + 1 }],
  ])('clears credentials before upstream for cross-Cookie %s disagreement', async (_label, bindingChange) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionRefresh(browserRequest({
      cookie: sessionCookies(refreshClaims, { ...bindingClaims, ...bindingChange }),
    }), {
      loadConfig: () => oldConfig,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectAtomicSessionClear(response);
  });

  test.each([
    ['non-JSON', { 'content-type': 'text/plain' }, { attemptId: callerAttemptId }],
    ['missing attempt', {}, {}],
    ['non-UUID attempt', {}, { attemptId: 'not-a-uuid' }],
    ['uppercase attempt', {}, { attemptId: 'a6666666-6666-4666-8666-666666666666'.toUpperCase() }],
    ['nil attempt', {}, { attemptId: '00000000-0000-0000-0000-000000000000' }],
    ['browser upstream key injection', {}, { attemptId: callerAttemptId, idempotencyKey: callerAttemptId }],
  ])('rejects strict browser body: %s', async (_label, headers, body) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionRefresh(browserRequest({
      cookie: sessionCookies(),
      headers,
      body,
    }), {
      loadConfig: () => oldConfig,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REFRESH_REQUEST_INVALID', retryable: false },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test('uses only verified Cookie authority in one signed upstream rotation and exposes no refresh or proof', async () => {
    const fetchUpstream = vi.fn(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      void input;
      void init;
      return jsonUpstream(validUpstreamSession);
    });
    const browser = browserRequest({
      cookie: sessionCookies(),
      headers: {
        authorization: 'Bearer browser-supplied',
        'x-spott-bff-signature': 'browser-supplied',
        'x-forwarded-host': 'evil.example',
      },
    });
    const response = await handleSessionRefresh(browser, {
      loadConfig: () => rotatedConfig,
      fetch: fetchUpstream,
      now: () => now,
      timeoutSignal: () => AbortSignal.timeout(3_000),
    });

    expect(response.status).toBe(200);
    const browserBody = await response.json();
    expect(browserBody).toEqual({
      state: 'authenticated',
      accessToken: validUpstreamSession.accessToken,
      accessTokenExpiresAt: validUpstreamSession.accessTokenExpiresAt,
      refreshGeneration: refreshGeneration + 1,
      sessionId,
      user: validUpstreamSession.user,
    });
    expect(JSON.stringify(browserBody)).not.toContain(refreshToken);
    expect(JSON.stringify(browserBody)).not.toContain(successorToken);
    expect(JSON.stringify(browserBody)).not.toContain(bindingClaims.secret);
    expectPrivateResponse(response);

    expect(fetchUpstream).toHaveBeenCalledOnce();
    const [url, init] = fetchUpstream.mock.calls[0] ?? [];
    expect(url).toBe('http://api.internal:4100/v1/auth/refresh');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'omit',
      redirect: 'error',
      cache: 'no-store',
    });
    const upstreamHeaders = new Headers(init?.headers);
    expect([...upstreamHeaders.keys()].sort()).toEqual([
      'accept',
      'content-type',
      'idempotency-key',
      'x-spott-bff-kid',
      'x-spott-bff-nonce',
      'x-spott-bff-signature',
      'x-spott-bff-timestamp',
      'x-spott-bff-version',
      'x-spott-device-id',
    ]);
    for (const forbidden of ['authorization', 'cookie', 'origin', 'x-forwarded-host']) {
      expect(upstreamHeaders.has(forbidden)).toBe(false);
    }
    const expectedAttempt = deriveUpstreamRefreshAttemptId({
      config: rotatedConfig,
      refresh: refreshClaims,
      binding: bindingClaims,
      callerAttemptId,
    });
    expect(upstreamHeaders.get('idempotency-key')).toBe(expectedAttempt);
    expect(upstreamHeaders.get('idempotency-key')).not.toBe(callerAttemptId);
    expect(upstreamHeaders.get('x-spott-device-id')).toBe(deviceId);

    const upstreamBody = String(init?.body);
    expect(JSON.parse(upstreamBody)).toEqual({
      refreshToken,
      deviceId,
      deviceBindingProof: {
        bindingId,
        generation: bindingGeneration,
        proof: bindingClaims.secret,
        proofClass: 'persistent',
      },
      refreshEnvelopeClaims: {
        sessionId,
        familyId,
        generation: refreshGeneration,
        transportClass: 'web_bff',
        persistentBindingId: bindingId,
        persistentBindingGeneration: bindingGeneration,
      },
    });
    const expectedSignature = signWebBFFAuthority({
      keyring: rotatedConfig.bffKeys,
      version: 'v1',
      kid: upstreamHeaders.get('x-spott-bff-kid') ?? '',
      method: 'POST',
      path: '/v1/auth/refresh',
      timestamp: Number(upstreamHeaders.get('x-spott-bff-timestamp')),
      nonce: upstreamHeaders.get('x-spott-bff-nonce') ?? '',
      bodyHash: createHash('sha256').update(upstreamBody).digest('hex'),
    });
    expect(upstreamHeaders.get('x-spott-bff-signature')).toBe(expectedSignature);

    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toContain('__Host-spott_refresh=');
    expect(cookies[0]).not.toContain('__Host-spott_device_binding=');
    const encodedSuccessor = cookieValue(cookies, '__Host-spott_refresh');
    const successor = parseRefreshEnvelope(encodedSuccessor, rotatedConfig, now);
    expect(successor).toEqual({
      ...refreshClaims,
      refreshToken: successorToken,
      generation: refreshGeneration + 1,
      bffAttemptKid: 'bff-new',
      issuedAt: now,
    });
  });

  test('bootstraps an already-installed successor instead of rotating it again during response-loss recovery', async () => {
    const successorRefresh = {
      ...refreshClaims,
      refreshToken: successorToken,
      generation: refreshGeneration + 1,
      issuedAt: now,
    };
    const fetchUpstream = vi.fn(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ) => {
      expect(String(input)).toBe('http://api.internal:4100/v1/auth/bootstrap');
      expect(new Headers(init?.headers).has('idempotency-key')).toBe(false);
      return jsonUpstream({
        ...validUpstreamSession,
        refreshToken: successorToken,
        refreshGeneration: refreshGeneration + 1,
      });
    });

    const response = await handleSessionRefresh(browserRequest({
      cookie: sessionCookies(successorRefresh),
      body: validBrowserRefresh,
    }), {
      loadConfig: () => oldConfig,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      state: 'authenticated',
      sessionId,
      refreshGeneration: refreshGeneration + 1,
      user: { id: userId },
    });
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(setCookies(response)).toEqual([]);
    expectPrivateResponse(response);
  });

  test('rejects browser recovery metadata that disagrees with verified Cookie authority', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionRefresh(browserRequest({
      cookie: sessionCookies(),
      body: { ...validBrowserRefresh, expectedUserId: '88888888-8888-4888-8888-888888888888' },
    }), {
      loadConfig: () => oldConfig,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectAtomicSessionClear(response);
  });

  test('pins retry derivation to the predecessor KID even after the current KID changes', async () => {
    const attempts: string[] = [];
    const fetchUpstream = vi.fn(async (_input: unknown, init?: RequestInit) => {
      attempts.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      throw new TypeError('response lost');
    });

    for (const config of [oldConfig, rotatedConfig]) {
      const response = await handleSessionRefresh(browserRequest({ cookie: sessionCookies() }), {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });
      expect(response.status).toBe(503);
      expect(setCookies(response)).toEqual([]);
    }

    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toBe(attempts[1]);
  });

  test.each([
    ['session ID', { sessionId: '88888888-8888-4888-8888-888888888888' }],
    ['user ID', { user: { ...validUpstreamSession.user, id: '88888888-8888-4888-8888-888888888888' } }],
    ['generation skip', { refreshGeneration: refreshGeneration + 2 }],
    ['predecessor token replay', { refreshToken }],
    ['noncanonical successor', { refreshToken: `legacy.${successorToken}` }],
  ])('clears credentials when upstream success violates %s invariants', async (_label, mutation) => {
    const response = await handleSessionRefresh(browserRequest({ cookie: sessionCookies() }), {
      loadConfig: () => oldConfig,
      fetch: vi.fn(async () => jsonUpstream({ ...validUpstreamSession, ...mutation })),
      now: () => now,
    });

    expect(response.status).toBe(401);
    expectAtomicSessionClear(response);
  });

  test.each(['TOKEN_EXPIRED', 'REFRESH_TOKEN_REUSED'])(
    'atomically clears every session Cookie for exact terminal problem %s',
    async (code) => {
      const response = await handleSessionRefresh(browserRequest({ cookie: sessionCookies() }), {
        loadConfig: () => oldConfig,
        fetch: vi.fn(async () => problemUpstream(code)),
        now: () => now,
      });

      expect(response.status).toBe(401);
      expectAtomicSessionClear(response);
    },
  );

  test.each([
    ['validation 400', () => problemUpstream('VALIDATION_FAILED', 400)],
    ['authority 401', () => problemUpstream('WEB_BFF_AUTHORITY_INVALID', 401)],
    ['transport 403', () => problemUpstream('SESSION_TRANSPORT_MISMATCH', 403)],
    ['conflict 409', () => problemUpstream('REQUEST_IN_PROGRESS', 409)],
    ['rate limit 429', () => problemUpstream('RATE_LIMITED', 429)],
    ['terminal code with wrong media', () => problemUpstream('TOKEN_EXPIRED', 401, 'application/json')],
    ['malformed terminal problem', () => new Response('{"error":', {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    })],
  ])('preserves Cookies and durable retry state for non-terminal upstream failure: %s', async (_label, upstream) => {
    const response = await handleSessionRefresh(browserRequest({ cookie: sessionCookies() }), {
      loadConfig: () => oldConfig,
      fetch: vi.fn(async () => upstream()),
      now: () => now,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REFRESH_UNAVAILABLE', retryable: true },
    });
    expect(setCookies(response)).toEqual([]);
  });

  test.each([
    ['network loss', async () => { throw new TypeError('response lost'); }],
    ['upstream 500', async () => jsonUpstream({ secret: successorToken }, 500)],
    ['invalid upstream content type', async () => jsonUpstream(validUpstreamSession, 200, 'text/plain')],
  ])('retains Cookies and attempt recovery material for %s', async (_label, upstream) => {
    const response = await handleSessionRefresh(browserRequest({ cookie: sessionCookies() }), {
      loadConfig: () => oldConfig,
      fetch: vi.fn(upstream) as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REFRESH_UNAVAILABLE', retryable: true },
    });
    expect(setCookies(response)).toEqual([]);
  });
});
