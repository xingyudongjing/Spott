import { Module } from '@nestjs/common';
import { EventsController } from './events.controller.js';
import { EventsService } from './events.service.js';
import { EventPromotionService } from './events.promotion.service.js';
import { EventAnnouncementsService } from './event-announcements.service.js';

@Module({
  controllers: [EventsController],
  providers: [EventsService, EventPromotionService, EventAnnouncementsService],
  exports: [EventsService, EventPromotionService, EventAnnouncementsService],
})
export class EventsModule {}
