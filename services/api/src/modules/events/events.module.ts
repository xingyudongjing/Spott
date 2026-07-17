import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { EventPromotionService } from './events.promotion.service.js';

@Module({
  controllers: [EventsController],
  providers: [EventsService, EventPromotionService],
  exports: [EventsService, EventPromotionService],
})
export class EventsModule {}
