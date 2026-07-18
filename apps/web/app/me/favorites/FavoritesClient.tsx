"use client";

import { PreviewModeLink as Link } from "../../components/PreviewModeLink";
import { useEffect, useState } from "react";
import { EventCard } from "../../components/EventCard";
import { useI18n } from "../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../lib/client-api";
import type { EventView } from "../../lib/demo-data";
import { DashboardNav } from "../DashboardNav";

export function FavoritesClient() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<EventView[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    apiRequest<{ items: EventView[] }>("/me/favorite-events", { authenticated: true })
      .then((payload) => setItems(payload.items))
      .catch((error) => setMessage(errorMessage(error)))
      .finally(() => setLoading(false));
  }, []);

  const copy =
    locale === "ja"
      ? {
          title: "保存したイベント",
          body: "iOS または Web で保存したイベントを、どちらからでも確認できます。",
          discover: "イベントを探す",
          syncing: "保存したイベントを同期中…",
          empty: "保存したイベントはありません",
          emptyBody: "気になるイベントを保存すると、どの端末からでも続きが見られます。",
        }
      : locale === "en"
        ? {
            title: "Saved events",
            body: "Events saved on iOS or Web are available on both.",
            discover: "Discover events",
            syncing: "Syncing saved events…",
            empty: "No saved events yet",
            emptyBody: "Save something interesting and pick it up later on any device.",
          }
        : {
            title: "我的收藏",
            body: "在 iOS 或 Web 收藏的活动都会出现在这里。",
            discover: "发现活动",
            syncing: "正在同步收藏…",
            empty: "还没有收藏",
            emptyBody: "把感兴趣的活动留在这里，之后可以在任何设备继续查看。",
          };

  return (
    <main className="dashboard-shell">
      <DashboardNav current="favorites" />
      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">SAVED / SYNCED</span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <Link className="create-button" href="/discover">
            {copy.discover}
          </Link>
        </div>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{copy.syncing || t("common.loading")}</p>
          </div>
        ) : items.length ? (
          <div className="event-grid wide">
            {items.map((event) => (
              <EventCard event={event} key={event.id} />
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
            <p>{copy.emptyBody}</p>
            <Link className="primary-action compact" href="/discover">
              {copy.discover}
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
