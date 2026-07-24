import { describe, expect, it } from "vitest";

import { isTimeOfDay, parseQuietHours } from "../app/lib/quiet-hours";

describe("quiet hours", () => {
  it("reads the tstzrange the API returns as Japan wall-clock times", () => {
    expect(
      parseQuietHours('["2026-07-24 22:00:00+09","2026-07-25 08:00:00+09")'),
    ).toEqual({ start: "22:00", end: "08:00" });
  });

  it("normalizes ISO separators, microseconds, and other offsets", () => {
    expect(
      parseQuietHours('["2026-07-24T13:00:00.123456+00:00","2026-07-24T23:30:00.000000+00:00")'),
    ).toEqual({ start: "22:00", end: "08:30" });
  });

  it("returns null instead of a broken time for absent or malformed values", () => {
    expect(parseQuietHours(null)).toBeNull();
    expect(parseQuietHours("")).toBeNull();
    expect(parseQuietHours("[not-a-range)")).toBeNull();
    expect(parseQuietHours('["2026-07-24 22:00:00+09")')).toBeNull();
  });

  it("validates editable time-of-day input", () => {
    expect(isTimeOfDay("00:00")).toBe(true);
    expect(isTimeOfDay("23:59")).toBe(true);
    expect(isTimeOfDay("24:00")).toBe(false);
    expect(isTimeOfDay("7:00")).toBe(false);
    expect(isTimeOfDay("")).toBe(false);
  });
});
