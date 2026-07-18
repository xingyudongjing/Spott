"use client";

import dynamic from "next/dynamic";

import type { MapBounds } from "../../lib/discovery-query";
import type { EventPage, EventSummary } from "../../lib/event-contract";
import { useI18n } from "../I18nProvider";
import { PreviewModeLink as Link } from "../PreviewModeLink";
import { usePreviewMode } from "../PreviewModeProvider";
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
  mapAttempt,
  bounds,
  selectedEventId,
  onRetry,
  onReset,
  onLoadMore,
  onBoundsChange,
  onMapFailure,
  onRetryMap,
  onUseList,
  onSelectEvent,
}: {
  page: EventPage | null;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: DiscoveryErrorKind;
  mode: "list" | "map";
  mapStyleURL: string;
  mapAttempt: number;
  bounds?: MapBounds;
  selectedEventId?: string | null;
  onRetry: () => void;
  onReset: () => void;
  onLoadMore: () => void;
  onBoundsChange: (bounds: MapBounds) => void;
  onMapFailure: () => void;
  onRetryMap: () => void;
  onUseList: () => void;
  onSelectEvent: (eventId: string) => void;
}) {
  const { t } = useI18n();

  if (!page && loading) return <DiscoveryLoading />;
  if (!page && error) return <DiscoveryError onRetry={onRetry} />;
  if (!page) return <DiscoveryLoading />;

  const hasItems = page.items.length > 0;
  const selectedEvent = selectedEventId
    ? page.items.find((event) => event.id === selectedEventId)
    : undefined;
  return (
    <>
      {refreshing ? <p className={styles.liveStatus} role="status">{t("discover.refreshing")}</p> : null}
      {error === "stale" ? <p className={styles.liveStatus} role="status">{t("discover.staleError")}</p> : null}
      {error === "pagination" ? <p className={styles.contractError} role="alert">{t("discover.paginationError")}</p> : null}

      {!hasItems && error === "pagination" ? null : !hasItems ? (
        <DiscoveryEmpty onReset={onReset} />
      ) : mode === "map" && mapStyleURL ? (
        <div className={styles.mapLayout}>
          <div className={styles.mapStage}>
            {error === "map" ? (
              <div className={styles.mapFallback} role="alert" aria-live="assertive">
                <span className={styles.mapFallbackMark} aria-hidden="true">⌁</span>
                <strong>{t("discover.mapError")}</strong>
                <div className={styles.mapFallbackActions}>
                  <button type="button" onClick={onRetryMap}>{t("discover.retryMap")}</button>
                  <button type="button" onClick={onUseList}>{t("discover.useList")}</button>
                </div>
              </div>
            ) : (
              <EventMap
                key={mapAttempt}
                events={page.items}
                styleURL={mapStyleURL}
                bounds={bounds}
                selectedEventId={selectedEventId}
                mapLabel={t("discover.mapRegion")}
                approximateLabel={t("discover.approximate")}
                onBoundsChange={onBoundsChange}
                onFailure={onMapFailure}
                onSelect={onSelectEvent}
              />
            )}
            {error !== "map" && selectedEvent ? <MapEventPreview event={selectedEvent} /> : null}
          </div>
          <EventList
            events={page.items}
            selectedEventId={selectedEventId}
            featuredFirst={false}
          />
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

export function MapEventPreview({ event }: { event: EventSummary }) {
  const { t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const label = t("discover.mapPreview", { title: event.title });
  return (
    <section
      id={`map-preview-${event.id}`}
      className={styles.mapPreview}
      role="region"
      aria-label={label}
      aria-live="polite"
    >
      <div>
        <strong>{event.title}</strong>
        <span>{event.publicArea || t("event.areaTBA")}</span>
      </div>
      <Link href={`/e/${event.publicSlug}`} prefetch={isReadOnly ? false : undefined}>
        {t("discover.viewDetails")}
      </Link>
    </section>
  );
}
