import { describe, expect, it, vi } from 'vitest';
import { MEDIA_CONTENT_TYPES, MediaContentParserRegistrar } from './media-content-parser.js';

describe('MediaContentParserRegistrar', () => {
  it('hands supported image streams to the media gateway without aggregate parsing', () => {
    const parsers = new Map<string, (...args: never[]) => void>();
    const instance = {
      hasContentTypeParser: vi.fn().mockReturnValue(false),
      addContentTypeParser: vi.fn((type: string, parser: (...args: never[]) => void) => {
        parsers.set(type, parser);
      }),
    };
    const registrar = new MediaContentParserRegistrar({
      httpAdapter: { getInstance: () => instance },
    } as never);

    registrar.onModuleInit();

    expect(instance.addContentTypeParser).toHaveBeenCalledTimes(MEDIA_CONTENT_TYPES.length);
    expect(instance.addContentTypeParser.mock.calls.every((call) => call.length === 2)).toBe(true);
    const payload = { pipe: vi.fn() };
    const done = vi.fn();
    parsers.get('image/jpeg')?.({} as never, payload as never, done as never);
    expect(done).toHaveBeenCalledWith(null, payload);
  });
});
