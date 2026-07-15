import { Module } from '@nestjs/common';
import { GrowthController } from './growth.controller.js';
import { GrowthService } from './growth.service.js';

@Module({ controllers: [GrowthController], providers: [GrowthService] })
export class GrowthModule {}
