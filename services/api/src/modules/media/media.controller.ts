import { Body, Controller, Headers, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../platform/request-context.js';
import { MediaService } from './media.service.js';

@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload-intents')
  createIntent(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z.object({
      purpose: z.enum(['event_cover', 'profile_avatar', 'group_cover', 'report_evidence', 'share_poster']),
      filename: z.string().min(1).max(255),
      mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/heic']),
      byteSize: z.number().int().min(1).max(20 * 1024 * 1024),
      focalX: z.number().min(0).max(1).default(0.5),
      focalY: z.number().min(0).max(1).default(0.5),
    }).parse(body);
    return this.media.createIntent(user, input);
  }

  @Post(':id/complete')
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('x-content-sha256') hash: string,
  ) {
    return this.media.complete(user, id, z.string().regex(/^[a-f0-9]{64}$/i).parse(hash));
  }

  @Post(':id/attach/event/:eventId')
  attachEvent(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ kind: z.enum(['cover', 'gallery']).default('cover'), sortOrder: z.number().int().min(0).max(5).default(0) }).parse(body);
    return this.media.attachEvent(user, id, eventId, input);
  }

  @Post(':id/attach/profile')
  attachProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.media.attachProfile(user, id);
  }

  @Post(':id/attach/group/:groupId')
  attachGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('groupId') groupId: string,
  ) {
    return this.media.attachGroup(user, id, groupId);
  }
}
