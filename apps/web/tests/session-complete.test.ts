import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { handleSessionComplete } from '../app/lib/session-complete';
import {
  encodeLoginIntentEnvelope,
  parseLoginIntentEnvelope,
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
const challengeId = '88888888-8888-4888-8888-888888888888';
const deviceId = '44444444-4444-4444-8444-444444444444';
const attemptId = '99999999-9999-4999-8999-999999999999';
const bindingId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bindingSecret = Buffer.alloc(32, 0x7c).toString('base64url');
const sessionId = '11111111-1111-4111-8111-111111111111';
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
const reconcileExpiresAt = now + 2_678_400_000;
const reconcileClaims: LoginIntentEnvelopeClaims = {
  ...prepareClaims,
  phase: 'reconcile',
  sessionId,
  expiresAt: reconcileExpiresAt,
};
const validUpstreamPending = { state: 'pending', sessionId, bindingId, deviceId } as const;

function cookie(claims: LoginIntentEnvelopeClaims): string {
  return `__Host-spott_login_intent=${encodeLoginIntentEnvelope(claims, config)}`;
}

function browserRequest(options: {
  readonly attemptId?: string;
  readonly challengeId?: string;
  readonly deviceId?: string;
  readonly cookie?: string;
  readonly origin?: string;
  readonly body?: unknown;
} = {}): Request {
  const body = options.body ?? {
    credential: {
      provider: 'email',
      challengeId: options.challengeId ?? challengeId,
      code: '123456',
    },
    deviceId: options.deviceId ?? deviceId,
    ...(options.attemptId === undefined ? {} : { attemptId: options.attemptId }),
  };
  return new Request('https://spott.example/api/session/complete', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? config.canonicalOrigin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: JSON.stringify(body),
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

function issuedLoginIntent(response: Response): string {
  const header = setCookies(response).find((value) => value.startsWith('__Host-spott_login_intent='));
  if (header === undefined) throw new Error('login-intent cookie missing');
  return header.slice('__Host-spott_login_intent='.length, header.indexOf(';'));
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

describe('HttpOnly Web email session completion', () => {
  test('issues one global prepare capability and returns no browser bearer or OTP material', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest(), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
      randomUUID: vi.fn().mockReturnValueOnce(attemptId).mockReturnValueOnce(bindingId),
      randomSecret: () => bindingSecret,
    });

    expect(response.status).toBe(202);
    const body = await response.json();
    expect(body).toEqual({
      state: 'completion_ready',
      attemptId,
      expiresAt: now + 120_000,
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(
      /^__Host-spott_login_intent=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=120; Priority=High$/u,
    );
    const envelope = issuedLoginIntent(response);
    expect(parseLoginIntentEnvelope(envelope, config, now)).toEqual(prepareClaims);
    expect(envelope).not.toContain('123456');
    expect(JSON.stringify(body)).not.toContain(bindingSecret);
  });

  test('replays the same ready state for a matching prepare capability without extending it', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({ cookie: cookie(prepareClaims) }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now + 1_000,
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      state: 'completion_ready', attemptId, expiresAt: prepareClaims.expiresAt,
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test.each([
    ['another challenge', cookie(prepareClaims), { challengeId: '77777777-7777-4777-8777-777777777777' }],
    ['another device', cookie(prepareClaims), { deviceId: '66666666-6666-4666-8666-666666666666' }],
    ['a reconcile phase', cookie(reconcileClaims), {}],
  ])('does not replace %s when an initial request has no attempt ID', async (_label, existing, overrides) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({ cookie: existing, ...overrides }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_COMPLETION_IN_PROGRESS', retryable: true },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test('uses only the exact prepare cookie for phase two and rotates it to long-lived reconcile', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(
      async () => jsonUpstream(validUpstreamPending),
    );
    const response = await handleSessionComplete(browserRequest({
      cookie: cookie(prepareClaims),
      attemptId,
    }), {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      state: 'completion_pending',
      attemptId,
      sessionId,
      bindingId,
      deviceId,
      reconcileExpiresAt,
    });
    const cookies = setCookies(response);
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatch(/; Max-Age=2678400; Priority=High$/u);
    expect(parseLoginIntentEnvelope(issuedLoginIntent(response), config, now)).toEqual(reconcileClaims);

    expect(fetchUpstream).toHaveBeenCalledOnce();
    const [url, init] = fetchUpstream.mock.calls[0] ?? [];
    expect(url).toBe('http://api.internal:4100/v1/auth/web/complete');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store' });
    const headers = new Headers(init?.headers);
    expect(headers.has('cookie')).toBe(false);
    expect(headers.has('authorization')).toBe(false);
    const upstreamBody = String(init?.body);
    expect(JSON.parse(upstreamBody)).toEqual({
      credential: { provider: 'email', challengeId, code: '123456' },
      deviceId,
      attemptId,
      newBinding: {
        bindingId,
        generation: 0,
        proof: bindingSecret,
        proofClass: 'persistent',
      },
    });
    expect(headers.get('x-spott-bff-signature')).toBe(signWebBFFAuthority({
      keyring: config.bffKeys,
      version: 'v1',
      kid: headers.get('x-spott-bff-kid') ?? '',
      method: 'POST',
      path: '/v1/auth/web/complete',
      timestamp: Number(headers.get('x-spott-bff-timestamp')),
      nonce: headers.get('x-spott-bff-nonce') ?? '',
      bodyHash: createHash('sha256').update(upstreamBody).digest('hex'),
    }));
  });

  test('recovers the Set-Cookie-before-body crash window from reconcile without another upstream call', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({
      cookie: cookie(reconcileClaims),
      attemptId,
    }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now + 10_000,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      state: 'completion_pending',
      attemptId,
      sessionId,
      bindingId,
      deviceId,
      reconcileExpiresAt,
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test.each([
    ['missing capability', undefined, attemptId],
    ['wrong attempt', cookie(prepareClaims), '77777777-7777-4777-8777-777777777777'],
  ])('rejects phase two with %s before upstream', async (_label, existing, suppliedAttempt) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({
      cookie: existing,
      attemptId: suppliedAttempt,
    }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });
    expect(response.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  test.each([
    [`__Host-spott_login_intent=${encodeLoginIntentEnvelope(prepareClaims, config)}x`],
    [`${cookie(prepareClaims)}; ${cookie(prepareClaims)}`],
  ])('fails closed and clears exactly an invalid or duplicate completion capability', async (existing) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({ cookie: existing }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(401);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([
      '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
    ]);
  });

  test.each([
    ['ready', undefined],
    ['pending', cookie(prepareClaims)],
    ['pending after cookie rotation', cookie(reconcileClaims)],
  ])('lets a durable logout intent fence %s without issuing any session cookie', async (_label, completion) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({
      cookie: [completion, '__Host-spott_logout_intent=v1.1.current'].filter(Boolean).join('; '),
      ...(completion === undefined ? {} : { attemptId }),
    }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: { code: 'LOGOUT_PENDING', retryable: true } });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test.each([
    ['network loss', async () => { throw new TypeError('offline'); }],
    ['upstream 503', async () => jsonUpstream({ secret: bindingSecret }, 503)],
  ])('keeps the prepare capability retryable after %s', async (_label, upstream) => {
    const response = await handleSessionComplete(browserRequest({
      cookie: cookie(prepareClaims), attemptId,
    }), {
      loadConfig: () => config,
      fetch: vi.fn(upstream),
      now: () => now,
    });
    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
    expect(await response.text()).not.toContain(bindingSecret);
  });

  test('rejects cross-site requests before decoding a capability or calling upstream', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionComplete(browserRequest({
      cookie: cookie(prepareClaims), attemptId, origin: 'https://evil.example',
    }), {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });
    expect(response.status).toBe(403);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });
});
