"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../components/I18nProvider";
import type { Locale } from "../i18n/messages";
import { apiRequest, errorMessage, type NotificationView } from "../lib/client-api";
import { DashboardNav } from "../me/DashboardNav";

export function NotificationsClient() {
  const { locale } = useI18n();
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

  const copy =
    locale === "ja"
      ? {
          title: "お知らせ",
          body: "既読状態は iOS と Web で共有されます。",
          all: "すべて既読にする",
          syncing: "お知らせを同期中…",
          empty: "新しいお知らせはありません",
          emptyBody: "申込、キャンセル待ち、グループ、イベントの重要な変更がここに届きます。",
          open: "関連内容を開く",
        }
      : locale === "en"
        ? {
            title: "Notifications",
            body: "Read status is shared across iOS and Web.",
            all: "Mark all as read",
            syncing: "Syncing notifications…",
            empty: "No new notifications",
            emptyBody: "Important registration, waitlist, group, and event updates appear here.",
            open: "Open related item",
          }
        : {
            title: "通知中心",
            body: "iOS 与 Web 共用已读状态。",
            all: "全部标为已读",
            syncing: "正在同步通知…",
            empty: "没有新通知",
            emptyBody: "报名、候补、群组和活动关键变化会出现在这里。",
            open: "打开相关内容",
          };

  return (
    <main className="dashboard-shell">
      <DashboardNav current="notifications" />
      <section className="dashboard-main notification-page">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">INBOX / SYNCED</span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <button
            className="secondary-action compact"
            type="button"
            onClick={() => void markAll()}
            disabled={busy || !items.some((item) => !item.readAt)}
          >
            {copy.all}
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
            <p>{copy.syncing}</p>
          </div>
        ) : items.length ? (
          <div className="notification-list">
            {items.map((item) => (
              <article
                className={!item.readAt ? "unread" : ""}
                key={item.id}
                onClick={() => void markRead(item)}
              >
                <span className="note-dot" />
                <div>
                  <span>{notificationTitle(item.type, locale)}</span>
                  <h2>{notificationBody(item, locale)}</h2>
                  <small>{relativeTime(item.createdAt, renderedAt, locale)}</small>
                </div>
                <Link href={resourceLink(item)} aria-label={copy.open}>
                  ↗
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
            <p>{copy.emptyBody}</p>
          </div>
        )}
      </section>
    </main>
  );
}

function notificationTitle(type: string, locale: Locale): string {
  const labels: Record<string, [string, string, string]> = {
    "event.key_fields_changed": ["活动关键变化", "イベントの重要な変更", "Important event change"],
    "event.cancelled": ["活动取消", "イベント中止", "Event cancelled"],
    "registration.confirmed": ["报名成功", "参加確定", "Registration confirmed"],
    "registration.rejected": ["报名结果", "申込結果", "Registration decision"],
    "waitlist.offered": ["候补递补", "空席のご案内", "Waitlist spot offered"],
    "waitlist.expired": ["候补名额已过期", "空席案内の期限切れ", "Waitlist offer expired"],
    "group.announcement": ["群组公告", "グループのお知らせ", "Group announcement"],
    "group.transfer": ["群主转让", "グループ所有権の移行", "Group ownership transfer"],
    "points.expiring": ["积分即将到期", "ポイント期限", "Points expiring"],
    "points.adjusted": ["积分调整", "ポイント調整", "Points adjusted"],
  };
  return (
    labels[type]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ??
    (locale === "ja" ? "Spott の更新" : locale === "en" ? "Spott update" : "Spott 更新")
  );
}

function notificationBody(item: NotificationView, locale: Locale): string {
  const values = item.variables;
  for (const key of ["message", "title", "eventTitle", "groupName", "reason"]) {
    if (typeof values[key] === "string") return values[key] as string;
  }
  return locale === "ja"
    ? "あなたに関係する新しい更新があります。開いて詳細を確認してください。"
    : locale === "en"
      ? "There is a new update related to you. Open it for details."
      : "有一条与你相关的新动态，打开查看详情。";
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

function resourceLink(item: NotificationView): string {
  if (item.resourceType === "event" && item.resourcePublicId)
    return `/e/${item.resourcePublicId}`;
  if (item.resourceType === "group" && item.resourcePublicId)
    return `/g/${item.resourcePublicId}`;
  if (item.type.startsWith("points.")) return "/me/wallet";
  return "/me/events";
}
