import { ForbiddenException } from '@nestjs/common';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { configuration } from '../config.js';
import { AccessTokenGuard } from './auth.guard.js';

process.env.DATABASE_URL ??= 'postgres://spott:spott@127.0.0.1:55432/spott';
process.env.ACCESS_TOKEN_SECRET ??= 'test-access-token-secret-at-least-32-bytes';
process.env.REFRESH_TOKEN_SECRET ??= 'test-refresh-token-secret-at-least-32-bytes';
process.env.FIELD_ENCRYPTION_KEY_BASE64 ??= Buffer.alloc(32).toString('base64');
process.env.LOOKUP_HMAC_PEPPER ??= 'test-lookup-pepper-at-least-16';
process.env.OPS_ORIGIN ??= 'https://ops.spott.test';

async function opsCookie(): Promise<string> {
  const token = await new SignJWT({
    sid: '019b0000-0000-7000-8000-000000000099',
    roles: ['operator', 'auditReader'],
    phoneVerified: true,
    restrictions: [],
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('spott-api')
    .setAudience('spott-clients')
    .setSubject('019b0000-0000-7000-8000-000000000004')
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(new TextEncoder().encode(configuration().ACCESS_TOKEN_SECRET));
  return `__Host-spott_ops=${encodeURIComponent(token)}`;
}

function context(request: Record<string, unknown>): any {
  return {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  };
}

describe('AccessTokenGuard Ops cookie authentication', () => {
  it('accepts a valid HttpOnly Ops access cookie and attaches its operator claims', async () => {
    const request = { method: 'GET', headers: { cookie: await opsCookie() } } as Record<string, any>;
    const guard = new AccessTokenGuard({ getAllAndOverride: () => false } as never);

    await expect(guard.canActivate(context(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({
      id: '019b0000-0000-7000-8000-000000000004',
      roles: ['operator', 'auditReader'],
    });
  });

  it('rejects cookie-authenticated mutations from an untrusted Origin', async () => {
    const request = {
      method: 'POST',
      headers: { cookie: await opsCookie(), origin: 'https://attacker.example' },
    };
    const guard = new AccessTokenGuard({ getAllAndOverride: () => false } as never);

    await expect(guard.canActivate(context(request))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
