import { describe, expect, test } from "vitest";

import {
  resolveEventCTA,
  type EventCTASession,
} from "../app/lib/event-cta";
import type { EventSummary } from "../app/lib/event-contract";

const now = new Date("2026-07-16T00:00:00.000Z");
const registrationID = "019b0000-0000-7000-8100-000000000099";
const activeOfferExpiry = "2026-07-16T00:10:00.000Z";

const guest: EventCTASession = { authenticated: false, phoneVerified: false };
const unverified: EventCTASession = { authenticated: true, phoneVerified: false };
const verified: EventCTASession = { authenticated: true, phoneVerified: true };

const baseEvent: EventSummary = {
  id: "019b0000-0000-7000-8100-000000000001",
  publicSlug: "event",
  organizerId: "019b0000-0000-7000-8100-000000000010",
  status: "published",
  title: "Event",
  description: "Description",
  category: "walk",
  startsAt: "2026-07-18T08:30:00.000Z",
  endsAt: "2026-07-18T11:00:00.000Z",
  deadlineAt: "2026-07-17T00:00:00.000Z",
  displayTimeZone: "Asia/Tokyo",
  region: "tokyo",
  publicArea: "Kiyosumi",
  capacity: 10,
  confirmedCount: 3,
  availableCapacity: 7,
  fee: {
    isFree: true,
    amountJPY: null,
    collectorName: null,
    method: null,
    paymentDeadlineText: null,
    refundPolicy: null,
  },
  coverURL: null,
  tags: [],
  organizer: {
    id: "019b0000-0000-7000-8100-000000000010",
    name: "Host",
    handle: "host",
    viewerFollowing: false,
    trust: { phoneVerified: false, completedEventCount: 0, attendanceRateBand: "unavailable" },
  },
  favorited: false,
  registrationStatus: null,
  viewerRegistration: null,
  registrationMode: "automatic",
  waitlistEnabled: true,
  format: "in_person",
  primaryLocale: "ja",
  supportedLocales: ["ja"],
  localeConfirmed: true,
  groupId: null,
  availableActions: ["register"],
  version: 1,
  updatedAt: "2026-07-15T00:00:00.000Z",
  coordinate: null,
};

type Case = {
  name: string;
  event: Partial<EventSummary>;
  session: EventCTASession;
  expected: ReturnType<typeof resolveEventCTA>;
};

const cases: Case[] = [
  {
    name: "1 unavailable event wins before an active offer",
    event: {
      status: "cancelled",
      viewerRegistration: { id: registrationID, status: "offered", partySize: 1, offerExpiresAt: activeOfferExpiry },
    },
    session: verified,
    expected: { kind: "event_unavailable", intent: "none", disabled: true },
  },
  {
    name: "2 active waitlist offer",
    event: {
      viewerRegistration: { id: registrationID, status: "offered", partySize: 1, offerExpiresAt: activeOfferExpiry },
    },
    session: verified,
    expected: {
      kind: "accept_waitlist",
      intent: "accept_waitlist",
      disabled: false,
      registrationId: registrationID,
      offerExpiresAt: activeOfferExpiry,
    },
  },
  {
    name: "3 confirmed registration itinerary",
    event: {
      deadlineAt: "2026-07-15T00:00:00.000Z",
      viewerRegistration: { id: registrationID, status: "confirmed", partySize: 1, offerExpiresAt: null },
    },
    session: verified,
    expected: { kind: "view_itinerary", intent: "itinerary", disabled: false, registrationId: registrationID },
  },
  {
    name: "3 checked-in registration itinerary",
    event: {
      viewerRegistration: { id: registrationID, status: "checked_in", partySize: 1, offerExpiresAt: null },
    },
    session: verified,
    expected: { kind: "view_itinerary", intent: "itinerary", disabled: false, registrationId: registrationID },
  },
  {
    name: "4 pending registration",
    event: {
      viewerRegistration: { id: registrationID, status: "pending", partySize: 1, offerExpiresAt: null },
    },
    session: verified,
    expected: { kind: "view_pending", intent: "itinerary", disabled: false, registrationId: registrationID },
  },
  {
    name: "5 waitlisted registration",
    event: {
      viewerRegistration: { id: registrationID, status: "waitlisted", partySize: 1, offerExpiresAt: null },
    },
    session: verified,
    expected: { kind: "view_waitlist", intent: "itinerary", disabled: false, registrationId: registrationID },
  },
  {
    name: "6 guest continues to login",
    event: { availableActions: [] },
    session: guest,
    expected: { kind: "continue_login", intent: "login", disabled: false },
  },
  {
    name: "7 signed-in user continues phone verification",
    event: { availableActions: [] },
    session: unverified,
    expected: { kind: "continue_phone_verification", intent: "phone_verification", disabled: false },
  },
  {
    name: "8 registration status is closed",
    event: { status: "registration_closed", availableActions: ["register"] },
    session: verified,
    expected: { kind: "registration_closed", intent: "none", disabled: true },
  },
  {
    name: "8 registration deadline is closed",
    event: { deadlineAt: "2026-07-16T00:00:00.000Z" },
    session: verified,
    expected: { kind: "registration_closed", intent: "none", disabled: true },
  },
  {
    name: "8 server action set is closed",
    event: { availableActions: [] },
    session: verified,
    expected: { kind: "registration_closed", intent: "none", disabled: true },
  },
  {
    name: "9 full event can join waitlist",
    event: { confirmedCount: 8, availableCapacity: 0, availableActions: ["joinWaitlist"] },
    session: verified,
    expected: { kind: "join_waitlist", intent: "register", disabled: false },
  },
  {
    name: "10 full event has no available waitlist",
    event: { confirmedCount: 10, availableCapacity: 0, waitlistEnabled: false, availableActions: [] },
    session: verified,
    expected: { kind: "full_closed", intent: "none", disabled: true },
  },
  {
    name: "11 approval event applies",
    event: { registrationMode: "approval", availableActions: ["register"] },
    session: verified,
    expected: { kind: "apply", intent: "register", disabled: false },
  },
  {
    name: "12 automatic event registers",
    event: {},
    session: verified,
    expected: { kind: "register", intent: "register", disabled: false },
  },
  {
    name: "fallback never broadens a waitlist-only server action while seats remain",
    event: { availableActions: ["joinWaitlist"] },
    session: verified,
    expected: { kind: "registration_closed", intent: "none", disabled: true },
  },
  {
    name: "expired offer does not remain actionable",
    event: {
      confirmedCount: 10,
      availableCapacity: 0,
      availableActions: ["joinWaitlist"],
      viewerRegistration: {
        id: registrationID,
        status: "offered",
        partySize: 1,
        offerExpiresAt: "2026-07-15T23:59:59.999Z",
      },
    },
    session: verified,
    expected: { kind: "join_waitlist", intent: "register", disabled: false },
  },
];

describe("event CTA ordered state machine", () => {
  test.each(cases)("$name", ({ event, session, expected }) => {
    expect(resolveEventCTA({ ...baseEvent, ...event }, session, now)).toEqual(expected);
  });

  test.each(["ended", "removed"] as const)("treats %s as unavailable", (status) => {
    expect(resolveEventCTA({ ...baseEvent, status }, verified, now)).toEqual({
      kind: "event_unavailable",
      intent: "none",
      disabled: true,
    });
  });
});
