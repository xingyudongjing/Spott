import { describe, expect, test } from "vitest";

import { parseRegistrationItineraryPage } from "../app/lib/event-contract";
import {
  groupItinerary,
  itineraryNextAction,
} from "../app/lib/itinerary";

const serverTime = "2026-07-16T03:00:00.000Z";

function registration(
  id: string,
  status: string,
  updatedAt: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    eventId: "019b0000-0000-7000-8100-000000000001",
    userId: "019b0000-0000-7000-8000-000000000001",
    status,
    partySize: 1,
    attendeeNote: null,
    offerExpiresAt: null,
    availableActions: status === "confirmed" ? ["cancelRegistration", "viewTicket", "checkIn"] : ["cancelRegistration"],
    version: 1,
    updatedAt,
    ...overrides,
  };
}

function event(
  id: string,
  title: string,
  startsAt: string | null,
  endsAt: string | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    publicSlug: `event-${id.slice(-2)}`,
    status: "published",
    title,
    startsAt,
    endsAt,
    displayTimeZone: "Asia/Tokyo",
    region: "tokyo",
    publicArea: "Shibuya",
    coverURL: null,
    format: "in_person",
    primaryLocale: "ja",
    localeConfirmed: true,
    version: 2,
    updatedAt: "2026-07-15T00:00:00.000Z",
    ...overrides,
  };
}

function page(items: Array<Record<string, unknown>>) {
  return parseRegistrationItineraryPage({
    items,
    nextCursor: null,
    hasMore: false,
    serverTime,
  });
}

