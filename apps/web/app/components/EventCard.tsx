"use client";

import Link from "next/link";
import type { EventView } from "../lib/demo-data";
import { eventDate, eventTime } from "../lib/format";
import { EventCover } from "./EventCover";
import { ArrowIcon, PinIcon } from "./icons";
import { useI18n } from "./I18nProvider";

export function EventCard({ event, featured = false }: { event: EventView; featured?: boolean }) {
  const { locale, t } = useI18n();
  const remaining = event.capacity - event.confirmedCount;
  return (
    <article className={`event-card${featured ? " event-card-featured" : ""}`}>
      <Link href={`/e/${event.publicSlug}`} className="card-cover-link" aria-label={`查看 ${event.title}`}>
        <EventCover event={event} large={featured} locale={locale} />
      </Link>
      <div className="event-card-body">
        <div className="card-meta-row">
          <span className="event-date">{eventDate(event.startsAt, locale)} · {eventTime(event.startsAt, event.endsAt, locale)}</span>
          <span className={`capacity-pill${remaining <= 2 ? " capacity-tight" : ""}`}>
            {remaining > 0 ? t("event.spots", { count: remaining }) : t("event.waitlist")}
          </span>
        </div>
        <h3><Link href={`/e/${event.publicSlug}`}>{event.title}</Link></h3>
        {featured && <p className="featured-copy">{event.description}</p>}
        <div className="card-bottom-row">
          <span><PinIcon /> {event.publicArea}</span>
          <span className="event-price">{event.priceLabel}</span>
          <Link className="card-arrow" href={`/e/${event.publicSlug}`} aria-label={`打开 ${event.title}`}>
            <ArrowIcon />
          </Link>
        </div>
      </div>
    </article>
  );
}
