import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../platform/request-context.js';
import {
  WebBFFTransportGuard,
  type SessionTransportClass,
  type VerifiedBFFAuthority,
} from '../../platform/web-bff-authority.js';
import { AuthController } from './auth.controller.js';

Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://127.0.0.1:55432/spott_auth_controller_unit_test',
  ACCESS_TOKEN_SECRET: 'auth-controller-access-token-secret-at-least-32-bytes',
  REFRESH_TOKEN_SECRET: 'auth-controller-refresh-token-secret-at-least-32-bytes',
  FIELD_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 4).toString('base64'),
  LOOKUP_HMAC_PEPPER: 'auth-controller-lookup-pepper-at-least-16-bytes',
});

type SessionRequestChannel = 'headerless_native' | 'consumer_web' | 'verified_bff' | 'ops';

interface IssuanceRequest {
  readonly issuedSessionTransportClass?: SessionTransportClass;
  readonly verifiedBFFAuthority?: VerifiedBFFAuthority;
  readonly sessionRequestChannel?: SessionRequestChannel;
}

interface ControllerContract {
  verifyEmail(request: IssuanceRequest, body: unknown): Promise<unknown>;
  apple(request: IssuanceRequest, body: unknown): Promise<unknown>;
  google(request: IssuanceRequest, body: unknown): Promise<unknown>;
  refresh(request: IssuanceRequest, body: unknown, key?: string): Promise<unknown>;
  bootstrap(request: IssuanceRequest, body: unknown): Promise<unknown>;
  upgradeDeviceBinding(request: IssuanceRequest, body: unknown): Promise<unknown>;
  mergeCommit(
    user: AuthenticatedUser,
    request: IssuanceRequest,
    key: string,
    body: unknown,
  ): Promise<unknown>;
}

const authority: VerifiedBFFAuthority = {
  version: 'v1',
  kid: 'bff-2026-07',
  timestamp: 1_784_246_400_000,
  nonceHash: Buffer.alloc(32, 7),
};
const deviceId = '019b0000-0000-7000-8000-000000000020';
const challengeId = '019b0000-0000-7000-8000-000000000030';
const bootstrapSessionId = '019b0000-0000-7000-8000-000000000040';
const bootstrapRefreshToken = `s2.${bootstrapSessionId}.3.${Buffer.alloc(32, 9).toString('base64url')}`;
const bootstrapProof = {
  bindingId: '019b0000-0000-7000-8000-000000000011',
  generation: 3,
  proof: Buffer.alloc(32, 23).toString('base64url'),
  proofClass: 'persistent',
} as const;

function guardContext(request: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as never;
}

function harness() {
  const auth = {
    verifyEmailChallenge: vi.fn().mockResolvedValue({ sessionId: 'email-session' }),
    authenticateApple: vi.fn().mockResolvedValue({ sessionId: 'apple-session' }),
    authenticateGoogle: vi.fn().mockResolvedValue({ sessionId: 'google-session' }),
    refresh: vi.fn().mockResolvedValue({ sessionId: 'refresh-session' }),
    bootstrap: vi.fn().mockResolvedValue({ sessionId: 'bootstrap-session' }),
    upgradeDeviceBinding: vi.fn().mockResolvedValue({
      sessionId: bootstrapSessionId,
      bindingId: bootstrapProof.bindingId,
    }),
    mergeCommit: vi.fn().mockResolvedValue({ sessionId: 'merge-session' }),
  };
  const controller = new AuthController(auth as never) as unknown as ControllerContract;
  return { auth, controller };
}

