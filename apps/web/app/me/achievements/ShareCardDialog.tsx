"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../components/I18nProvider";
import {
  achievementCodeFallback,
  achievementNameKey,
  isAchievementCode,
  type AchievementShareCard,
} from "../../lib/achievements";

/**
 * The API returns share-card *data*, not an image: brand, nickname, achievement,
 * a coarse public data range, and an attributable link. The card is composed
 * here so the copy stays localized and no exact behavioural number is shown.
 */
export function ShareCardDialog({
  card,
  onClose,
}: {
  card: AchievementShareCard;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const [copyState, setCopyState] = useState("");

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  const name = isAchievementCode(card.achievement.code)
    ? t(achievementNameKey(card.achievement.code))
    : achievementCodeFallback(card.achievement.code);

  async function copyLink() {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(card.link);
        setCopyState(t("achievements.shareCopied"));
        return;
      } catch {
        // The selectable link below still works when permission is denied.
      }
    }
    setCopyState(t("achievements.shareCopyManually"));
  }

  const range = card.dataRange;
  const facts: Array<{ label: string; value: string }> = [];
  if (typeof range?.eventsAttended === "number")
    facts.push({
      label: t("achievements.dataAttended"),
      value: t("achievements.eventCount", { count: range.eventsAttended }),
    });
  if (typeof range?.completedEvents === "number")
    facts.push({
      label: t("achievements.dataHosted"),
      value: t("achievements.eventCount", { count: range.completedEvents }),
    });
  if (range?.attendanceBand)
    facts.push({ label: t("achievements.dataAttendance"), value: range.attendanceBand });

  return createPortal(
    <div
      className="app-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <div>
            <span>SPOTT</span>
            <h2 id={titleId}>{t("achievements.shareTitle")}</h2>
          </div>
          <button
            className="app-dialog-close"
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="app-dialog-body">
          <article className="share-card">
            <span className="share-card-brand">{card.brand}</span>
            <strong>{name}</strong>
            <p>{card.nickname}</p>
            <small>
              {t("achievements.earnedOn", {
                date: formatDate(card.achievement.awardedAt, locale),
              })}
            </small>
            {facts.length > 0 && (
              <div className="share-card-range">
                <span>{t("achievements.dataRange")}</span>
                <dl>
                  {facts.map((fact) => (
                    <div key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            )}
          </article>
          <p>{t("achievements.shareBody")}</p>
          <div className="share-card-link">
            <span>{t("achievements.shareLink")}</span>
            <code>{card.link}</code>
          </div>
          {copyState && <p role="status">{copyState}</p>}
        </div>
        <footer className="app-dialog-actions">
          <button type="button" onClick={onClose}>
            {t("common.close")}
          </button>
          <button className="primary" type="button" onClick={() => void copyLink()}>
            {t("achievements.shareCopy")}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}

function formatDate(value: string, locale: "zh-Hans" | "ja" | "en"): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return new Intl.DateTimeFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
    { dateStyle: "medium", timeZone: "Asia/Tokyo" },
  ).format(parsed);
}
