"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiRequest, readSession } from "../../lib/client-api";
import { trackProductEvent } from "../../lib/analytics";
import {
  parseDiscoveryQuery,
  serializeDiscoveryQuery,
  type EventDiscoveryQuery,
  type MapBounds,
} from "../../lib/discovery-query";
import {
  orderedDiscoveryFeedModules,
  parseDiscoveryFeed,
  type DiscoveryFeed,
} from "../../lib/discovery-feed";
import { parseEventPage, type EventPage } from "../../lib/event-contract";
import { useI18n } from "../I18nProvider";
import { usePreviewMode } from "../PreviewModeProvider";
import { DiscoveryFilters } from "./DiscoveryFilters";
import { DiscoveryFeedModules } from "./DiscoveryFeedModules";
import { DiscoveryToolbar } from "./DiscoveryToolbar";
import { EventResults, type DiscoveryErrorKind } from "./EventResults";
import styles from "./DiscoveryShell.module.css";

const PAGE_SIZE = 24;

export function DiscoveryShell({
  initialQuery,
  initialPage,
  initialFeed = null,
  initialError,
  lockedRegion,
  heading,
  supportingText,
  mapStyleURL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "",
}: {
  initialQuery: EventDiscoveryQuery;
  initialPage: EventPage | null;
  initialFeed?: DiscoveryFeed | null;
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
  const [feed, setFeed] = useState<DiscoveryFeed | null>(initialFeed);
  const [mode, setMode] = useState<"list" | "map">("list");
  const [mapAttempt, setMapAttempt] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [loading, setLoading] = useState(!initialPage && !initialFeed && !initialError);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<DiscoveryErrorKind>(() => initialError
    ? "initial"
    : brokenCursor(initialPage) ? "pagination" : null);
  const requestRef = useRef<AbortController | null>(null);
  const requestSequence = useRef(0);
  const viewerRevalidated = useRef(false);
  const initialFeedCount = useMemo(() => initialFeed
    ? orderedDiscoveryFeedModules(initialFeed).reduce((count, module) => count + module.items.length, 0)
    : 0, [initialFeed]);

  useEffect(() => {
    if (isReadOnly) return;
    void trackProductEvent("discovery_viewed", {
      initialResultCount: initialPage?.items.length ?? initialFeedCount,
      queryPresent: Boolean(initialQuery.q),
    });
  }, [initialFeedCount, initialPage?.items.length, initialQuery.q, isReadOnly]);

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
    else if (page || feed) setRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const requestQuery = {
        ...nextQuery,
        cursor: options.cursor,
        limit: nextQuery.limit ?? PAGE_SIZE,
      };
      const result = defaultDiscoveryQuery(nextQuery) && !append
        ? { kind: "feed" as const, feed: await discoveryFeedForViewer(requestQuery, controller.signal) }
        : { kind: "page" as const, page: await searchEventsForViewer(requestQuery, controller.signal) };
      if (controller.signal.aborted || sequence !== requestSequence.current) return;

      startTransition(() => {
        if (result.kind === "feed") {
          setFeed(result.feed);
          setPage(null);
          setError(null);
          return;
        }
        setFeed(null);
        setPage((current) => append && current
          ? { ...result.page, items: [...current.items, ...result.page.items] }
          : result.page);
        setError(brokenCursor(result.page) ? "pagination" : null);
      });
      if (!isReadOnly) {
        void trackProductEvent("event_search_completed", {
          queryPresent: Boolean(nextQuery.q),
          resultCount: result.kind === "feed"
            ? result.feed.modules.reduce((count, module) => count + module.items.length, 0)
            : result.page.items.length,
          page: append ? "next" : "first",
        });
      }
    } catch (caught) {
      if (isAbortError(caught) || controller.signal.aborted || sequence !== requestSequence.current) return;
      setError(page || feed ? "stale" : "initial");
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [feed, isReadOnly, page]);

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
        setError(page || feed ? "stale" : "initial");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [feed, loadPage, lockedRegion, page]);

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
    patchQuery({ bounds });
  }, [patchQuery]);
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

  const orderedFeedModules = useMemo(
    () => feed ? orderedDiscoveryFeedModules(feed) : [],
    [feed],
  );
  const feedEvents = useMemo(
    () => orderedFeedModules.flatMap((module) => module.items),
    [orderedFeedModules],
  );
  const feedPage = useMemo<EventPage | null>(() => feed ? {
    items: feedEvents,
    nextCursor: null,
    hasMore: false,
    serverTime: feed.serverTime,
    queryExplanationId: feed.queryExplanationId,
  } : null, [feed, feedEvents]);
  const showModuleFeed = feed !== null && mode === "list";
  const resultCount = feed ? feedEvents.length : page?.items.length ?? 0;
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

      {!showModuleFeed ? (
        <div className={styles.resultsHeading}>
          <div>
            <h2>{t("discover.results")}</h2>
            <span>{t("discover.resultCount", { count: resultCount })}</span>
          </div>
          <span className={styles.sortLabel}>
            {feed ? t("discover.sortRecommended") : t("discover.sortTime")}
          </span>
        </div>
      ) : null}

      {showModuleFeed ? (
        <>
          {refreshing ? <p className={styles.liveStatus} role="status">{t("discover.refreshing")}</p> : null}
          {error === "stale" ? <p className={styles.liveStatus} role="status">{t("discover.staleError")}</p> : null}
          <DiscoveryFeedModules modules={orderedFeedModules} onReset={reset} />
        </>
      ) : (
        <EventResults
          page={feedPage ?? page}
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
      )}
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

async function discoveryFeedForViewer(query: EventDiscoveryQuery, signal: AbortSignal): Promise<DiscoveryFeed> {
  const params = serializeDiscoveryQuery(query);
  const suffix = params.size ? `?${params.toString()}` : "";
  return parseDiscoveryFeed(await apiRequest<unknown>(`/discovery/feed${suffix}`, { signal }));
}

function defaultDiscoveryQuery(query: EventDiscoveryQuery): boolean {
  return Object.keys(query).length === 0;
}
