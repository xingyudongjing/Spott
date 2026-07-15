import { Body, Controller, Delete, Get, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../platform/request-context.js';
import { SafetyService } from './safety.service.js';

@Controller()
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Post('reports')
  report(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z
      .object({
        targetType: z.enum(['event', 'group', 'user', 'comment', 'announcement']),
        targetId: z.string().uuid(),
        reason: z.string().min(3).max(500),
        details: z.string().max(5000).optional(),
        evidenceAssetIds: z.array(z.string().uuid()).max(10).default([]),
      })
      .parse(body);
    return this.safety.report(user.id, input);
  }

  @Post('appeals')
  appeal(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z
      .object({
        caseId: z.string().uuid().optional(),
        caseReference: z.string().trim().transform((value) => value.toUpperCase())
          .pipe(z.string().regex(/^SPT-[0-9]{4}-[A-F0-9]{12}$/)).optional(),
        statement: z.string().trim().min(10).max(5000),
      })
      .refine((value) => Boolean(value.caseId) !== Boolean(value.caseReference), {
        path: ['caseReference'],
        message: 'caseReference 和 caseId 必须且只能提供一个。',
      })
      .parse(body);
    return this.safety.appeal(user.id, input);
  }

  @Get('me/safety-cases')
  cases(@CurrentUser() user: AuthenticatedUser) {
    return this.safety.cases(user.id);
  }

  @Get('me/blocks')
  blocks(@CurrentUser() user: AuthenticatedUser) {
    return this.safety.blocks(user.id);
  }

  @Put('users/:id/block')
  block(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = z.object({ reason: z.string().max(200).optional() }).default({}).parse(body ?? {});
    return this.safety.setBlock(user.id, id, true, input.reason);
  }

  @Delete('users/:id/block')
  unblock(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.safety.setBlock(user.id, id, false);
  }
}
