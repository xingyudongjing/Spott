import { Module } from '@nestjs/common';
import { StoreKitController } from './storekit.controller.js';
import { StoreKitService } from './storekit.service.js';

@Module({ controllers: [StoreKitController], providers: [StoreKitService] })
export class StoreKitModule {}
