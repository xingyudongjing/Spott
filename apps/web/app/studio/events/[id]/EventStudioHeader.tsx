"use client";

import Link from "next/link";
import { useI18n } from "../../../components/I18nProvider";
import type { MessageKey } from "../../../i18n/messages";
import type { EventView } from "../../../lib/demo-data";

export type StudioEventTab =
  | "edit"
  | "attendees"
  | "tickets"
  | "announcements"
  | "promotion"
  | "feedback";

const TABS: Array<{ id: StudioEventTab; segment: string; label: MessageKey; statuses: string[] }> = [
  {
    id: "edit",
    segment: "edit",
    label: "studio.event.tabEdit",
    statuses: ["draft", "needs_changes", "published"],
  },
  {
    id: "attendees",
    segment: "attendees",
    label: "studio.event.tabAttendees",
    statuses: ["published", "registration_closed", "in_progress", "ended"],
  },
  {
    id: "tickets",
    segment: "tickets",
    label: "studio.event.tabTickets",
    statuses: ["draft", "needs_changes", "published", "registration_closed", "in_progress"],
  },
  {
    id: "announcements",
    segment: "announcements",
    label: "studio.event.tabAnnouncements",
    statuses: ["published", "registration_closed", "in_progress"],
  },
  {
    id: "promotion",
    segment: "promotion",
    label: "studio.event.tabPromotion",
    statuses: ["published"],
  },
  {
    id: "feedback",
    segment: "feedback",
    label: "studio.event.tabFeedback",
    statuses: ["ended"],
  },
];

/**
 * Shared heading for every studio page that manages one event: the same back
 * link, eyebrow, title and cross-links, so the event workspace reads as one
 * place rather than a set of unrelated screens.
 */
export function EventStudioHeader({
  eventId,
  event,
  current,
  eyebrow,
  title,
  body,
}: {
  eventId: string;
  event: EventView | null;
  current: StudioEventTab;
  eyebrow: MessageKey;
  title: MessageKey;
  body: MessageKey;
}) {
  const { t } = useI18n();
  return (
    <>
      <div className="dashboard-heading">
        <div>
          <Link className="back-link" href="/studio/events">
            ← {t("studio.backToEvents")}
          </Link>
          <span className="section-number">{t(eyebrow)}</span>
          <h1>{t(title)}</h1>
          <p>{event ? `${event.title} · ${t(body)}` : t(body)}</p>
        </div>
        {event && (
          <Link className="secondary-action compact" href={`/e/${event.publicSlug}`}>
            {t("studio.event.viewPublic")}
          </Link>
        )}
      </div>
      <EventStudioTabs eventId={eventId} event={event} current={current} />
    </>
  );
}

/** The event workspace tab bar, also mounted by pages that own their heading. */
export function EventStudioTabs({
  eventId,
  event,
  current,
}: {
  eventId: string;
  event: EventView | null;
  current: StudioEventTab;
}) {
  const { t } = useI18n();
  const status = event?.status ?? "";
  const tabs = TABS.filter((tab) => tab.id === current || tab.statuses.includes(status));
  if (!event || tabs.length < 2) return null;
  return (
    <nav className="studio-event-tabs" aria-label={t("nav.hostStudio")}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          className={tab.id === current ? "active" : ""}
          aria-current={tab.id === current ? "page" : undefined}
          href={`/studio/events/${eventId}/${tab.segment}`}
        >
          {t(tab.label)}
        </Link>
      ))}
    </nav>
  );
}
