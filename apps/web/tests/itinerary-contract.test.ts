import { describe, expect, it } from "vitest";
import * as eventContract from "../app/lib/event-contract";

const itineraryPayload = {
  items: [{
    registration: {
      id: "019b0000-0000-7000-8200-000000000003",
      eventId: "019b0000-0000-7000-8100-000000000001",
      userId: "019b0000-0000-7000-8000-000000000001",
      status: "offered",
      partySize: 2,
      attendeeNote: null,
      offerExpiresAt: "2026-07-16T03:10:00.000Z",
      availableActions: ["cancelRegistration", "register"],
      version: 4,
      updatedAt: "2026-07-16T02:00:00.000Z",
    },
    event: {
      id: "019b0000-0000-7000-8100-000000000001",
      publicSlug: "evening-walk",
      status: "published",
      title: "Evening walk",
      startsAt: "2026-07-20T09:00:00.000Z",
      endsAt: "2026-07-20T11:00:00.000Z",
      displayTimeZone: "Asia/Tokyo",
      region: "tokyo",
      publicArea: "Shibuya",
      coverURL: "https://cdn.spott.jp/events/evening-walk.webp",
      format: "in_person",
      primaryLocale: "ja",
      localeConfirmed: true,
      version: 7,
      updatedAt: "2026-07-15T02:00:00.000Z",
    },
  }],
  nextCursor: "eyJkYXRlIjoiMjAyNi0wNy0xNlQwMjowMDowMC4wMDBaIiwiaWQiOiIwMTliMDAwMC0wMDAwLTcwMDAtODIwMC0wMDAwMDAwMDAwMDMifQ",
  hasMore: true,
  serverTime: "2026-07-16T03:00:00.000Z",
};

describe("registration itinerary contract", () => {
  it("parses the authoritative page with its registration and limited event summary", () => {
    const candidate = eventContract as typeof eventContract & {
      parseRegistrationItineraryPage?: (value: unknown) => unknown;
    };

    expect(candidate.parseRegistrationItineraryPage).toBeTypeOf("function");
    expect(candidate.parseRegistrationItineraryPage!(itineraryPayload)).toEqual(itineraryPayload);
  });

  it("preserves a registration when the event summary is unavailable", () => {
    const unavailable = {
      ...structuredClone(itineraryPayload),
      items: [{ ...structuredClone(itineraryPayload.items[0]!), event: null }],
    };

    expect(eventContract.parseRegistrationItineraryPage(unavailable).items[0]).toMatchObject({
      registration: { id: itineraryPayload.items[0]!.registration.id },
      event: null,
    });
  });

  it.each([
    ["exactAddress", "1-2-3 Jingumae"],
    ["coordinate", { latitude: 35.668, longitude: 139.706, precision: "exact" }],
    ["joinURL", "https://meet.example/private"],
    ["joinInstructions", "Use the private room code"],
    ["registrationQuestions", [{ id: "019b0000-0000-7000-8300-000000000001", prompt: "Private" }]],
    ["description", "Detail-only copy"],
    ["organizer", { id: "019b0000-0000-7000-8000-000000000099", privateNote: "Private" }],
  ])("rejects the privacy-forbidden event field %s", (field, value) => {
    const unsafe = structuredClone(itineraryPayload) as typeof itineraryPayload & {
      items: Array<{ event: Record<string, unknown> }>;
    };
    unsafe.items[0]!.event[field] = value;

    expect(() => eventContract.parseRegistrationItineraryPage(unsafe)).toThrow(
      /Invalid RegistrationItineraryPage/,
    );
  });

  it("rejects unknown wrapper and registration fields instead of silently accepting contract drift", () => {
    const unsafePage = { ...structuredClone(itineraryPayload), deviceTime: "2026-07-16T04:00:00.000Z" };
    const unsafeRegistration = structuredClone(itineraryPayload) as typeof itineraryPayload & {
      items: Array<{ registration: Record<string, unknown> }>;
    };
    unsafeRegistration.items[0]!.registration.eventTitle = "Duplicated detail";

    expect(() => eventContract.parseRegistrationItineraryPage(unsafePage)).toThrow(
      /Invalid RegistrationItineraryPage/,
    );
    expect(() => eventContract.parseRegistrationItineraryPage(unsafeRegistration)).toThrow(
      /Invalid RegistrationItineraryPage/,
    );
  });
});
