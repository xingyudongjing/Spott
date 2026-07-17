import { describe, expect, test } from "vitest";

import { isRFC3339DateTime } from "../app/lib/rfc3339";

describe("strict RFC3339 date-time validation", () => {
  test.each([
    "2026-07-16T00:00:00Z",
    "2026-07-16T00:00:00.123456Z",
    "2026-07-16T09:30:00+09:00",
    "2024-02-29T23:59:59-05:30",
  ])("accepts %s", (value) => {
    expect(isRFC3339DateTime(value)).toBe(true);
  });

  test.each([
    "0",
    "2026-07-16",
    "2026-02-30T00:00:00Z",
    "2026-07-16T24:00:00Z",
    "2026-07-16T00:60:00Z",
    "2026-07-16T00:00:00+24:00",
    "not-a-date",
    null,
  ])("rejects malformed value %s", (value) => {
    expect(isRFC3339DateTime(value)).toBe(false);
  });
});
