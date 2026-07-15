import { Module } from '@nestjs/common';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { SyncController } from './sync.controller.js';
import { SyncService } from './sync.service.js';

@Module({ imports: [ProfilesModule], controllers: [SyncController], providers: [SyncService] })
export class SyncModule {}
