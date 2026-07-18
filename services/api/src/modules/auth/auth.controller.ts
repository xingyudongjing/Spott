import { Body, Controller, Delete, Headers, HttpCode, Param, Post, Req } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { z } from 'zod';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
  type SpottRequest,
} from '../../platform/request-context.js';
import type {
  SessionRequestChannel,
  SessionTransportClass,
} from '../../platform/web-bff-authority.js';
import { AuthService } from './auth.service.js';
import { isCanonicalPersistentDeviceBindingProof } from './session-token.service.js';

const persistentDeviceBindingProofSchema = z
  .object({
    bindingId: z.string().uuid(),
    generation: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    proof: z.string().refine(isCanonicalPersistentDeviceBindingProof),
    proofClass: z.literal('persistent'),
  })
  .strict();

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
  verifyEmail(@Req() request: SpottRequest, @Body() body: unknown) {
    const input = z
      .object({ challengeId: z.string(), code: z.string(), deviceId: z.string() })
      .parse(body);
    const transportClass = this.issuanceTransport(request);
    return this.auth.verifyEmailChallenge(
      input,
      transportClass === 'native' ? 'ios' : 'web',
      transportClass,
    );
  }

  @Public()
  @Post('auth/apple')
  apple(@Req() request: SpottRequest, @Body() body: unknown) {
    const input = z
      .object({
        identityToken: z.string().min(1),
        nonce: z.string().min(32).max(512),
        deviceId: z.string().uuid(),
        platform: z.enum(['ios', 'web']).default('ios'),
      })
      .parse(body);
    return this.auth.authenticateApple(input, this.issuanceTransport(request));
  }

  @Public()
  @Post('auth/google')
  google(@Req() request: SpottRequest, @Body() body: unknown) {
    const input = z.object({ idToken: z.string(), deviceId: z.string() }).parse(body);
    return this.auth.authenticateGoogle(input, this.issuanceTransport(request));
  }

  @Public()
  @Post('auth/refresh')
  refresh(
    @Req() request: SpottRequest,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    const input = z
      .object({
        refreshToken: z.string(),
        deviceId: z.string().uuid(),
        deviceBindingProof: persistentDeviceBindingProofSchema.optional(),
      })
      .parse(body);
    return this.auth.refresh(
      input.refreshToken,
      input.deviceId,
      'web',
      request.verifiedBFFAuthority,
      this.requestChannel(request),
      this.optionalKey(key),
      input.deviceBindingProof,
    );
  }

  @Public()
  @Post('auth/bootstrap')
  bootstrap(@Req() request: SpottRequest, @Body() body: unknown) {
    const input = z
      .object({
        refreshToken: z.string(),
        deviceId: z.string().uuid(),
        deviceBindingProof: persistentDeviceBindingProofSchema,
      })
      .strict()
      .parse(body);
    return this.auth.bootstrap(
      input.refreshToken,
      input.deviceId,
      input.deviceBindingProof,
      request.verifiedBFFAuthority,
      this.requestChannel(request),
    );
  }

  @Public()
  @Post('auth/device-binding/upgrade')
  @HttpCode(200)
  upgradeDeviceBinding(@Req() request: SpottRequest, @Body() body: unknown) {
    const input = z
      .object({
        refreshToken: z.string(),
        deviceId: z.string().uuid(),
        attemptId: z.string().uuid(),
        newBinding: persistentDeviceBindingProofSchema.extend({ generation: z.literal(0) }),
      })
      .strict()
      .parse(body);
    return this.auth.upgradeDeviceBinding(
      input,
      request.verifiedBFFAuthority,
      this.requestChannel(request),
    );
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') sessionId: string,
  ): Promise<void> {
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
    const credential = z
      .discriminatedUnion('provider', [
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
      ])
      .parse((body as { credential?: unknown } | null)?.credential);
    return this.auth.mergePreview(user.id, credential);
  }

  @Post('accounts/merge/commit')
  @HttpCode(200)
  mergeCommit(
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: SpottRequest,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z
      .object({
        jobId: z.string().uuid(),
        mergeToken: z.string().min(32).max(256),
        deviceId: z.string().uuid(),
        platform: z.enum(['ios', 'web']).default('web'),
      })
      .parse(body);
    return this.auth.mergeCommit(
      user.id,
      user.sessionId,
      this.key(key),
      input,
      request.verifiedBFFAuthority,
      this.requestChannel(request),
    );
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

  private optionalKey(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!z.string().uuid().safeParse(value).success) {
      throw new DomainError('IDEMPOTENCY_KEY_INVALID', '幂等键格式无效。', 400, {
        retryable: false,
      });
    }
    return value;
  }

  private issuanceTransport(request: SpottRequest): SessionTransportClass {
    const transportClass = request.issuedSessionTransportClass;
    if (!transportClass || transportClass === 'ops') {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道校验失败，请重新登录。', 403, {
        retryable: false,
      });
    }
    return transportClass;
  }

  private requestChannel(request: SpottRequest): SessionRequestChannel {
    if (!request.sessionRequestChannel) {
      throw new DomainError('SESSION_TRANSPORT_MISMATCH', '会话通道校验失败，请重新登录。', 403, {
        retryable: false,
      });
    }
    return request.sessionRequestChannel;
  }
}
