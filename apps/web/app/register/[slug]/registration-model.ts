import type { EventDetail } from "../../lib/event-contract";

export interface RegistrationQuote {
  id: string;
  amount: number;
  currency: "POINTS";
  expiresAt: string;
}

export type RegistrationFieldErrors = Record<string, string>;

export function registrationPartyLimit(
  event: Pick<EventDetail, "capacity" | "availableCapacity">,
) {
  if (event.capacity <= 0) return 1;
  return Math.max(1, Math.min(event.capacity, event.availableCapacity));
}
