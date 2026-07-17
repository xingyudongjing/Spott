import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Put, Req, Res } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
  type SpottRequest,
} from '../../platform/request-context.js';
import { MediaService } from './media.service.js';

interface IntentControllerResult {
  readonly status: 200 | 201;
  readonly body: unknown;
}

interface MediaIntentBoundary {
  createIntent(user: AuthenticatedUser, input: {
    purpose: 'event_cover' | 'profile_avatar' | 'group_cover' | 'report_evidence' | 'share_poster';
    filename: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
    byteSize: number;
    focalX: number;
    focalY: number;
    contentSha256: string;
  }, key: string): Promise<unknown>;
}

interface MediaMutationBoundary {
  complete(
    user: AuthenticatedUser,
    assetId: string,
    contentSha256: string,
    key: string,
  ): Promise<unknown>;
  abandon(user: AuthenticatedUser, assetId: string, key: string): Promise<unknown>;
  attachEvent(
    user: AuthenticatedUser,
    assetId: string,
    eventId: string,
    input: { kind: 'cover' | 'gallery'; sortOrder: number },
    key: string,
  ): Promise<unknown>;
  attachProfile(user: AuthenticatedUser, assetId: string, key: string): Promise<unknown>;
  attachGroup(user: AuthenticatedUser, assetId: string, groupId: string, key: string): Promise<unknown>;
  arrangeEvent(
    user: AuthenticatedUser,
    eventId: string,
    input: { orderedAssetIds: string[] },
    key: string,
  ): Promise<unknown>;
}

interface MediaGatewayBoundary {
  recoverAttempt(user: AuthenticatedUser, attemptId: string): Promise<unknown>;
  uploadContent(input: {
    attemptId: string;
    capability: string;
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic';
    byteSize: number;
    contentSha256: string;
    handlerStartedAt: number;
    stream: SpottRequest['raw'];
  }): Promise<unknown>;
}

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-intents')
  async createIntent(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const canonicalKey = this.key(key);
    const input = z.object({
      purpose: z.enum(['event_cover', 'profile_avatar', 'group_cover', 'report_evidence', 'share_poster']),
      filename: z.string().min(1).max(255),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
      byteSize: z.number().int().min(1).max(20 * 1024 * 1024),
      focalX: z.number().min(0).max(1).default(0.5),
      focalY: z.number().min(0).max(1).default(0.5),
      contentSha256: z.string().regex(/^[a-f0-9]{64}$/i).transform((value) => value.toLowerCase()),
    }).parse(body);
    const result = await (this.media as unknown as MediaIntentBoundary)
      .createIntent(user, input, canonicalKey);
    const response = this.intentResult(result);
    reply.status(response.status);
    this.noStore(reply);
    return response.body;
  }

  @Get('upload-attempts/:attemptId')
  async recoverAttempt(
    @CurrentUser() user: AuthenticatedUser,
    @Param('attemptId') attemptId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const response = await (this.media as unknown as MediaGatewayBoundary)
      .recoverAttempt(user, this.uuid(attemptId));
    this.noStore(reply);
    return response;
  }

  @Public()
  @Put('upload-attempts/:attemptId/content')
  uploadContent(
    @Param('attemptId') attemptId: string,
    @Headers('x-spott-upload-capability') capability: string | undefined,
    @Headers('content-type') mimeType: string | undefined,
    @Headers('content-length') byteSize: string | undefined,
    @Headers('x-content-sha256') hash: string | undefined,
    @Headers('cookie') cookie: string | undefined,
    @Headers('authorization') authorization: string | undefined,
    @Req() request: SpottRequest,
  ) {
    const handlerStartedAt = performance.now();
    if (cookie || authorization) {
      throw new DomainError(
        'MEDIA_GATEWAY_AMBIENT_CREDENTIALS_FORBIDDEN',
        '媒体上传网关不接受会话凭证。',
        400,
      );
    }
    const input = {
      attemptId: this.uuid(attemptId),
      capability: z.string().min(1).max(4096).regex(/^\S+$/).parse(capability),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']).parse(mimeType),
      byteSize: z.string().regex(/^[1-9][0-9]*$/)
        .transform((value) => Number(value))
        .pipe(z.number().int().max(20 * 1024 * 1024))
        .parse(byteSize),
      contentSha256: this.contentHash(hash),
      handlerStartedAt,
      stream: this.uploadStream(request),
    };
    return (this.media as unknown as MediaGatewayBoundary).uploadContent(input);
  }

  @Post(':id/complete')
  @HttpCode(200)
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
    @Headers('x-content-sha256') hash: string | undefined,
  ) {
    return (this.media as unknown as MediaMutationBoundary)
      .complete(user, id, this.contentHash(hash), this.key(key));
  }

  @Delete(':id')
  abandon(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return (this.media as unknown as MediaMutationBoundary).abandon(user, id, this.key(key));
  }

  @Post(':id/attach/event/:eventId')
  @HttpCode(200)
  attachEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const canonicalKey = this.key(key);
    const input = z.object({ kind: z.enum(['cover', 'gallery']).default('cover'), sortOrder: z.number().int().min(0).max(5).default(0) }).parse(body);
    return (this.media as unknown as MediaMutationBoundary)
      .attachEvent(user, id, eventId, input, canonicalKey);
  }

  @Post(':id/attach/profile')
  attachProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return (this.media as unknown as MediaMutationBoundary)
      .attachProfile(user, id, this.key(key));
  }

  @Post(':id/attach/group/:groupId')
  attachGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
    @Headers('idempotency-key') key: string | undefined,
  ) {
    return (this.media as unknown as MediaMutationBoundary)
      .attachGroup(user, id, groupId, this.key(key));
  }

  @Post('events/:eventId/arrangement')
  @HttpCode(200)
  arrangeEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('eventId') eventId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body() body: unknown,
  ) {
    const canonicalKey = this.key(key);
    const input = z.object({
      orderedAssetIds: z.array(z.string().uuid().transform((value) => value.toLowerCase()))
        .min(1).max(6)
        .refine((values) => new Set(values).size === values.length, 'orderedAssetIds 不得重复。'),
    }).parse(body);
    return (this.media as unknown as MediaMutationBoundary)
      .arrangeEvent(user, eventId, input, canonicalKey);
  }

  private key(value: string | undefined): string {
    const parsed = z.string().uuid().safeParse(value);
    if (!parsed.success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    }
    return parsed.data.toLowerCase();
  }

  private uploadStream(request: SpottRequest): SpottRequest['raw'] {
    const parsedBody = request.body as { pipe?: unknown } | undefined;
    return parsedBody && typeof parsedBody.pipe === 'function'
      ? parsedBody as SpottRequest['raw']
      : request.raw;
  }

  private uuid(value: string): string {
    return z.string().uuid().transform((id) => id.toLowerCase()).parse(value);
  }

  private contentHash(value: string | undefined): string {
    return z.string().regex(/^[a-f0-9]{64}$/i)
      .transform((hash) => hash.toLowerCase())
      .parse(value);
  }

  private intentResult(result: unknown): IntentControllerResult {
    if (result && typeof result === 'object' && 'status' in result && 'body' in result) {
      const candidate = result as Partial<IntentControllerResult>;
      if (candidate.status === 200 || candidate.status === 201) {
        return { status: candidate.status, body: candidate.body };
      }
    }
    return { status: 201, body: result };
  }

  private noStore(reply: FastifyReply): void {
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    reply.header('Referrer-Policy', 'no-referrer');
  }
}
