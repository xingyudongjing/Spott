import { Body, Controller, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { Public, type SpottRequest } from '../../platform/request-context.js';
import { AnalyticsService } from './analytics.service.js';

const eventSchema = z.object({
  eventName: z.string().regex(/^[a-z][a-z0-9_]{2,79}$/),
  schemaVersion: z.number().int().min(1).max(100).default(1),
  anonymousId: z.string().uuid().optional(),
  sessionId: z.string().uuid(),
  platform: z.enum(['ios', 'web', 'ops', 'server']),
  properties: z.record(z.string(), z.unknown()).default({}),
  traceId: z.string().max(120).optional(),
  occurredAt: z.iso.datetime(),
});

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Public()
  @Post('events/batch')
  ingest(@Req() request: SpottRequest, @Body() body: unknown) {
    const input = z.object({ events: z.array(eventSchema).min(1).max(100) }).parse(body);
    return this.analytics.ingest(request.user?.id, input.events);
  }
}
