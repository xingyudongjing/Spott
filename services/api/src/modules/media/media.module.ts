import { Module } from '@nestjs/common';
import { MediaContentParserRegistrar } from './media-content-parser.js';
import { MediaController } from './media.controller.js';
import { MediaObjectStore } from './media-object-store.js';
import { MediaService } from './media.service.js';

@Module({
  controllers: [MediaController],
  providers: [MediaContentParserRegistrar, MediaObjectStore, MediaService],
  exports: [MediaService],
})
export class MediaModule {}
