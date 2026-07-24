"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { apiRequest, readSession } from "../../lib/client-api";
import { trackProductEvent } from "../../lib/analytics";
import {
  boundsCenter,
  parseDiscoveryQuery,
  serializeDiscoveryQuery,
  type EventDiscoveryQuery,
  type EventDiscoverySort,
  type MapBounds,
} from "../../lib/discovery-query";
import { parseEventPage, type EventPage } from "../../lib/event-contract";
import { useI18n } from "../I18nProvider";
import { SortIcon } from "../icons";
import { usePreviewMode } from "../PreviewModeProvider";
import { DiscoveryFilters } from "./DiscoveryFilters";
import { DiscoveryToolbar } from "./DiscoveryToolbar";
import { EventResults, type DiscoveryErrorKind } from "./EventResults";
import styles from "./DiscoveryShell.module.css";

const PAGE_SIZE = 24;

export function DiscoveryShell({
  initialQuery,
  initialPage,
  initialError,
  lockedRegion,
  heading,
  supportingText,
  mapStyleURL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "",
}: {
  initialQuery: EventDiscoveryQuery;
  initialPage: EventPage | null;
  initialError?: string | null;
  lockedRegion?: string;
  heading?: string;
  supportingText?: string;
  mapStyleURL?: string;
}) {
  const { t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const [query, setQuery] = useState(() => cleanQuery(initialQuery, lockedRegion));
  const [searchText, setSearchText] = useState(initialQuery.q ?? "");
  const [page, setPage] = useState<EventPage | null>(initialPage);
  const [mode, setMode] = useState<"list" | "map">("list");
  const [mapAttempt, setMapAttempt] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialPage && !initialError);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DiscoveryErrorKind>(() => initialError
    ? "initial"
    : brokenCursor(initialPage) ? "pagination" : null);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const viewerRevalidated = useRef(false);

  useEffect(() => {
    if (isReadOnly) return;
    void trackProductEvent("discovery_viewed", {
      initialResultCount: initialPage?.items.length ?? 0,
      queryPresent: Boolean(initialQuery.q),
    });
  }, [initialPage?.items.length, initialQuery.q, isReadOnly]);

  const loadPage = useCallback(async (
    nextQuery: EventDiscoveryQuery,
    options: { append?: boolean; cursor?: string } = {},
  ) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    const sequence = ++requestSequence.current;
    const append = options.append === true;
    if (append) setLoadingMore(true);
    else if (page) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const result = await searchEventsForViewer({
        ...nextQuery,
        cursor: options.cursor,
        limit: nextQuery.limit ?? PAGE_SIZE,
      }, controller.signal);
      if (controller.signal.aborted || sequence !== requestSequence.current) return;

      startTransition(() => {
        setPage((current) => append && current
          ? { ...result, items: [...current.items, ...result.items] }
          : result);
        setError(brokenCursor(result) ? "pagination" : null);
      });
      if (!isReadOnly) {
        void trackProductEvent("event_search_completed", {
          queryPresent: Boolean(nextQuery.q),
          resultCount: result.items.length,
          page: append ? "next" : "first",
        });
      }
    } catch (caught) {
      if (isAbortError(caught) || controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(page ? "stale" : "initial");
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [isReadOnly, page]);

  useEffect(() => {
    if (isReadOnly || viewerRevalidated.current || !hasCurrentSession()) return;
    viewerRevalidated.current = true;
    void loadPage(query);
  }, [isReadOnly, loadPage, query]);

  const commitQuery = useCallback((nextValue: EventDiscoveryQuery, history: "push" | "replace" = "push") => {
    const next = cleanQuery(nextValue, lockedRegion);
    const params = serializeDiscoveryQuery(next);
    setQuery(next);
    setSearchText(next.q ?? "");
    const url = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
    window.history[history === "push" ? "pushState" : "replaceState"](null, "", url);
    void loadPage(next);
  }, [loadPage, lockedRegion]);

  const patchQuery = useCallback((patch: Partial<EventDiscoveryQuery>) => {
    commitQuery({ ...query, ...patch, cursor: undefined });
  }, [commitQuery, query]);

  useEffect(() => {
    const normalized = searchText.trim();
    if (normalized === (query.q ?? "")) return;
    const timer = window.setTimeout(() => {
      commitQuery({ ...query, q: normalized || undefined, cursor: undefined }, "replace");
    }, 300);
    return () => window.clearTimeout(timer);
  }, [commitQuery, query, searchText]);

  useEffect(() => {
    const onPopState = () => {
      try {
        const restored = cleanQuery(parseDiscoveryQuery(window.location.search), lockedRegion);
        const restoredParams = serializeDiscoveryQuery(restored);
        const restoredURL = `${window.location.pathname}${restoredParams.size ? `?${restoredParams.toString()}` : ""}`;
        window.history.replaceState(null, "", restoredURL);
        setQuery(restored);
        setSearchText(restored.q ?? "");
        void loadPage(restored);
      } catch {
        setError(page ? "stale" : "initial");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadPage, lockedRegion, page]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const reset = useCallback(() => commitQuery({}), [commitQuery]);
  const retry = useCallback(() => { void loadPage(query); }, [loadPage, query]);
  const loadMore = useCallback(() => {
    if (!page?.hasMore) return;
    if (!page.nextCursor) {
      setError("pagination");
      return;
    }
    void loadPage(query, { append: true, cursor: page.nextCursor });
  }, [loadPage, page, query]);
  const updateBounds = useCallback((bounds: MapBounds) => {
    // While sorting by distance, the origin follows the visible map area.
    patchQuery(query.sort === "distance" ? { bounds, near: boundsCenter(bounds) } : { bounds });
  }, [patchQuery, query.sort]);
  const changeSort = useCallback((value: string) => {
    const sort = value === "time" ? undefined : (value as EventDiscoverySort);
    if (sort === "distance") {
      if (!query.bounds) return;
      patchQuery({ sort, near: boundsCenter(query.bounds) });
      return;
    }
    patchQuery({ sort, near: undefined });
  }, [patchQuery, query.bounds]);
  const mapFailure = useCallback(() => {
    setError("map");
  }, []);
  const retryMap = useCallback(() => {
    setMapAttempt((attempt) => attempt + 1);
    setError((current) => current === "map" ? null : current);
  }, []);
  const changeMode = useCallback((nextMode: "list" | "map") => {
    setMode(nextMode);
    if (nextMode === "map") setMapAttempt((attempt) => attempt + 1);
    setError((current) => current === "map" ? null : current);
  }, []);

  const resultCount = page?.items.length ?? 0;
  const sortValue = query.sort ?? "time";
  // Distance is only meaningful once the map gives the query a spatial context.
  const distanceSortAvailable = Boolean(query.bounds);
  return (
    <section className={styles.shell} aria-busy={loading || refreshing}>
      <header className={styles.intro}>
        <h1>{heading ?? t("discover.promise")}</h1>
        <p>{supportingText ?? t("discover.support")}</p>
      </header>

      <DiscoveryToolbar
        query={query}
        searchText={searchText}
        mode={mode}
        mapEnabled={Boolean(mapStyleURL)}
        regionLocked={Boolean(lockedRegion)}
        onSearchTextChange={setSearchText}
        onRegionChange={(region) => patchQuery({ region })}
        onModeChange={changeMode}
      />
      <DiscoveryFilters
        query={query}
        regionLocked={Boolean(lockedRegion)}
        onPatch={patchQuery}
        onReset={reset}
      />

      <div className={styles.resultsHeading}>
        <div>
          <h2>{t("discover.results")}</h2>
          <span>{t("discover.resultCount", { count: resultCount })}</span>
        </div>
        <label className={styles.sortControl}>
          <SortIcon />
          <span className="sr-only">{t("discover.sortLabel")}</span>
          <select
            value={sortValue}
            aria-label={t("discover.sortLabel")}
            onChange={(event) => changeSort(event.target.value)}
          >
            <option value="time">{t("discover.sortTime")}</option>
            <option value="recommended">{t("discover.sortRecommended")}</option>
            <option value="newest">{t("discover.sortNewest")}</option>
            <option value="almost_full">{t("discover.sortAlmostFull")}</option>
            {distanceSortAvailable || sortValue === "distance" ? (
              <option value="distance">{t("discover.sortDistance")}</option>
            ) : null}
          </select>
        </label>
      </div>

      <EventResults
        page={page}
        loading={loading}
        refreshing={refreshing}
        loadingMore={loadingMore}
        error={error}
        mode={mode}
        mapStyleURL={mapStyleURL}
        mapAttempt={mapAttempt}
        bounds={query.bounds}
        selectedEventId={selectedEventId}
        onRetry={retry}
        onReset={reset}
        onLoadMore={loadMore}
        onBoundsChange={updateBounds}
        onMapFailure={mapFailure}
        onRetryMap={retryMap}
        onUseList={() => changeMode("list")}
        onSelectEvent={setSelectedEventId}
      />
    </section>
  );
}

function cleanQuery(query: EventDiscoveryQuery, lockedRegion?: string): EventDiscoveryQuery {
  const result = { ...query, ...(lockedRegion ? { region: lockedRegion } : {}) };
  delete result.cursor;
  for (const key of Object.keys(result) as Array<keyof EventDiscoveryQuery>) {
    if (result[key] === undefined || result[key] === "") delete result[key];
  }
  return result;
}

function brokenCursor(page: EventPage | null) {
  return Boolean(page?.hasMore && !page.nextCursor);
}

function isAbortError(error: unknown) {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function hasCurrentSession() {
  try {
    return Boolean(readSession());
  } catch {
    // Storage can be unavailable in hardened/private browsing contexts.
    return false;
  }
}

async function searchEventsForViewer(query: EventDiscoveryQuery, signal: AbortSignal): Promise<EventPage> {
  const params = serializeDiscoveryQuery(query);
  const suffix = params.size ? `?${params.toString()}` : "";
  return parseEventPage(await apiRequest<unknown>(`/events/search${suffix}`, { signal }));
}
