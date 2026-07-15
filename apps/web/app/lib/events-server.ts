import { headers } from "next/headers";

import type { EventDiscoveryQuery } from "./discovery-query";
import type { EventPage } from "./event-contract";
import { searchEvents } from "./events-api";

/**
 * First-party SSR boundary for discovery. Only the Cookie header is forwarded;
 * host, forwarding, authorization, and tracing headers from the page request are
 * intentionally not copied to the API request.
 */
export async function searchEventsForRequest(query: EventDiscoveryQuery): Promise<EventPage> {
  const cookie = (await headers()).get("cookie");
  return cookie ? searchEvents(query, { cookie }) : searchEvents(query);
}