describe("server-authoritative itinerary grouping", () => {
  test("groups pending, waitlist, upcoming, and past using serverTime rather than the device clock", () => {
    const result = groupItinerary(page([
      {
        registration: registration("019b0000-0000-7000-8200-000000000001", "pending", "2026-07-16T02:00:00.000Z"),
        event: event("019b0000-0000-7000-8100-000000000001", "Pending", "2026-07-20T09:00:00.000Z", "2026-07-20T11:00:00.000Z"),
      },
      {
        registration: registration("019b0000-0000-7000-8200-000000000002", "waitlisted", "2026-07-16T02:10:00.000Z"),
        event: event("019b0000-0000-7000-8100-000000000002", "Waitlist", "2026-07-21T09:00:00.000Z", "2026-07-21T11:00:00.000Z"),
      },
      {
        registration: registration("019b0000-0000-7000-8200-000000000003", "confirmed", "2026-07-16T02:20:00.000Z"),
        event: event("019b0000-0000-7000-8100-000000000003", "Upcoming", "2026-07-17T09:00:00.000Z", "2026-07-17T11:00:00.000Z"),
      },
      {
        registration: registration("019b0000-0000-7000-8200-000000000004", "confirmed", "2026-07-16T02:30:00.000Z"),
        event: event("019b0000-0000-7000-8100-000000000004", "Past", "2026-07-15T09:00:00.000Z", "2026-07-15T11:00:00.000Z"),
      },
    ]));

    expect(Object.fromEntries(Object.entries(result).map(([key, items]) => [key, items.map((item) => item.event?.title)]))).toEqual({
      pending: ["Pending"],
      waitlist: ["Waitlist"],
      upcoming: ["Upcoming"],
      past: ["Past"],
    });
  });

  test("sorts active offers by server-validated expiry before ordinary waitlist rows", () => {
    const result = groupItinerary(page([
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000001",
          "offered",
          "2026-07-16T02:00:00.000Z",
          { offerExpiresAt: "2026-07-16T03:20:00.000Z" },
        ),
        event: event("019b0000-0000-7000-8100-000000000001", "Later offer", "2026-07-20T09:00:00.000Z", "2026-07-20T11:00:00.000Z"),
      },
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000002",
          "offered",
          "2026-07-16T01:00:00.000Z",
          { offerExpiresAt: "2026-07-16T03:10:00.000Z" },
        ),
        event: event("019b0000-0000-7000-8100-000000000002", "Urgent offer", "2026-07-21T09:00:00.000Z", "2026-07-21T11:00:00.000Z"),
      },
      {
        registration: registration("019b0000-0000-7000-8200-000000000003", "waitlisted", "2026-07-16T02:30:00.000Z"),
        event: event("019b0000-0000-7000-8100-000000000003", "Waitlisted", "2026-07-22T09:00:00.000Z", "2026-07-22T11:00:00.000Z"),
      },
    ]));

    expect(result.waitlist.map((item) => item.event?.title)).toEqual([
      "Urgent offer",
      "Later offer",
      "Waitlisted",
    ]);
  });

  test("returns exactly one next action and keeps an unavailable event registration visible", () => {
    const parsed = page([
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000001",
          "offered",
          "2026-07-16T02:00:00.000Z",
          { offerExpiresAt: "2026-07-16T03:10:00.000Z" },
        ),
        event: null,
      },
    ]);

    expect(groupItinerary(parsed).waitlist).toHaveLength(1);
    expect(itineraryNextAction(parsed.items[0]!, parsed.serverTime)).toEqual({
      kind: "accept_offer",
      registrationId: "019b0000-0000-7000-8200-000000000001",
    });
  });

  test("only offers check-in when the server-authoritative action says it is eligible", () => {
    const parsed = page([
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000001",
          "confirmed",
          "2026-07-16T02:00:00.000Z",
        ),
        event: event(
          "019b0000-0000-7000-8100-000000000001",
          "Starts soon",
          "2026-07-16T03:30:00.000Z",
          "2026-07-16T05:00:00.000Z",
        ),
      },
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000002",
          "confirmed",
          "2026-07-16T02:00:00.000Z",
          { availableActions: ["cancelRegistration", "viewTicket"] },
        ),
        event: event(
          "019b0000-0000-7000-8100-000000000002",
          "Next week",
          "2026-07-23T03:30:00.000Z",
          "2026-07-23T05:00:00.000Z",
        ),
      },
    ]);

    expect(itineraryNextAction(parsed.items[0]!, parsed.serverTime)).toEqual({
      kind: "check_in",
      registrationId: "019b0000-0000-7000-8200-000000000001",
    });
    expect(itineraryNextAction(parsed.items[1]!, parsed.serverTime)).toEqual({
      kind: "open_event",
      publicSlug: "event-02",
    });
  });

  test.each([
    ["no_show", "correct_attendance"],
    ["attendance_disputed", "correct_attendance"],
    ["checked_in", "leave_feedback"],
  ])("chooses the eligible post-event action for %s", (status, kind) => {
    const parsed = page([
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000001",
          status,
          "2026-07-16T02:00:00.000Z",
          { availableActions: [] },
        ),
        event: event(
          "019b0000-0000-7000-8100-000000000001",
          "Just ended",
          "2026-07-15T23:00:00.000Z",
          "2026-07-16T02:30:00.000Z",
          { status: "ended" },
        ),
      },
    ]);

    expect(itineraryNextAction(parsed.items[0]!, parsed.serverTime)).toEqual({
      kind,
      registrationId: "019b0000-0000-7000-8200-000000000001",
    });
  });

  test("does not offer a correction or feedback after its server-time window closes", () => {
    const parsed = page([
      {
        registration: registration(
          "019b0000-0000-7000-8200-000000000001",
          "attendance_disputed",
          "2026-07-16T02:00:00.000Z",
          { availableActions: [] },
        ),
        event: event(
          "019b0000-0000-7000-8100-000000000001",
          "Old event",
          "2026-07-01T00:00:00.000Z",
          "2026-07-01T02:00:00.000Z",
          { status: "ended" },
        ),
      },
    ]);

    expect(itineraryNextAction(parsed.items[0]!, parsed.serverTime)).toEqual({
      kind: "open_event",
      publicSlug: "event-01",
    });
  });

  test.each([
    ["attendance_disputed", "2026-07-14T03:00:00.000Z", "correct_attendance"],
    ["checked_in", "2026-06-16T03:00:00.000Z", "leave_feedback"],
  ])("includes the exact post-event boundary for %s", (status, endsAt, kind) => {
    const parsed = page([{
      registration: registration(
        "019b0000-0000-7000-8200-000000000001",
        status,
        "2026-07-16T02:00:00.000Z",
        { availableActions: [] },
      ),
      event: event(
        "019b0000-0000-7000-8100-000000000001",
        "Boundary event",
        "2026-06-16T00:00:00.000Z",
        endsAt,
        { status: "ended" },
      ),
    }]);

    expect(itineraryNextAction(parsed.items[0]!, parsed.serverTime)).toEqual({
      kind,
      registrationId: "019b0000-0000-7000-8200-000000000001",
    });
  });

  test("closes feedback one millisecond after 30 days", () => {
    const parsed = page([{
      registration: registration(
        "019b0000-0000-7000-8200-000000000001",
        "checked_in",
        "2026-07-16T02:00:00.000Z",
        { availableActions: [] },
      ),
      event: event(
        "019b0000-0000-7000-8100-000000000001",
        "Old event",
        "2026-06-15T23:00:00.000Z",
        "2026-06-16T02:59:59.999Z",
        { status: "ended" },
      ),
    }]);

    expect(itineraryNextAction(parsed.items[0]!, parsed.serverTime)).toEqual({
      kind: "open_event",
      publicSlug: "event-01",
    });
  });
});
