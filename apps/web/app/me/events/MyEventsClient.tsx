"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useI18n } from "../../components/I18nProvider";
import {
  apiRequest,
  errorMessage,
  readSession,
  subscribeSessionChanges,
} from "../../lib/client-api";
import {
  parseRegistrationItineraryPage,
  type RegistrationItineraryPage,
} from "../../lib/event-contract";
import { groupItinerary, type ItineraryGroup } from "../../lib/itinerary";
import { getSyncEngine } from "../../lib/sync-engine";
import { DashboardNav } from "../DashboardNav";
import { ItineraryCard, type ItineraryLoadResult } from "./ItineraryCard";
import { itineraryCopy } from "./itinerary-copy";
import styles from "./MyEvents.module.css";

const tabs: ItineraryGroup[] = ["upcoming", "waitlist", "pending", "past"];

export function MyEventsClient() {
  const { locale } = useI18n();
  const copy = itineraryCopy(locale);
  const [page, setPage] = useState<RegistrationItineraryPage | null>(null);
  const [tab, setTab] = useState<ItineraryGroup>("upcoming");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [criticalRefreshing, setCriticalRefreshing] = useState(false);
  const [message, setMessage] = useState("");
  const [noticeFocusRequest, setNoticeFocusRequest] = useState(0);
  const [requestedRegistrationId, setRequestedRegistrationId] = useState<string | null>(null);
  const ownerUserId = useRef(readSession()?.user.id ?? null);
  const loadGeneration = useRef(0);
  const handledRegistrationId = useRef<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const criticalRefreshPromise = useRef<Promise<ItineraryLoadResult> | null>(null);

  const load = useCallback(async (
    refresh = false,
    successMessage = "",
    failureMessage = "",
    focusResult = false,
  ): Promise<ItineraryLoadResult> => {
    const generation = ++loadGeneration.current;
    const requestedOwnerUserId = readSession()?.user.id ?? null;
    ownerUserId.current = requestedOwnerUserId;
    const supersededResult = (): ItineraryLoadResult | null => {
      if ((readSession()?.user.id ?? null) !== requestedOwnerUserId) {
        return { status: "superseded", reason: "owner_changed", generation };
      }
      if (generation !== loadGeneration.current) {
        return { status: "superseded", reason: "newer_generation", generation };
      }
      return null;
    };
    if (refresh) setRefreshing(true);
    try {
      const payload = await apiRequest<unknown>("/me/registrations?limit=100", {
        authenticated: true,
      });
      const superseded = supersededResult();
      if (superseded) return superseded;
      setPage(parseRegistrationItineraryPage(payload));
      setMessage(successMessage);
      if (focusResult) setNoticeFocusRequest((request) => request + 1);
      return { status: "success", generation };
    } catch (error) {
      const superseded = supersededResult();
      if (superseded) return superseded;
      setMessage(failureMessage || errorMessage(error));
      if (focusResult) setNoticeFocusRequest((request) => request + 1);
      return { status: "failed", reason: "request_failed", generation };
    } finally {
      if (
        generation === loadGeneration.current
        && readSession()?.user.id === requestedOwnerUserId
      ) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  const reload = useCallback(async () => {
    await load();
  }, [load]);

  const runCriticalRefresh = useCallback((
    successMessage: string,
    failureMessage: string,
  ): Promise<ItineraryLoadResult> => {
    const inFlight = criticalRefreshPromise.current;
    if (inFlight) return inFlight;
    setCriticalRefreshing(true);
    const trackedRequest = load(false, successMessage, failureMessage, true).finally(() => {
      if (criticalRefreshPromise.current !== trackedRequest) return;
      criticalRefreshPromise.current = null;
      setCriticalRefreshing(false);
    });
    criticalRefreshPromise.current = trackedRequest;
    return trackedRequest;
  }, [load]);

  const refreshAfterWaitlistConflict = useCallback(
    () => runCriticalRefresh(copy.waitlistChanged, copy.waitlistRefreshFailed),
    [copy.waitlistChanged, copy.waitlistRefreshFailed, runCriticalRefresh],
  );

  const refreshAfterWaitlistAcceptance = useCallback(
    () => runCriticalRefresh(
      copy.waitlistAcceptanceRefreshed,
      copy.waitlistAcceptanceRefreshFailed,
    ),
    [
      copy.waitlistAcceptanceRefreshed,
      copy.waitlistAcceptanceRefreshFailed,
      runCriticalRefresh,
    ],
  );

  const refreshFromHeader = useCallback(async () => {
    const criticalRefresh = criticalRefreshPromise.current;
    if (criticalRefresh) {
      await criticalRefresh;
      return;
    }
    await load(true);
  }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => subscribeSessionChanges(() => {
    const nextOwnerUserId = readSession()?.user.id ?? null;
    if (nextOwnerUserId === ownerUserId.current) return;
    ownerUserId.current = nextOwnerUserId;
    loadGeneration.current += 1;
    criticalRefreshPromise.current = null;
    setPage(null);
    setMessage("");
    setRefreshing(false);
    setCriticalRefreshing(false);
    setLoading(Boolean(nextOwnerUserId));
    if (nextOwnerUserId) void load();
  }), [load]);

  useEffect(() => {
    // Converge cross-device changes without a manual pull: when the sync engine
    // reports authoritative registration/waitlist changes, reload the itinerary
    // (dev doc §6.4/§6.8). We reload from the API rather than trusting the change
    // payload so the server state machine stays the source of truth.
    return getSyncEngine().subscribe((changes) => {
      const relevant = changes.some(
        (change) => change.entityType === "registration" || change.entityType === "waitlist",
      );
      if (relevant) void load(true);
    });
  }, [load]);

  useEffect(() => {
    const readRequestedRegistration = () => {
      const next = new URLSearchParams(window.location.search).get("registration");
      handledRegistrationId.current = null;
      setRequestedRegistrationId(next);
    };
    readRequestedRegistration();
    window.addEventListener("popstate", readRequestedRegistration);
    return () => window.removeEventListener("popstate", readRequestedRegistration);
  }, []);

  const grouped = useMemo(() => page ? groupItinerary(page) : null, [page]);
  const visible = grouped?.[tab] ?? [];

  useEffect(() => {
    if (
      !grouped
      || !requestedRegistrationId
      || handledRegistrationId.current === requestedRegistrationId
    ) return;
    const targetGroup = tabs.find((group) => grouped[group].some(
      (item) => item.registration.id === requestedRegistrationId,
    ));
    if (!targetGroup) {
      handledRegistrationId.current = requestedRegistrationId;
      return;
    }
    if (targetGroup !== tab) {
      const timer = window.setTimeout(() => setTab(targetGroup), 0);
      return () => window.clearTimeout(timer);
    }
    handledRegistrationId.current = requestedRegistrationId;
    const timer = window.setTimeout(() => {
      const card = document.getElementById(`itinerary-registration-${requestedRegistrationId}`);
      if (!card) {
        handledRegistrationId.current = null;
        return;
      }
      card.focus({ preventScroll: true });
      const reduceMotion = typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [grouped, requestedRegistrationId, tab]);

  useEffect(() => {
    if (noticeFocusRequest > 0) noticeRef.current?.focus({ preventScroll: true });
  }, [noticeFocusRequest]);

  function moveTabFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, current: ItineraryGroup) {
    const currentIndex = tabs.indexOf(current);
    const nextIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % tabs.length
      : event.key === "ArrowLeft"
        ? (currentIndex - 1 + tabs.length) % tabs.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : null;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex]!;
    setTab(next);
    document.getElementById(`itinerary-tab-${next}`)?.focus();
  }

  return (
    <main className={`dashboard-shell ${styles.shell}`}>
      <DashboardNav current="events" />
      <section className={`dashboard-main ${styles.main}`}>
        <header className={styles.heading}>
          <div>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <div className={styles.headingActions}>
            <button
              type="button"
              disabled={refreshing || criticalRefreshing}
              aria-busy={refreshing || criticalRefreshing}
              onClick={() => void refreshFromHeader()}
            >
              {refreshing || criticalRefreshing ? copy.refreshing : copy.refresh}
            </button>
            <Link href="/discover">{copy.discover}</Link>
          </div>
        </header>

        <div className={styles.tabs} role="tablist" aria-label={copy.title}>
          {tabs.map((value) => (
            <button
              id={`itinerary-tab-${value}`}
              key={value}
              type="button"
              role="tab"
              aria-controls={`itinerary-panel-${value}`}
              aria-selected={tab === value}
              tabIndex={tab === value ? 0 : -1}
              onClick={() => setTab(value)}
              onKeyDown={(event) => moveTabFromKeyboard(event, value)}
            >
              {copy.tabs[value]} <span>{grouped?.[value].length ?? 0}</span>
            </button>
          ))}
        </div>

        {message ? (
          <p
            ref={noticeRef}
            className={styles.notice}
            role={page ? "status" : "alert"}
            tabIndex={-1}
          >
            {message}
          </p>
        ) : null}

        <div
          id={`itinerary-panel-${tab}`}
          role="tabpanel"
          aria-labelledby={`itinerary-tab-${tab}`}
          tabIndex={0}
        >
          {loading && !page ? (
            <div className={styles.loading}><p>{copy.loading}</p></div>
          ) : visible.length === 0 ? (
            <div className={styles.empty}>
              <div>
                <h2>{copy.empty}</h2>
                <p>{copy.emptyBody}</p>
                <Link href="/discover">{copy.discover}</Link>
              </div>
            </div>
          ) : (
            <div className={styles.list}>
              {visible.map((item) => (
                <ItineraryCard
                  key={item.registration.id}
                  item={item}
                  serverTime={page!.serverTime}
                  copy={copy}
                  locale={locale}
                  onChanged={reload}
                  onError={setMessage}
                  onWaitlistConflict={refreshAfterWaitlistConflict}
                  onWaitlistAcceptance={refreshAfterWaitlistAcceptance}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
