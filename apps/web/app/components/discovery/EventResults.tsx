"use client";

import dynamic from "next/dynamic";

import type { MapBounds } from "../../lib/discovery-query";
import type { EventPage } from "../../lib/event-contract";
import { useI18n } from "../I18nProvider";
import { DiscoveryEmpty, DiscoveryError, DiscoveryLoading } from "./DiscoveryState";
import { EventList } from "./EventList";
import styles from "./DiscoveryShell.module.css";

const EventMap = dynamic(
  () => import("./EventMap").then((module) => module.EventMap),
  { ssr: false, loading: () => <DiscoveryLoading /> },
);

export type DiscoveryErrorKind = "initial" | "stale" | "pagination" | "map" | null;

export function EventResults({
  page,
  loading,
  refreshing,
  loadingMore,
  error,
  mode,
  mapStyleURL,
  bounds,
  selectedEventId,
  onRetry,
  onReset,
  onLoadMore,
  onBoundsChange,
  onMapFailure,
  onSelectEvent,
}: {
  page: EventPage | null;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: DiscoveryErrorKind;
  mode: "list" | "map";
  mapStyleURL: string;
  bounds?: MapBounds;
  selectedEventId?: string | null;
  onRetry: () => void;
  onReset: () => void;
  onLoadMore: () => void;
  onBoundsChange: (bounds: MapBounds) => void;
  onMapFailure: () => void;
  onSelectEvent: (eventId: string) => void;
}) {
  const { t } = useI18n();

  if (!page && loading) return <DiscoveryLoading />;
  if (!page && error) return <DiscoveryError onRetry={onRetry} />;
  if (!page) return <DiscoveryLoading />;

  const hasItems = page.items.length > 0;
  return (
    <>
      {refreshing ? <p className={styles.liveStatus} role="status">{t("discover.refreshing")}</p> : null}
      {error === "stale" ? <p className={styles.liveStatus} role="status">{t("discover.staleError")}</p> : null}
      {error === "map" ? <p className={styles.liveStatus} role="status">{t("discover.mapError")}</p> : null}
      {error === "pagination" ? <p className={styles.contractError} role="alert">{t("discover.paginationError")}</p> : null}

      {!hasItems && error === "pagination" ? null : !hasItems ? (
        <DiscoveryEmpty onReset={onReset} />
      ) : mode === "map" && mapStyleURL ? (
        <div className={styles.mapLayout}>
          <EventMap
            events={page.items}
            styleURL={mapStyleURL}
            bounds={bounds}
            mapLabel={t("discover.mapRegion")}
            approximateLabel={t("discover.approximate")}
            onBoundsChange={onBoundsChange}
            onFailure={onMapFailure}
            onSelect={onSelectEvent}
          />
          <EventList events={page.items} selectedEventId={selectedEventId} />
        </div>
      ) : (
        <EventList events={page.items} selectedEventId={selectedEventId} />
      )}

      {page.hasMore && page.nextCursor ? (
        <button
          className={styles.loadMore}
          type="button"
          onClick={onLoadMore}
          disabled={loadingMore}
        >
          {loadingMore ? t("common.loading") : t("common.more")}
        </button>
      ) : null}
    </>
  );
}
