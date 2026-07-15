import { headers } from "next/headers";
import { cache } from "react";

import type { EventDiscoveryQuery } from "./discovery-query";
import type { EventDetail, EventPage } from "./event-contract";
import { fetchEvent, searchEvents } from "./events-api";

/**
 * First-party SSR boundary for discovery. Only the Cookie header is forwarded;
 * host, forwarding, authorization, and tracing headers from the page request are
 * intentionally not copied to the API request.
 */
export async function searchEventsForRequest(query: EventDiscoveryQuery): Promise<EventPage> {
  const cookie = (await headers()).get("cookie");
  return cookie ? searchEvents(query, { cookie }) : searchEvents(query);
}

/** Request-scoped detail retrieval shared by metadata and the page render. */
export const fetchEventForRequest = cache(async (identifier: string): Promise<EventDetail> => {
  const cookie = (await headers()).get("cookie");
  return cookie ? fetchEvent(identifier, { cookie }) : fetchEvent(identifier);
});
