import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { EventsModule } from '../events/events.module.js';
import { OpsController } from './ops.controller.js';
import { OpsService } from './ops.service.js';

@Module({ imports: [AuthModule, EventsModule], controllers: [OpsController], providers: [OpsService] })
export class OpsModule {}
