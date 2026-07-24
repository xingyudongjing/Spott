import type { EventDetail } from "../../lib/event-contract";

/**
 * A ticket tier as published by the organizer. Every money field is a RECORD of
 * an off-platform arrangement: Spott never collects, holds or refunds it.
 */
export interface EventTicketType {
  id: string;
  name: string;
  description: string | null;
  isFree: boolean;
  amountJPY: number | null;
  collectorName: string | null;
  method: string | null;
  paymentDeadlineText: string | null;
  refundPolicy: string | null;
  quota: number | null;
  remaining: number | null;
  soldOut: boolean;
}

export type TicketTypesState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; items: EventTicketType[] };

export function parseTicketTypes(payload: unknown): EventTicketType[] {
  const items = (payload as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.name !== "string") return [];
    if (row.active === false) return [];
    const quota = typeof row.quota === "number" ? row.quota : null;
    const remaining = typeof row.remaining === "number" ? row.remaining : null;
    return [{
      id: row.id,
      name: row.name,
      description: typeof row.description === "string" ? row.description : null,
      isFree: row.isFree !== false,
      amountJPY: typeof row.amountJPY === "number" ? row.amountJPY : null,
      collectorName: typeof row.collectorName === "string" ? row.collectorName : null,
      method: typeof row.method === "string" ? row.method : null,
      paymentDeadlineText: typeof row.paymentDeadlineText === "string" ? row.paymentDeadlineText : null,
      refundPolicy: typeof row.refundPolicy === "string" ? row.refundPolicy : null,
      quota,
      remaining,
      soldOut: row.soldOut === true || (remaining !== null && remaining <= 0),
    }];
  });
}

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
