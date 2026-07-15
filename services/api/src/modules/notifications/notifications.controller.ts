import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../platform/request-context.js';
import { NotificationsService } from './notifications.service.js';

@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('locale') locale?: string,
  ) {
    const parsedLocale = locale ? z.enum(['zh-Hans', 'ja', 'en']).parse(locale) : undefined;
    return this.notifications.list(user.id, cursor, limit ? Number(limit) : 20, parsedLocale);
  }

  @Put(['items/:id/read', ':id/read'])
  @HttpCode(204)
  async read(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.notifications.markRead(user.id, id);
  }

  @Post('device-tokens')
  registerDevice(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z.object({
      deviceId: z.string().uuid().optional(),
      platform: z.enum(['ios', 'web']),
      token: z.string().min(16).max(4096),
      environment: z.enum(['sandbox', 'production']).default('production'),
    }).parse(body);
    return this.notifications.registerDevice(user.id, input);
  }

  @Delete('device-tokens/:tokenHash')
  @HttpCode(204)
  async disableDevice(@CurrentUser() user: AuthenticatedUser, @Param('tokenHash') tokenHash: string): Promise<void> {
    await this.notifications.disableDevice(user.id, tokenHash);
  }

  @Get('preferences')
  preferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.preferences(user.id);
  }

  @Put('preferences/:type')
  updatePreference(@CurrentUser() user: AuthenticatedUser, @Param('type') type: string, @Body() body: unknown) {
    const input = z.object({
      inApp: z.boolean().default(true), push: z.boolean().default(true), email: z.boolean().default(false),
      quietStart: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      quietEnd: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
      locale: z.enum(['zh-Hans', 'ja', 'en']).default('zh-Hans'),
    }).parse(body);
    return this.notifications.updatePreference(user.id, z.string().regex(/^[a-z0-9_.-]{3,80}$/).parse(type), input);
  }
}
