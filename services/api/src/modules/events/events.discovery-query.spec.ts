import { describe, expect, it, vi } from 'vitest';
import { draftSchema, EventsController } from './events.controller.js';
import { parseDiscoveryQuery } from './events.discovery-query.js';

describe('parseDiscoveryQuery', () => {
  it('parses every supported discovery filter', () => {
    const parsed = parseDiscoveryQuery({
      q: 'coffee',
      region: 'tokyo',
      category: 'food',
      startsAfter: '2026-07-16T00:00:00.000Z',
      startsBefore: '2026-07-20T00:00:00.000Z',
      availableOnly: 'true',
      format: 'hybrid',
      language: 'ja',
      price: 'free',
      bounds: '139.60,35.55,139.90,35.80',
      cursor: 'next-page',
      limit: '24',
    });

    expect(parsed).toEqual({
      query: 'coffee',
      region: 'tokyo',
      category: 'food',
      startsAfter: new Date('2026-07-16T00:00:00.000Z'),
      startsBefore: new Date('2026-07-20T00:00:00.000Z'),
      availableOnly: true,
      format: 'hybrid',
      language: 'ja',
      price: 'free',
      bounds: { west: 139.6, south: 35.55, east: 139.9, north: 35.8 },
      cursor: 'next-page',
      limit: 24,
    });
  });

  it.each([
    '139.6,35.5,139.9',
    '181,35.5,139.9,35.8',
    '139.9,35.5,139.6,35.8',
    '139.6,35.8,139.9,35.5',
    '139.6,,139.9,35.8',
  ])('rejects invalid bounds %s', (bounds) => {
    expect(() => parseDiscoveryQuery({ bounds })).toThrow();
  });

  it('rejects a start window whose end precedes its beginning', () => {
    expect(() => parseDiscoveryQuery({
      startsAfter: '2026-07-20T00:00:00.000Z',
      startsBefore: '2026-07-16T00:00:00.000Z',
    })).toThrow();
  });

  it('rejects an unsupported locale', () => {
    expect(() => parseDiscoveryQuery({ language: 'ko' })).toThrow();
  });

  it('rejects boolean spellings other than true and false', () => {
    expect(() => parseDiscoveryQuery({ availableOnly: '1' })).toThrow();
  });

  it.each(['1', '100'])('accepts limit %s', (limit) => {
    expect(parseDiscoveryQuery({ limit }).limit).toBe(Number(limit));
  });

  it.each(['0', '101', '1.5', 'not-a-number'])('rejects invalid limit %s', (limit) => {
    expect(() => parseDiscoveryQuery({ limit })).toThrow();
  });
});

describe('EventsController discovery query handling', () => {
  it.each(['discovery', 'search'] as const)('%s forwards the complete parsed query', async (method) => {
    const discovery = vi.fn().mockResolvedValue({ items: [] });
    const controller = new EventsController({ discovery } as never, {} as never) as unknown as Record<
      typeof method,
      (request: { user?: undefined }, query: Record<string, string>) => Promise<unknown>
    >;
    const rawQuery = {
      q: 'coffee',
      startsAfter: '2026-07-16T00:00:00.000Z',
      startsBefore: '2026-07-20T00:00:00.000Z',
      availableOnly: 'true',
      format: 'hybrid',
      language: 'ja',
      price: 'free',
      bounds: '139.60,35.55,139.90,35.80',
      limit: '24',
    };

    await controller[method]({ user: undefined }, rawQuery);

    expect(discovery).toHaveBeenCalledWith(undefined, expect.objectContaining({
      query: 'coffee',
      startsAfter: new Date('2026-07-16T00:00:00.000Z'),
      startsBefore: new Date('2026-07-20T00:00:00.000Z'),
      availableOnly: true,
      format: 'hybrid',
      language: 'ja',
      price: 'free',
      bounds: { west: 139.6, south: 35.55, east: 139.9, north: 35.8 },
      limit: 24,
    }));
  });
});

describe('draftSchema locale fields', () => {
  it.each([
    { primaryLocale: 'ja' },
    { supportedLocales: ['ja'] },
  ])('rejects a partial locale field group', (input) => {
    expect(draftSchema.safeParse(input).success).toBe(false);
  });

  it('accepts a valid format and confirmed locale group', () => {
    expect(draftSchema.safeParse({
      format: 'hybrid',
      primaryLocale: 'ja',
      supportedLocales: ['ja', 'en'],
    }).success).toBe(true);
  });

  it.each([
    { primaryLocale: 'ja', supportedLocales: ['ja', 'ja'] },
    { primaryLocale: 'ja', supportedLocales: ['en'] },
    { primaryLocale: 'ja', supportedLocales: ['zh-Hans', 'ja', 'en', 'ja'] },
    { primaryLocale: 'ko', supportedLocales: ['ko'] },
  ])('rejects an invalid confirmed locale group', (input) => {
    expect(draftSchema.safeParse(input).success).toBe(false);
  });

  it('rejects an unsupported event format', () => {
    expect(draftSchema.safeParse({ format: 'offline' }).success).toBe(false);
  });

  it('retains a valid draft coordinate without adding precision', () => {
    expect(draftSchema.parse({
      coordinate: { latitude: 35.6812, longitude: 139.7671 },
    })).toEqual({ coordinate: { latitude: 35.6812, longitude: 139.7671 } });
  });

  it.each([
    { latitude: -91, longitude: 139.7 },
    { latitude: 35.6, longitude: 181 },
  ])('rejects an out-of-range draft coordinate', (coordinate) => {
    expect(draftSchema.safeParse({ coordinate }).success).toBe(false);
  });
});
