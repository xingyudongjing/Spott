import { parseDiscoveryQuery, type EventDiscoveryQuery } from "./discovery-query";
import type { EventPage } from "./event-contract";
import { searchEventsForRequest } from "./events-server";

export type DiscoverySearchParams = Record<string, string | string[] | undefined>;

export interface DiscoveryPageState {
  initialQuery: EventDiscoveryQuery;
  initialPage: EventPage | null;
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
    const initialPage = await searchEventsForRequest({
      ...initialQuery,
      limit: initialQuery.limit ?? 24,
    });
    return { initialQuery, initialPage, initialError: null };
  } catch (error) {
    return {
      initialQuery: lockedRegion ? { region: lockedRegion } : {},
      initialPage: null,
      initialError: error instanceof Error ? error.name : "DiscoveryError",
    };
  }
}
