import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ConfigModule from '../config.js';
import type { Configuration } from '../config.js';
import { AccessTokenGuard, OPS_ROUTE_KEY } from './auth.guard.js';
import { IS_PUBLIC_KEY, type AuthenticatedUser } from './request-context.js';

const configurationState: {
  NODE_ENV: Configuration['NODE_ENV'];
  ENABLE_DEV_HEADER_AUTH: 'true' | 'false';
} = {
  NODE_ENV: 'development',
  ENABLE_DEV_HEADER_AUTH: 'false',
};

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof ConfigModule>();
  return {
    ...actual,
    configuration: () => configurationState as unknown as Configuration,
  };
});

const { OpsService } = await import('../modules/ops/ops.service.js');

interface GuardRequest {
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
}

function context(request: GuardRequest): ExecutionContext {
  return {
    getHandler: () => context,
    getClass: () => AccessTokenGuard,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function harness() {
  const authority = { authorize: vi.fn().mockResolvedValue(null) };
  const reflector = {
    getAllAndOverride: vi.fn((key: string) => {
      if (key === IS_PUBLIC_KEY) return false;
      if (key === OPS_ROUTE_KEY) return false;
      return undefined;
    }),
  };
  return { guard: new AccessTokenGuard(reflector as never, authority as never) };
}

function backdoorRequest(): GuardRequest {
  return {
    method: 'GET',
    url: '/v1/ops/users',
    headers: {
      'x-spott-user-id': '00000000-0000-4000-8000-0000000000ff',
      'x-spott-role': 'operator',
    },
  };
}

beforeEach(() => {
  configurationState.NODE_ENV = 'development';
  configurationState.ENABLE_DEV_HEADER_AUTH = 'false';
});

describe('development header authentication is fail-closed', () => {
  it('rejects the header backdoor in development when no explicit switch is set', async () => {
    const request = backdoorRequest();
    const { guard } = harness();

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('rejects the header backdoor in test when no explicit switch is set', async () => {
    configurationState.NODE_ENV = 'test';
    const request = backdoorRequest();
    const { guard } = harness();

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('admits the header backdoor only when the dedicated switch is explicitly enabled', async () => {
    configurationState.ENABLE_DEV_HEADER_AUTH = 'true';
    const request = backdoorRequest();
    const { guard } = harness();

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({
      id: '00000000-0000-4000-8000-0000000000ff',
      roles: ['operator'],
    });
  });

  it('rejects the header backdoor in production even when the switch is set to true', async () => {
    configurationState.NODE_ENV = 'production';
    configurationState.ENABLE_DEV_HEADER_AUTH = 'true';
    const request = backdoorRequest();
    const { guard } = harness();

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });
});

const headerUser: AuthenticatedUser = {
  id: '00000000-0000-4000-8000-0000000000ff',
  sessionId: 'development-session',
  phoneVerified: true,
  restrictions: [],
  roles: ['operator'],
};

function opsServiceWith(query: ReturnType<typeof vi.fn>) {
  const database = {
    query,
    transaction: vi.fn(async (work: (client: { query: typeof query }) => unknown) => work({ query })),
  };
  const points = { captureHold: vi.fn(), releaseHold: vi.fn() };
  const idempotency = {
    requestHash: vi.fn(() => Buffer.from('request')),
    claim: vi.fn(async () => null),
    complete: vi.fn(async () => undefined),
  };
  return new OpsService(database as never, points as never, idempotency as never);
}

describe('OpsService development operator escalation is fail-closed', () => {
  it('refuses to synthesise a superAdmin for an unknown user when the switch is unset', async () => {
    const service = opsServiceWith(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }));

    await expect(service.overview(headerUser)).rejects.toMatchObject({ code: 'OPS_FORBIDDEN' });
  });

  it('refuses to synthesise a superAdmin in production even when the switch is true', async () => {
    configurationState.NODE_ENV = 'production';
    configurationState.ENABLE_DEV_HEADER_AUTH = 'true';
    const service = opsServiceWith(vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }));

    await expect(service.overview(headerUser)).rejects.toMatchObject({ code: 'OPS_FORBIDDEN' });
  });
});
