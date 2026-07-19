import { describe, expect, test } from "vitest";

import type { Locale } from "../app/i18n/messages";
import { eventTime } from "../app/lib/format";

describe("event time presentation", () => {
  test.each(
    [
      ["zh-Hans", "23:30–次日 01:00"],
      ["ja", "23:30–翌日 01:00"],
      ["en", "23:30–next day 01:00"],
    ] satisfies ReadonlyArray<readonly [Locale, string]>,
  )(
    "marks an end time on the next natural day in %s",
    (locale, expected) => {
      expect(
        eventTime(
          "2026-07-18T14:30:00.000Z",
          "2026-07-18T16:00:00.000Z",
          locale,
          "Asia/Tokyo",
        ),
      ).toBe(expected);
    },
  );

  test("does not add a next-day label when both times share the display-zone date", () => {
    expect(
      eventTime(
        "2026-07-18T23:30:00.000Z",
        "2026-07-19T00:30:00.000Z",
        "zh-Hans",
        "Asia/Tokyo",
      ),
    ).toBe("08:30–09:30");
  });

  test.each(
    [
      ["zh-Hans", "23:30–2026年8月2日 · 01:00"],
      ["ja", "23:30–2026年8月2日 · 01:00"],
      ["en", "23:30–Aug 2, 2026 · 01:00"],
    ] satisfies ReadonlyArray<readonly [Locale, string]>,
  )("shows the explicit local end date for a multi-day event in %s", (locale, expected) => {
    expect(
      eventTime(
        "2026-07-31T14:30:00.000Z",
        "2026-08-01T16:00:00.000Z",
        locale,
        "Asia/Tokyo",
      ),
    ).toBe(expected);
  });

  test("keeps the year visible when a multi-day event crosses into a new year", () => {
    expect(
      eventTime(
        "2026-12-30T14:30:00.000Z",
        "2027-01-01T16:00:00.000Z",
        "en",
        "Asia/Tokyo",
      ),
    ).toBe("23:30–Jan 2, 2027 · 01:00");
  });

  test.each([
    [
      "2026-03-08T04:30:00.000Z",
      "2026-03-08T07:30:00.000Z",
      "23:30–next day 03:30",
    ],
    [
      "2026-10-31T05:30:00.000Z",
      "2026-11-02T06:30:00.000Z",
      "01:30–Nov 2, 2026 · 01:30",
    ],
  ])("uses display-zone calendar days across a DST boundary", (start, end, expected) => {
    expect(eventTime(start, end, "en", "America/New_York")).toBe(expected);
  });
});
