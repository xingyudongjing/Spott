export type EventFormat = "in_person" | "online" | "hybrid";
export type EventLocale = "zh-Hans" | "ja" | "en";
export type EventPriceFilter = "free" | "paid";
export type EventDateShortcut = "today" | "tomorrow" | "this_weekend";

export interface MapBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

export interface EventDiscoveryQuery {
  q?: string;
  region?: string;
  category?: string;
  startsAfter?: string;
  startsBefore?: string;
  availableOnly?: boolean;
  format?: EventFormat;
  language?: EventLocale;
  price?: EventPriceFilter;
  bounds?: MapBounds;
  cursor?: string;
  limit?: number;
}

export class DiscoveryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryQueryError";
  }
}

const orderedKeys = [
  "q",
  "region",
  "category",
  "startsAfter",
  "startsBefore",
  "availableOnly",
  "format",
  "language",
  "price",
  "bounds",
  "cursor",
  "limit",
] as const;

export function serializeDiscoveryQuery(query: EventDiscoveryQuery): URLSearchParams {
  validateDiscoveryQuery(query);
  const values: Partial<Record<(typeof orderedKeys)[number], string>> = {
    q: query.q,
    region: query.region,
    category: query.category,
    startsAfter: query.startsAfter,
    startsBefore: query.startsBefore,
    availableOnly: query.availableOnly === undefined ? undefined : String(query.availableOnly),
    format: query.format,
    language: query.language,
    price: query.price,
    bounds: query.bounds ? formatBounds(query.bounds) : undefined,
    cursor: query.cursor,
    limit: query.limit === undefined ? undefined : String(query.limit),
  };
  const result = new URLSearchParams();
  for (const key of orderedKeys) {
    const value = values[key];
    if (value !== undefined && value !== "") result.append(key, value);
  }
  return result;
}

export function parseDiscoveryQuery(source: string | URLSearchParams): EventDiscoveryQuery {
  const params = typeof source === "string" ? new URLSearchParams(source) : source;
  const query: EventDiscoveryQuery = {};
  const text = (key: string) => params.get(key) || undefined;
  const q = text("q");
  const region = text("region");
  const category = text("category");
  const startsAfter = text("startsAfter");
  const startsBefore = text("startsBefore");
  const availableOnly = text("availableOnly");
  const format = text("format");
  const language = text("language");
  const price = text("price");
  const bounds = text("bounds");
  const cursor = text("cursor");
  const limit = text("limit");

  if (q) query.q = q;
  if (region) query.region = region;
  if (category) query.category = category;
  if (startsAfter) query.startsAfter = startsAfter;
  if (startsBefore) query.startsBefore = startsBefore;
  if (availableOnly) {
    if (availableOnly !== "true" && availableOnly !== "false") {
      throw new DiscoveryQueryError("availableOnly must be true or false");
    }
    query.availableOnly = availableOnly === "true";
  }
  if (format) query.format = parseEnum(format, ["in_person", "online", "hybrid"], "format");
  if (language) query.language = parseEnum(language, ["zh-Hans", "ja", "en"], "language");
  if (price) query.price = parseEnum(price, ["free", "paid"], "price");
  if (bounds) query.bounds = parseBounds(bounds);
  if (cursor) query.cursor = cursor;
  if (limit) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new DiscoveryQueryError("limit must be an integer between 1 and 100");
    }
    query.limit = parsed;
  }
  validateDiscoveryQuery(query);
  return query;
}

export function resolveDateShortcut(
  shortcut: EventDateShortcut,
  displayTimeZone: string,
  now = new Date(),
): Pick<EventDiscoveryQuery, "startsAfter" | "startsBefore"> {
  const local = localDateParts(now, displayTimeZone);
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  let startOffset = 0;
  let dayCount = 1;
  if (shortcut === "tomorrow") startOffset = 1;
  if (shortcut === "this_weekend") {
    const weekday = localDate.getUTCDay();
    startOffset = weekday === 0 ? 0 : (6 - weekday + 7) % 7;
    dayCount = weekday === 0 ? 1 : 2;
  }
  const startDate = addCalendarDays(local, startOffset);
  const endDate = addCalendarDays(startDate, dayCount);
  return {
    startsAfter: localMidnightToUTC(startDate, displayTimeZone).toISOString(),
    startsBefore: localMidnightToUTC(endDate, displayTimeZone).toISOString(),
  };
}

export function validateDiscoveryQuery(query: EventDiscoveryQuery): void {
  for (const [name, value] of [["startsAfter", query.startsAfter], ["startsBefore", query.startsBefore]] as const) {
    if (value !== undefined && (!Number.isFinite(Date.parse(value)) || !/[zZ]|[+-]\d\d:\d\d$/.test(value))) {
      throw new DiscoveryQueryError(`${name} must be an ISO date-time with an explicit offset`);
    }
  }
  if (query.startsAfter && query.startsBefore && Date.parse(query.startsAfter) > Date.parse(query.startsBefore)) {
    throw new DiscoveryQueryError("startsBefore must not precede startsAfter");
  }
  if (query.bounds) validateBounds(query.bounds);
  if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100)) {
    throw new DiscoveryQueryError("limit must be an integer between 1 and 100");
  }
}

function parseBounds(value: string): MapBounds {
  const segments = value.split(",");
  const values = segments.map(Number);
  if (segments.length !== 4 || segments.some((part) => part.trim() === "") || values.some((part) => !Number.isFinite(part))) {
    throw new DiscoveryQueryError("bounds must contain west,south,east,north");
  }
  const [west, south, east, north] = values as [number, number, number, number];
  const bounds = { west, south, east, north };
  validateBounds(bounds);
  return bounds;
}

function validateBounds({ west, south, east, north }: MapBounds): void {
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) {
    throw new DiscoveryQueryError("bounds coordinates are invalid");
  }
}

function formatBounds(bounds: MapBounds): string {
  return [bounds.west, bounds.south, bounds.east, bounds.north].map(String).join(",");
}

function parseEnum<const Value extends string>(value: string, allowed: readonly Value[], name: string): Value {
  if (!allowed.includes(value as Value)) throw new DiscoveryQueryError(`${name} is invalid`);
  return value as Value;
}

interface LocalDate {
  year: number;
  month: number;
  day: number;
}

function localDateParts(date: Date, timeZone: string): LocalDate {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(values.find((value) => value.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day") };
}

function addCalendarDays(date: LocalDate, days: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

function localMidnightToUTC(date: LocalDate, timeZone: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let candidate = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = zonedDateTimeParts(new Date(candidate), timeZone);
    const observedAsUTC = Date.UTC(
      observed.year,
      observed.month - 1,
      observed.day,
      observed.hour,
      observed.minute,
      observed.second,
    );
    const correction = target - observedAsUTC;
    candidate += correction;
    if (correction === 0) break;
  }
  return new Date(candidate);
}

function zonedDateTimeParts(date: Date, timeZone: string) {
  const values = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(values.find((value) => value.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
    second: part("second"),
  };
}
