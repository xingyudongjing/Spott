"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useAppDialog } from "../../../../components/AppDialog";
import { useI18n } from "../../../../components/I18nProvider";
import { apiRequest, errorMessage, type WalletView } from "../../../../lib/client-api";
import type { MessageKey } from "../../../../i18n/messages";
import { StudioNav } from "../../../StudioNav";
import { EventStudioHeader } from "../EventStudioHeader";
import { useOrganizerEvent } from "../use-organizer-event";

type PromotionTier = "boost_24h" | "boost_72h" | "boost_7d";

interface PromotionView {
  id: string;
  eventId: string;
  tier: string;
  amount: number;
  durationHours: number;
  state: string;
  startsAt: string;
  expiresAt: string;
}

interface QuoteView {
  id: string;
  amount: number;
  expiresAt: string;
}

const TIERS: Array<{ id: PromotionTier; label: MessageKey }> = [
  { id: "boost_24h", label: "studio.promotion.tier24h" },
  { id: "boost_72h", label: "studio.promotion.tier72h" },
  { id: "boost_7d", label: "studio.promotion.tier7d" },
];

export function PromotionManager({ eventId }: { eventId: string }) {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const { event, loading: eventLoading, error: eventError } = useOrganizerEvent(eventId);
  const [active, setActive] = useState<PromotionView | null>(null);
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [walletError, setWalletError] = useState("");
  const [quotes, setQuotes] = useState<Partial<Record<PromotionTier, QuoteView>>>({});
  const [selected, setSelected] = useState<PromotionTier>("boost_24h");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const quotesRequested = useRef(false);

  const purchasable = event?.status === "published";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const current = await apiRequest<PromotionView | null>(`/events/${eventId}/promotion`, {
        authenticated: true,
      });
      setActive(current);
      setMessage("");
      try {
        setWallet(await apiRequest<WalletView>("/wallet", { authenticated: true }));
        setWalletError("");
      } catch {
        setWallet(null);
        setWalletError(t("studio.promotion.balanceUnavailable"));
      }
      if (current) setQuotes({});
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [eventId, t]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Quotes are only priced once the event can actually be boosted, so a draft
  // never writes throwaway quote rows just by opening this page.
  useEffect(() => {
    if (active || !purchasable || quotesRequested.current) return;
    quotesRequested.current = true;
    void (async () => {
      try {
        const loaded: Partial<Record<PromotionTier, QuoteView>> = {};
        for (const tier of TIERS) {
          loaded[tier.id] = await apiRequest<QuoteView>("/quotes", {
            method: "POST",
            authenticated: true,
            body: JSON.stringify({ purpose: tier.id, resourceId: eventId }),
          });
        }
        setQuotes(loaded);
      } catch {
        setMessage(t("studio.promotion.quoteFailed"));
      }
    })();
  }, [active, eventId, purchasable, t]);

  async function freshQuote(tier: PromotionTier): Promise<QuoteView> {
    const current = quotes[tier];
    if (current && new Date(current.expiresAt).getTime() > Date.now() + 30_000) return current;
    const refreshed = await apiRequest<QuoteView>("/quotes", {
      method: "POST",
      authenticated: true,
      body: JSON.stringify({ purpose: tier, resourceId: eventId }),
    });
    setQuotes((value) => ({ ...value, [tier]: refreshed }));
    return refreshed;
  }

  async function purchase(tier: PromotionTier) {
    setBusy(true);
    setMessage("");
    let quote: QuoteView;
    try {
      quote = await freshQuote(tier);
    } catch {
      setMessage(t("studio.promotion.quoteFailed"));
      setBusy(false);
      return;
    }
    const tierLabel = t(TIERS.find((item) => item.id === tier)!.label);
    try {
      await appDialog.run({
        title: t("studio.promotion.confirmTitle"),
        message: t("studio.promotion.confirmBody", { count: quote.amount, tier: tierLabel }),
        confirmLabel: t("studio.promotion.confirmLabel"),
        onConfirm: async () => {
          try {
            const promotion = await apiRequest<PromotionView>(`/events/${eventId}/promotions`, {
              method: "POST",
              authenticated: true,
              idempotent: true,
              body: JSON.stringify({ tier, quoteId: quote.id }),
            });
            setActive(promotion);
            setQuotes({});
            try {
              setWallet(await apiRequest<WalletView>("/wallet", { authenticated: true }));
              setWalletError("");
            } catch {
              setWalletError(t("studio.promotion.balanceUnavailable"));
            }
          } catch (error) {
            setMessage(errorMessage(error));
            throw error;
          }
        },
      });
    } finally {
      setBusy(false);
    }
  }

  const selectedQuote = quotes[selected];
  const affordable =
    wallet && selectedQuote ? wallet.totalBalance >= selectedQuote.amount : null;

  if (!eventLoading && !event) {
    return (
      <main className="studio-shell">
        <StudioNav current="events" />
        <section className="studio-content">
          <EventStudioHeader
            eventId={eventId}
            event={null}
            current="promotion"
            eyebrow="studio.eyebrow.promotion"
            title="studio.promotion.title"
            body="studio.promotion.body"
          />
          <div className="empty-state compact-empty">
            <h2>{t("studio.event.notFound")}</h2>
            <p>{eventError || t("studio.event.notFoundBody")}</p>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="studio-shell">
      <StudioNav current="events" />
      <section className="studio-content">
        <EventStudioHeader
          eventId={eventId}
          event={event}
          current="promotion"
          eyebrow="studio.eyebrow.promotion"
          title="studio.promotion.title"
          body="studio.promotion.body"
        />
        <p className="studio-boundary-note">{t("studio.promotion.transparency")}</p>
        {(message || eventError) && (
          <p className="form-message" role="alert">
            {message || eventError}
          </p>
        )}

        {loading || eventLoading ? (
          <div className="loading-state">
            <span />
            <p>{t("common.loading")}</p>
          </div>
        ) : active ? (
          <section className="management-card promotion-active-card">
            <span className="section-number">{t("event.promoted")}</span>
            <h2>{t("studio.promotion.activeTitle")}</h2>
            <p>
              {t("studio.promotion.activeUntil", { time: formatDateTime(active.expiresAt, locale) })}
              {" · "}
              {t("studio.promotion.activeSpent", { count: active.amount })}
            </p>
            <p>{t("studio.promotion.activeNote")}</p>
          </section>
        ) : !purchasable ? (
          <div className="empty-state compact-empty">
            <h2>{t("studio.promotion.unavailableTitle")}</h2>
            <p>{t("studio.promotion.unavailableBody")}</p>
          </div>
        ) : (
          <section className="management-card promotion-purchase-card">
            <div className="choice-cards promotion-tiers">
              {TIERS.map((tier) => {
                const quote = quotes[tier.id];
                return (
                  <label key={tier.id} className={selected === tier.id ? "selected" : ""}>
                    <input
                      type="radio"
                      name="promotion-tier"
                      checked={selected === tier.id}
                      onChange={() => setSelected(tier.id)}
                    />
                    <strong>{t(tier.label)}</strong>
                    <span>
                      {quote
                        ? t("studio.promotion.points", { count: quote.amount })
                        : t("studio.promotion.quoteFailed")}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="promotion-balance">
              {walletError
                ? walletError
                : wallet
                  ? t("studio.promotion.balance", { count: wallet.totalBalance })
                  : ""}
            </p>
            {affordable === false && (
              <p className="form-message" role="status">
                {t("studio.promotion.insufficient")}
              </p>
            )}
            <button
              className="primary-action compact"
              disabled={busy || !selectedQuote || affordable === false}
              onClick={() => void purchase(selected)}
            >
              {busy
                ? t("studio.promotion.purchasing")
                : t("studio.promotion.purchase", { count: selectedQuote?.amount ?? 0 })}
            </button>
          </section>
        )}
      </section>
    </main>
  );
}

function formatDateTime(value: string, locale: "zh-Hans" | "ja" | "en"): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
