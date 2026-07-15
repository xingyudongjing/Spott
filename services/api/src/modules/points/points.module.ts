import { Global, Module } from '@nestjs/common';
import { PointsController } from './points.controller.js';
import { PointsService } from './points.service.js';

@Global()
@Module({ controllers: [PointsController], providers: [PointsService], exports: [PointsService] })
export class PointsModule {}
