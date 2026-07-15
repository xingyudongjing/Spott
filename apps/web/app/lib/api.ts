import type { EventView } from "./demo-data";
import {
  EventContractError,
  parseEventDetail,
  parseEventSummary,
  type EventDetail,
  type EventSummary,
} from "./event-contract";
import { fetchEvent, searchEvents } from "./events-api";

export function normalizeEvent(value: unknown): EventView {
  const parsed = isDetailPayload(value) ? parseEventDetail(value) : parseEventSummary(value);
  return {
    ...parsed,
    categoryLabel: parsed.category,
    priceLabel: feeLabel(parsed),
    organizer: {
      ...parsed.organizer,
      reliability: trustFacts(parsed),
    },
    fee: { ...parsed.fee },
  } as EventView;
}

export async function getEvents(): Promise<EventView[]> {
  try {
    const page = await searchEvents({ limit: 24 });
    return page.items.map(normalizeEvent);
  } catch (error) {
    if (error instanceof EventContractError) throw error;
    return [];
  }
}

export async function getEvent(slug: string): Promise<EventView | undefined> {
  try {
    return normalizeEvent(await fetchEvent(slug));
  } catch (error) {
    if (error instanceof EventContractError) throw error;
    return undefined;
  }
}

function isDetailPayload(value: unknown): value is EventDetail {
  const record = asRecord(value);
  return [
    "exactAddress",
    "attendeeRequirements",
    "riskFlags",
    "riskDetails",
    "exactAddressVisibility",
    "registrationQuestions",
    "media",
    "mediaCount",
  ].every((key) => Object.hasOwn(record, key));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function feeLabel(event: EventSummary | EventDetail): string {
  if (event.fee.isFree) return "JPY 0";
  if (event.fee.amountJPY !== null) return `JPY ${event.fee.amountJPY}`;
  return [event.fee.collectorName, event.fee.method].filter((value): value is string => Boolean(value)).join(" · ");
}

function trustFacts(event: EventSummary | EventDetail): string {
  const trust = event.organizer.trust;
  return [
    `phoneVerified:${String(trust.phoneVerified)}`,
    `completedEvents:${trust.completedEventCount}`,
    `attendance:${trust.attendanceRateBand}`,
  ].join(" · ");
}
