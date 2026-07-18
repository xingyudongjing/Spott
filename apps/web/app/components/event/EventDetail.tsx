import type { Locale, MessageKey } from "../../i18n/messages";
import { formatMessage } from "../../i18n/messages";
import type { EventDetail } from "../../lib/event-contract";
import { localizedPublicTags } from "../../lib/public-taxonomy";
import {
  eventDate,
  eventFeeLabel,
  eventFormatLabel,
  eventLanguageLabel,
  eventTime,
} from "../../lib/format";
import { EventCover } from "../EventCover";
import { PreviewModeLink as Link } from "../PreviewModeLink";
import styles from "./EventDetail.module.css";
import { OrganizerContactCard } from "./OrganizerContactCard";

export function EventDetailView({
  event,
  locale,
  actions,
  supplementary,
}: {
  event: EventDetail;
  locale: Locale;
  actions: React.ReactNode;
  supplementary?: React.ReactNode;
}) {
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    formatMessage(locale, key, values);
  const location = eventLocation(event, locale);
  const availability = eventAvailability(event, locale);
  const language = event.supportedLocales
    .map((value) => eventLanguageLabel(value, locale))
    .join(" · ");
  const tags = localizedPublicTags(event.tags, locale);
  const trust = organizerTrustFacts(event, locale);

  return (
    <main className={styles.page}>
      <section className={styles.firstViewport} data-testid="event-first-viewport">
        <div className={styles.shell}>
          <Link className={styles.back} href="/discover" prefetch={false}>← {t("detail.back")}</Link>
          <div className={styles.heroGrid}>
            <EventCover
              event={event}
              large
              priority
              sizes="(max-width: 780px) 100vw, (max-width: 1200px) 48vw, 600px"
              className={styles.cover}
            />
            <div className={styles.intro}>
              <div className={styles.statusLine}>
                <span>{eventFormatLabel(event.format, locale)}</span>
                <i aria-hidden="true" />
                <strong>{availability.primary}</strong>
              </div>
              <h1>{event.title}</h1>
              <p className={styles.lead}>{event.description}</p>
              {tags.length ? (
                <div className={styles.tags}>{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>
              ) : null}
            </div>
          </div>

          <div className={styles.decisionLayout}>
            <section className={styles.facts} aria-label={t("detail.decisionFacts")}>
              <Fact label={t("detail.when")} value={eventDate(event.startsAt, locale, event.displayTimeZone)} detail={eventTime(event.startsAt, event.endsAt, locale, event.displayTimeZone)} />
              <Fact label={t("detail.where")} value={location.primary} detail={location.detail} />
              <Fact label={t("detail.fee")} value={eventFeeLabel(event.fee, locale)} detail={event.fee && !event.fee.isFree ? t("detail.feeExternal") : undefined} />
              <Fact label={t("detail.availability")} value={availability.primary} detail={availability.detail} />
              <Fact label={t("detail.format")} value={eventFormatLabel(event.format, locale)} />
              <Fact label={t("detail.language")} value={language} detail={t(event.localeConfirmed ? "event.languageConfirmed" : "event.languageUnconfirmed")} />
              <Fact label={t("detail.host")} value={event.organizer.name} detail={trust[0]} />
            </section>
            {actions ? <aside className={styles.actionSlot} aria-label={t("event.primaryAction")}>{actions}</aside> : null}
          </div>
        </div>
      </section>

      <div className={`${styles.shell} ${styles.bodyGrid}`}>
        <div className={styles.content}>
          <section className={styles.section}>
            <h2>{t("detail.about")}</h2>
            <p>{event.description}</p>
            {event.attendeeRequirements ? (
              <aside className={styles.requirements}>
                <strong>{t("detail.requirements")}</strong>
                <p>{event.attendeeRequirements}</p>
              </aside>
            ) : null}
          </section>

          {supplementary}

          {event.organizerContact ? (
            <OrganizerContactCard
              contact={event.organizerContact}
              eventId={event.id}
              locale={locale}
            />
          ) : null}

          {event.fee && !event.fee.isFree ? (
            <section className={styles.section}>
              <p className={styles.eyebrow}>{t("detail.feeDetails")}</p>
              <h2>{eventFeeLabel(event.fee, locale)}</h2>
              <p>{t("detail.feeExternal")}</p>
              <dl className={styles.detailList}>
                {event.fee.collectorName ? <Detail label={t("detail.collector")} value={event.fee.collectorName} /> : null}
                {event.fee.method ? <Detail label={t("detail.method")} value={event.fee.method} /> : null}
                {event.fee.paymentDeadlineText ? <Detail label={t("detail.paymentDeadline")} value={event.fee.paymentDeadlineText} /> : null}
                {event.fee.refundPolicy ? <Detail label={t("detail.refund")} value={event.fee.refundPolicy} /> : null}
              </dl>
            </section>
          ) : null}

          {event.registrationQuestions.length ? (
            <section className={styles.section}>
              <p className={styles.eyebrow}>{t("detail.questions")}</p>
              <ol className={styles.questions}>
                {event.registrationQuestions.map((question, index) => (
                  <li key={question.id}>
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <p>{question.prompt}</p>
                    <small>{t(question.required ? "registration.required" : "detail.optional")}</small>
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          <section className={styles.safety}>
            <div>
              <strong>{t("detail.safety")}</strong>
              <p>{t("detail.safetyBody")}</p>
              <small>{t("detail.locationPrivacy")}</small>
            </div>
            <Link href={`/reports/new?targetType=event&targetId=${event.id}`} prefetch={false}>{t("detail.report")}</Link>
          </section>
        </div>

        <aside className={styles.hostCard}>
          <div className={styles.avatar} aria-hidden="true">{Array.from(event.organizer.name)[0]}</div>
          <p className={styles.eyebrow}>{t("detail.hostTrust")}</p>
          <h2>{event.organizer.name}</h2>
          <span>@{event.organizer.handle}</span>
          <ul>{trust.map((fact) => <li key={fact}>{fact}</li>)}</ul>
          <Link href={`/u/${event.organizer.handle}`} prefetch={false}>{t("detail.profile")} →</Link>
        </aside>
      </div>
    </main>
  );
}

function Fact({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className={styles.fact}>
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}

function eventLocation(event: EventDetail, locale: Locale) {
  if (event.format === "online") {
    return { primary: formatMessage(locale, "detail.online"), detail: undefined };
  }
  if (event.exactAddress) {
    return {
      primary: event.exactAddress,
      detail: [event.publicArea, formatMessage(locale, "detail.authorizedAddress")].filter(Boolean).join(" · "),
    };
  }
  return {
    primary: event.publicArea ?? formatMessage(locale, "event.areaTBA"),
    detail: formatMessage(locale, "detail.addressAfter"),
  };
}

function eventAvailability(event: EventDetail, locale: Locale) {
  if (event.capacity === 0) {
    return { primary: formatMessage(locale, "event.unlimited"), detail: undefined };
  }
  const detail = formatMessage(locale, "detail.confirmedCount", {
    confirmed: event.confirmedCount,
    capacity: event.capacity,
  });
  if (event.availableCapacity > 0) {
    return {
      primary: formatMessage(locale, "detail.remaining", { count: event.availableCapacity }),
      detail,
    };
  }
  return {
    primary: formatMessage(locale, event.waitlistEnabled ? "detail.waitlistOpen" : "detail.full"),
    detail,
  };
}

function organizerTrustFacts(event: EventDetail, locale: Locale) {
  const facts: string[] = [];
  if (event.organizer.trust.phoneVerified) facts.push(formatMessage(locale, "event.phoneVerified"));
  facts.push(event.organizer.trust.completedEventCount === 0
    ? formatMessage(locale, "event.newHost")
    : formatMessage(locale, "event.completedEvents", { count: event.organizer.trust.completedEventCount }));
  const attendanceKey: Partial<Record<EventDetail["organizer"]["trust"]["attendanceRateBand"], MessageKey>> = {
    under_70: "event.attendanceUnder70",
    "70_89": "event.attendance70to89",
    "90_plus": "event.attendance90plus",
  };
  const key = event.organizer.trust.completedEventCount > 0
    ? attendanceKey[event.organizer.trust.attendanceRateBand]
    : undefined;
  if (key) facts.push(formatMessage(locale, key));
  return facts;
}

export function eventStructuredData(event: EventDetail) {
  const attendanceMode = event.format === "online"
    ? "https://schema.org/OnlineEventAttendanceMode"
    : event.format === "hybrid"
      ? "https://schema.org/MixedEventAttendanceMode"
      : "https://schema.org/OfflineEventAttendanceMode";
  const status = event.status === "cancelled"
    ? "https://schema.org/EventCancelled"
    : event.status === "ended"
      ? "https://schema.org/EventCompleted"
      : "https://schema.org/EventScheduled";
  return {
    "@context": "https://schema.org",
    "@type": "Event",
    name: event.title,
    description: event.description,
    startDate: event.startsAt ?? undefined,
    endDate: event.endsAt ?? undefined,
    eventStatus: status,
    eventAttendanceMode: attendanceMode,
    ...(event.format !== "online" && event.publicArea ? {
      location: {
        "@type": "Place",
        name: event.publicArea,
        address: event.region ? { "@type": "PostalAddress", addressRegion: event.region, addressCountry: "JP" } : undefined,
      },
    } : {}),
    organizer: { "@type": "Person", name: event.organizer.name },
  };
}
