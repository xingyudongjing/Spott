import type { Locale } from "../../i18n/messages";
import { formatMessage } from "../../i18n/messages";
import type { OrganizerContact } from "../../lib/event-contract";
import { PreviewModeLink as Link } from "../PreviewModeLink";
import styles from "./OrganizerContactCard.module.css";

export function OrganizerContactCard({
  contact,
  eventId,
  locale,
}: {
  contact: OrganizerContact;
  eventId: string;
  locale: Locale;
}) {
  const t = (key: Parameters<typeof formatMessage>[1]) => formatMessage(locale, key);
  const headingId = `organizer-contact-${eventId}`;
  const external = contact.kind !== "email";

  return (
    <section className={styles.card} aria-labelledby={headingId}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{t("registration.contactEyebrow")}</p>
          <h2 id={headingId}>{t("registration.contactTitle")}</h2>
        </div>
        <span className={styles.shield} aria-hidden="true">✓</span>
      </header>
      <p className={styles.body}>{t("registration.contactBody")}</p>
      <div className={styles.channel}>
        <span>{contact.label ?? t("registration.contactChannel")}</span>
        <strong dir="auto">{contact.value}</strong>
      </div>
      <div className={styles.actions}>
        <a
          className={styles.primary}
          href={contactHref(contact)}
          {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        >
          {contact.kind === "email"
            ? t("registration.contactEmail")
            : contact.kind === "line"
              ? t("registration.contactLine")
              : t("registration.contactWebsite")}
          {external ? (
            <>
              <span className={styles.externalMark} aria-hidden="true">↗</span>
              <span className="sr-only"> ({t("registration.opensNewWindow")})</span>
            </>
          ) : null}
        </a>
        <Link
          className={styles.report}
          href={`/reports/new?targetType=event&targetId=${eventId}`}
        >
          {t("registration.reportIssue")}
        </Link>
      </div>
      <p className={styles.safety}>{t("registration.contactSafety")}</p>
    </section>
  );
}

function contactHref(contact: OrganizerContact) {
  if (contact.kind === "email") return `mailto:${contact.value}`;
  if (contact.kind === "line") return `https://line.me/R/ti/p/~${encodeURIComponent(contact.value)}`;
  return contact.value;
}
