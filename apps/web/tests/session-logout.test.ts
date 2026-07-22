import { createHash } from 'node:crypto';
import { describe, expect, test, vi } from 'vitest';

import { handleSessionLogout } from '../app/lib/session-logout';
import {
  encodeDeviceBindingEnvelope,
  encodeLoginIntentEnvelope,
  encodeLogoutIntent,
  encodeRefreshEnvelope,
  type DeviceBindingEnvelopeClaims,
  type LoginIntentEnvelopeClaims,
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
const challengeId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const originalBindingId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const familyId = '66666666-6666-4666-8666-666666666666';
const userId = '77777777-7777-4777-8777-777777777777';
const currentBindingId = '88888888-8888-4888-8888-888888888888';
const originalBindingSecret = Buffer.alloc(32, 0x5a).toString('base64url');
const currentBindingSecret = Buffer.alloc(32, 0x5b).toString('base64url');
const originalRefreshToken = `s2.${sessionId}.0.${Buffer.alloc(32, 0x41).toString('base64url')}`;
const currentRefreshToken = `s2.${sessionId}.1.${Buffer.alloc(32, 0x42).toString('base64url')}`;
const prepareClaims: LoginIntentEnvelopeClaims = {
  purpose: 'login_intent',
  audience: config.canonicalOrigin,
  phase: 'prepare',
  challengeId,
  deviceId,
  attemptId,
  sessionId: null,
  bindingId: originalBindingId,
  bindingGeneration: 0,
  bindingSecret: originalBindingSecret,
  issuedAt: now,
  expiresAt: now + 120_000,
};
const reconcileClaims: LoginIntentEnvelopeClaims = {
  ...prepareClaims,
  phase: 'reconcile',
  sessionId,
  expiresAt: now + 2_678_400_000,
};
const acceptedMaterial = {
  accessToken: 'header.payload.signature',
  accessTokenExpiresAt: new Date(now + 900_000).toISOString(),
  refreshToken: originalRefreshToken,
  refreshGeneration: 0,
  sessionId,
  refreshFamilyId: familyId,
  refreshTokenExpiresAt: new Date(now + 2_500_000_000).toISOString(),
  transportClass: 'web_bff',
  bindingId: originalBindingId,
  bindingGeneration: 0,
  bindingIssuedAt: new Date(now - 1_000).toISOString(),
  bindingAbsoluteExpiresAt: new Date(now + 2_600_000_000).toISOString(),
  user: { id: userId, publicHandle: 'city-walker', phoneVerified: true, restrictions: [] },
} as const;
const refreshClaims: RefreshEnvelopeClaims = {
  purpose: 'refresh',
  audience: config.canonicalOrigin,
  refreshToken: currentRefreshToken,
  sessionId,
  familyId,
  generation: 1,
  transportClass: 'web_bff',
  persistentBindingId: currentBindingId,
  persistentBindingGeneration: 1,
  bffAttemptKid: config.bffKeys.currentKid,
  issuedAt: now - 1_000,
  expiresAt: now + 2_500_000_000,
};
const bindingClaims: DeviceBindingEnvelopeClaims = {
  purpose: 'device_binding',
  audience: config.canonicalOrigin,
  bindingId: currentBindingId,
  deviceId,
  userId,
  sessionId,
  generation: 1,
  secret: currentBindingSecret,
  issuedAt: now - 1_000,
  expiresAt: now + 2_600_000_000,
};

function capability(claims: LoginIntentEnvelopeClaims = reconcileClaims): string {
  return `__Host-spott_login_intent=${encodeLoginIntentEnvelope(claims, config)}`;
}

function persistentCookies(
  refresh: RefreshEnvelopeClaims = refreshClaims,
  binding: DeviceBindingEnvelopeClaims = bindingClaims,
): string {
  return `__Host-spott_refresh=${encodeRefreshEnvelope(refresh, config)}; `
    + `__Host-spott_device_binding=${encodeDeviceBindingEnvelope(binding, config)}`;
}

function logoutIntent(scope: 'current' | 'all' = 'current', sessionHint?: string): string {
  return `__Host-spott_logout_intent=${encodeLogoutIntent({
    epoch: now,
    scope,
    ...(sessionHint === undefined ? {} : { sessionHint }),
  })}`;
}

function switchLogoutIntent(): string {
  return `__Host-spott_logout_intent=v2.${now}.current.${sessionId}.${challengeId}`;
}

function browserRequest(options: {
  readonly cookie?: string;
  readonly body?: string;
  readonly origin?: string;
} = {}): Request {
  return new Request('https://spott.example/api/session/logout', {
    method: 'POST',
    headers: {
      origin: options.origin ?? config.canonicalOrigin,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: options.body,
  });
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', 'set-cookie': 'upstream=forbidden' },
  });
}

