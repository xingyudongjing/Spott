import { describe, expect, test } from "vitest";

import { eventFixture, makeEvent } from "./event-fixtures";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function displayDateTime(value: string | Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value;

  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}

describe("event fixtures", () => {
  test("keeps the default event a bounded interval ahead of the current clock", () => {
    const observedAt = Date.now();
    const deadlineAt = Date.parse(eventFixture.deadlineAt!);
    const startsAt = Date.parse(eventFixture.startsAt!);
    const endsAt = Date.parse(eventFixture.endsAt!);

    expect(deadlineAt - observedAt).toBeGreaterThanOrEqual(45 * MINUTE_MS);
    expect(deadlineAt - observedAt).toBeLessThanOrEqual(75 * MINUTE_MS);
    expect(startsAt - deadlineAt).toBe(HOUR_MS);
    expect(endsAt - startsAt).toBe(150 * MINUTE_MS);
  });

  test("derives stable event intervals from an injected baseline across Tokyo midnight", () => {
    const baseline = new Date("2026-07-18T14:30:00.000Z");
    const event = makeEvent({}, baseline);

    expect(event.deadlineAt).toBe("2026-07-18T15:30:00.000Z");
    expect(event.startsAt).toBe("2026-07-18T16:30:00.000Z");
    expect(event.endsAt).toBe("2026-07-18T19:00:00.000Z");
    expect(displayDateTime(baseline, event.displayTimeZone)).toBe("2026-07-18 23:30");
    expect(displayDateTime(event.startsAt!, event.displayTimeZone)).toBe("2026-07-19 01:30");
  });
});
