import { Body, Controller, Get, Query, Post } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, Public, type AuthenticatedUser } from '../../platform/request-context.js';
import { PointsService } from './points.service.js';

@Controller()
export class PointsController {
  constructor(private readonly points: PointsService) {}

  @Get('wallet')
  wallet(@CurrentUser() user: AuthenticatedUser) {
    return this.points.wallet(user.id);
  }

  @Get('wallet/transactions')
  transactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.points.transactions(user.id, cursor, limit ? Number(limit) : 20);
  }

  @Public()
  @Get('points/rules')
  rules() {
    return this.points.rules();
  }

  @Post('quotes')
  quote(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z.object({ purpose: z.string(), resourceId: z.string().uuid().optional() }).parse(body);
    return this.points.createQuote(user.id, input.purpose, input.resourceId);
  }
}
