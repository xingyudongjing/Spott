"use client";

import Link from "next/link";
import { useState } from "react";

import { useI18n } from "../../components/I18nProvider";
import type { RegistrationView } from "../../lib/client-api";
import type { EventDetail } from "../../lib/event-contract";
import { EventSummary } from "./RegistrationForms";
import styles from "./RegistrationFlow.module.css";

export function RegistrationConfirmation({
  event,
  registration,
}: {
  event: EventDetail;
  registration: RegistrationView;
}) {
  const { t } = useI18n();
  const [shareNotice, setShareNotice] = useState<{ message: string; error: boolean } | null>(null);
  const status = registration.status === "pending" ? "pending" : registration.status === "waitlisted" ? "waitlisted" : "confirmed";
  const title = status === "pending"
    ? t("registration.pendingTitle")
    : status === "waitlisted"
      ? t("registration.waitlistSuccess")
      : t("registration.confirmedTitle");
  const body = status === "pending"
    ? t("registration.pendingBody")
    : status === "waitlisted"
      ? t("registration.waitlistBody")
      : t("registration.confirmedBody");

  function addToCalendar() {
    if (!event.startsAt || !event.endsAt) return;
    const stamp = (value: string) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const content = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      `UID:${event.id}@spott.jp`,
      `DTSTART:${stamp(event.startsAt)}`,
      `DTEND:${stamp(event.endsAt)}`,
      `SUMMARY:${escapeCalendarText(event.title)}`,
      `LOCATION:${escapeCalendarText(event.publicArea ?? "")}`,
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([content], { type: "text/calendar" }));
    anchor.download = `${event.publicSlug}.ics`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  async function share() {
    const url = `${window.location.origin}/e/${event.publicSlug}`;
    setShareNotice(null);
    try {
      if (navigator.share) await navigator.share({ title: event.title, url });
      else {
        await navigator.clipboard.writeText(url);
        setShareNotice({ message: t("event.linkCopied"), error: false });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareNotice({ message: t("registration.shareError"), error: true });
    }
  }

  return (
    <main className={`${styles.page} ${styles.confirmationPage}`}>
      <section className={styles.confirmation}>
        <div className={styles.successMark} aria-hidden="true">✓</div>
        <p className={styles.eyebrow}>{t("registration.completeStep")}</p>
        <h1>{title}</h1>
        <p className={styles.confirmationLead}>{body}</p>
        <EventSummary event={event} />
        <p className={styles.partyConfirmation}>{t("registration.partySummary", { count: registration.partySize })}</p>
        <div className={styles.confirmationUtilities}>
          {event.startsAt && event.endsAt ? <button type="button" onClick={addToCalendar}>{t("event.calendar")}</button> : null}
          <button type="button" onClick={() => void share()}>{t("event.share")}</button>
        </div>
        {shareNotice ? (
          <p className={styles.shareNotice} role={shareNotice.error ? "alert" : "status"}>{shareNotice.message}</p>
        ) : null}
        <Link className={styles.confirmationPrimary} href="/me/events">{t("registration.viewItinerary")}</Link>
        <Link className={styles.confirmationSecondary} href={`/e/${event.publicSlug}`}>{t("registration.backEvent")}</Link>
      </section>
    </main>
  );
}

function escapeCalendarText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\r", "").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
}
