import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser, type SpottRequest } from '../../platform/request-context.js';
import { GrowthService } from './growth.service.js';
import { ReferralService } from './referral.service.js';

@Controller()
export class GrowthController {
  constructor(
    private readonly growth: GrowthService,
    private readonly referral: ReferralService,
  ) {}

  @Post('shares')
  createShare(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z.object({
      resourceType: z.enum(['event', 'group', 'profile']),
      resourceId: z.string().uuid(),
      campaign: z.string().max(80).optional(),
      channel: z.enum(['copy_link', 'line', 'x', 'instagram', 'qr', 'other']).optional(),
      purpose: z.enum(['share', 'invite']).default('share'),
    }).parse(body);
    return this.growth.createShare(user.id, input);
  }

  @Post('shares/:code/accept')
  acceptInvite(@CurrentUser() user: AuthenticatedUser, @Param('code') code: string) {
    return this.referral.acceptInvite(user.id, code);
  }

  @Public()
  @Get('shares/:code')
  open(@Req() request: SpottRequest, @Param('code') code: string) {
    const sessionHeader = request.headers['x-spott-session-id'];
    const anonymousHeader = request.headers['x-spott-anonymous-id'];
    return this.growth.open(
      code,
      Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader,
      Array.isArray(anonymousHeader) ? anonymousHeader[0] : anonymousHeader,
      request.user?.id,
    );
  }

  @Post('posters')
  createPoster(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z.object({
      resourceType: z.enum(['event', 'group', 'profile']),
      resourceId: z.string().uuid(),
      template: z.enum(['tokyo_afterglow', 'night_transit', 'paper_lantern']).default('tokyo_afterglow'),
      locale: z.enum(['zh-Hans', 'zh-Hant', 'ja', 'en']).default('zh-Hans'),
      mode: z.enum(['template', 'ai_assisted']).default('template'),
    }).parse(body);
    return this.growth.createPoster(user, input);
  }

  @Get('posters/:id')
  poster(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.growth.poster(user.id, id);
  }

  @Get('events/:id/poster')
  eventPoster(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.growth.eventPoster(user, id);
  }
}
