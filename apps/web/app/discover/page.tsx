import { DiscoveryShell } from "../components/discovery/DiscoveryShell";
import { parseDiscoveryQuery, type EventDiscoveryQuery } from "../lib/discovery-query";
import type { EventPage } from "../lib/event-contract";
import { searchEvents } from "../lib/events-api";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function DiscoverPage({ searchParams }: { searchParams: SearchParams }) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
    else if (value !== undefined) params.set(key, value);
  }

  let initialQuery: EventDiscoveryQuery = {};
  let initialPage: EventPage | null = null;
  let initialError: string | null = null;
  try {
    initialQuery = parseDiscoveryQuery(params);
    initialPage = await searchEvents({ ...initialQuery, limit: initialQuery.limit ?? 24 });
  } catch (error) {
    initialError = error instanceof Error ? error.name : "DiscoveryError";
  }

  return (
    <main>
      <DiscoveryShell
        initialQuery={initialQuery}
        initialPage={initialPage}
        initialError={initialError}
      />
    </main>
  );
}
