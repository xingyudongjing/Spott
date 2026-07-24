"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../../../lib/client-api";
import { StudioNav } from "../../../StudioNav";
import { EventStudioHeader } from "../EventStudioHeader";
import { useOrganizerEvent } from "../use-organizer-event";

interface SentAnnouncement {
  id: string;
  title: string;
  body: string;
  recipientCount: number;
  sentAt: string;
}

interface AnnouncementPage {
  items: SentAnnouncement[];
  dailyLimit: number;
  remainingToday: number;
}

interface SendReceipt {
  announcementId: string;
  recipientCount: number;
  dailyLimit: number;
  remainingToday: number;
}

export function AnnouncementComposer({ eventId }: { eventId: string }) {
  const { locale, t } = useI18n();
  const { event, loading: eventLoading, error: eventError } = useOrganizerEvent(eventId);
  const [items, setItems] = useState<SentAnnouncement[]>([]);
  const [dailyLimit, setDailyLimit] = useState(5);
  const [remainingToday, setRemainingToday] = useState(5);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiRequest<AnnouncementPage>(`/events/${eventId}/announcements`, {
        authenticated: true,
      });
      setItems(payload.items);
      setDailyLimit(payload.dailyLimit);
      setRemainingToday(payload.remainingToday);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function send() {
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (trimmedTitle.length < 2 || trimmedTitle.length > 120) {
      setMessage(t("studio.announcements.titleError"));
      return;
    }
    if (trimmedBody.length < 1 || trimmedBody.length > 2000) {
      setMessage(t("studio.announcements.bodyError"));
      return;
    }
    setSending(true);
    setMessage("");
    setNotice("");
    try {
      const receipt = await apiRequest<SendReceipt>(`/events/${eventId}/announcements`, {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({ title: trimmedTitle, body: trimmedBody }),
      });
      setRemainingToday(receipt.remainingToday);
      setTitle("");
      setBody("");
      setNotice(t("studio.announcements.sent", { count: receipt.recipientCount }));
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setSending(false);
    }
  }

  const canSend =
    !sending
    && remainingToday > 0
    && title.trim().length >= 2
    && body.trim().length >= 1;

  if (!eventLoading && !event) {
    return (
      <main className="studio-shell">
        <StudioNav current="events" />
        <section className="studio-content">
          <EventStudioHeader
            eventId={eventId}
            event={null}
            current="announcements"
            eyebrow="studio.eyebrow.announcements"
            title="studio.announcements.title"
            body="studio.announcements.body"
          />
          <div className="empty-state compact-empty">
            <h2>{t("studio.event.notFound")}</h2>
            <p>{eventError || t("studio.event.notFoundBody")}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="studio-shell">
      <StudioNav current="events" />
      <section className="studio-content">
        <EventStudioHeader
          eventId={eventId}
          event={event}
          current="announcements"
          eyebrow="studio.eyebrow.announcements"
          title="studio.announcements.title"
          body="studio.announcements.body"
        />
        <p className="studio-boundary-note">{t("studio.announcements.boundary")}</p>

        <section className="management-card announcement-composer-card">
          <label className="form-field">
            {t("studio.announcements.fieldTitle")}
            <input
              value={title}
              maxLength={120}
              placeholder={t("studio.announcements.fieldTitlePlaceholder")}
              onChange={(input) => setTitle(input.target.value)}
            />
            <small>{title.trim().length} / 120</small>
          </label>
          <label className="form-field">
            {t("studio.announcements.fieldBody")}
            <textarea
              rows={6}
              maxLength={2000}
              value={body}
              placeholder={t("studio.announcements.fieldBodyPlaceholder")}
              onChange={(input) => setBody(input.target.value)}
            />
            <small>{body.trim().length} / 2000</small>
          </label>
          <p className="announcement-quota" data-exhausted={remainingToday > 0 ? undefined : "true"}>
            {remainingToday > 0
              ? t("studio.announcements.remaining", {
                  count: remainingToday,
                  limit: dailyLimit,
                })
              : t("studio.announcements.limitReached")}
          </p>
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          {notice && (
            <p className="form-message" role="status">
              {notice}
            </p>
          )}
          <button className="primary-action compact" disabled={!canSend} onClick={() => void send()}>
            {sending ? t("studio.announcements.sending") : t("studio.announcements.send")}
          </button>
        </section>

        {eventError && (
          <p className="form-message" role="alert">
            {eventError}
          </p>
        )}

        <div className="section-heading">
          <div>
            <h2>{t("studio.announcements.history")}</h2>
          </div>
        </div>
        {loading || eventLoading ? (
          <div className="loading-state">
            <span />
            <p>{t("common.loading")}</p>
          </div>
        ) : items.length ? (
          <div className="announcement-history">
            {items.map((item) => (
              <article key={item.id}>
                <div>
                  <h3>{item.title}</h3>
                  <time dateTime={item.sentAt}>{formatDateTime(item.sentAt, locale)}</time>
                </div>
                <p>{item.body}</p>
                <span>{t("studio.announcements.recipients", { count: item.recipientCount })}</span>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{t("studio.announcements.historyEmpty")}</h2>
            <p>{t("studio.announcements.historyEmptyBody")}</p>
          </div>
        )}
      </section>
    </main>
  );
}

function formatDateTime(value: string, locale: "zh-Hans" | "ja" | "en"): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
