/**
 * Quiet-hours helpers.
 *
 * The API stores a notification preference's quiet window as a PostgreSQL
 * `tstzrange` and returns it as text, e.g.
 * `["2026-07-24 22:00:00+09","2026-07-25 08:00:00+09")`. The product treats the
 * window as a wall-clock range in Japan time (the API writes it with a +09:00
 * offset), so the UI reads it back in Asia/Tokyo and edits plain `HH:MM` values.
 */

const TOKYO_TIME_ZONE = "Asia/Tokyo";
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface QuietHours {
  /** Wall-clock start in Japan time, `HH:MM`. */
  start: string;
  /** Wall-clock end in Japan time, `HH:MM`. */
  end: string;
}

export function isTimeOfDay(value: string): boolean {
  return TIME_OF_DAY.test(value);
}

/**
 * Read a stored quiet-hours range. Returns null for an absent, empty, or
 * unparseable value so the caller can fall back to its own default instead of
 * showing a broken time.
 */
export function parseQuietHours(value: string | null | undefined): QuietHours | null {
  if (!value) return null;
  const inner = value.trim().replace(/^[[(]/, "").replace(/[\])]$/, "");
  const parts = inner.split(",").map((part) => part.trim().replace(/^"|"$/g, ""));
  if (parts.length !== 2) return null;
  const start = tokyoTimeOfDay(parts[0] ?? "");
  const end = tokyoTimeOfDay(parts[1] ?? "");
  if (!start || !end) return null;
  return { start, end };
}

function tokyoTimeOfDay(timestamp: string): string | null {
  const parsed = parseTimestamp(timestamp);
  if (!parsed) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TOKYO_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(parsed);
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  if (!hour || !minute) return null;
  const value = `${hour}:${minute}`;
  return isTimeOfDay(value) ? value : null;
}

function parseTimestamp(value: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed
    .replace(" ", "T")
    // Postgres emits microsecond precision; JS parses milliseconds.
    .replace(/(\.\d{3})\d+/, "$1")
    // A bare `+09` / `-05` offset is not valid ISO 8601 for every engine.
    .replace(/([+-]\d{2})$/, "$1:00");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
