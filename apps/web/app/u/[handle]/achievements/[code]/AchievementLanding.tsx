"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Footer } from "../../../../components/Footer";
import { useI18n } from "../../../../components/I18nProvider";
import type { Locale } from "../../../../i18n/messages";
import {
  achievementCodeFallback,
  achievementDetailKey,
  achievementNameKey,
  isAchievementCode,
  type PublicAchievement,
} from "../../../../lib/achievements";
import { apiRequest, readSession } from "../../../../lib/client-api";

interface PublicProfile {
  userId: string;
  publicHandle: string;
  nickname: string;
  avatarURL: string | null;
}

/**
 * Landing page for the link on an achievement share card
 * (`{share base}/u/{userId}/achievements/{code}`).
 *
 * The profile itself is public, but the achievement list is not, so a
 * signed-out visitor is told plainly what signing in would confirm instead of
 * being shown an unverified badge.
 */
export function AchievementLanding({ handle, code }: { handle: string; code: string }) {
  const { locale, t } = useI18n();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [award, setAward] = useState<PublicAchievement | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "signedOut" | "missing" | "error">(
    "loading",
  );

  const load = useCallback(async () => {
    setState("loading");
    try {
      const profileValue = await apiRequest<PublicProfile>(
        `/profiles/${encodeURIComponent(handle)}`,
      );
      setProfile(profileValue);
      if (!readSession()) {
        setState("signedOut");
        return;
      }
      const page = await apiRequest<{ items: PublicAchievement[] }>(
        `/users/${encodeURIComponent(profileValue.userId)}/achievements`,
        { authenticated: true },
      );
      const match = page.items.find((item) => item.code === code) ?? null;
      setAward(match);
      setState(match ? "ready" : "missing");
    } catch {
      setState("error");
    }
  }, [code, handle]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const name = isAchievementCode(code) ? t(achievementNameKey(code)) : achievementCodeFallback(code);
  const detail = isAchievementCode(code) ? t(achievementDetailKey(code)) : null;
  const profileHref = profile ? `/u/${encodeURIComponent(profile.publicHandle)}` : null;

  return (
    <main>
      <div className="standard-shell">
        <section className="award-landing">
          {state === "loading" ? (
            <div className="loading-state">
              <span />
              <p>{t("achievements.loading")}</p>
            </div>
          ) : state === "error" ? (
            <div className="empty-state compact-empty">
              <h1>{t("achievements.errorTitle")}</h1>
              <p>{t("achievements.errorBody")}</p>
              <button type="button" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </div>
          ) : state === "missing" ? (
            <div className="empty-state compact-empty">
              <h1>{t("achievements.landingMissingTitle")}</h1>
              <p>{t("achievements.landingMissingBody")}</p>
              {profileHref && <Link href={profileHref}>{t("achievements.landingProfile")} ↗</Link>}
            </div>
          ) : (
            <>
              <span className="section-number">SPOTT / ACHIEVEMENT</span>
              <h1>
                {t("achievements.landingTitle", { name: profile?.nickname ?? "" })}
              </h1>
              <article className="share-card">
                <span className="share-card-brand">Spott</span>
                <strong>{name}</strong>
                <p>{profile?.nickname}</p>
                {detail && <small>{detail}</small>}
                {state === "ready" && award && (
                  <small>
                    {t("achievements.earnedOn", { date: formatDate(award.awardedAt, locale) })}
                  </small>
                )}
              </article>
              {state === "signedOut" ? (
                <div className="award-landing-actions">
                  <p>{t("achievements.landingSignedOut")}</p>
                  <Link
                    className="primary-action compact"
                    href={`/login?returnTo=${encodeURIComponent(`/u/${handle}/achievements/${code}`)}`}
                  >
                    {t("achievements.landingLogin")}
                  </Link>
                  {profileHref && (
                    <Link className="secondary-action compact" href={profileHref}>
                      {t("achievements.landingProfile")}
                    </Link>
                  )}
                </div>
              ) : (
                profileHref && (
                  <div className="award-landing-actions">
                    <Link className="secondary-action compact" href={profileHref}>
                      {t("achievements.landingProfile")}
                    </Link>
                  </div>
                )
              )}
            </>
          )}
        </section>
      </div>
      <Footer />
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
