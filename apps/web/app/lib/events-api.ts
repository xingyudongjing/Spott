import { serializeDiscoveryQuery, type EventDiscoveryQuery } from "./discovery-query";
import { parseDiscoveryFeed, type DiscoveryFeed } from "./discovery-feed";
import { parseEventDetail, parseEventPage, type EventDetail, type EventPage } from "./event-contract";

export class EventAPIError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "EventAPIError";
  }
}

export async function searchEvents(
  query: EventDiscoveryQuery,
  options?: { signal?: AbortSignal },
): Promise<EventPage> {
  const params = serializeDiscoveryQuery(query);
  const suffix = params.size ? `?${params.toString()}` : "";
  const headers = new Headers({ Accept: "application/json" });
  const response = await fetch(`${eventAPIBase()}/events/search${suffix}`, {
    method: "GET",
    headers,
    credentials: "omit",
    signal: options?.signal,
  });
  if (!response.ok) throw await responseError(response);
  return parseEventPage(await response.json());
}

export async function fetchDiscoveryFeed(
  query: EventDiscoveryQuery,
  options?: { signal?: AbortSignal },
): Promise<DiscoveryFeed> {
  const params = serializeDiscoveryQuery(query);
  const suffix = params.size ? `?${params.toString()}` : "";
  const response = await fetch(`${eventAPIBase()}/discovery/feed${suffix}`, {
    method: "GET",
    headers: new Headers({ Accept: "application/json" }),
    credentials: "omit",
    signal: options?.signal,
  });
  if (!response.ok) throw await responseError(response);
  return parseDiscoveryFeed(await response.json());
}

export async function fetchEvent(
  identifier: string,
  options?: { signal?: AbortSignal },
): Promise<EventDetail> {
  const headers = new Headers({ Accept: "application/json" });
  const response = await fetch(`${eventAPIBase()}/events/${encodeURIComponent(identifier)}`, {
    method: "GET",
    headers,
    credentials: "omit",
    signal: options?.signal,
  });
  if (!response.ok) throw await responseError(response);
  return parseEventDetail(await response.json());
}

function eventAPIBase(): string {
  return (
    process.env.API_INTERNAL_URL
    ?? process.env.NEXT_PUBLIC_API_URL
    ?? (process.env.NODE_ENV === "development" ? "http://localhost:4100/v1" : "https://api.spott.jp/v1")
  ).replace(/\/$/, "");
}

async function responseError(response: Response): Promise<EventAPIError> {
  let message = `Event request failed (${response.status})`;
  try {
    const payload = await response.json() as { message?: string; error?: { message?: string } };
    message = payload.error?.message ?? payload.message ?? message;
  } catch {
    // The HTTP status remains an explicit error even when the body is not JSON.
  }
  return new EventAPIError(response.status, message);
}
