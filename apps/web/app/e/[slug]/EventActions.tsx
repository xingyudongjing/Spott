"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { useI18n } from "../../components/I18nProvider";
import { trackProductEvent } from "../../lib/analytics";
import { apiRequest, errorMessage, readSession } from "../../lib/client-api";
import type { EventSummary } from "../../lib/event-contract";
import { resolveEventCTA, type EventCTA } from "../../lib/event-cta";
import styles from "./EventActions.module.css";

export function EventActions({ event }: { event: EventSummary }) {
  const { locale, t } = useI18n();
  const [session, setSession] = useState(() => readSession());
  const [favorited, setFavorited] = useState(event.favorited);
  const [following, setFollowing] = useState(event.organizer.viewerFollowing);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const offerIdempotencyKey = useRef<string | null>(null);
  const cta = resolveEventCTA(event, {
    authenticated: Boolean(session),
    phoneVerified: Boolean(session?.user.phoneVerified),
  });

  useEffect(() => {
    const changed = () => setSession(readSession());
    window.addEventListener("spott:session", changed);
    return () => window.removeEventListener("spott:session", changed);
  }, []);

  useEffect(() => {
    void trackProductEvent("event_detail_viewed", {
      eventId: event.id,
      category: event.category,
      region: event.region,
      status: event.status,
      availableCapacity: event.availableCapacity,
    });
  }, [event.availableCapacity, event.category, event.id, event.region, event.status]);

  async function acceptOffer(registrationId: string) {
    setBusy(true);
    setMessage("");
    try {
      const key = offerIdempotencyKey.current ?? window.crypto.randomUUID();
      offerIdempotencyKey.current = key;
      await apiRequest(`/registrations/${registrationId}/waitlist-acceptance`, {
        method: "POST",
        authenticated: true,
        idempotencyKey: key,
      });
      offerIdempotencyKey.current = null;
      window.location.assign(`/me/events?registration=${encodeURIComponent(registrationId)}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFavorite() {
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/e/${event.publicSlug}`)}`);
      return;
    }
    const next = !favorited;
    setFavorited(next);
    setBusy(true);
    setMessage("");
    try {
      await apiRequest(`/events/${event.id}/favorite`, {
        method: next ? "PUT" : "DELETE",
        authenticated: true,
      });
    } catch (error) {
      setFavorited(!next);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFollow() {
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/e/${event.publicSlug}`)}`);
      return;
    }
    const next = !following;
    setFollowing(next);
    setBusy(true);
    setMessage("");
    try {
      await apiRequest(`/profiles/${encodeURIComponent(event.organizer.id)}/follow`, {
        method: next ? "PUT" : "DELETE",
        authenticated: true,
      });
    } catch (error) {
      setFollowing(!next);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const canonical = `${window.location.origin}/e/${event.publicSlug}`;
    let url = canonical;
    if (readSession()) {
      try {
        const created = await apiRequest<{ url: string }>("/shares", {
          method: "POST",
          authenticated: true,
          body: JSON.stringify({
            resourceType: "event",
            resourceId: event.id,
            campaign: "web_event_detail",
          }),
        });
        url = created.url;
      } catch {
        // A canonical public URL remains a safe share fallback.
      }
    }
    try {
      if (navigator.share) await navigator.share({ title: event.title, text: event.description, url });
      else {
        await navigator.clipboard.writeText(url);
        setMessage(t("event.linkCopied"));
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage(errorMessage(error));
    }
  }

  function addToCalendar() {
    if (!event.startsAt || !event.endsAt) return;
    const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
    const stamp = (value: string) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const content = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Spott//Events//EN", "BEGIN:VEVENT",
      `UID:${event.id}@spott.jp`, `DTSTAMP:${stamp(new Date().toISOString())}`,
      `DTSTART:${stamp(event.startsAt)}`, `DTEND:${stamp(event.endsAt)}`,
      `SUMMARY:${escape(event.title)}`, `DESCRIPTION:${escape(event.description)}`,
      `LOCATION:${escape(event.publicArea ?? "")}`, `URL:${window.location.origin}/e/${event.publicSlug}`,
      "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([content], { type: "text/calendar;charset=utf-8" }));
    anchor.download = `${event.publicSlug}.ics`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  const utilities = (
    <>
      <button type="button" onClick={() => void toggleFavorite()} disabled={busy} aria-pressed={favorited}>
        {favorited ? t("event.favorited") : t("event.favorite")}
      </button>
      <button type="button" onClick={() => void toggleFollow()} disabled={busy} aria-pressed={following}>
        {following ? t("event.following") : t("event.followHost")}
      </button>
      <button type="button" onClick={() => void share()}>{t("event.share")}</button>
      {event.startsAt && event.endsAt ? <button type="button" onClick={addToCalendar}>{t("event.calendar")}</button> : null}
    </>
  );

  return (
    <div className={styles.root}>
      <EventPrimaryAction
        cta={cta}
        event={event}
        busy={busy}
        onAccept={acceptOffer}
      />
      <div className={styles.utilities}>{utilities}</div>
      <details className={styles.mobileUtilities}>
        <summary>{t("common.moreActions")}</summary>
        <div>{utilities}</div>
      </details>
      {message ? <p className={styles.message} role="alert">{message}</p> : null}
    </div>
  );
}

export function EventPrimaryAction({
  cta,
  event,
  busy,
  onAccept,
}: {
  cta: EventCTA;
  event: EventSummary;
  busy: boolean;
  onAccept: (registrationId: string) => void;
}) {
  const { t } = useI18n();
  const registerPath = `/register/${event.publicSlug}`;
  const marker = { "data-event-primary": true };

  if (cta.disabled) {
    const label = cta.kind === "event_unavailable"
      ? t("event.unavailable")
      : cta.kind === "full_closed"
        ? t("event.fullClosed")
        : t("event.registrationClosed");
    return <button {...marker} className={styles.primary} type="button" disabled>{label}</button>;
  }
  if (cta.kind === "accept_waitlist" && cta.registrationId) {
    return (
      <button
        {...marker}
        className={styles.primary}
        type="button"
        disabled={busy}
        onClick={() => onAccept(cta.registrationId!)}
      >
        {t("event.acceptWaitlist")}
      </button>
    );
  }
  if (cta.intent === "itinerary") {
    const label = cta.kind === "view_pending"
      ? t("event.viewPending")
      : cta.kind === "view_waitlist"
        ? t("event.viewWaitlist")
        : t("event.viewRegistration");
    return <Link {...marker} className={styles.primary} href={`/me/events?registration=${cta.registrationId}`}>{label}</Link>;
  }
  if (cta.kind === "continue_login") {
    return <Link {...marker} className={styles.primary} href={`/login?returnTo=${encodeURIComponent(registerPath)}`}>{t("event.continueLogin")}</Link>;
  }
  if (cta.kind === "continue_phone_verification") {
    return <Link {...marker} className={styles.primary} href={`/phone-verification?returnTo=${encodeURIComponent(registerPath)}`}>{t("event.continuePhone")}</Link>;
  }
  const label = cta.kind === "join_waitlist"
    ? t("event.joinWaitlist")
    : cta.kind === "apply"
      ? t("event.apply")
      : t("event.register");
  return <Link {...marker} className={styles.primary} href={registerPath}>{label}</Link>;
}
