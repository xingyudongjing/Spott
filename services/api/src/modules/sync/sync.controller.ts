import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, type AuthenticatedUser } from '../../platform/request-context.js';
import { SyncService } from './sync.service.js';

@Controller('sync')
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('pull')
  pull(
    @CurrentUser() user: AuthenticatedUser,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.sync.pull(user.id, Number(cursor ?? 0), Number(limit ?? 500));
  }

  @Post('push')
  push(@CurrentUser() user: AuthenticatedUser, @Body() body: unknown) {
    const input = z
      .object({
        deviceId: z.string().uuid(),
        operations: z
          .array(
            z.object({
              operationId: z.string().uuid(),
              entityType: z.string(),
              entityId: z.string().uuid().nullable().optional(),
              action: z.string(),
              baseVersion: z.number().int().positive().nullable().optional(),
              patch: z.record(z.string(), z.unknown()).optional(),
            }),
          )
          .min(1)
          .max(50),
      })
      .parse(body);
    return this.sync.push(user.id, input.deviceId, input.operations);
  }
}
