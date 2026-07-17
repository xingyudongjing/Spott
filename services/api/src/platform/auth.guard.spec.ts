import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { configuration } from '../config.js';
import { AccessTokenGuard, OPS_ROUTE_KEY } from './auth.guard.js';
import {
  IS_PUBLIC_KEY,
  type AuthenticatedUser,
} from './request-context.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1:55432/spott_auth_guard_unit_test',
  ACCESS_TOKEN_SECRET: 'test-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: 'test-refresh-token-secret-at-least-32-bytes',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'test-lookup-pepper-at-least-16',
  OPS_ORIGIN: 'https://ops.spott.test',
});

const userId = '019b0000-0000-7000-8000-000000000004';
const sessionId = '019b0000-0000-7000-8000-000000000099';

const liveUser: AuthenticatedUser = {
  id: userId,
  sessionId,
  phoneVerified: false,
  restrictions: ['publishBlocked'],
  roles: ['operator', 'safetyReviewer'],
};

interface GuardRequest {
  method: 'GET' | 'POST' | 'DELETE';
  url: string;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  verifiedBFFAuthority?: unknown;
}

interface GuardOptions {
  readonly publicRoute?: boolean;
  readonly opsRoute?: boolean;
  readonly authorizedUser?: AuthenticatedUser | null;
}

const validOpsHeaders = {
  origin: 'https://ops.spott.test',
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  // Fetch Metadata maps fetch()'s empty-string destination to the explicit token "empty".
  // https://www.w3.org/TR/fetch-metadata/#sec-fetch-dest-header
  'sec-fetch-dest': 'empty',
} as const;

function context(request: GuardRequest): ExecutionContext {
  return {
    getHandler: () => context,
    getClass: () => AccessTokenGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function harness(options: GuardOptions = {}) {
  const authority = {
    authorize: vi.fn().mockResolvedValue(options.authorizedUser ?? null),
  };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return options.publicRoute ?? false;
      if (key === OPS_ROUTE_KEY) return options.opsRoute ?? false;
      return undefined;
    }),
  };
  return {
    authority,
    guard: new AccessTokenGuard(reflector as never, authority as never),
  };
}

async function accessToken(options: { expired?: boolean } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    sid: sessionId,
    roles: ['operator', 'staleRole'],
    phoneVerified: true,
    restrictions: ['staleRestriction'],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('spott-api')
    .setAudience('spott-clients')
    .setSubject(userId)
    .setIssuedAt(now - 120)
    .setExpirationTime(options.expired ? now - 60 : now + 900)
    .sign(new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET));
}

function opsCookie(token: string): string {
  return `__Host-spott_ops=${encodeURIComponent(token)}`;
}

