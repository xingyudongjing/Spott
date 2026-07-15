"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { EventView } from "../../lib/demo-data";
import { trackProductEvent } from "../../lib/analytics";
import { apiRequest, errorMessage, readSession } from "../../lib/client-api";
import { useI18n } from "../../components/I18nProvider";

export function EventActions({ event, remaining }: { event: EventView; remaining: number }) {
  const { locale, t } = useI18n();
  const [favorited, setFavorited] = useState(Boolean(event.favorited));
  const [following, setFollowing] = useState(Boolean(event.organizer.viewerFollowing));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const alreadyRegistered = Boolean(event.registrationStatus && !["cancelled", "rejected"].includes(event.registrationStatus));

  useEffect(() => {
    void trackProductEvent("event_detail_viewed", {
      eventId: event.id,
      category: event.category,
      region: event.region,
      status: event.status,
      remaining,
    });
  }, [event.category, event.id, event.region, event.status, remaining]);

  async function toggleFavorite() {
    const session = readSession();
    if (!session) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/e/${event.publicSlug}`)}`);
      return;
    }
    setBusy(true);
    setMessage("");
    const next = !favorited;
    setFavorited(next);
    try {
      await apiRequest(`/events/${event.id}/favorite`, { method: next ? "PUT" : "DELETE", authenticated: true });
    } catch (error) {
      setFavorited(!next);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleFollow() {
    const session = readSession();
    if (!session) { window.location.assign(`/login?returnTo=${encodeURIComponent(`/e/${event.publicSlug}`)}`); return; }
    const target = event.organizer.id ?? event.organizerId ?? event.organizer.handle;
    const next = !following;
    setFollowing(next); setBusy(true); setMessage("");
    try { await apiRequest(`/profiles/${encodeURIComponent(target)}/follow`, { method: next ? "PUT" : "DELETE", authenticated: true }); }
    catch (error) { setFollowing(!next); setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function share() {
    const canonical = `${window.location.origin}/e/${event.publicSlug}`;
    let url = canonical;
    if (readSession()) {
      try {
        const created = await apiRequest<{ url: string }>("/shares", {
          method: "POST", authenticated: true,
          body: JSON.stringify({ resourceType: "event", resourceId: event.id, campaign: "web_event_detail" }),
        });
        url = created.url;
      } catch { /* canonical URL remains a valid share */ }
    }
    try {
      if (navigator.share) await navigator.share({ title: event.title, text: event.description, url });
      else {
        await navigator.clipboard.writeText(url);
        setMessage(locale === "ja" ? "リンクをコピーしました。" : locale === "en" ? "Link copied." : "分享链接已复制。");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setMessage(errorMessage(error));
    }
  }

  function addToCalendar() {
    const escape = (value: string) => value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll(",", "\\,").replaceAll(";", "\\;");
    const stamp = (value: string) => new Date(value).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
    const content = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Spott//Events//EN", "BEGIN:VEVENT", `UID:${event.id}@spott.jp`, `DTSTAMP:${stamp(new Date().toISOString())}`, `DTSTART:${stamp(event.startsAt)}`, `DTEND:${stamp(event.endsAt)}`, `SUMMARY:${escape(event.title)}`, `DESCRIPTION:${escape(event.description)}`, `LOCATION:${escape(event.publicArea)}`, `URL:${window.location.origin}/e/${event.publicSlug}`, "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const anchor = document.createElement("a");
    anchor.href = URL.createObjectURL(new Blob([content], { type: "text/calendar;charset=utf-8" }));
    anchor.download = `${event.publicSlug}.ics`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
  }

  return <>
    {alreadyRegistered ? (
      <Link className="primary-action" href="/me/events">{t("event.viewRegistration")}</Link>
    ) : (
      <Link className="primary-action" href={`/register/${event.publicSlug}`}>{remaining > 0 ? t("event.register") : t("event.joinWaitlist")}</Link>
    )}
    <button className={`secondary-action favorite-action${favorited ? " active" : ""}`} type="button" onClick={toggleFavorite} disabled={busy} aria-pressed={favorited}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20.2 4.4 13A4.9 4.9 0 0 1 11 5.8l1 1 1-1A4.9 4.9 0 0 1 19.6 13Z" /></svg>
      {favorited ? t("event.favorited") : t("event.favorite")}
    </button>
    <button className={`secondary-action follow-action${following ? " active" : ""}`} type="button" onClick={toggleFollow} disabled={busy} aria-pressed={following}>{following ? (locale === "ja" ? "フォロー中" : locale === "en" ? "Following" : "已关注主办方") : t("event.followHost")}</button>
    <div className="action-pair"><button className="secondary-action" type="button" onClick={() => void share()}>{t("event.share")}</button><button className="secondary-action" type="button" onClick={addToCalendar}>{t("event.calendar")}</button></div>
    {message && <p className="action-error" role="alert">{message}</p>}
  </>;
}
