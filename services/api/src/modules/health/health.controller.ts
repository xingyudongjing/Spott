import { Controller, Get, Req } from '@nestjs/common';
import type { SpottRequest } from '../../platform/request-context.js';
import { Public } from '../../platform/request-context.js';
import { Database } from '../../platform/database.js';

@Controller('health')
export class HealthController {
  constructor(private readonly database: Database) {}

  @Public()
  @Get()
  async health(@Req() request: SpottRequest): Promise<unknown> {
    const postgres = await this.database.health();
    return {
      status: postgres === 'ok' ? 'ok' : 'degraded',
      version: process.env.APP_VERSION ?? 'development',
      requestId: request.requestId,
      dependencies: { postgres },
    };
  }
}