describe('AccessTokenGuard DB-backed optional authentication', () => {
  it('attaches only the live database user state, ignoring stale JWT authorization fields', async () => {
    const token = await accessToken();
    const request: GuardRequest = {
      method: 'GET',
      url: '/v1/ops/session',
      headers: { cookie: opsCookie(token) },
    };
    const { guard, authority } = harness({ opsRoute: true, authorizedUser: liveUser });

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toEqual(liveUser);
    expect(authority.authorize).toHaveBeenCalledWith(
      expect.objectContaining({ sub: userId, sid: sessionId }),
      'ops',
    );
  });

  it.each([
    ['consumer Public', false, {}],
    ['Ops verify Public', true, validOpsHeaders],
    ['Ops refresh Public', true, {
      ...validOpsHeaders,
      cookie: '__Host-spott_ops_refresh=opaque-refresh-only',
    }],
  ] as const)('keeps absent credentials anonymous on %s', async (
    _label,
    opsRoute,
    headers,
  ) => {
    const request: GuardRequest = {
      method: 'POST',
      url: opsRoute ? '/v1/ops/auth/refresh' : '/v1/public',
      headers: { ...headers },
    };
    const { guard, authority } = harness({ publicRoute: true, opsRoute });

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['consumer Public', false, (token: string) => ({ authorization: `Bearer ${token}` })],
    ['Ops verify Public', true, (token: string) => ({
      ...validOpsHeaders,
      cookie: opsCookie(token),
    })],
    ['Ops refresh Public', true, (token: string) => ({
      ...validOpsHeaders,
      cookie: `${opsCookie(token)}; __Host-spott_ops_refresh=opaque-refresh`,
    })],
  ] as const)('rejects a supplied revoked-but-cryptographically-valid credential on %s', async (
    _label,
    opsRoute,
    headers,
  ) => {
    const token = await accessToken();
    const request: GuardRequest = {
      method: 'POST',
      url: opsRoute ? '/v1/ops/auth/refresh' : '/v1/public',
      headers: headers(token),
    };
    const { guard, authority } = harness({ publicRoute: true, opsRoute, authorizedUser: null });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).toHaveBeenCalledOnce();
  });

  it('rejects an expired supplied Ops access cookie instead of treating it as anonymous', async () => {
    const request: GuardRequest = {
      method: 'POST',
      url: '/v1/ops/auth/refresh',
      headers: {
        ...validOpsHeaders,
        cookie: `${opsCookie(await accessToken({ expired: true }))}; __Host-spott_ops_refresh=opaque`,
      },
    };
    const { guard, authority } = harness({ publicRoute: true, opsRoute: true });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['scheme without a token', 'Bearer'],
    ['Bearer with an empty token', 'Bearer '],
  ])('rejects a supplied %s Authorization header on Public instead of treating it as absent', async (
    _case,
    authorization,
  ) => {
    const request: GuardRequest = {
      method: 'GET',
      url: '/v1/public',
      headers: { authorization },
    };
    const { guard, authority } = harness({ publicRoute: true, authorizedUser: liveUser });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['a trailing segment', (token: string) => `Bearer ${token} trailing`],
    ['a comma-joined second value', (token: string) => `Bearer ${token}, Bearer ${token}`],
    ['a control character suffix', (token: string) => `Bearer ${token}\ttrailing`],
    ['multiple header values', (token: string) => [`Bearer ${token}`, `Bearer ${token}`]],
  ] as const)('rejects Authorization with %s even when the first token is valid', async (
    _case,
    malformedAuthorization,
  ) => {
    const token = await accessToken();
    const request: GuardRequest = {
      method: 'GET',
      url: '/v1/public',
      headers: { authorization: malformedAuthorization(token) },
    };
    const { guard, authority } = harness({ publicRoute: true, authorizedUser: liveUser });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it.each([
    ['empty', '__Host-spott_ops='],
    ['blank', '__Host-spott_ops=%20%20'],
    ['missing equals', '__Host-spott_ops'],
    ['invalid percent encoding', '__Host-spott_ops=%E0%A4%A'],
  ])('rejects a supplied %s Ops access Cookie on Public instead of treating it as absent', async (
    _case,
    cookie,
  ) => {
    const request: GuardRequest = {
      method: 'POST',
      url: '/v1/ops/auth/email/verify',
      headers: { ...validOpsHeaders, cookie },
    };
    const { guard, authority } = harness({ publicRoute: true, opsRoute: true, authorizedUser: liveUser });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it('rejects duplicate Ops access Cookies even when the first token is valid', async () => {
    const token = await accessToken();
    const request: GuardRequest = {
      method: 'POST',
      url: '/v1/ops/auth/email/verify',
      headers: {
        ...validOpsHeaders,
        cookie: `${opsCookie(token)}; ${opsCookie(token)}`,
      },
    };
    const { guard, authority } = harness({ publicRoute: true, opsRoute: true, authorizedUser: liveUser });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).not.toHaveBeenCalled();
  });

  it('never reads an Ops Cookie as a consumer credential, including an empty one', async () => {
    const request: GuardRequest = {
      method: 'GET',
      url: '/v1/public',
      headers: { cookie: '__Host-spott_ops=' },
    };
    const { guard, authority } = harness({ publicRoute: true, opsRoute: false });

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
    expect(authority.authorize).not.toHaveBeenCalled();
  });
});

const opsMutationRoutes = [
  ['verify', '/v1/ops/auth/email/verify', true, undefined],
  ['refresh', '/v1/ops/auth/refresh', true, '__Host-spott_ops_refresh=opaque'],
  ['logout', '/v1/ops/auth/session', false, undefined],
  ['ordinary mutation', '/v1/ops/users/target/restriction-decisions', false, undefined],
] as const;

const invalidRawHeaders = [
  ['missing Origin', { origin: undefined }],
  ['foreign Origin', { origin: 'https://attacker.example' }],
  ['cross-site Fetch Site', { 'sec-fetch-site': 'cross-site' }],
  ['navigate Fetch Mode', { 'sec-fetch-mode': 'navigate' }],
  ['document Fetch Dest', { 'sec-fetch-dest': 'document' }],
  ['blank Fetch Dest', { 'sec-fetch-dest': '' }],
  ['missing Fetch Dest', { 'sec-fetch-dest': undefined }],
] as const;

const invalidOpsMutationCases = opsMutationRoutes.flatMap(([
  route,
  url,
  publicRoute,
  cookie,
]) => invalidRawHeaders.map(([headerCase, mutation]) => ({
  route,
  url,
  publicRoute,
  cookie,
  headerCase,
  mutation,
})));

describe('AccessTokenGuard raw Ops mutation boundary', () => {
  it.each(opsMutationRoutes)(
    'requires authentication only after the valid raw matrix on %s',
    async (_label, url, publicRoute, cookie) => {
      const request: GuardRequest = {
        method: url.endsWith('/session') ? 'DELETE' : 'POST',
        url,
        headers: { ...validOpsHeaders, ...(cookie ? { cookie } : {}) },
      };
      const { guard } = harness({ opsRoute: true, publicRoute });

      if (publicRoute) await expect(guard.canActivate(context(request))).resolves.toBe(true);
      else await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it.each(invalidOpsMutationCases)(
    'rejects $route before Public/access short-circuits when raw metadata has $headerCase',
    async ({ url, publicRoute, cookie, mutation }) => {
      const headers: Record<string, string | string[] | undefined> = {
        ...validOpsHeaders,
        ...(cookie ? { cookie } : {}),
        ...mutation,
      };
      const request: GuardRequest = {
        method: url.endsWith('/session') ? 'DELETE' : 'POST',
        url,
        headers,
      };
      const { guard, authority } = harness({ opsRoute: true, publicRoute });

      await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(ForbiddenException);
      expect(authority.authorize).not.toHaveBeenCalled();
    },
  );

  it('runs the raw guard before parsing a missing or expired access Cookie', async () => {
    const request: GuardRequest = {
      method: 'DELETE',
      url: '/v1/ops/auth/session',
      headers: {
        ...validOpsHeaders,
        origin: 'https://attacker.example',
        cookie: opsCookie(await accessToken({ expired: true })),
      },
    };
    const { guard } = harness({ opsRoute: true });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not accept consumer BFF authority as a substitute for Ops raw metadata', async () => {
    const request: GuardRequest = {
      method: 'POST',
      url: '/v1/ops/auth/email/verify',
      headers: {
        'x-spott-bff-version': 'v1',
        'x-spott-bff-kid': 'bff-2026-07',
        'x-spott-bff-signature': 'signed-consumer-request',
      },
      verifiedBFFAuthority: { version: 'v1' },
    };
    const { guard } = harness({ opsRoute: true, publicRoute: true });

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('marks the entire Ops controller so ordinary mutations cannot bypass the raw guard', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../modules/ops/ops.controller.ts'),
      'utf8',
    );
    expect(source).toContain("import { OpsRoute } from '../../platform/auth.guard.js'");
    expect(source).toMatch(/@OpsRoute\(\)\s+@Controller\('ops'\)/);
  });
});
