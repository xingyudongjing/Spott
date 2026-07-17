import type { Metadata } from "next";

import { DiscoveryShell } from "../components/discovery/DiscoveryShell";
import { formatMessage, type Locale } from "../i18n/messages";
import { serverLocale } from "../i18n/server";
import { loadDiscoveryPage } from "../lib/discovery-page";
import type { EventSummary } from "../lib/event-contract";
import { tokyoLanguageAlternates, tokyoPath } from "../lib/city-locale";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const openGraphLocales: Record<Locale, string> = {
  "zh-Hans": "zh_CN",
  ja: "ja_JP",
  en: "en_US",
};

export async function generateMetadata({ searchParams }: { searchParams: SearchParams }): Promise<Metadata> {
  const [locale, rawSearchParams] = await Promise.all([serverLocale(), searchParams]);
  const title = formatMessage(locale, "metadata.tokyoTitle");
  const description = formatMessage(locale, "metadata.tokyoDescription");
  return {
    title,
    description,
    alternates: {
      canonical: tokyoPath(locale),
      languages: tokyoLanguageAlternates,
    },
    ...(hasSearchParams(rawSearchParams) ? { robots: { index: false, follow: false } } : {}),
    openGraph: {
      title,
      description,
      type: "website",
      locale: openGraphLocales[locale],
      alternateLocale: Object.values(openGraphLocales).filter((value) => value !== openGraphLocales[locale]),
      url: tokyoPath(locale),
      images: [{ url: "/og.jpg", width: 1536, height: 1024, alt: title, type: "image/jpeg" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: ["/og.jpg"],
    },
  };
}

export default async function TokyoPage({ searchParams }: { searchParams: SearchParams }) {
  const rawSearchParams = await searchParams;
  const [locale, state] = await Promise.all([
    serverLocale(),
    loadDiscoveryPage(rawSearchParams, "tokyo"),
  ]);
  const jsonLd = hasSearchParams(rawSearchParams)
    ? null
    : JSON.stringify(tokyoStructuredData(locale, state.initialPage?.items ?? []))
      .replaceAll("<", "\\u003c");

  return (
    <main>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} /> : null}
      <DiscoveryShell
        initialQuery={state.initialQuery}
        initialPage={state.initialPage}
        initialError={state.initialError}
        lockedRegion="tokyo"
        heading={formatMessage(locale, "city.tokyoTitle")}
        supportingText={formatMessage(locale, "city.tokyoSupport")}
      />
    </main>
  );
}

function hasSearchParams(raw: Record<string, string | string[] | undefined>) {
  return Object.keys(raw).length > 0;
}

function tokyoStructuredData(locale: Locale, events: EventSummary[]) {
  const site = process.env.NEXT_PUBLIC_SITE_URL ?? "https://spott.jp";
  const pageURL = new URL(tokyoPath(locale), site).toString();
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": pageURL,
    url: pageURL,
    name: formatMessage(locale, "metadata.tokyoTitle"),
    description: formatMessage(locale, "metadata.tokyoDescription"),
    inLanguage: locale,
    about: { "@type": "City", name: formatMessage(locale, "region.tokyo") },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: events.length,
      itemListElement: events.map((event, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: publicEventStructuredData(site, event),
      })),
    },
  };
}

function publicEventStructuredData(site: string, event: EventSummary) {
  const url = new URL(`/e/${encodeURIComponent(event.publicSlug)}`, site).toString();
  return {
    "@type": "Event",
    "@id": url,
    url,
    name: event.title,
    description: event.description,
    ...(event.startsAt ? { startDate: event.startsAt } : {}),
    ...(event.endsAt ? { endDate: event.endsAt } : {}),
    ...(event.coverURL ? { image: [event.coverURL] } : {}),
    eventAttendanceMode: event.format === "online"
      ? "https://schema.org/OnlineEventAttendanceMode"
      : event.format === "hybrid"
        ? "https://schema.org/MixedEventAttendanceMode"
        : "https://schema.org/OfflineEventAttendanceMode",
    ...(event.publicArea ? {
      location: {
        "@type": "Place",
        name: event.publicArea,
        address: { "@type": "PostalAddress", addressRegion: "Tokyo", addressCountry: "JP" },
      },
    } : {}),
    organizer: {
      "@type": "Organization",
      name: event.organizer.name,
      url: new URL(`/u/${encodeURIComponent(event.organizer.handle)}`, site).toString(),
    },
  };
}
