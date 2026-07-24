"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../components/I18nProvider";
import type { Locale, MessageKey } from "../i18n/messages";
import { apiRequest, errorMessage, type NotificationView } from "../lib/client-api";
import { notificationHref } from "../lib/notification-routing";
import { DashboardNav } from "../me/DashboardNav";

const knownTypes = new Set([
  "event.key_fields_changed",
  "event.cancelled",
  "event.reminder",
  "event.reviewed",
  "event.removed",
  "event.host_announcement",
  "registration.confirmed",
  "registration.rejected",
  "registration.changed",
  "registration.hold_expired",
  "waitlist.offered",
  "waitlist.expired",
  "group.announcement",
  "group.transfer",
  "group.dissolution_scheduled",
  "points.expiring",
  "points.adjusted",
  "achievements.awarded",
  "moderation.decided",
  "account.restricted",
  "safety.case",
]);

export function NotificationsClient() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<NotificationView[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [renderedAt] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const payload = await apiRequest<{ items: NotificationView[] }>(
        "/notifications?limit=100",
        { authenticated: true },
      );
      setItems(payload.items);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function markRead(item: NotificationView) {
    if (item.readAt) return;
    setItems((current) =>
      current.map((value) =>
        value.id === item.id ? { ...value, readAt: new Date().toISOString() } : value,
      ),
    );
    try {
      await apiRequest(`/notifications/items/${item.id}/read`, {
        method: "PUT",
        authenticated: true,
        idempotent: true,
      });
    } catch (error) {
      setMessage(errorMessage(error));
      await load();
    }
  }

  async function markAll() {
    const unread = items.filter((item) => !item.readAt);
    if (!unread.length) return;
    setBusy(true);
    setItems((current) =>
      current.map((item) => ({ ...item, readAt: item.readAt ?? new Date().toISOString() })),
    );
    try {
      await Promise.all(
        unread.map((item) =>
          apiRequest(`/notifications/items/${item.id}/read`, {
            method: "PUT",
            authenticated: true,
            idempotent: true,
          }),
        ),
      );
    } catch (error) {
      setMessage(errorMessage(error));
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="dashboard-shell">
      <DashboardNav current="notifications" />
      <section className="dashboard-main notification-page">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">INBOX / SYNCED</span>
            <h1>{t("notify.title")}</h1>
            <p>{t("notify.body")}</p>
          </div>
          <button
            className="secondary-action compact"
            type="button"
            onClick={() => void markAll()}
            disabled={busy || !items.some((item) => !item.readAt)}
          >
            {t("notify.markAll")}
          </button>
        </div>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{t("notify.loading")}</p>
          </div>
        ) : items.length ? (
          <div className="notification-list">
            {items.map((item) => (
              <article className={!item.readAt ? "unread" : ""} key={item.id}>
                <span className="note-dot" />
                <div>
                  <span>{notificationTitle(item.type, t)}</span>
                  <h2>{notificationBody(item, t)}</h2>
                  <small>{relativeTime(item.createdAt, renderedAt, locale)}</small>
                </div>
                {/* Opening the subject is the same gesture that marks it read,
                    so the unread dot never lingers on something already handled. */}
                <Link
                  className="notification-open"
                  href={notificationHref(item)}
                  aria-label={t("notify.open")}
                  onClick={() => void markRead(item)}
                >
                  ↗
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{t("notify.emptyTitle")}</h2>
            <p>{t("notify.emptyBody")}</p>
          </div>
        )}
      </section>
    </main>
  );
}

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

function notificationTitle(type: string, t: Translate): string {
  const normalized = type.startsWith("event.reminder") ? "event.reminder" : type;
  return knownTypes.has(normalized)
    ? t(`notify.type.${normalized}` as MessageKey)
    : t("notify.generic");
}

function notificationBody(item: NotificationView, t: Translate): string {
  const values = item.variables;
  for (const key of ["message", "title", "eventTitle", "groupName", "reason"]) {
    if (typeof values[key] === "string") return values[key] as string;
  }
  return t("notify.genericBody");
}

function relativeTime(createdAt: string, now: number, locale: Locale): string {
  const seconds = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 1000));
  const formatter = new Intl.RelativeTimeFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
    { numeric: "auto" },
  );
  if (seconds < 60) return formatter.format(-seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}