function problem(code: string, status = 401, contentType = 'application/problem+json'): Response {
  return new Response(JSON.stringify({
    error: {
      code,
      message: 'safe message',
      requestId: 'request-1',
      retryable: false,
      fieldErrors: {},
      actions: [],
      meta: {},
    },
  }), {
    status,
    headers: { 'content-type': contentType },
  });
}

function setCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  return headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''].filter(Boolean);
}

const allClears = [
  '__Host-spott_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_device_binding=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_migration_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High',
  '__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0; Priority=High',
];

describe('logout with authoritative HttpOnly completion capability', () => {
  test('uses v2 switch identity only as a current-session logout hint', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => new Response(null, {
      status: 204,
    }));
    const response = await handleSessionLogout(browserRequest({
      cookie: `${persistentCookies()}; ${switchLogoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    const [url, init] = fetchUpstream.mock.calls[0] ?? [];
    expect(String(url)).toBe('http://api.internal:4100/v1/auth/logout');
    expect(String(init?.body)).not.toContain(challengeId);
    expect(setCookies(response)).toEqual(allClears);
  });

  test('discards a pending prepare attempt before terminal anonymous cleanup', async () => {
    const fetchUpstream = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toContain(`/completion-attempts/${attemptId}/discard`);
      return json({ state: 'discarded', bindingId: originalBindingId, deviceId });
    });
    const response = await handleSessionLogout(browserRequest({
      cookie: `${capability(prepareClaims)}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: 'anonymous' });
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(setCookies(response)).toEqual(allClears);
  });

  test('revokes accepted completion by attempt authority without recovering generation-zero material', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => json({
      state: 'revoked',
      sessionId,
      bindingId: originalBindingId,
      deviceId,
    }));
    const response = await handleSessionLogout(browserRequest({
      cookie: `${capability()}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    const [url, revokeInit] = fetchUpstream.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      `http://api.internal:4100/v1/auth/web/completion-attempts/${attemptId}/revoke`,
    );
    expect(JSON.parse(String(revokeInit?.body))).toEqual({
      challengeId,
      deviceId,
      binding: {
        bindingId: originalBindingId,
        generation: 0,
        proof: originalBindingSecret,
        proofClass: 'persistent',
      },
    });
    expect(String(revokeInit?.body)).not.toContain(originalRefreshToken);
    expect(setCookies(response)).toEqual(allClears);
    expect(setCookies(response).every((value) => /Max-Age=0/u.test(value))).toBe(true);
    expect(await response.text()).not.toContain(originalRefreshToken);
  });

  test('uses attempt revoke for a matching refreshed session without replaying either refresh generation', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => json({
      state: 'revoked',
      sessionId,
      bindingId: originalBindingId,
      deviceId,
    }));
    const response = await handleSessionLogout(browserRequest({
      cookie: `${persistentCookies()}; ${capability()}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    const [url, revokeInit] = fetchUpstream.mock.calls[0] ?? [];
    expect(String(url)).toContain(`/completion-attempts/${attemptId}/revoke`);
    expect(JSON.parse(String(revokeInit?.body))).toEqual({
      challengeId,
      deviceId,
      binding: {
        bindingId: originalBindingId,
        generation: 0,
        proof: originalBindingSecret,
        proofClass: 'persistent',
      },
    });
    expect(String(revokeInit?.body)).not.toContain(originalRefreshToken);
    expect(String(revokeInit?.body)).not.toContain(currentRefreshToken);
  });

  test.each(['current', 'all'] as const)(
    'discards a pending capability before using the current persistent authority for %s logout',
    async (scope) => {
      const fetchUpstream = vi.fn()
        .mockResolvedValueOnce(json({
          state: 'discarded',
          bindingId: originalBindingId,
          deviceId,
        }))
        .mockResolvedValueOnce(scope === 'current'
          ? new Response(null, { status: 204 })
          : json({ revokedCount: 3 }));
      const response = await handleSessionLogout(browserRequest({
        cookie: `${persistentCookies()}; ${capability(prepareClaims)}; ${logoutIntent(scope)}`,
      }), scope, {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(200);
      expect(fetchUpstream).toHaveBeenCalledTimes(2);
      expect(String(fetchUpstream.mock.calls[0]?.[0]))
        .toContain(`/completion-attempts/${attemptId}/discard`);
      expect(String(fetchUpstream.mock.calls[1]?.[0]))
        .toBe(`http://api.internal:4100/v1/auth/${scope === 'current' ? 'logout' : 'logout-all'}`);
      const persistentBody = String(fetchUpstream.mock.calls[1]?.[1]?.body);
      expect(JSON.parse(persistentBody)).toMatchObject({
        refreshToken: currentRefreshToken,
        deviceBindingProof: {
          bindingId: currentBindingId,
          generation: 1,
          proof: currentBindingSecret,
        },
      });
      expect(String(fetchUpstream.mock.calls[0]?.[1]?.body)).not.toContain(originalRefreshToken);
      expect(persistentBody).not.toContain(originalRefreshToken);
      expect(setCookies(response)).toEqual(allClears);
    },
  );

  test('uses the current persistent authority for logout-all before exact accepted-attempt revoke', async () => {
    const fetchUpstream = vi.fn()
      .mockResolvedValueOnce(json({ revokedCount: 3 }))
      .mockResolvedValueOnce(json({
        state: 'revoked',
        sessionId,
        bindingId: originalBindingId,
        deviceId,
      }));
    const response = await handleSessionLogout(browserRequest({
      cookie: `${persistentCookies()}; ${capability()}; ${logoutIntent('all')}`,
    }), 'all', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(200);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
    expect(String(fetchUpstream.mock.calls[0]?.[0])).toBe('http://api.internal:4100/v1/auth/logout-all');
    expect(String(fetchUpstream.mock.calls[1]?.[0])).toContain(`/completion-attempts/${attemptId}/revoke`);
    expect(String(fetchUpstream.mock.calls[0]?.[1]?.body)).toContain(currentRefreshToken);
    expect(String(fetchUpstream.mock.calls[0]?.[1]?.body)).not.toContain(originalRefreshToken);
    expect(String(fetchUpstream.mock.calls[1]?.[1]?.body)).not.toContain(originalRefreshToken);
    expect(String(fetchUpstream.mock.calls[1]?.[1]?.body)).not.toContain(currentRefreshToken);
    expect(setCookies(response)).toEqual(allClears);
  });

  test('does not claim terminal logout-all when exact revoke response is lost after global revocation', async () => {
    const fetchUpstream = vi.fn()
      .mockResolvedValueOnce(json({ revokedCount: 3 }))
      .mockRejectedValueOnce(new TypeError('lost exact-revoke response'));
    const response = await handleSessionLogout(browserRequest({
      cookie: `${persistentCookies()}; ${capability()}; ${logoutIntent('all')}`,
    }), 'all', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(response.status).toBe(503);
    expect(fetchUpstream).toHaveBeenCalledTimes(2);
    expect(String(fetchUpstream.mock.calls[0]?.[0])).toBe('http://api.internal:4100/v1/auth/logout-all');
    expect(String(fetchUpstream.mock.calls[1]?.[0])).toContain(`/completion-attempts/${attemptId}/revoke`);
    expect(setCookies(response)).toEqual([]);

    const retryFetch = vi.fn()
      .mockResolvedValueOnce(problem('TOKEN_EXPIRED'))
      .mockResolvedValueOnce(json({
        state: 'revoked',
        sessionId,
        bindingId: originalBindingId,
        deviceId,
      }));
    const retry = await handleSessionLogout(browserRequest({
      cookie: `${persistentCookies()}; ${capability()}; ${logoutIntent('all')}`,
    }), 'all', {
      loadConfig: () => config,
      fetch: retryFetch as typeof globalThis.fetch,
      now: () => now,
    });

    expect(retry.status).toBe(409);
    await expect(retry.json()).resolves.toEqual({
      error: { code: 'LOGOUT_ALL_UNCONFIRMED', retryable: false },
    });
    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(String(retryFetch.mock.calls[0]?.[0])).toBe('http://api.internal:4100/v1/auth/logout-all');
    expect(String(retryFetch.mock.calls[1]?.[0])).toContain(`/completion-attempts/${attemptId}/revoke`);
    expect(setCookies(retry)).toEqual(allClears);
  });

  test.each(['current', 'all'] as const)(
    'revokes both exact completion and a different persistent session for %s logout',
    async (scope) => {
      const otherSessionId = '99999999-9999-4999-8999-999999999999';
      const otherFamilyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const otherRefreshToken = `s2.${otherSessionId}.1.${Buffer.alloc(32, 0x43).toString('base64url')}`;
      const otherRefresh: RefreshEnvelopeClaims = {
        ...refreshClaims,
        refreshToken: otherRefreshToken,
        sessionId: otherSessionId,
        familyId: otherFamilyId,
      };
      const otherBinding: DeviceBindingEnvelopeClaims = {
        ...bindingClaims,
        sessionId: otherSessionId,
      };
      const fetchUpstream = vi.fn()
        .mockResolvedValueOnce(json({
          state: 'revoked',
          sessionId,
          bindingId: originalBindingId,
          deviceId,
        }))
        .mockResolvedValueOnce(scope === 'current'
          ? new Response(null, { status: 204 })
          : json({ revokedCount: 2 }));
      const response = await handleSessionLogout(browserRequest({
        cookie: `${persistentCookies(otherRefresh, otherBinding)}; ${capability()}; ${logoutIntent(scope)}`,
      }), scope, {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(200);
      expect(fetchUpstream).toHaveBeenCalledTimes(2);
      expect(String(fetchUpstream.mock.calls[0]?.[0]))
        .toContain(`/completion-attempts/${attemptId}/revoke`);
      expect(String(fetchUpstream.mock.calls[1]?.[0]))
        .toBe(`http://api.internal:4100/v1/auth/${scope === 'current' ? 'logout' : 'logout-all'}`);
      expect(String(fetchUpstream.mock.calls[0]?.[1]?.body)).not.toContain(originalRefreshToken);
      expect(String(fetchUpstream.mock.calls[1]?.[1]?.body)).toContain(otherRefreshToken);
      expect(setCookies(response)).toEqual(allClears);
    },
  );

  test('retries both mutations after a different-session persistent revoke response is lost', async () => {
    const otherSessionId = '99999999-9999-4999-8999-999999999999';
    const otherFamilyId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const otherRefreshToken = `s2.${otherSessionId}.1.${Buffer.alloc(32, 0x43).toString('base64url')}`;
    const otherRefresh: RefreshEnvelopeClaims = {
      ...refreshClaims,
      refreshToken: otherRefreshToken,
      sessionId: otherSessionId,
      familyId: otherFamilyId,
    };
    const otherBinding: DeviceBindingEnvelopeClaims = {
      ...bindingClaims,
      sessionId: otherSessionId,
    };
    const cookie = `${persistentCookies(otherRefresh, otherBinding)}; ${capability()}; ${logoutIntent()}`;
    const firstFetch = vi.fn()
      .mockResolvedValueOnce(json({
        state: 'revoked',
        sessionId,
        bindingId: originalBindingId,
        deviceId,
      }))
      .mockRejectedValueOnce(new TypeError('lost persistent-revoke response'));
    const first = await handleSessionLogout(browserRequest({ cookie }), 'current', {
      loadConfig: () => config,
      fetch: firstFetch as typeof globalThis.fetch,
      now: () => now,
    });

    expect(first.status).toBe(503);
    expect(firstFetch).toHaveBeenCalledTimes(2);
    expect(setCookies(first)).toEqual([]);

    const retryFetch = vi.fn()
      .mockResolvedValueOnce(json({
        state: 'revoked',
        sessionId,
        bindingId: originalBindingId,
        deviceId,
      }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const retry = await handleSessionLogout(browserRequest({ cookie }), 'current', {
      loadConfig: () => config,
      fetch: retryFetch as typeof globalThis.fetch,
      now: () => now,
    });

    expect(retry.status).toBe(200);
    expect(retryFetch).toHaveBeenCalledTimes(2);
    expect(String(retryFetch.mock.calls[0]?.[0])).toContain(`/completion-attempts/${attemptId}/revoke`);
    expect(String(retryFetch.mock.calls[1]?.[0])).toBe('http://api.internal:4100/v1/auth/logout');
    expect(setCookies(retry)).toEqual(allClears);
  });

  test.each([
    ['revoke network loss', vi.fn(async () => { throw new TypeError('offline'); })],
    ['revoke 503', vi.fn(async () => json({ error: 'unavailable' }, 503))],
  ])('keeps logout and completion capability retryable after %s', async (_label, fetchUpstream) => {
    const response = await handleSessionLogout(browserRequest({
      cookie: `${capability()}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });
    expect(response.status).toBe(503);
    expect(setCookies(response)).toEqual([]);
  });

  test('rejects an accepted-material response from revoke without publishing or replaying it', async () => {
    const fetchUpstream = vi.fn(async () => json({ state: 'accepted', material: acceptedMaterial }));
    const response = await handleSessionLogout(browserRequest({
      cookie: `${capability()}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });
    expect(response.status).toBe(503);
    expect(fetchUpstream).toHaveBeenCalledOnce();
    expect(setCookies(response)).toEqual([]);
    expect(await response.text()).not.toContain(originalRefreshToken);
  });

  test('recovers a lost discard response by retrying the same exact capability', async () => {
    const first = await handleSessionLogout(browserRequest({
      cookie: `${capability(prepareClaims)}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: vi.fn(async () => { throw new TypeError('lost response'); }),
      now: () => now,
    });
    expect(first.status).toBe(503);
    expect(setCookies(first)).toEqual([]);

    const second = await handleSessionLogout(browserRequest({
      cookie: `${capability(prepareClaims)}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: vi.fn(async () => json({ state: 'discarded', bindingId: originalBindingId, deviceId })),
      now: () => now,
    });
    expect(second.status).toBe(200);
    expect(setCookies(second)).toEqual(allClears);
  });

  test('with no completion or persistent pair, current logout is terminal anonymous success', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionLogout(browserRequest({ cookie: logoutIntent() }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: 'anonymous' });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual(allClears);
  });

  test('treats a truly anonymous logout-all as terminal and idempotent', async () => {
    const response = await handleSessionLogout(browserRequest({ cookie: logoutIntent('all') }), 'all', {
      loadConfig: () => config,
      fetch: vi.fn(),
      now: () => now,
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: 'anonymous' });
    expect(setCookies(response)).toEqual(allClears);
  });

  test.each([
    ['tampered', `${capability()}x`],
    ['duplicate', `${capability()}; ${capability()}`],
  ])('fails closed without silently treating an inaccessible %s capability as terminal', async (_label, completion) => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionLogout(browserRequest({
      cookie: `${completion}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'SESSION_REAUTH_REQUIRED', retryable: false },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual(allClears);
  });

  test.each([
    ['tampered', 'current', `${capability()}x`, 401, 'SESSION_REAUTH_REQUIRED'],
    ['duplicate', 'current', `${capability()}; ${capability()}`, 401, 'SESSION_REAUTH_REQUIRED'],
    ['tampered', 'all', `${capability()}x`, 409, 'LOGOUT_ALL_UNCONFIRMED'],
    ['duplicate', 'all', `${capability()}; ${capability()}`, 409, 'LOGOUT_ALL_UNCONFIRMED'],
  ] as const)(
    'revokes valid persistent authority after %s completion for %s logout',
    async (_label, scope, completion, expectedStatus, expectedCode) => {
      const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => scope === 'current'
        ? new Response(null, { status: 204 })
        : json({ revokedCount: 3 }));
      const response = await handleSessionLogout(browserRequest({
        cookie: `${persistentCookies()}; ${completion}; ${logoutIntent(scope)}`,
      }), scope, {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual({
        error: { code: expectedCode, retryable: false },
      });
      expect(fetchUpstream).toHaveBeenCalledOnce();
      expect(String(fetchUpstream.mock.calls[0]?.[0]))
        .toBe(`http://api.internal:4100/v1/auth/${scope === 'current' ? 'logout' : 'logout-all'}`);
      expect(setCookies(response)).toEqual(allClears);
    },
  );

  test.each(['current', 'all'] as const)(
    'preserves valid persistent Cookies when %s revoke is unavailable and completion is invalid',
    async (scope) => {
      const fetchUpstream = vi.fn(async () => { throw new TypeError('offline'); });
      const response = await handleSessionLogout(browserRequest({
        cookie: `${persistentCookies()}; ${capability()}x; ${logoutIntent(scope)}`,
      }), scope, {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(503);
      expect(fetchUpstream).toHaveBeenCalledOnce();
      expect(setCookies(response)).toEqual([]);
    },
  );

  test.each([
    ['WEB_BFF_AUTHORITY_INVALID 401', () => problem('WEB_BFF_AUTHORITY_INVALID')],
    ['WEB_BFF_AUTHORITY_REQUIRED 403', () => problem('WEB_BFF_AUTHORITY_REQUIRED', 403)],
    ['other 401', () => problem('SESSION_REAUTH_REQUIRED')],
    ['TOKEN_EXPIRED 403', () => problem('TOKEN_EXPIRED', 403)],
    ['SESSION_TRANSPORT_MISMATCH 403', () => problem('SESSION_TRANSPORT_MISMATCH', 403)],
    ['wrong content type', () => problem('TOKEN_EXPIRED', 401, 'application/json')],
    ['malformed problem JSON', () => new Response('{', {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    })],
    ['oversized problem JSON', () => new Response('x'.repeat(1_025), {
      status: 401,
      headers: { 'content-type': 'application/problem+json' },
    })],
  ] as const)(
    'treats %s as unavailable and preserves persistent Cookies',
    async (_label, upstreamResponse) => {
      const response = await handleSessionLogout(browserRequest({
        cookie: `${persistentCookies()}; ${logoutIntent()}`,
      }), 'current', {
        loadConfig: () => config,
        fetch: vi.fn(async () => upstreamResponse()) as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(503);
      expect(setCookies(response)).toEqual([]);
    },
  );

  test.each([
    ['current', 401, 'SESSION_REAUTH_REQUIRED'],
    ['all', 409, 'LOGOUT_ALL_UNCONFIRMED'],
  ] as const)(
    'accepts only exact TOKEN_EXPIRED problem JSON as persistent %s reauthentication',
    async (scope, expectedStatus, expectedCode) => {
      const response = await handleSessionLogout(browserRequest({
        cookie: `${persistentCookies()}; ${logoutIntent(scope)}`,
      }), scope, {
        loadConfig: () => config,
        fetch: vi.fn(async () => problem('TOKEN_EXPIRED')) as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual({
        error: { code: expectedCode, retryable: false },
      });
      expect(setCookies(response)).toEqual(allClears);
    },
  );

  test('treats a logout-all session hint without authority as unconfirmed, never authorized success', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionLogout(browserRequest({
      cookie: logoutIntent('all', sessionId),
    }), 'all', {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'LOGOUT_ALL_UNCONFIRMED', retryable: false },
    });
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual(allClears);
  });

  test.each([
    ['prepare discard', prepareClaims, 'discard'],
    ['reconcile discard', reconcileClaims, 'revoke'],
  ] as const)(
    'treats concrete session from %s without persistent logout-all authority as unconfirmed',
    async (_label, claims, operation) => {
      const fetchUpstream = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toContain(`/completion-attempts/${attemptId}/${operation}`);
        return json({ state: 'discarded', sessionId, bindingId: originalBindingId, deviceId });
      });
      const response = await handleSessionLogout(browserRequest({
        cookie: `${capability(claims)}; ${logoutIntent('all')}`,
      }), 'all', {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'LOGOUT_ALL_UNCONFIRMED', retryable: false },
      });
      expect(fetchUpstream).toHaveBeenCalledOnce();
      expect(setCookies(response)).toEqual(allClears);
    },
  );

  test.each([
    ['current', 401, 'SESSION_REAUTH_REQUIRED'],
    ['all', 409, 'LOGOUT_ALL_UNCONFIRMED'],
  ] as const)(
    'exact-revokes a valid reconcile capability before clearing an invalid persistent pair for %s logout',
    async (scope, expectedStatus, expectedCode) => {
      const fetchUpstream = vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toContain(`/completion-attempts/${attemptId}/revoke`);
        return json({
          state: 'revoked',
          sessionId,
          bindingId: originalBindingId,
          deviceId,
        });
      });
      const response = await handleSessionLogout(browserRequest({
        cookie: `${capability()}; __Host-spott_refresh=${encodeRefreshEnvelope(refreshClaims, config)}; ${logoutIntent(scope)}`,
      }), scope, {
        loadConfig: () => config,
        fetch: fetchUpstream as typeof globalThis.fetch,
        now: () => now,
      });

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toEqual({
        error: { code: expectedCode, retryable: false },
      });
      expect(fetchUpstream).toHaveBeenCalledOnce();
      expect(setCookies(response)).toEqual(allClears);
    },
  );

  test('requires a canonical durable logout intent before any mutation', async () => {
    const fetchUpstream = vi.fn();
    const response = await handleSessionLogout(browserRequest({ cookie: capability() }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream,
      now: () => now,
    });
    expect(response.status).toBe(409);
    expect(fetchUpstream).not.toHaveBeenCalled();
    expect(setCookies(response)).toEqual([]);
  });

  test('keeps strict CSRF and rejects a browser body before any upstream mutation', async () => {
    const fetchUpstream = vi.fn();
    const crossSite = await handleSessionLogout(browserRequest({
      cookie: `${capability()}; ${logoutIntent()}`,
      origin: 'https://evil.example',
    }), 'current', { loadConfig: () => config, fetch: fetchUpstream, now: () => now });
    expect(crossSite.status).toBe(403);

    const withBody = await handleSessionLogout(browserRequest({
      cookie: `${capability()}; ${logoutIntent()}`,
      body: JSON.stringify({ attemptId }),
    }), 'current', { loadConfig: () => config, fetch: fetchUpstream, now: () => now });
    expect(withBody.status).toBe(400);
    expect(fetchUpstream).not.toHaveBeenCalled();
  });

  test('signs exact completion revoke without forwarding browser Cookie authority', async () => {
    const fetchUpstream = vi.fn<typeof globalThis.fetch>(async () => json({
      state: 'revoked',
      sessionId,
      bindingId: originalBindingId,
      deviceId,
    }));
    await handleSessionLogout(browserRequest({
      cookie: `${capability()}; ${logoutIntent()}`,
    }), 'current', {
      loadConfig: () => config,
      fetch: fetchUpstream as typeof globalThis.fetch,
      now: () => now,
    });

    expect(fetchUpstream).toHaveBeenCalledOnce();
    for (const [url, init] of fetchUpstream.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.has('cookie')).toBe(false);
      expect(headers.has('authorization')).toBe(false);
      const path = new URL(String(url)).pathname;
      const body = String(init?.body);
      expect(headers.get('x-spott-bff-signature')).toBe(signWebBFFAuthority({
        keyring: config.bffKeys,
        version: 'v1',
        kid: headers.get('x-spott-bff-kid') ?? '',
        method: 'POST',
        path,
        timestamp: Number(headers.get('x-spott-bff-timestamp')),
        nonce: headers.get('x-spott-bff-nonce') ?? '',
        bodyHash: createHash('sha256').update(body).digest('hex'),
      }));
    }
  });
});
