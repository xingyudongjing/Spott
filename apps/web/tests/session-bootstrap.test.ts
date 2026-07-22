import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { handleSessionBootstrap } from '../app/lib/session-bootstrap';
import {
  encodeDeviceBindingEnvelope,
  encodeRefreshEnvelope,
  type DeviceBindingEnvelopeClaims,
  type RefreshEnvelopeClaims,
} from '../app/lib/session-cookie-codec';
import { parseSessionServerConfig } from '../app/lib/session-server-config';
import { signWebBFFAuthority } from '../app/lib/web-bff-authority';

const now = 1_784_246_400_000;
const key = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64url');
const config = parseSessionServerConfig({
  NODE_ENV: 'test',
  SPOTT_WEB_BFF_KEYS: `bff-current:${key}`,
  SPOTT_WEB_BFF_CURRENT_KID: 'bff-current',
  SPOTT_WEB_CANONICAL_ORIGIN: 'https://spott.example',
  API_INTERNAL_URL: 'http://api.internal:4100/v1',
  WEB_SESSION_RECOVERY_SECONDS: '120',
});
const sessionId = '11111111-1111-4111-8111-111111111111';
const familyId = '22222222-2222-4222-8222-222222222222';
const bindingId = '33333333-3333-4333-8333-333333333333';
const deviceId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const bindingGeneration = 2;
const refreshToken = `s2.${sessionId}.3.${Buffer.alloc(32, 0x41).toString('base64url')}`;
const refreshClaims: RefreshEnvelopeClaims = {
  purpose: 'refresh' as const,
  audience: config.canonicalOrigin,
  refreshToken,
  sessionId,
  familyId,
  generation: 3,
  transportClass: 'web_bff' as const,
  persistentBindingId: bindingId,
  persistentBindingGeneration: bindingGeneration,
  bffAttemptKid: config.bffKeys.currentKid,
  issuedAt: now - 1_000,
  expiresAt: now + 60_000,
};
const bindingClaims: DeviceBindingEnvelopeClaims = {
  purpose: 'device_binding' as const,
  audience: config.canonicalOrigin,
  bindingId,
  deviceId,
  userId,
  sessionId,
  generation: bindingGeneration,
  secret: Buffer.alloc(32, 0x42).toString('base64url'),
  issuedAt: now - 1_000,
  expiresAt: now + 60_000,
};
const validUpstreamSession = {
  accessToken: 'header.payload.signature',
  accessTokenExpiresAt: new Date(now + 900_000).toISOString(),
  refreshToken,
  refreshGeneration: refreshClaims.generation,
  sessionId,
  user: {
    id: userId,
    publicHandle: 'city-walker',
    phoneVerified: true,
    restrictions: ['postingLimited'],
  },
};

function sessionCookies(
  refresh: RefreshEnvelopeClaims = refreshClaims,
  binding: DeviceBindingEnvelopeClaims = bindingClaims,
): string {
  return (
    `__Host-spott_refresh=${encodeRefreshEnvelope(refresh, config)}; ` +
    `__Host-spott_device_binding=${encodeDeviceBindingEnvelope(binding, config)}`
  );
}

