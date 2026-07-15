import { Body, Controller, Delete, Headers, HttpCode, Param, Post } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../platform/request-context.js';
import { AuthService } from './auth.service.js';

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('auth/email/challenges')
  createEmailChallenge(@Body() body: unknown) {
    const input = z.object({ email: z.string(), deviceId: z.string() }).parse(body);
    return this.auth.createEmailChallenge(input.email, input.deviceId);
  }

  @Public()
  @Post('auth/email/verify')
  verifyEmail(@Body() body: unknown) {
    const input = z
      .object({ challengeId: z.string(), code: z.string(), deviceId: z.string() })
      .parse(body);
    return this.auth.verifyEmailChallenge(input);
  }

  @Public()
  @Post('auth/apple')
  apple(@Body() body: unknown) {
    const input = z
      .object({
        identityToken: z.string().min(1),
        nonce: z.string().min(32).max(512),
        deviceId: z.string().uuid(),
        platform: z.enum(['ios', 'web']).default('ios'),
      })
      .parse(body);
    return this.auth.authenticateApple(input);
  }

  @Public()
  @Post('auth/google')
  google(@Body() body: unknown) {
    const input = z.object({ idToken: z.string(), deviceId: z.string() }).parse(body);
    return this.auth.authenticateGoogle(input);
  }

  @Public()
  @Post('auth/refresh')
  refresh(@Body() body: unknown) {
    const input = z.object({ refreshToken: z.string(), deviceId: z.string() }).parse(body);
    return this.auth.refresh(input.refreshToken, input.deviceId);
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(@CurrentUser() user: AuthenticatedUser, @Param('id') sessionId: string): Promise<void> {
    await this.auth.revokeSession(user.id, sessionId);
  }

  @Delete('sessions')
  revokeAll(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.revokeAllSessions(user.id);
  }

  @Post('phone/challenges')
  createPhoneChallenge(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z.object({ phoneNumber: z.string(), deviceId: z.string() }).parse(body);
    return this.auth.createPhoneChallenge(user.id, input.phoneNumber, input.deviceId);
  }

  @Post('phone/challenges/:id/verify')
  verifyPhone(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') challengeId: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ code: z.string() }).parse(body);
    return this.auth.verifyPhoneChallenge(user.id, challengeId, input.code);
  }

  @Post('accounts/merge/preview')
  @HttpCode(200)
  mergePreview(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const credential = z.discriminatedUnion('provider', [
      z.object({
        provider: z.literal('apple'),
        identityToken: z.string().min(1),
        nonce: z.string().min(32).max(512),
        platform: z.enum(['ios', 'web']).default('ios'),
      }),
      z.object({ provider: z.literal('google'), idToken: z.string().min(1) }),
      z.object({
        provider: z.literal('email'),
        challengeId: z.string().uuid(),
        code: z.string().regex(/^[0-9]{6}$/),
      }),
    ]).parse((body as { credential?: unknown } | null)?.credential);
    return this.auth.mergePreview(user.id, credential);
  }

  @Post('accounts/merge/commit')
  @HttpCode(200)
  mergeCommit(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      jobId: z.string().uuid(),
      mergeToken: z.string().min(32).max(256),
      deviceId: z.string().uuid(),
      platform: z.enum(['ios', 'web']).default('web'),
    }).parse(body);
    return this.auth.mergeCommit(user.id, this.key(key), input);
  }

  @Post('accounts/deletion-request')
  requestDeletion(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.requestDeletion(user.id);
  }

  @Delete('accounts/deletion-request')
  cancelDeletion(@CurrentUser() user: AuthenticatedUser) {
    return this.auth.cancelDeletion(user.id);
  }

  private key(value: string | undefined): string {
    if (!value || !z.string().uuid().safeParse(value).success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    }
    return value;
  }
}