describe('AuthController trusted session issuance authority', () => {
  it('passes only guard-attached transport authority into email verification', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = {
      issuedSessionTransportClass: 'web_bff',
      verifiedBFFAuthority: authority,
    };
    const body = {
      challengeId,
      code: '123456',
      deviceId,
      platform: 'ios',
      issuedSessionTransportClass: 'native',
      verifiedBFFAuthority: authority,
    };

    await expect(controller.verifyEmail(request, body)).resolves.toEqual({
      sessionId: 'email-session',
    });
    expect(auth.verifyEmailChallenge).toHaveBeenCalledWith(
      { challengeId, code: '123456', deviceId },
      'web',
      'web_bff',
    );
  });

  it('keeps headerless native email issuance native despite forged body metadata', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = { issuedSessionTransportClass: 'native' };

    await controller.verifyEmail(request, {
      challengeId,
      code: '123456',
      deviceId,
      platform: 'web',
      issuedSessionTransportClass: 'web_bff',
    });

    expect(auth.verifyEmailChallenge).toHaveBeenCalledWith(
      { challengeId, code: '123456', deviceId },
      'ios',
      'native',
    );
  });

  it('uses verifier-attached transport for Apple and Google instead of caller fields', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = {
      issuedSessionTransportClass: 'web_bff',
      verifiedBFFAuthority: authority,
    };
    const nonce = 'nonce-with-at-least-thirty-two-random-characters';

    await controller.apple(request, {
      identityToken: 'apple-token',
      nonce,
      deviceId,
      platform: 'web',
      issuedSessionTransportClass: 'native',
    });
    await controller.google(request, {
      idToken: 'google-token',
      deviceId,
      platform: 'ios',
      issuedSessionTransportClass: 'native',
    });

    expect(auth.authenticateApple).toHaveBeenCalledWith(
      {
        identityToken: 'apple-token',
        nonce,
        deviceId,
        platform: 'web',
      },
      'web_bff',
    );
    expect(auth.authenticateGoogle).toHaveBeenCalledWith(
      {
        idToken: 'google-token',
        deviceId,
      },
      'web_bff',
    );
  });

  it('passes only the guard-derived request channel into refresh', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = {
      sessionRequestChannel: 'headerless_native',
    };

    await expect(
      controller.refresh(request, {
        refreshToken: 'refresh-token',
        deviceId,
        sessionRequestChannel: 'consumer_web',
      }),
    ).resolves.toEqual({ sessionId: 'refresh-session' });
    expect(auth.refresh).toHaveBeenCalledWith(
      'refresh-token',
      deviceId,
      'web',
      undefined,
      'headerless_native',
      undefined,
      undefined,
    );
  });

  it('parses optional refresh recovery material while caller transport fields remain powerless', async () => {
    const { auth, controller } = harness();
    const key = '019b0000-0000-7000-8000-000000000010';
    const proof = {
      bindingId: '019b0000-0000-7000-8000-000000000011',
      generation: 3,
      proof: Buffer.alloc(32, 23).toString('base64url'),
      proofClass: 'persistent',
    };
    const request: IssuanceRequest = {
      verifiedBFFAuthority: authority,
      sessionRequestChannel: 'verified_bff',
    };

    await expect(
      controller.refresh(
        request,
        {
          refreshToken: 'current-refresh-token',
          deviceId,
          deviceBindingProof: proof,
          platform: 'ios',
          transportClass: 'native',
          sessionRequestChannel: 'headerless_native',
        },
        key,
      ),
    ).resolves.toEqual({ sessionId: 'refresh-session' });

    expect(auth.refresh).toHaveBeenCalledWith(
      'current-refresh-token',
      deviceId,
      'web',
      authority,
      'verified_bff',
      key,
      proof,
    );
  });

  it('rejects a malformed optional idempotency key or non-persistent proof before AuthService', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = { sessionRequestChannel: 'headerless_native' };

    await expect(
      Promise.resolve().then(() =>
        controller.refresh(
          request,
          {
            refreshToken: 'current-refresh-token',
            deviceId,
          },
          'not-a-uuid',
        ),
      ),
    ).rejects.toBeDefined();

    await expect(
      Promise.resolve().then(() =>
        controller.refresh(request, {
          refreshToken: 'current-refresh-token',
          deviceId,
          deviceBindingProof: {
            bindingId: '019b0000-0000-7000-8000-000000000011',
            generation: 3,
            proof: 'migration-temporary-proof-material-001',
            proofClass: 'migration_temporary',
          },
        }),
      ),
    ).rejects.toBeDefined();

    expect(auth.refresh).not.toHaveBeenCalled();
  });

  it('passes only parsed persistent proof and guard-derived authority into read-only bootstrap', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = {
      verifiedBFFAuthority: authority,
      sessionRequestChannel: 'verified_bff',
    };

    await expect(
      controller.bootstrap(request, {
        refreshToken: 'current-refresh-token',
        deviceId,
        deviceBindingProof: bootstrapProof,
      }),
    ).resolves.toEqual({ sessionId: 'bootstrap-session' });

    expect(auth.bootstrap).toHaveBeenCalledWith(
      'current-refresh-token',
      deviceId,
      bootstrapProof,
      authority,
      'verified_bff',
    );
  });

  it('rejects caller platform, transport, and authority fields instead of silently stripping them', async () => {
    const { auth, controller } = harness();

    await expect(
      Promise.resolve().then(() =>
        controller.bootstrap(
          {
            verifiedBFFAuthority: authority,
            sessionRequestChannel: 'verified_bff',
          },
          {
            refreshToken: 'current-refresh-token',
            deviceId,
            deviceBindingProof: bootstrapProof,
            platform: 'ios',
            transportClass: 'native',
            verifiedBFFAuthority: { forged: true },
          },
        ),
      ),
    ).rejects.toBeDefined();
    expect(auth.bootstrap).not.toHaveBeenCalled();
  });

  it('requires an exact persistent binding proof for bootstrap before AuthService', async () => {
    const { auth, controller } = harness();

    await expect(
      Promise.resolve().then(() =>
        controller.bootstrap(
          { sessionRequestChannel: 'headerless_native' },
          {
            refreshToken: 'current-refresh-token',
            deviceId,
            deviceBindingProof: {
              bindingId: '019b0000-0000-7000-8000-000000000011',
              generation: 3,
              proof: 'persistent-device-proof-material-0001',
              proofClass: 'migration_temporary',
            },
          },
        ),
      ),
    ).rejects.toBeDefined();
    expect(auth.bootstrap).not.toHaveBeenCalled();
  });

  it('passes a strict first-binding upgrade request and only guard-derived BFF authority', async () => {
    const { auth, controller } = harness();
    const request: IssuanceRequest = {
      verifiedBFFAuthority: authority,
      sessionRequestChannel: 'verified_bff',
    };
    const attemptId = '019b0000-0000-7000-8000-000000000012';
    const body = {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      attemptId,
      newBinding: {
        bindingId: bootstrapProof.bindingId,
        generation: 0,
        proof: bootstrapProof.proof,
        proofClass: 'persistent',
      },
    };

    await expect(controller.upgradeDeviceBinding(request, body)).resolves.toEqual({
      sessionId: bootstrapSessionId,
      bindingId: bootstrapProof.bindingId,
    });
    expect(auth.upgradeDeviceBinding).toHaveBeenCalledWith(
      body,
      authority,
      'verified_bff',
    );
  });

  it.each([
    ['temporary new proof', {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      attemptId: '019b0000-0000-7000-8000-000000000012',
      newBinding: {
        bindingId: bootstrapProof.bindingId,
        generation: 0,
        proof: bootstrapProof.proof,
        proofClass: 'migration_temporary',
      },
    }],
    ['non-zero first generation', {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      attemptId: '019b0000-0000-7000-8000-000000000012',
      newBinding: { ...bootstrapProof, generation: 1 },
    }],
    ['caller authority field', {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      attemptId: '019b0000-0000-7000-8000-000000000012',
      newBinding: { ...bootstrapProof, generation: 0 },
      verifiedBFFAuthority: authority,
    }],
    ['canonically equivalent Unicode proof', {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      attemptId: '019b0000-0000-7000-8000-000000000012',
      newBinding: {
        ...bootstrapProof,
        generation: 0,
        proof: `${'A'.repeat(31)}e\u0301`,
      },
    }],
    ['non-canonical base64url proof', {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      attemptId: '019b0000-0000-7000-8000-000000000012',
      newBinding: {
        ...bootstrapProof,
        generation: 0,
        proof: `${Buffer.alloc(32, 47).toString('base64url').slice(0, -1)}9`,
      },
    }],
  ] as const)('rejects %s before the binding service can mutate', async (_label, body) => {
    const { auth, controller } = harness();

    await expect(Promise.resolve().then(() => controller.upgradeDeviceBinding({
      verifiedBFFAuthority: authority,
      sessionRequestChannel: 'verified_bff',
    }, body))).rejects.toBeDefined();
    expect(auth.upgradeDeviceBinding).not.toHaveBeenCalled();
  });

  it('passes a guard-classified headerless Google request through as native', async () => {
    const { auth, controller } = harness();

    await controller.google(
      { issuedSessionTransportClass: 'native' },
      {
        idToken: 'native-google-token',
        deviceId,
      },
    );

    expect(auth.authenticateGoogle).toHaveBeenCalledWith(
      {
        idToken: 'native-google-token',
        deviceId,
      },
      'native',
    );
  });

  it('fails closed when a public issuance route lacks a guard decision', async () => {
    const { auth, controller } = harness();
    let thrown: unknown;

    try {
      await controller.google({}, { idToken: 'google-token', deviceId });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ code: 'SESSION_TRANSPORT_MISMATCH', status: 403 });
    expect(auth.authenticateGoogle).not.toHaveBeenCalled();
  });

  it('passes the authenticated session and verified authority into merge commit', async () => {
    const { auth, controller } = harness();
    const user: AuthenticatedUser = {
      id: '019b0000-0000-7000-8000-000000000001',
      sessionId: '019b0000-0000-7000-8000-000000000002',
      phoneVerified: true,
      restrictions: [],
      roles: ['user'],
    };
    const request: IssuanceRequest = {
      verifiedBFFAuthority: authority,
      sessionRequestChannel: 'verified_bff',
    };
    const key = '019b0000-0000-7000-8000-000000000010';
    const body = {
      jobId: '019b0000-0000-7000-9000-000000000001',
      mergeToken: 'merge-proof-with-more-than-thirty-two-characters',
      deviceId,
      platform: 'ios',
      issuedSessionTransportClass: 'native',
    };

    await expect(controller.mergeCommit(user, request, key, body)).resolves.toEqual({
      sessionId: 'merge-session',
    });
    expect(auth.mergeCommit).toHaveBeenCalledWith(
      user.id,
      user.sessionId,
      key,
      {
        jobId: body.jobId,
        mergeToken: body.mergeToken,
        deviceId,
        platform: 'ios',
      },
      authority,
      'verified_bff',
    );
  });
});