function jsonUpstream(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
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

async function bootstrapWith(fetchUpstream: typeof globalThis.fetch): Promise<Response> {
  return handleSessionBootstrap(request(sessionCookies()), {
    loadConfig: () => config,
    fetch: fetchUpstream,
    now: () => now,
    timeoutSignal: () => AbortSignal.timeout(3_000),
  });
}

async function expectStableError(
  response: Response,
  status: number,
  code: string,
  retryable: boolean,
): Promise<void> {
  expect(response.status).toBe(status);
  await expect(response.json()).resolves.toEqual({ error: { code, retryable } });
  expectPrivateResponse(response);
}

function request(cookie?: string): Request {
  return new Request('https://spott.example/api/session/bootstrap', {
    headers: cookie === undefined ? undefined : { cookie },
  });
}

function expectPrivateResponse(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
  expect(response.headers.get('pragma')).toBe('no-cache');
  expect(response.headers.get('vary')).toBe('Cookie');
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

const allSessionClears = [
  '__Host-spott_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_device_binding=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_migration_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0; Priority=High',
] as const;

function expectNoSetCookies(response: Response): void {
  expect(setCookies(response)).toEqual([]);
}

function expectAtomicSessionClear(response: Response): void {
  expect(setCookies(response)).toEqual(allSessionClears);
}

describe('credentialless session bootstrap', () => {
  test('blocks on any logout-intent presence before configuration, other Cookies, or upstream', async () => {
    const loadConfig = vi.fn(() => {
      throw new Error('must not read configuration');
    });
    const fetchUpstream = vi.fn();

    const response = await handleSessionBootstrap(
      request(
        '__Host-spott_refresh=one; __Host-spott_refresh=two; ' + '__Host-spott_logout_intent=',
      ),
      { loadConfig, fetch: fetchUpstream },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'LOGOUT_PENDING', retryable: true },
    });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectPrivateResponse(response);
    expectNoSetCookies(response);
  });

  test.each([undefined, 'locale=ja; theme=dark'])(
    'returns anonymous without loading secrets when both session Cookies are absent: %s',
    async (cookie) => {
      const loadConfig = vi.fn();
      const fetchUpstream = vi.fn();
      const response = await handleSessionBootstrap(request(cookie), {
        loadConfig,
        fetch: fetchUpstream,
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ state: 'anonymous' });
      expect(loadConfig).not.toHaveBeenCalled();
      expect(fetchUpstream).not.toHaveBeenCalled();
      expectPrivateResponse(response);
      expectNoSetCookies(response);
    },
  );

  test.each([
    '__Host-spott_refresh=refresh',
    '__Host-spott_device_binding=binding',
    '__Host-spott_refresh=one; __Host-spott_refresh=two',
    '__Host-spott_device_binding=one; __Host-spott_device_binding=two',
    '__Host-spott_refresh=; __Host-spott_device_binding=binding',
  ])(
    'requires reauthentication for partial or structurally invalid Cookie state: %s',
    async (cookie) => {
      const loadConfig = vi.fn();
      const fetchUpstream = vi.fn();
      const response = await handleSessionBootstrap(request(cookie), {
        loadConfig,
        fetch: fetchUpstream,
      });

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false },
      });
      expect(loadConfig).not.toHaveBeenCalled();
      expect(fetchUpstream).not.toHaveBeenCalled();
      expectPrivateResponse(response);
      expectAtomicSessionClear(response);
    },
  );

  test('fails safely when server-only configuration is unavailable', async () => {
    const loadConfig = vi.fn(() => {
      throw new Error('missing secret material');
    });
    const fetchUpstream = vi.fn();
    const response = await handleSessionBootstrap(request(sessionCookies()), {
      loadConfig,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_BOOTSTRAP_UNAVAILABLE', retryable: true },
    });
    expect(loadConfig).toHaveBeenCalledOnce();
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectPrivateResponse(response);
    expectNoSetCookies(response);
  });

  test('requires reauthentication when either sealed envelope is invalid', async () => {
    const valid = sessionCookies();
    const separator = valid.indexOf('; ');
    const tampered = `${valid.slice(0, separator)}x${valid.slice(separator)}`;
    const fetchUpstream = vi.fn();
    const response = await handleSessionBootstrap(request(tampered), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectPrivateResponse(response);
    expectAtomicSessionClear(response);
  });

  test.each([
    ['session', bindingId, bindingGeneration, '66666666-6666-4666-8666-666666666666'],
    ['binding ID', '66666666-6666-4666-8666-666666666666', bindingGeneration, sessionId],
    ['binding generation', bindingId, bindingGeneration + 1, sessionId],
  ] as const)(
    'requires reauthentication for cross-Cookie %s disagreement',
    async (_label, changedBindingId, changedGeneration, changedSessionId) => {
      const fetchUpstream = vi.fn();
      const cookie = sessionCookies(refreshClaims, {
        ...bindingClaims,
        bindingId: changedBindingId,
        generation: changedGeneration,
        sessionId: changedSessionId,
      });
      const response = await handleSessionBootstrap(request(cookie), {
        loadConfig: () => config,
        fetch: fetchUpstream,
        now: () => now,
      });

      expect(response.status).toBe(401);
      expect(fetchUpstream).not.toHaveBeenCalled();
      expectPrivateResponse(response);
      expectAtomicSessionClear(response);
    },
  );

  test('rejects a refresh envelope whose lifetime outlasts its persistent binding', async () => {
    const fetchUpstream = vi.fn();
    const cookie = sessionCookies(refreshClaims, {
      ...bindingClaims,
      expiresAt: refreshClaims.expiresAt - 1,
    });
    const response = await handleSessionBootstrap(request(cookie), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expectPrivateResponse(response);
    expectAtomicSessionClear(response);
  });

  test.each([200, 201])(
    'bootstraps through one signed credential-isolated upstream request for status %s and strips refresh authority',
    async (upstreamStatus) => {
      const fetchUpstream = vi.fn(
        async (
          input: Parameters<typeof globalThis.fetch>[0],
          init?: Parameters<typeof globalThis.fetch>[1],
        ) => {
          void input;
          void init;
          return new Response(JSON.stringify(validUpstreamSession), {
            status: upstreamStatus,
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'set-cookie': 'attacker=must-not-pass; Path=/',
            },
          });
        },
      );
      const browserRequest = new Request('https://spott.example/api/session/bootstrap', {
        headers: {
          cookie: sessionCookies(),
          authorization: 'Bearer browser-supplied',
          origin: 'https://evil.example',
          'x-forwarded-host': 'evil.example',
          'x-spott-bff-signature': 'browser-supplied',
          'user-agent': 'browser-supplied',
        },
      });

      const response = await handleSessionBootstrap(browserRequest, {
        loadConfig: () => config,
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
        refreshGeneration: validUpstreamSession.refreshGeneration,
        sessionId,
        user: validUpstreamSession.user,
      });
      expect(JSON.stringify(browserBody)).not.toContain(refreshToken);
      expectPrivateResponse(response);
      expectNoSetCookies(response);

      expect(fetchUpstream).toHaveBeenCalledOnce();
      const [url, init] = fetchUpstream.mock.calls[0] ?? [];
      expect(url).toBe('http://api.internal:4100/v1/auth/bootstrap');
      expect(init).toMatchObject({
        method: 'POST',
        credentials: 'omit',
        redirect: 'error',
        cache: 'no-store',
      });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const upstreamHeaders = new Headers(init?.headers);
      expect([...upstreamHeaders.keys()].sort()).toEqual([
        'accept',
        'content-type',
        'x-spott-bff-kid',
        'x-spott-bff-nonce',
        'x-spott-bff-signature',
        'x-spott-bff-timestamp',
        'x-spott-bff-version',
        'x-spott-device-id',
      ]);
      for (const forbidden of [
        'authorization',
        'cookie',
        'origin',
        'user-agent',
        'x-forwarded-host',
      ]) {
        expect(upstreamHeaders.has(forbidden)).toBe(false);
      }
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
          generation: refreshClaims.generation,
          transportClass: 'web_bff',
          persistentBindingId: bindingId,
          persistentBindingGeneration: bindingGeneration,
        },
      });
      const expectedSignature = signWebBFFAuthority({
        keyring: config.bffKeys,
        version: 'v1',
        kid: upstreamHeaders.get('x-spott-bff-kid') ?? '',
        method: 'POST',
        path: '/v1/auth/bootstrap',
        timestamp: Number(upstreamHeaders.get('x-spott-bff-timestamp')),
        nonce: upstreamHeaders.get('x-spott-bff-nonce') ?? '',
        bodyHash: createHash('sha256').update(upstreamBody).digest('hex'),
      });
      expect(upstreamHeaders.get('x-spott-bff-signature')).toBe(expectedSignature);
    },
  );

  test('clears Cookies only for an exact TOKEN_EXPIRED problem response', async () => {
    const response = await bootstrapWith(
      vi.fn(async () => problemUpstream('TOKEN_EXPIRED')) as typeof globalThis.fetch,
    );

    await expectStableError(response, 401, 'SESSION_REAUTH_REQUIRED', false);
    expectAtomicSessionClear(response);
  });

  test.each([
    ['validation 400', () => problemUpstream('VALIDATION_FAILED', 400)],
    ['authority 401', () => problemUpstream('WEB_BFF_AUTHORITY_INVALID', 401)],
    ['transport 403', () => problemUpstream('SESSION_TRANSPORT_MISMATCH', 403)],
    ['terminal code with wrong media', () => problemUpstream('TOKEN_EXPIRED', 401, 'application/json')],
    ['malformed terminal problem', () => new Response('{"error":', {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    })],
    ['invalid UTF-8 terminal problem', () => new Response(new Uint8Array([
      ...new TextEncoder().encode('{"error":{"code":"TOKEN_EXPIRED","message":"'),
      0xff,
      ...new TextEncoder().encode('"}}'),
    ]), {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    })],
    ['length-mismatched terminal problem', () => new Response(JSON.stringify({
      error: { code: 'TOKEN_EXPIRED' },
    }), {
      status: 401,
      headers: {
        'content-type': 'application/problem+json',
        'content-length': '1',
      },
    })],
  ])('preserves every Cookie for non-terminal upstream failure: %s', async (_label, upstream) => {
    const response = await bootstrapWith(
      vi.fn(async () => upstream()) as typeof globalThis.fetch,
    );

    await expectStableError(response, 503, 'SESSION_BOOTSTRAP_UNAVAILABLE', true);
    expectNoSetCookies(response);
  });

  test.each([429, 500, 502])(
    'maps upstream %s to safe temporary unavailability',
    async (status) => {
      const fetchUpstream = vi.fn(
        async () =>
          new Response('upstream detail', {
            status,
            headers: { 'set-cookie': 'upstream=must-not-pass; Path=/' },
          }),
      );

      await expectStableError(
        await bootstrapWith(fetchUpstream as typeof globalThis.fetch),
        503,
        'SESSION_BOOTSTRAP_UNAVAILABLE',
        true,
      );
    },
  );

  test.each([202, 204, 206])('rejects unsupported upstream success status %s', async (status) => {
    const fetchUpstream = vi.fn(async () =>
      status === 204 ? new Response(null, { status }) : jsonUpstream(validUpstreamSession, status),
    );

    await expectStableError(
      await bootstrapWith(fetchUpstream as typeof globalThis.fetch),
      503,
      'SESSION_BOOTSTRAP_UNAVAILABLE',
      true,
    );
  });

  test.each([
    ['timeout', new DOMException('timed out', 'AbortError')],
    ['redirect rejection', new TypeError('redirect mode is error')],
  ])('maps %s without leaking diagnostics', async (_label, failure) => {
    const fetchUpstream = vi.fn(async () => {
      throw failure;
    });

    await expectStableError(
      await bootstrapWith(fetchUpstream as typeof globalThis.fetch),
      503,
      'SESSION_BOOTSTRAP_UNAVAILABLE',
      true,
    );
  });

  test.each([
    [
      'wrong media type',
      new Response(JSON.stringify(validUpstreamSession), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    ],
    [
      'invalid JSON',
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ],
  ])('rejects a non-JSON upstream contract: %s', async (_label, upstream) => {
    const fetchUpstream = vi.fn(async () => upstream);
    await expectStableError(
      await bootstrapWith(fetchUpstream as typeof globalThis.fetch),
      503,
      'SESSION_BOOTSTRAP_UNAVAILABLE',
      true,
    );
  });

  test.each([
    ['session', { ...validUpstreamSession, sessionId: '66666666-6666-4666-8666-666666666666' }],
    ['generation', { ...validUpstreamSession, refreshGeneration: refreshClaims.generation + 1 }],
    [
      'user',
      {
        ...validUpstreamSession,
        user: { ...validUpstreamSession.user, id: '66666666-6666-4666-8666-666666666666' },
      },
    ],
    ['refresh token', { ...validUpstreamSession, refreshToken: `${refreshToken}x` }],
  ])(
    'reauthenticates when upstream %s disagrees with the verified Cookies',
    async (_label, value) => {
      const fetchUpstream = vi.fn(async () => jsonUpstream(value));
      const response = await bootstrapWith(fetchUpstream as typeof globalThis.fetch);
      await expectStableError(
        response,
        401,
        'SESSION_REAUTH_REQUIRED',
        false,
      );
      expectAtomicSessionClear(response);
    },
  );

  test.each([
    ['unknown field', { ...validUpstreamSession, unexpected: true }],
    [
      'expired access token',
      {
        ...validUpstreamSession,
        accessTokenExpiresAt: new Date(now).toISOString(),
      },
    ],
    ['oversized access token', { ...validUpstreamSession, accessToken: 'x'.repeat(16_385) }],
    [
      'oversized public handle',
      {
        ...validUpstreamSession,
        user: { ...validUpstreamSession.user, publicHandle: 'x'.repeat(129) },
      },
    ],
    [
      'too many restrictions',
      {
        ...validUpstreamSession,
        user: {
          ...validUpstreamSession.user,
          restrictions: Array.from({ length: 65 }, (_, i) => `r${i}`),
        },
      },
    ],
  ])('rejects an unsafe upstream AuthSession shape: %s', async (_label, value) => {
    const fetchUpstream = vi.fn(async () => jsonUpstream(value));
    await expectStableError(
      await bootstrapWith(fetchUpstream as typeof globalThis.fetch),
      503,
      'SESSION_BOOTSTRAP_UNAVAILABLE',
      true,
    );
  });
});
