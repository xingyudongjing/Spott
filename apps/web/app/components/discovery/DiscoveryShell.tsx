"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { readSession } from "../../lib/client-api";
import { trackProductEvent } from "../../lib/analytics";
import {
  parseDiscoveryQuery,
  serializeDiscoveryQuery,
  type EventDiscoveryQuery,
  type MapBounds,
} from "../../lib/discovery-query";
import type { EventPage } from "../../lib/event-contract";
import { searchEvents } from "../../lib/events-api";
import { useI18n } from "../I18nProvider";
import { DiscoveryFilters } from "./DiscoveryFilters";
import { DiscoveryToolbar } from "./DiscoveryToolbar";
import { EventResults, type DiscoveryErrorKind } from "./EventResults";
import styles from "./DiscoveryShell.module.css";

const PAGE_SIZE = 24;

export function DiscoveryShell({
  initialQuery,
  initialPage,
  initialError,
  mapStyleURL = process.env.NEXT_PUBLIC_MAP_STYLE_URL ?? "",
}: {
  initialQuery: EventDiscoveryQuery;
  initialPage: EventPage | null;
  initialError?: string | null;
  mapStyleURL?: string;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState(() => cleanQuery(initialQuery));
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
    void trackProductEvent("discovery_viewed", {
      initialResultCount: initialPage?.items.length ?? 0,
      queryPresent: Boolean(initialQuery.q),
    });
  }, [initialPage?.items.length, initialQuery.q]);

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
      const accessToken = currentAccessToken();
      const result = await searchEvents({
        ...nextQuery,
        cursor: options.cursor,
        limit: nextQuery.limit ?? PAGE_SIZE,
      }, {
        signal: controller.signal,
        ...(accessToken ? { accessToken } : {}),
      });
      if (controller.signal.aborted || sequence !== requestSequence.current) return;

      startTransition(() => {
        setPage((current) => append && current
          ? { ...result, items: [...current.items, ...result.items] }
          : result);
        setError(brokenCursor(result) ? "pagination" : null);
      });
      void trackProductEvent("event_search_completed", {
        queryPresent: Boolean(nextQuery.q),
        resultCount: result.items.length,
        page: append ? "next" : "first",
      });
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
  }, [page]);

  useEffect(() => {
    if (viewerRevalidated.current || !currentAccessToken()) return;
    viewerRevalidated.current = true;
    void loadPage(query);
  }, [loadPage, query]);

  const commitQuery = useCallback((nextValue: EventDiscoveryQuery, history: "push" | "replace" = "push") => {
    const next = cleanQuery(nextValue);
    setQuery(next);
    setSearchText(next.q ?? "");
    const params = serializeDiscoveryQuery(next);
    const url = `${window.location.pathname}${params.size ? `?${params.toString()}` : ""}`;
    window.history[history === "push" ? "pushState" : "replaceState"](null, "", url);
    void loadPage(next);
  }, [loadPage]);

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
        const restored = cleanQuery(parseDiscoveryQuery(window.location.search));
        setQuery(restored);
        setSearchText(restored.q ?? "");
        void loadPage(restored);
      } catch {
        setError(page ? "stale" : "initial");
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [loadPage, page]);

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

  const resultCount = page?.items.length ?? 0;
  return (
    <section className={styles.shell} aria-busy={loading || refreshing}>
      <header className={styles.intro}>
        <h1>{t("discover.promise")}</h1>
        <p>{t("discover.support")}</p>
      </header>

      <DiscoveryToolbar
        query={query}
        searchText={searchText}
        mode={mode}
        mapEnabled={Boolean(mapStyleURL)}
        onSearchTextChange={setSearchText}
        onRegionChange={(region) => patchQuery({ region })}
        onModeChange={changeMode}
      />
      <DiscoveryFilters query={query} onPatch={patchQuery} onReset={reset} />

      <div className={styles.resultsHeading}>
        <div>
          <h2>{t("discover.results")}</h2>
          <span>{t("discover.resultCount", { count: resultCount })}</span>
        </div>
        <span className={styles.sortLabel}>{t("discover.sortTime")}</span>
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

function cleanQuery(query: EventDiscoveryQuery): EventDiscoveryQuery {
  const result = { ...query };
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

function currentAccessToken() {
  try {
    return readSession()?.accessToken;
  } catch {
    // Storage can be unavailable in hardened/private browsing contexts.
    return undefined;
  }
}
