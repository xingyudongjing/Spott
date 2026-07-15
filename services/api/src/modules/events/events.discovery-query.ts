import { z } from 'zod';

export type EventFormat = 'in_person' | 'online' | 'hybrid';
export type EventLocale = 'zh-Hans' | 'ja' | 'en';
export type EventPriceFilter = 'free' | 'paid';

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface DiscoveryQuery {
  query?: string;
  region?: string;
  category?: string;
  startsAfter?: Date;
  startsBefore?: Date;
  availableOnly?: boolean;
  format?: EventFormat;
  language?: EventLocale;
  price?: EventPriceFilter;
  bounds?: MapBounds;
  cursor?: string;
  limit: number;
}

const optionalText = z.string().min(1);
const dateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const limitQuery = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100));

const boundsQuery = z.string().transform((value, context): MapBounds => {
  const parts = value.split(',');
  if (parts.length !== 4 || parts.some((part) => part.trim() === '')) {
    context.addIssue({ code: 'custom', message: 'bounds must contain west,south,east,north' });
    return z.NEVER;
  }

  const [west, south, east, north] = parts.map(Number) as [number, number, number, number];
  if (
    ![west, south, east, north].every(Number.isFinite)
    || west < -180
    || east > 180
    || south < -90
    || north > 90
    || west >= east
    || south >= north
  ) {
    context.addIssue({ code: 'custom', message: 'bounds coordinates are invalid' });
    return z.NEVER;
  }

  return { west, south, east, north };
});

const discoveryQuerySchema = z.object({
  q: optionalText.max(120).optional(),
  region: optionalText.optional(),
  category: optionalText.optional(),
  startsAfter: dateTime.optional(),
  startsBefore: dateTime.optional(),
  availableOnly: booleanQuery.optional(),
  format: z.enum(['in_person', 'online', 'hybrid']).optional(),
  language: z.enum(['zh-Hans', 'ja', 'en']).optional(),
  price: z.enum(['free', 'paid']).optional(),
  bounds: boundsQuery.optional(),
  cursor: optionalText.optional(),
  limit: limitQuery.default(20),
}).refine(
  ({ startsAfter, startsBefore }) => !startsAfter || !startsBefore || startsAfter <= startsBefore,
  { path: ['startsBefore'], message: 'startsBefore must not precede startsAfter' },
);

export function parseDiscoveryQuery(input: Record<string, string | undefined>): DiscoveryQuery {
  const parsed = discoveryQuerySchema.parse(input);
  return {
    ...(parsed.q === undefined ? {} : { query: parsed.q }),
    ...(parsed.region === undefined ? {} : { region: parsed.region }),
    ...(parsed.category === undefined ? {} : { category: parsed.category }),
    ...(parsed.startsAfter === undefined ? {} : { startsAfter: parsed.startsAfter }),
    ...(parsed.startsBefore === undefined ? {} : { startsBefore: parsed.startsBefore }),
    ...(parsed.availableOnly === undefined ? {} : { availableOnly: parsed.availableOnly }),
    ...(parsed.format === undefined ? {} : { format: parsed.format }),
    ...(parsed.language === undefined ? {} : { language: parsed.language }),
    ...(parsed.price === undefined ? {} : { price: parsed.price }),
    ...(parsed.bounds === undefined ? {} : { bounds: parsed.bounds }),
    ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
    limit: parsed.limit,
  };
}
