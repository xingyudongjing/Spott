import { cache } from "react";

import type { EventDiscoveryQuery } from "./discovery-query";
import type { DiscoveryFeed } from "./discovery-feed";
import type { EventDetail, EventPage } from "./event-contract";
import { fetchDiscoveryFeed, fetchEvent, searchEvents } from "./events-api";

/** Public discovery stays anonymous at the SSR boundary. */
export async function searchEventsForRequest(query: EventDiscoveryQuery): Promise<EventPage> {
  return searchEvents(query);
}

/** Public recommendation feed stays anonymous at the SSR boundary. */
export async function fetchDiscoveryFeedForRequest(query: EventDiscoveryQuery): Promise<DiscoveryFeed> {
  return fetchDiscoveryFeed(query);
}

/** Request-scoped detail retrieval shared by metadata and the page render. */
export const fetchEventForRequest = cache(async (identifier: string): Promise<EventDetail> => {
  return fetchEvent(identifier);
});
