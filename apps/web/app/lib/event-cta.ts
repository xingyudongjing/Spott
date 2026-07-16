import type { EventSummary } from "./event-contract";

export type EventCTAEvent = Pick<
  EventSummary,
  | "status"
  | "viewerRegistration"
  | "capacity"
  | "availableCapacity"
  | "deadlineAt"
  | "waitlistEnabled"
  | "availableActions"
  | "registrationMode"
>;

export type EventCTAKind =
  | "event_unavailable"
  | "accept_waitlist"
  | "view_itinerary"
  | "view_pending"
  | "view_waitlist"
  | "continue_login"
  | "continue_phone_verification"
  | "registration_closed"
  | "join_waitlist"
  | "full_closed"
  | "apply"
  | "register";

export type EventCTAIntent = "none" | "accept_waitlist" | "itinerary" | "login" | "phone_verification" | "register";

export interface EventCTA {
  kind: EventCTAKind;
  intent: EventCTAIntent;
  disabled: boolean;
  registrationId?: string;
  offerExpiresAt?: string;
}

export interface EventCTASession {
  authenticated: boolean;
  phoneVerified: boolean;
}

export function resolveEventCTA(event: EventCTAEvent, session: EventCTASession, now = new Date()): EventCTA {
  if (["cancelled", "ended", "removed"].includes(event.status)) {
    return disabled("event_unavailable");
  }

  const registration = event.viewerRegistration;
  if (
    registration?.status === "offered"
    && registration.offerExpiresAt !== null
    && Date.parse(registration.offerExpiresAt) > now.getTime()
  ) {
    return {
      kind: "accept_waitlist",
      intent: "accept_waitlist",
      disabled: false,
      registrationId: registration.id,
      offerExpiresAt: registration.offerExpiresAt,
    };
  }
  if (registration && ["confirmed", "checked_in"].includes(registration.status)) {
    return itinerary("view_itinerary", registration.id);
  }
  if (registration?.status === "pending") return itinerary("view_pending", registration.id);
  if (registration?.status === "waitlisted") return itinerary("view_waitlist", registration.id);

  const isFull = event.capacity > 0 && event.availableCapacity === 0;
  const windowOpen = event.status === "published"
    && (event.deadlineAt === null || Date.parse(event.deadlineAt) > now.getTime());
  const structurallyRegistrable = windowOpen && (!isFull || event.waitlistEnabled);

  if (!session.authenticated && structurallyRegistrable) {
    return { kind: "continue_login", intent: "login", disabled: false };
  }
  if (session.authenticated && !session.phoneVerified && structurallyRegistrable) {
    return { kind: "continue_phone_verification", intent: "phone_verification", disabled: false };
  }

  const canRegister = event.availableActions.includes("register");
  const canJoinWaitlist = event.availableActions.includes("joinWaitlist");
  if (!windowOpen || (!isFull && !canRegister && !canJoinWaitlist)) {
    return disabled("registration_closed");
  }
  if (isFull && event.waitlistEnabled && canJoinWaitlist) {
    return { kind: "join_waitlist", intent: "register", disabled: false };
  }
  if (isFull) return disabled("full_closed");
  if (event.registrationMode === "approval" && canRegister) {
    return { kind: "apply", intent: "register", disabled: false };
  }
  if (canRegister) return { kind: "register", intent: "register", disabled: false };
  return disabled("registration_closed");
}

function itinerary(kind: "view_itinerary" | "view_pending" | "view_waitlist", registrationId: string): EventCTA {
  return { kind, intent: "itinerary", disabled: false, registrationId };
}

function disabled(kind: "event_unavailable" | "registration_closed" | "full_closed"): EventCTA {
  return { kind, intent: "none", disabled: true };
}
