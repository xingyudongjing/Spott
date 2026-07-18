import type { Metadata } from "next";
import { DiscoveryShell } from "../components/discovery/DiscoveryShell";
import { loadDiscoveryPage } from "../lib/discovery-page";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const raw = await searchParams;
  const hasVariant = Object.values(raw).some((value) => (
    Array.isArray(value) ? value.some((item) => item.length > 0) : Boolean(value)
  ));
  return {
    alternates: { canonical: "/discover" },
    robots: { index: !hasVariant, follow: true },
  };
}

export default async function DiscoverPage({ searchParams }: { searchParams: SearchParams }) {
  const { initialQuery, initialPage, initialFeed, initialError } = await loadDiscoveryPage(await searchParams);

  return (
    <main>
      <DiscoveryShell
        initialQuery={initialQuery}
        initialPage={initialPage}
        initialFeed={initialFeed}
        initialError={initialError}
      />
    </main>
  );
}
