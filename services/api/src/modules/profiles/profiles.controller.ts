import { Body, Controller, Delete, Get, Headers, Param, Patch, Put, Query, Req } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { z } from 'zod';
import {
  CurrentUser,
  Public,
  type AuthenticatedUser,
  type SpottRequest,
} from '../../platform/request-context.js';
import { ProfilesService } from './profiles.service.js';

@Controller()
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('me/profile')
  get(@CurrentUser() user: AuthenticatedUser) {
    return this.profiles.get(user.id);
  }

  @Patch('me/profile')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Headers('if-match') ifMatch: string,
    @Body() body: unknown,
  ) {
    const match = ifMatch?.match(/^"([1-9][0-9]*)"$/);
    if (!match) throw new DomainError('VERSION_REQUIRED', '请求缺少有效的 If-Match 版本。', 400);
    const patch = z
      .object({
        nickname: z.string().min(1).max(40).optional(),
        bio: z.string().max(500).optional(),
        regionId: z.string().max(80).optional(),
        preferredLocale: z.enum(['zh-Hans', 'ja', 'en']).optional(),
        contentLanguages: z.array(z.enum(['zh-Hans', 'ja', 'en'])).min(1).max(3).optional(),
      })
      .parse(body);
    return this.profiles.update(user.id, Number(match[1]), patch);
  }

  @Public()
  @Get('profiles/:id')
  publicProfile(@Req() request: SpottRequest, @Param('id') id: string) {
    return this.profiles.getPublic(id, request.user?.id);
  }

  @Public()
  @Get('profiles/:id/events')
  publicEvents(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.profiles.publicEvents(id, cursor, limit ? Number(limit) : 20);
  }

  @Put('profiles/:id/follow')
  follow(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.profiles.setFollow(user.id, id, true);
  }

  @Delete('profiles/:id/follow')
  unfollow(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.profiles.setFollow(user.id, id, false);
  }
}
