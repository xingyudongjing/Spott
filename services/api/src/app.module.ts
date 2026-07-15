import { Module } from '@nestjs/common';
import { AuthModule } from './modules/auth/auth.module.js';
import { AnalyticsModule } from './modules/analytics/analytics.module.js';
import { CommunityModule } from './modules/community/community.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { GroupsModule } from './modules/groups/groups.module.js';
import { GrowthModule } from './modules/growth/growth.module.js';
import { HealthController } from './modules/health/health.controller.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { MediaModule } from './modules/media/media.module.js';
import { OpsModule } from './modules/ops/ops.module.js';
import { PointsModule } from './modules/points/points.module.js';
import { ProfilesModule } from './modules/profiles/profiles.module.js';
import { RegistrationsModule } from './modules/registrations/registrations.module.js';
import { SafetyModule } from './modules/safety/safety.module.js';
import { StoreKitModule } from './modules/storekit/storekit.module.js';
import { SyncModule } from './modules/sync/sync.module.js';
import { DatabaseModule } from './platform/database.js';
import { PlatformModule } from './platform/platform.module.js';

@Module({
  imports: [
    DatabaseModule,
    PlatformModule,
    AuthModule,
    AnalyticsModule,
    ProfilesModule,
    PointsModule,
    StoreKitModule,
    EventsModule,
    RegistrationsModule,
    GroupsModule,
    GrowthModule,
    CommunityModule,
    MediaModule,
    NotificationsModule,
    SafetyModule,
    SyncModule,
    OpsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
