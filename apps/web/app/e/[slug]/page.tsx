import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { eventStructuredData } from "../../components/event/EventDetail";
import { Footer } from "../../components/Footer";
import { serverLocale } from "../../i18n/server";
import { EventAPIError, fetchEventPromotion } from "../../lib/events-api";
import { fetchEventForRequest } from "../../lib/events-server";
import { EventDetailClient } from "./EventDetailClient";

type PageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const event = await eventOrNull((await params).slug);
  if (!event) return { title: "Event not found · Spott" };
  return {
    title: event.title,
    description: event.description,
    alternates: { canonical: `/e/${event.publicSlug}` },
    openGraph: {
      title: event.title,
      description: event.description,
      type: "website",
      ...(event.coverURL ? { images: [event.coverURL] } : {}),
    },
  };
}

export default async function EventPage({ params }: PageProps) {
  const [{ slug }, locale] = await Promise.all([params, serverLocale()]);
  const event = await eventOrNull(slug);
  if (!event) notFound();
  // The detail EventView omits the discovery `promoted` flag, so the badge is
  // sourced from the public promotion endpoint instead.
  const promotion = event.promoted ? null : await fetchEventPromotion(event.id);
  const displayEvent = promotion?.state === "active" ? { ...event, promoted: true } : event;
  const jsonLd = JSON.stringify(eventStructuredData(event)).replaceAll("<", "\\u003c");

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <EventDetailClient event={displayEvent} locale={locale} />
      <Footer />
    </>
  );
}

async function eventOrNull(slug: string) {
  try {
    return await fetchEventForRequest(slug);
  } catch (error) {
    if (error instanceof EventAPIError && error.status === 404) return null;
    throw error;
  }
}
