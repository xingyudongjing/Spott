"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useI18n } from "../../components/I18nProvider";
import { apiRequest, errorMessage } from "../../lib/client-api";
import {
  parseRegistrationItineraryPage,
  type RegistrationItineraryPage,
} from "../../lib/event-contract";
import { groupItinerary, type ItineraryGroup } from "../../lib/itinerary";
import { DashboardNav } from "../DashboardNav";
import { ItineraryCard } from "./ItineraryCard";
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
  const [message, setMessage] = useState("");

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    try {
      const payload = await apiRequest<unknown>("/me/registrations?limit=100", {
        authenticated: true,
      });
      setPage(parseRegistrationItineraryPage(payload));
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const grouped = useMemo(() => page ? groupItinerary(page) : null, [page]);
  const visible = grouped?.[tab] ?? [];

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
              disabled={refreshing}
              onClick={() => void load(true)}
            >
              {refreshing ? copy.refreshing : copy.refresh}
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
            >
              {copy.tabs[value]} <span>{grouped?.[value].length ?? 0}</span>
            </button>
          ))}
        </div>

        {message ? (
          <p className={styles.notice} role={page ? "status" : "alert"}>{message}</p>
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
                  onChanged={load}
                  onError={setMessage}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