describe('Auth bootstrap global guard to controller chain', () => {
  it('classifies a headerless current native credential before invoking the controller', async () => {
    const { auth, controller } = harness();
    const body = {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      deviceBindingProof: bootstrapProof,
    };
    const request: IssuanceRequest & {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: typeof body;
    } = {
      method: 'POST',
      url: '/v1/auth/bootstrap',
      headers: {},
      body,
    };
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{ transport_class: 'native' }],
        rowCount: 1,
      }),
    };
    const bffAuthority = {
      hasAuthorityHeaders: vi.fn().mockReturnValue(false),
      verifyRequest: vi.fn(),
    };
    const guard = new WebBFFTransportGuard(database as never, bffAuthority as never);

    await expect(guard.canActivate(guardContext(request))).resolves.toBe(true);
    await expect(controller.bootstrap(request, body)).resolves.toEqual({
      sessionId: 'bootstrap-session',
    });

    expect(request).toMatchObject({ sessionRequestChannel: 'headerless_native' });
    expect(bffAuthority.verifyRequest).not.toHaveBeenCalled();
    expect(auth.bootstrap).toHaveBeenCalledWith(
      bootstrapRefreshToken,
      deviceId,
      bootstrapProof,
      undefined,
      'headerless_native',
    );
  });

  it('verifies and attaches BFF authority for a current Web credential before invoking the controller', async () => {
    const { auth, controller } = harness();
    const body = {
      refreshToken: bootstrapRefreshToken,
      deviceId,
      deviceBindingProof: bootstrapProof,
    };
    const request: IssuanceRequest & {
      method: string;
      url: string;
      headers: Record<string, string>;
      body: typeof body;
    } = {
      method: 'POST',
      url: '/v1/auth/bootstrap',
      headers: { 'x-spott-bff-version': 'v1' },
      body,
    };
    const database = {
      query: vi.fn().mockResolvedValue({
        rows: [{ transport_class: 'web_bff' }],
        rowCount: 1,
      }),
    };
    const bffAuthority = {
      hasAuthorityHeaders: vi.fn().mockReturnValue(true),
      verifyRequest: vi.fn().mockResolvedValue(authority),
    };
    const guard = new WebBFFTransportGuard(database as never, bffAuthority as never);

    await expect(guard.canActivate(guardContext(request))).resolves.toBe(true);
    await expect(controller.bootstrap(request, body)).resolves.toEqual({
      sessionId: 'bootstrap-session',
    });

    expect(request).toMatchObject({
      verifiedBFFAuthority: authority,
      sessionRequestChannel: 'verified_bff',
    });
    expect(bffAuthority.verifyRequest).toHaveBeenCalledWith(request);
    expect(auth.bootstrap).toHaveBeenCalledWith(
      bootstrapRefreshToken,
      deviceId,
      bootstrapProof,
      authority,
      'verified_bff',
    );
  });
});
