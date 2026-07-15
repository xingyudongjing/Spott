"use client";

import Link from "next/link";

import type { EventSummary } from "../../lib/event-contract";
import {
  eventDate,
  eventFeeLabel,
  eventFormatLabel,
  eventLanguageLabel,
  eventTime,
} from "../../lib/format";
import { EventCover } from "../EventCover";
import { useI18n } from "../I18nProvider";
import {
  BuildingIcon,
  ChevronIcon,
  GlobeIcon,
  PinIcon,
  ShieldCheckIcon,
  TicketIcon,
} from "../icons";
import styles from "./DiscoveryShell.module.css";

export type EventCardEvent = Pick<
  EventSummary,
  | "id"
  | "publicSlug"
  | "title"
  | "category"
  | "coverURL"
  | "startsAt"
  | "endsAt"
  | "displayTimeZone"
  | "publicArea"
  | "fee"
  | "format"
  | "primaryLocale"
  | "localeConfirmed"
  | "organizer"
  | "capacity"
  | "availableCapacity"
  | "waitlistEnabled"
  | "availableActions"
>;

export function EventResultCard({
  event,
  priority = false,
  selected = false,
}: {
  event: EventCardEvent;
  priority?: boolean;
  selected?: boolean;
}) {
  const { locale, t } = useI18n();
  const area = event.publicArea || t("event.areaTBA");
  const fee = eventFeeLabel(event.fee, locale);
  const format = eventFormatLabel(event.format, locale);
  const language = eventLanguageLabel(event.primaryLocale, locale);
  const attendance = attendanceLabel(event.organizer.trust.attendanceRateBand, t);
  const capacity = capacityLabel(event, t);
  const capacityIsTight = event.capacity > 0 && event.availableCapacity <= 2;

  return (
    <article
      className={styles.eventCard}
      aria-label={event.title}
      data-selected={selected || undefined}
      data-testid="discovery-event"
    >
      <Link className={styles.eventLink} href={`/e/${event.publicSlug}`}>
        <div className={styles.coverFrame}>
          <EventCover
            event={event}
            priority={priority}
            sizes="(max-width: 780px) calc(100vw - 32px), 232px"
          />
        </div>
        <div className={styles.eventBody}>
          <p className={styles.eventDate}>
            {eventDate(event.startsAt, locale, event.displayTimeZone)}
            <span aria-hidden="true"> · </span>
            {eventTime(event.startsAt, event.endsAt, locale, event.displayTimeZone)}
          </p>
          <h3>{event.title}</h3>
          <div className={styles.eventFacts}>
            <span><PinIcon />{area}</span>
            <span><TicketIcon />{fee}<span aria-hidden="true"> · </span>{format}</span>
            <span data-tone={event.localeConfirmed ? "confirmed" : "pending"}>
              <GlobeIcon />
              {language}<span aria-hidden="true"> · </span>
              {event.localeConfirmed ? t("event.languageConfirmed") : t("event.languageUnconfirmed")}
            </span>
          </div>
          <div className={styles.trustFacts}>
            <span><BuildingIcon />{event.organizer.name}</span>
            {event.organizer.trust.phoneVerified ? (
              <span data-tone="verified"><ShieldCheckIcon />{t("event.phoneVerified")}</span>
            ) : null}
            <span>{t("event.completedEvents", { count: event.organizer.trust.completedEventCount })}</span>
            {attendance ? <span>{attendance}</span> : null}
          </div>
        </div>
        <div className={styles.capacity} data-tight={capacityIsTight || undefined}>
          <strong>{capacity}</strong>
          <ChevronIcon />
        </div>
      </Link>
    </article>
  );
}

function capacityLabel(
  event: EventCardEvent,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (event.capacity === 0) return t("event.unlimited");
  if (event.availableCapacity > 0) return t("event.spots", { count: event.availableCapacity });
  if (event.waitlistEnabled && event.availableActions.includes("joinWaitlist")) {
    return t("event.waitlistAvailable");
  }
  return t("event.full");
}

function attendanceLabel(
  band: EventCardEvent["organizer"]["trust"]["attendanceRateBand"],
  t: ReturnType<typeof useI18n>["t"],
) {
  if (band === "unavailable") return null;
  if (band === "under_70") return t("event.attendanceUnder70");
  if (band === "70_89") return t("event.attendance70to89");
  return t("event.attendance90plus");
}
