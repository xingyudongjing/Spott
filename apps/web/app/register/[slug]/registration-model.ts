import type { EventDetail } from "../../lib/event-contract";

export interface RegistrationQuote {
  id: string;
  amount: number;
  currency: "POINTS";
  expiresAt: string;
}

export type RegistrationFieldErrors = Record<string, string>;

const REGISTRATION_PARTY_API_MAXIMUM = 10;

export function registrationPartyLimit(
  event: Pick<EventDetail, "capacity" | "availableCapacity" | "availableActions">,
) {
  if (event.capacity <= 0) return 1;
  const eventMaximum = Math.min(REGISTRATION_PARTY_API_MAXIMUM, event.capacity);
  if (event.availableCapacity > 0) {
    return Math.max(1, Math.min(eventMaximum, event.availableCapacity));
  }
  return event.availableActions.includes("joinWaitlist")
    ? Math.max(1, eventMaximum)
    : 1;
}
