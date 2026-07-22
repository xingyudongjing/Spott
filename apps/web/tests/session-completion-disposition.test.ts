import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { handleSessionCompletionDisposition } from '../app/lib/session-completion-disposition';
import {
  encodeLoginIntentEnvelope,
  parseDeviceBindingEnvelope,
  parseRefreshEnvelope,
  type LoginIntentEnvelopeClaims,
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
const challengeId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const bindingId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const familyId = '66666666-6666-4666-8666-666666666666';
const userId = '77777777-7777-4777-8777-777777777777';
const bindingSecret = Buffer.alloc(32, 0x5a).toString('base64url');
const refreshToken = `s2.${sessionId}.0.${Buffer.alloc(32, 0x41).toString('base64url')}`;
const prepareClaims: LoginIntentEnvelopeClaims = {
  purpose: 'login_intent',
  audience: config.canonicalOrigin,
  phase: 'prepare',
  challengeId,
  deviceId,
  attemptId,
  sessionId: null,
  bindingId,
  bindingGeneration: 0,
  bindingSecret,
  issuedAt: now,
  expiresAt: now + 120_000,
};
const reconcileClaims: LoginIntentEnvelopeClaims = {
  ...prepareClaims,
  phase: 'reconcile',
  sessionId,
  expiresAt: now + 2_678_400_000,
};
const material = {
  accessToken: 'header.payload.signature',
  accessTokenExpiresAt: new Date(now + 900_000).toISOString(),
  refreshToken,
  refreshGeneration: 0,
  sessionId,
  refreshFamilyId: familyId,
  refreshTokenExpiresAt: new Date(now + 2_500_000_000).toISOString(),
  transportClass: 'web_bff',
  bindingId,
  bindingGeneration: 0,
  bindingIssuedAt: new Date(now - 1_000).toISOString(),
  bindingAbsoluteExpiresAt: new Date(now + 2_600_000_000).toISOString(),
  user: {
    id: userId,
    publicHandle: 'city-walker',
    phoneVerified: true,
    restrictions: ['postingLimited'],
  },
} as const;

function capability(claims: LoginIntentEnvelopeClaims = reconcileClaims): string {
  return `__Host-spott_login_intent=${encodeLoginIntentEnvelope(claims, config)}`;
}

function browserRequest(
  operation: 'accept' | 'discard',
  options: {
    readonly claims?: LoginIntentEnvelopeClaims;
    readonly cookie?: string;
    readonly body?: unknown;
    readonly origin?: string;
  } = {},
): Request {
  return new Request(`https://spott.example/api/session/completion/${operation}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? config.canonicalOrigin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      cookie: options.cookie ?? capability(options.claims),
    },
    body: JSON.stringify(options.body ?? { attemptId }),
  });
}

function jsonUpstream(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
      'set-cookie': 'upstream=must-not-pass; Path=/',
    },
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

describe('HttpOnly session completion disposition', () => {
  test('accepts only reconcile and publishes exact validated browser authority', async () => {
    const fetchUpstream = vi.fn(async () => jsonUpstream({ state: 'accepted', material }));
    const response = await handleSessionCompletionDisposition(browserRequest('accept'), 'accept', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    const browserBody = await response.json();
    expect(browserBody).toEqual({
      state: 'authenticated',
      accessToken: material.accessToken,
      accessTokenExpiresAt: material.accessTokenExpiresAt,
      refreshGeneration: 0,
      sessionId,
      user: material.user,
    });
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(3);
    expect(cookies.at(-1)).toBe(
      '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
    );
    const refresh = cookies[0]?.slice('__Host-spott_refresh='.length, cookies[0].indexOf(';'));
    const binding = cookies[1]?.slice('__Host-spott_device_binding='.length, cookies[1].indexOf(';'));
    expect(parseRefreshEnvelope(refresh, config, now)).toMatchObject({
      refreshToken, sessionId, persistentBindingId: bindingId, generation: 0,
    });
    expect(parseDeviceBindingEnvelope(binding, config, now)).toMatchObject({
      sessionId, bindingId, deviceId, secret: bindingSecret, generation: 0,
    });
    expect(JSON.stringify(browserBody)).not.toContain(refreshToken);
    expect(JSON.stringify(browserBody)).not.toContain(bindingSecret);
  });

  test('rejects accept in prepare phase without calling upstream', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionCompletionDisposition(
      browserRequest('accept', { claims: prepareClaims }),
      'accept',
      { loadConfig: () => config, fetch: fetchUpstream, now: () => now },
    );
    expect(response.status).toBe(409);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test.each([
    ['prepare', prepareClaims, { state: 'discarded', bindingId, deviceId }],
    ['reconcile', reconcileClaims, { state: 'discarded', sessionId, bindingId, deviceId }],
  ] as const)('allows exact discard from %s and clears the capability', async (_label, claims, upstream) => {
    const response = await handleSessionCompletionDisposition(
      browserRequest('discard', { claims }),
      'discard',
      {
        loadConfig: () => config,
        fetch: vi.fn(async () => jsonUpstream(upstream)),
        now: () => now,
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ state: 'discarded', attemptId });
    expect(setCookies(response)).toEqual([
      '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
    ]);
  });

  test('recovers discard-after-accept by restoring the same accepted authority', async () => {
    const response = await handleSessionCompletionDisposition(browserRequest('discard'), 'discard', {
      loadConfig: () => config,
      fetch: vi.fn(async () => jsonUpstream({ state: 'accepted', material })),
      now: () => now,
    });
    expect(response.status).toBe(200);
    expect(setCookies(response).map((value) => value.split('=', 1)[0])).toEqual([
      '__Host-spott_refresh', '__Host-spott_device_binding', '__Host-spott_login_intent',
    ]);
  });

  test('sends exact signed BFF disposition without forwarding browser cookies', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(
      async () => jsonUpstream({ state: 'discarded', sessionId, bindingId, deviceId }),
    );
    await handleSessionCompletionDisposition(browserRequest('discard'), 'discard', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    const [url, init] = fetchUpstream.mock.calls[0] ?? [];
    expect(url).toBe(`http://api.internal:4100/v1/auth/web/completion-attempts/${attemptId}/discard`);
    const headers = new Headers(init?.headers);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    const body = String(init?.body);
    expect(JSON.parse(body)).toEqual({
      challengeId,
      deviceId,
      binding: { bindingId, generation: 0, proof: bindingSecret, proofClass: 'persistent' },
    });
    expect(headers.get('x-spott-bff-signature')).toBe(signWebBFFAuthority({
      keyring: config.bffKeys,
      version: 'v1',
      kid: headers.get('x-spott-bff-kid') ?? '',
      method: 'POST',
      path: `/v1/auth/web/completion-attempts/${attemptId}/discard`,
      timestamp: Number(headers.get('x-spott-bff-timestamp')),
      nonce: headers.get('x-spott-bff-nonce') ?? '',
      bodyHash: createHash('sha256').update(body).digest('hex'),
    }));
  });

  test.each([
    ['session', { ...material, sessionId: '88888888-8888-4888-8888-888888888888' }],
    ['binding', { ...material, bindingId: '88888888-8888-4888-8888-888888888888' }],
  ])('never publishes accepted material with mismatched %s', async (_label, invalidMaterial) => {
    const response = await handleSessionCompletionDisposition(browserRequest('accept'), 'accept', {
      loadConfig: () => config,
      fetch: vi.fn(async () => jsonUpstream({ state: 'accepted', material: invalidMaterial })),
      now: () => now,
    });
    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
  });

  test.each([
    ['tampered', `${capability()}x`],
    ['duplicate', `${capability()}; ${capability()}`],
  ])('clears exactly an invalid or %s capability before upstream', async (_label, existing) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionCompletionDisposition(
      browserRequest('discard', { cookie: existing }),
      'discard',
      { loadConfig: () => config, fetch: fetchUpstream, now: () => now },
    );
    expect(response.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([
      '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
    ]);
  });

  test('requires the browser attempt ID to match the HttpOnly capability exactly', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionCompletionDisposition(browserRequest('discard', {
      body: { attemptId: '88888888-8888-4888-8888-888888888888' },
    }), 'discard', {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });
    expect(response.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test.each(['accept', 'discard'] as const)(
    'lets logout intent fence %s before any upstream mutation or cookie issuance',
    async (operation) => {
      const fetchUpstream = vi.fn();
      const response = await handleSessionCompletionDisposition(browserRequest(operation, {
        cookie: `${capability()}; __Host-spott_logout_intent=v1.1.current`,
      }), operation, {
        loadConfig: () => config,
        fetch: fetchUpstream,
        now: () => now,
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: { code: 'LOGOUT_PENDING', retryable: true } });
      expect(fetchUpstream).not.toHaveBeenCalled();
      expect(setCookies(response)).toEqual([]);
    },
  );

  test('retains the capability for retry when reconciliation is unavailable', async () => {
    const response = await handleSessionCompletionDisposition(browserRequest('discard'), 'discard', {
      loadConfig: () => config,
      fetch: vi.fn(async () => { throw new TypeError('offline'); }),
      now: () => now,
    });
    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
  });

  test('rejects legacy bearer-token-shaped browser input', async () => {
    const response = await handleSessionCompletionDisposition(browserRequest('discard', {
      body: { attemptId, completionToken: 'legacy-browser-bearer' },
    }), 'discard', {
      loadConfig: () => config,
      fetch: vi.fn(),
      now: () => now,
    });
    expect(response.status).toBe(400);
  });
});
