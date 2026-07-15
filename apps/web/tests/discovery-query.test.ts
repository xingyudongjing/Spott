import { afterEach, describe, expect, test, vi } from "vitest";

import { normalizeEvent } from "../app/lib/api";
import {
  parseDiscoveryQuery,
  resolveDateShortcut,
  serializeDiscoveryQuery,
  type EventDiscoveryQuery,
} from "../app/lib/discovery-query";
import {
  EventContractError,
  parseEventSummary,
  type EventDetail,
  type EventSummary,
} from "../app/lib/event-contract";
import { fetchEvent, searchEvents } from "../app/lib/events-api";

const summary: EventSummary = {
  id: "019b0000-0000-7000-8100-000000000001",
  publicSlug: "tokyo-afterglow-walk",
  organizerId: "019b0000-0000-7000-8100-000000000010",
  status: "published",
  title: "Tokyo afterglow walk",
  description: "A quiet walk along the Sumida river.",
  category: "walk",
  startsAt: "2026-07-18T08:30:00.000Z",
  endsAt: "2026-07-18T11:00:00.000Z",
  deadlineAt: "2026-07-18T07:30:00.000Z",
  displayTimeZone: "Asia/Tokyo",
  region: "tokyo",
  publicArea: "Kiyosumi-shirakawa",
  capacity: 24,
  confirmedCount: 11,
  availableCapacity: 13,
  fee: {
    isFree: true,
    amountJPY: null,
    collectorName: null,
    method: null,
    paymentDeadlineText: null,
    refundPolicy: null,
  },
  coverURL: null,
  tags: ["walk"],
  organizer: {
    id: "019b0000-0000-7000-8100-000000000010",
    name: "Weekend Kai",
    handle: "weekend_kai",
    viewerFollowing: false,
    trust: {
      phoneVerified: true,
      completedEventCount: 18,
      attendanceRateBand: "90_plus",
    },
  },
  favorited: false,
  registrationStatus: null,
  viewerRegistration: null,
  registrationMode: "automatic",
  waitlistEnabled: true,
  format: "in_person",
  primaryLocale: "ja",
  supportedLocales: ["ja", "en"],
  localeConfirmed: true,
  availableActions: ["register"],
  version: 2,
  updatedAt: "2026-07-16T00:00:00.000Z",
  coordinate: { latitude: 35.68, longitude: 139.79, precision: "approximate" },
};

const detail: EventDetail = {
  ...summary,
  coordinate: { latitude: 35.68123, longitude: 139.79123, precision: "exact" },
  exactAddress: "1-2-3 Kiyosumi",
  attendeeRequirements: null,
  riskFlags: [],
  riskDetails: {},
  exactAddressVisibility: "confirmed",
  registrationQuestions: [],
  media: [],
  mediaCount: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery query", () => {
  test("round-trips every server filter in deterministic order", () => {
    const query: EventDiscoveryQuery = {
      q: "night walk",
      region: "tokyo",
      category: "walk",
      startsAfter: "2026-07-01T00:00:00.000Z",
      startsBefore: "2026-08-01T00:00:00.000Z",
      availableOnly: true,
      format: "hybrid",
      language: "ja",
      price: "paid",
      bounds: { west: 139.6, south: 35.5, east: 139.9, north: 35.8 },
      cursor: "2026-07-18T08:30:00.000Z|019b",
      limit: 20,
    };

    const serialized = serializeDiscoveryQuery(query);

    expect([...serialized.keys()]).toEqual([
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
    ]);
    expect(parseDiscoveryQuery(serialized)).toEqual(query);
    expect(serializeDiscoveryQuery(parseDiscoveryQuery(serialized)).toString()).toBe(serialized.toString());
  });

  test("omits absent filters instead of manufacturing query facts", () => {
    expect(serializeDiscoveryQuery({}).toString()).toBe("");
    expect(parseDiscoveryQuery("")).toEqual({});
  });

  test("rejects bounds with an empty coordinate segment", () => {
    expect(() => parseDiscoveryQuery("bounds=139.6%2C%2C139.9%2C35.8"))
      .toThrow(/bounds/);
  });

  test("resolves a quick date into explicit ISO boundaries in the event time zone", () => {
    expect(
      resolveDateShortcut("today", "Asia/Tokyo", new Date("2026-07-16T15:30:00.000Z")),
    ).toEqual({
      startsAfter: "2026-07-16T15:00:00.000Z",
      startsBefore: "2026-07-17T15:00:00.000Z",
    });
  });
});

describe("strict event contracts", () => {
  test("preserves valid server facts, including forward-compatible fields", () => {
    const parsed = parseEventSummary({
      ...summary,
      categoryLabel: "legacy category",
      priceLabel: "legacy price",
      queryRank: 0.93,
      organizer: { ...summary.organizer, reliability: "legacy trust" },
      fee: { ...summary.fee, boundaryStatement: "legacy boundary" },
    });

    expect(parsed).toMatchObject(summary);
    expect((parsed as EventSummary & { queryRank: number }).queryRank).toBe(0.93);
    expect(parsed).not.toHaveProperty("categoryLabel");
    expect(parsed).not.toHaveProperty("priceLabel");
    expect(parsed.organizer).not.toHaveProperty("reliability");
    expect(parsed.fee).not.toHaveProperty("boundaryStatement");
  });

  test("throws a precise parse error instead of filling missing required facts", () => {
    expect(() => normalizeEvent({ id: summary.id, publicSlug: summary.publicSlug, title: summary.title }))
      .toThrow(EventContractError);
    expect(() => normalizeEvent({ id: summary.id, publicSlug: summary.publicSlug, title: summary.title }))
      .toThrow(/description|startsAt|fee/);
  });

  test("legacy display strings cannot cross the normalization boundary", () => {
    const normalized = normalizeEvent({
      ...summary,
      categoryLabel: "LEGACY CATEGORY",
      priceLabel: "LEGACY PRICE",
      organizer: { ...summary.organizer, reliability: "LEGACY TRUST" },
      fee: { ...summary.fee, boundaryStatement: "LEGACY BOUNDARY" },
    });

    expect(normalized.categoryLabel).toBe(summary.category);
    expect(normalized.priceLabel).not.toBe("LEGACY PRICE");
    expect(normalized.organizer.reliability).not.toBe("LEGACY TRUST");
    expect(normalized.fee.boundaryStatement).not.toBe("LEGACY BOUNDARY");
  });
});

describe("event API cancellation", () => {
  test("passes the caller AbortSignal to the actual search request", async () => {
    let networkSignal: AbortSignal | null | undefined;
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      networkSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    }));
    const controller = new AbortController();

    const request = searchEvents({ q: "newest" }, { signal: controller.signal });
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(networkSignal).toBe(controller.signal);
  });

  test("encodes identifiers and parses a strict detail response", async () => {
    let requestedURL = "";
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      requestedURL = String(input);
      return new Response(JSON.stringify(detail), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEvent("tokyo/walk")).resolves.toEqual(detail);
    expect(requestedURL).toContain("/events/tokyo%2Fwalk");
  });
});
