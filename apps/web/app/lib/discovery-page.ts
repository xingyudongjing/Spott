import { parseDiscoveryQuery, type EventDiscoveryQuery } from "./discovery-query";
import type { DiscoveryFeed } from "./discovery-feed";
import type { EventPage } from "./event-contract";
import { fetchDiscoveryFeedForRequest, searchEventsForRequest } from "./events-server";

export type DiscoverySearchParams = Record<string, string | string[] | undefined>;

export interface DiscoveryPageState {
  initialQuery: EventDiscoveryQuery;
  initialPage: EventPage | null;
  initialFeed: DiscoveryFeed | null;
  initialError: string | null;
}

export async function loadDiscoveryPage(
  raw: DiscoverySearchParams,
  lockedRegion?: string,
): Promise<DiscoveryPageState> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }

  try {
    const parsed = parseDiscoveryQuery(params);
    const initialQuery = {
      ...parsed,
      ...(lockedRegion ? { region: lockedRegion } : {}),
    };
    const requestQuery = {
      ...initialQuery,
      limit: initialQuery.limit ?? 24,
    };
    if (!lockedRegion && Object.keys(initialQuery).length === 0) {
      const initialFeed = await fetchDiscoveryFeedForRequest(requestQuery);
      return { initialQuery, initialPage: null, initialFeed, initialError: null };
    }
    const initialPage = await searchEventsForRequest(requestQuery);
    return { initialQuery, initialPage, initialFeed: null, initialError: null };
  } catch (error) {
    return {
      initialQuery: lockedRegion ? { region: lockedRegion } : {},
      initialPage: null,
      initialFeed: null,
      initialError: error instanceof Error ? error.name : "DiscoveryError",
    };
  }
}
