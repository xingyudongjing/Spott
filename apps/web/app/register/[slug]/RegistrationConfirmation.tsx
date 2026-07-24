"use client";

import Link from "next/link";
import { useState } from "react";

import { useI18n } from "../../components/I18nProvider";
import { apiRequest, readSession, type RegistrationView } from "../../lib/client-api";
import type { EventDetail } from "../../lib/event-contract";
import { EventSummary } from "./RegistrationForms";
import styles from "./RegistrationFlow.module.css";
import { RegistrationHeader } from "./RegistrationHeader";
import type { EventTicketType } from "./registration-model";

export function RegistrationConfirmation({
  event,
  registration,
  ticketType = null,
}: {
  event: EventDetail;
  registration: RegistrationView;
  ticketType?: EventTicketType | null;
}) {
  const { t } = useI18n();
  const [shareNotice, setShareNotice] = useState<{ message: string; error: boolean } | null>(null);
  // Rehydrate the off-platform payment claim from the persisted registration so
  // the "reported / confirmed" state survives a reload instead of resetting.
  const [paymentReported, setPaymentReported] = useState(
    Boolean(registration.paymentSelfReportedAt),
  );
  const paymentConfirmed = Boolean(registration.paymentConfirmedAt);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState("");
  const status = registration.status === "pending" ? "pending" : registration.status === "waitlisted" ? "waitlisted" : "confirmed";
  const title = status === "pending"
    ? t("registration.pendingTitle")
    : status === "waitlisted"
      ? t("registration.waitlistSuccess")
      : t("registration.confirmedTitle");
  // Only a confirmed registration on a paid tier (or a paid single-fee event) has
  // anything to settle off-platform — Spott records the claim, never the money.
  const paidRegistration = ticketType ? !ticketType.isFree : Boolean(event.fee && !event.fee.isFree);
  const paymentReportable = status === "confirmed" && paidRegistration;
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

  // The attendee just committed to this event, so their invite is the highest
  // intent share Spott ever sees: attribute it, and fall back to the canonical
  // public URL whenever the attributed link cannot be minted.
  async function inviteURL(): Promise<string> {
    const canonical = `${window.location.origin}/e/${event.publicSlug}`;
    if (!readSession()) return canonical;
    try {
      const created = await apiRequest<{ url?: string }>("/shares", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({
          resourceType: "event",
          resourceId: event.id,
          campaign: "web_registration_confirmation",
        }),
      });
      return typeof created?.url === "string" && created.url ? created.url : canonical;
    } catch {
      return canonical;
    }
  }

  async function share() {
    setShareNotice(null);
    const url = await inviteURL();
    if (navigator.share) {
      try {
        await navigator.share({ title: event.title, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setShareNotice({ message: t("event.linkCopied"), error: false });
    } catch {
      setShareNotice({ message: t("registration.shareError"), error: true });
    }
  }

  async function reportPayment() {
    setPaymentBusy(true);
    setPaymentError("");
    try {
      await apiRequest(`/registrations/${registration.id}/payment-report`, {
        method: "POST",
        authenticated: true,
      });
      setPaymentReported(true);
    } catch {
      setPaymentError(t("payment.reportError"));
    } finally {
      setPaymentBusy(false);
    }
  }

  return (
    <main className={styles.page}>
      <RegistrationHeader eventSlug={event.publicSlug} />
      <div className={styles.confirmationPage}>
        <section className={styles.confirmation}>
        <div className={styles.successMark} aria-hidden="true">✓</div>
        <p className={styles.eyebrow}>{t("registration.completeStep")}</p>
        <h1>{title}</h1>
        <p className={styles.confirmationLead}>{body}</p>
        <EventSummary event={event} />
        <p className={styles.partyConfirmation}>{t("registration.partySummary", { count: registration.partySize })}</p>
        <div className={styles.confirmationUtilities}>
          {event.startsAt && event.endsAt ? <button type="button" onClick={addToCalendar}>{t("event.calendar")}</button> : null}
          <button type="button" onClick={() => void share()}>{t("registration.invite")}</button>
        </div>
        {shareNotice ? (
          <p className={styles.shareNotice} role={shareNotice.error ? "alert" : "status"}>{shareNotice.message}</p>
        ) : null}
        {paymentReportable ? (
          <section className={styles.paymentReport}>
            {paymentConfirmed ? (
              <span className={styles.paymentConfirmed}>✓ {t("payment.confirmed")}</span>
            ) : paymentReported ? (
              <span className={styles.paymentReported}>{t("payment.reported")}</span>
            ) : (
              <>
                <button type="button" disabled={paymentBusy} aria-busy={paymentBusy} onClick={() => void reportPayment()}>
                  {paymentBusy ? t("payment.reporting") : t("payment.reportAction")}
                </button>
                <small>{t("payment.reportHint")}</small>
              </>
            )}
            {paymentError ? <p className={styles.paymentError} role="alert">{paymentError}</p> : null}
          </section>
        ) : null}
        <Link className={styles.confirmationPrimary} href="/me/events">{t("registration.viewItinerary")}</Link>
        <Link className={styles.confirmationSecondary} href={`/e/${event.publicSlug}`}>{t("registration.backEvent")}</Link>
        </section>
      </div>
    </main>
  );
}

function escapeCalendarText(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("\r", "").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
}
