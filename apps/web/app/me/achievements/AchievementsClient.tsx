"use client";

import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import type { Locale } from "../../i18n/messages";
import {
  achievementCodeFallback,
  achievementDetailKey,
  achievementNameKey,
  isAchievementCode,
  isRevocationReason,
  revocationReasonKey,
  type AchievementAward,
  type AchievementShareCard,
} from "../../lib/achievements";
import { apiRequest, errorMessage } from "../../lib/client-api";
import { DashboardNav } from "../DashboardNav";
import { ShareCardDialog } from "./ShareCardDialog";

interface EvaluationResult {
  awarded: string[];
}

export function AchievementsClient() {
  const { locale, t } = useI18n();
  const [awards, setAwards] = useState<AchievementAward[] | null>(null);
  const [newlyAwarded, setNewlyAwarded] = useState<string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [hideAllBusy, setHideAllBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const [shareCard, setShareCard] = useState<AchievementShareCard | null>(null);
  const [shareBusyId, setShareBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      // Opening the screen re-evaluates the rules first, exactly like iOS, so a
      // milestone reached elsewhere is visible here without waiting for a job.
      const evaluated = await apiRequest<EvaluationResult>("/me/achievements/evaluate", {
        method: "POST",
        authenticated: true,
      }).catch(() => null);
      const page = await apiRequest<{ items: AchievementAward[] }>("/me/achievements", {
        authenticated: true,
      });
      setAwards(page.items);
      setNewlyAwarded(evaluated?.awarded ?? []);
      setMessage("");
    } catch {
      // The designed error state carries the explanation; a transport message
      // would only leak noise into the page.
      setLoadFailed(true);
      setMessage("");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const earned = (awards ?? []).filter((award) => !award.revokedAt);
  const revoked = (awards ?? []).filter((award) => award.revokedAt);
  const allHidden = earned.length > 0 && earned.every((award) => award.hidden);

  function label(code: string): { name: string; detail: string | null } {
    if (!isAchievementCode(code)) return { name: achievementCodeFallback(code), detail: null };
    return { name: t(achievementNameKey(code)), detail: t(achievementDetailKey(code)) };
  }

  async function setHidden(award: AchievementAward, hidden: boolean) {
    if (pendingId) return;
    setPendingId(award.id);
    setMessage("");
    const previous = awards;
    setAwards(
      (current) =>
        current?.map((item) => (item.id === award.id ? { ...item, hidden } : item)) ?? current,
    );
    try {
      await apiRequest(`/me/achievements/${award.id}/hidden`, {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ hidden }),
      });
    } catch (error) {
      setAwards(previous);
      setMessage(errorMessage(error));
    } finally {
      setPendingId(null);
    }
  }

  async function setAllHidden(hidden: boolean) {
    if (hideAllBusy) return;
    setHideAllBusy(true);
    setMessage("");
    const previous = awards;
    setAwards(
      (current) =>
        current?.map((item) => (item.revokedAt ? item : { ...item, hidden })) ?? current,
    );
    try {
      await apiRequest("/me/achievements/hidden", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ hidden }),
      });
    } catch (error) {
      setAwards(previous);
      setMessage(errorMessage(error));
    } finally {
      setHideAllBusy(false);
    }
  }

  async function openShareCard(award: AchievementAward) {
    if (shareBusyId) return;
    setShareBusyId(award.id);
    setMessage("");
    try {
      const card = await apiRequest<AchievementShareCard>(
        `/me/achievements/${award.id}/share-card`,
        { authenticated: true },
      );
      setShareCard(card);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setShareBusyId(null);
    }
  }

  return (
    <main className="dashboard-shell">
      <DashboardNav current="achievements" />
      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">ACHIEVEMENTS / SYNCED</span>
            <h1>{t("achievements.title")}</h1>
            <p>{t("achievements.body")}</p>
          </div>
          {earned.length > 0 && (
            <span className="sync-badge">
              <i /> {t("achievements.count", { count: earned.length })}
            </span>
          )}
        </div>

        {message && (
          <p className="form-message" role={loadFailed ? "alert" : "status"}>
            {message}
          </p>
        )}

        {awards === null ? (
          loadFailed ? (
            <div className="empty-state compact-empty">
              <h2>{t("achievements.errorTitle")}</h2>
              <p>{t("achievements.errorBody")}</p>
              <button type="button" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </div>
          ) : (
            <div className="loading-state">
              <span />
              <p>{t("achievements.loading")}</p>
            </div>
          )
        ) : earned.length === 0 && revoked.length === 0 ? (
          <div className="empty-state compact-empty">
            <h2>{t("achievements.emptyTitle")}</h2>
            <p>{t("achievements.emptyBody")}</p>
          </div>
        ) : (
          <>
            {newlyAwarded.length > 0 && (
              <p className="form-message" role="status">
                {t("achievements.newAwards", {
                  names: newlyAwarded.map((code) => label(code).name).join(" · "),
                })}
              </p>
            )}

            {earned.length > 0 && (
              <div className="settings-section">
                <label className="toggle-row">
                  <span>
                    <strong>{t("achievements.hideAll")}</strong>
                    <small>{t("achievements.hideAllBody")}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={allHidden}
                    disabled={hideAllBusy}
                    onChange={(event) => void setAllHidden(event.target.checked)}
                  />
                </label>
              </div>
            )}

            {earned.length > 0 && (
              <div className="award-grid">
                {earned.map((award) => {
                  const labels = label(award.code);
                  const busy = pendingId === award.id;
                  const sharing = shareBusyId === award.id;
                  return (
                    <article
                      className={`award-card${award.hidden ? " award-hidden" : ""}`}
                      key={award.id}
                    >
                      <div className="award-body">
                        <strong>{labels.name}</strong>
                        {labels.detail && <p>{labels.detail}</p>}
                      </div>
                      <div className="award-meta">
                        <span>
                          {t("achievements.earnedOn", {
                            date: formatDate(award.awardedAt, locale),
                          })}
                        </span>
                        {award.hidden && (
                          <span className="award-chip">{t("achievements.hiddenTag")}</span>
                        )}
                      </div>
                      <div className="award-actions">
                        <button
                          className="secondary-action compact"
                          type="button"
                          disabled={busy}
                          aria-busy={busy}
                          onClick={() => void setHidden(award, !award.hidden)}
                        >
                          {award.hidden ? t("achievements.unhide") : t("achievements.hide")}
                        </button>
                        <button
                          className="secondary-action compact"
                          type="button"
                          disabled={award.hidden || sharing}
                          aria-busy={sharing}
                          title={award.hidden ? t("achievements.shareHidden") : undefined}
                          onClick={() => void openShareCard(award)}
                        >
                          {sharing ? t("achievements.shareLoading") : t("achievements.share")}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}

            {revoked.length > 0 && (
              <section className="settings-section">
                <h2>{t("achievements.revokedTitle")}</h2>
                <p className="achievement-intro">{t("achievements.revokedBody")}</p>
                <ul className="award-revoked">
                  {revoked.map((award) => (
                    <li key={award.id}>
                      <strong>{label(award.code).name}</strong>
                      <span>
                        {isRevocationReason(award.revocationReason)
                          ? t(revocationReasonKey(award.revocationReason))
                          : t("achievements.reasonUnknown")}
                      </span>
                      <small>
                        {t("achievements.revokedOn", {
                          date: formatDate(award.revokedAt ?? award.awardedAt, locale),
                        })}
                      </small>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </section>

      {shareCard && <ShareCardDialog card={shareCard} onClose={() => setShareCard(null)} />}
    </main>
  );
}

function formatDate(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
    { dateStyle: "medium", timeZone: "Asia/Tokyo" },
  ).format(parsed);
}
