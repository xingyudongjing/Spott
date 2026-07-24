"use client";

import Link from "next/link";
import { useRef, useState } from "react";

import { useI18n } from "../../components/I18nProvider";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import { apiRequest, errorMessage, readSession, type WebSession } from "../../lib/client-api";
import type { EventSummary } from "../../lib/event-contract";
import { resolveEventCTA, type EventCTA, type EventCTAEvent } from "../../lib/event-cta";
import styles from "./EventActions.module.css";

type EventActionsEvent = EventCTAEvent & Pick<
  EventSummary,
  | "id"
  | "publicSlug"
  | "title"
  | "description"
  | "category"
  | "region"
  | "publicArea"
  | "startsAt"
  | "endsAt"
  | "favorited"
  | "organizer"
>;

export function EventActions({
  event,
  session,
  viewerMessage = "",
}: {
  event: EventActionsEvent;
  session: WebSession | null;
  viewerMessage?: string;
}) {
  const { t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const [favorited, setFavorited] = useState(event.favorited);
  const [following, setFollowing] = useState(event.organizer.viewerFollowing);
  const [blockedHost, setBlockedHost] = useState(false);
  const [blockConfirming, setBlockConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const viewerIsOrganizer = Boolean(session && session.user.id === event.organizer.id);
  const offerIdempotencyKey = useRef<string | null>(null);
  const cta = resolveEventCTA(event, {
    authenticated: Boolean(session),
    phoneVerified: Boolean(session?.user.phoneVerified),
  });

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

  /**
   * Blocking is one-way here, exactly like the iOS event menu: the event page
   * never lists the viewer's blocks, so the control reports what it just did
   * instead of pretending to know a persistent state.
   */
  function requestBlockHost() {
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/e/${event.publicSlug}`)}`);
      return;
    }
    setMessage("");
    setBlockConfirming(true);
  }

  async function confirmBlockHost() {
    setBusy(true);
    setMessage("");
    try {
      await apiRequest(`/users/${encodeURIComponent(event.organizer.id)}/block`, {
        method: "PUT",
        authenticated: true,
        body: JSON.stringify({ reason: "event_detail_safety_boundary" }),
      });
      setBlockedHost(true);
      setBlockConfirming(false);
      setFollowing(false);
      setMessage(t("event.blockHostDone"));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const canonical = `${window.location.origin}/e/${event.publicSlug}`;
    let url = canonical;
    if (!isReadOnly && readSession()) {
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
    if (navigator.share) {
      try {
        await navigator.share({ title: event.title, text: event.description, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(url);
        setMessage(t("event.linkCopied"));
        return;
      } catch {
        // The selectable canonical URL below works even when permission is denied.
      }
    }
    setMessage(t("event.copyManually", { url }));
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
      {!isReadOnly ? (
        <>
          <button type="button" onClick={() => void toggleFavorite()} disabled={busy} aria-pressed={favorited}>
            {favorited ? t("event.favorited") : t("event.favorite")}
          </button>
          <button type="button" onClick={() => void toggleFollow()} disabled={busy} aria-pressed={following}>
            {following ? t("event.following") : t("event.followHost")}
          </button>
        </>
      ) : null}
      <button type="button" onClick={() => void share()}>{t("event.share")}</button>
      {event.startsAt && event.endsAt ? <button type="button" onClick={addToCalendar}>{t("event.calendar")}</button> : null}
    </>
  );

  // Safety actions stay a quiet text row: present on every event page, never
  // competing with the single primary action.
  const safetyActions = !isReadOnly && !viewerIsOrganizer ? (
    <div className={styles.safetyActions}>
      <Link href={`/reports/new?targetType=user&targetId=${encodeURIComponent(event.organizer.id)}`}>
        {t("event.reportHost")}
      </Link>
      {blockConfirming && !blockedHost ? (
        <>
          <p className={styles.blockPrompt}>{t("event.blockHostConfirm", { name: event.organizer.name })}</p>
          <button type="button" disabled={busy} onClick={() => void confirmBlockHost()}>
            {t("event.blockHost")}
          </button>
          <button type="button" disabled={busy} onClick={() => setBlockConfirming(false)}>
            {t("common.cancel")}
          </button>
        </>
      ) : (
        <button type="button" disabled={busy || blockedHost} onClick={requestBlockHost}>
          {t("event.blockHost")}
        </button>
      )}
    </div>
  ) : null;

  return (
    <div className={styles.root}>
      <EventPrimaryAction
        cta={cta}
        event={event}
        busy={busy}
        onAccept={acceptOffer}
      />
      <div className={styles.utilities}>{utilities}</div>
      <div className={styles.desktopSafety}>{safetyActions}</div>
      <details className={styles.mobileUtilities}>
        <summary>{t("common.moreActions")}</summary>
        <div>
          {utilities}
          {safetyActions}
        </div>
      </details>
      {viewerMessage || message ? (
        <p className={styles.message} role="alert">{viewerMessage || message}</p>
      ) : null}
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
  event: Pick<EventSummary, "publicSlug">;
  busy: boolean;
  onAccept: (registrationId: string) => void;
}) {
  const { t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
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
  if (isReadOnly) {
    return <button {...marker} className={styles.primary} type="button" disabled>{t("preview.readOnlyAction")}</button>;
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
