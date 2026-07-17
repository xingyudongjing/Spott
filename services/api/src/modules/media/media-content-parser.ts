import { Injectable, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

export const MEDIA_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const;

interface ContentParserInstance {
  hasContentTypeParser(contentType: string): boolean;
  addContentTypeParser(
    contentType: string,
    parser: (request: unknown, payload: unknown, done: (error: Error | null, body: unknown) => void) => void,
  ): void;
}

@Injectable()
export class MediaContentParserRegistrar implements OnModuleInit {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  onModuleInit(): void {
    const value: unknown = this.adapterHost.httpAdapter?.getInstance();
    if (!this.isContentParserInstance(value)) return;
    for (const contentType of MEDIA_CONTENT_TYPES) {
      if (value.hasContentTypeParser(contentType)) continue;
      value.addContentTypeParser(contentType, (_request, payload, done) => {
        // No parseAs option: ownership of backpressure, size and deadline stays
        // with the media gateway instead of Fastify's 1 MiB aggregate parser.
        done(null, payload);
      });
    }
  }

  private isContentParserInstance(value: unknown): value is ContentParserInstance {
    if (!value || typeof value !== 'object') return false;
    const candidate = value as Record<string, unknown>;
    return typeof candidate.hasContentTypeParser === 'function'
      && typeof candidate.addContentTypeParser === 'function';
  }
}
