import { Module } from '@nestjs/common';
import { GrowthController } from './growth.controller.js';
import { GrowthService } from './growth.service.js';
import { ReferralService } from './referral.service.js';

@Module({
  controllers: [GrowthController],
  providers: [GrowthService, ReferralService],
  exports: [ReferralService],
})
export class GrowthModule {}
