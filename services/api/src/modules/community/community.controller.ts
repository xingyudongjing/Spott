import { Body, Controller, Get, Headers, Param, Post } from '@nestjs/common';
import { DomainError } from '@spott/domain';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../platform/request-context.js';
import { CommunityService } from './community.service.js';

@Controller()
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Post('registrations/:id/feedback')
  feedback(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Headers('idempotency-key') key: string,
    @Body() body: unknown,
  ) {
    const input = z.object({
      attendanceRating: z.number().int().min(1).max(5),
      tags: z.array(z.enum(['friendly', 'well_organized', 'clear_information', 'safe', 'would_join_again'])).max(5).default([]),
      comment: z.string().max(500).optional(),
      visibility: z.enum(['private', 'aggregate_only']).default('aggregate_only'),
    }).parse(body);
    return this.community.feedback(user.id, id, this.key(key), input);
  }

  @Get('registrations/:id/feedback')
  ownFeedback(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.community.ownFeedback(user.id, id);
  }

  @Public()
  @Get('events/:id/feedback-summary')
  summary(@Param('id') id: string) {
    return this.community.feedbackSummary(id);
  }

  @Get('events/:id/feedback/private')
  privateFeedback(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.community.privateFeedback(user, id);
  }

  @Get('me/achievements')
  achievements(@CurrentUser() user: AuthenticatedUser) {
    return this.community.achievements(user.id);
  }

  @Post('me/achievements/evaluate')
  evaluate(@CurrentUser() user: AuthenticatedUser) {
    return this.community.evaluateAchievements(user.id);
  }

  private key(value: string | undefined): string {
    if (!value || !z.string().uuid().safeParse(value).success) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', '请求缺少有效的幂等键。', 400);
    }
    return value;
  }
}
