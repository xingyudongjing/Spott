import { Module } from '@nestjs/common';
import { GroupsController } from './groups.controller.js';
import { GroupsService } from './groups.service.js';

@Module({ controllers: [GroupsController], providers: [GroupsService] })
export class GroupsModule {}
