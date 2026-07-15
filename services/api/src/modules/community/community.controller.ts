import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../platform/request-context.js';
import { CommunityService } from './community.service.js';

@Controller()
export class CommunityController {
  constructor(private readonly community: CommunityService) {}

  @Post('registrations/:id/feedback')
  feedback(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: unknown) {
    const input = z.object({
      attendanceRating: z.number().int().min(1).max(5),
      tags: z.array(z.enum(['friendly', 'well_organized', 'clear_information', 'safe', 'would_join_again'])).max(5).default([]),
      comment: z.string().max(500).optional(),
      visibility: z.enum(['private', 'aggregate_only']).default('aggregate_only'),
    }).parse(body);
    return this.community.feedback(user.id, id, input);
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
}
