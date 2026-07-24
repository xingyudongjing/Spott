"use client";

import { useEffect, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import type { Locale } from "../../i18n/messages";
import {
  achievementCodeFallback,
  achievementDetailKey,
  achievementNameKey,
  isAchievementCode,
  type PublicAchievement,
} from "../../lib/achievements";
import { apiRequest } from "../../lib/client-api";

interface HostReputation {
  completedEvents: number;
  attendanceBand: string | null;
  continuousOrganizingMonths: number;
}

interface PublicAchievementPage {
  userId: string;
  items: PublicAchievement[];
  hostReputation: HostReputation | null;
}

/**
 * Public achievements for a member (`GET /v1/users/{id}/achievements`).
 *
 * The endpoint is authenticated, so the section only exists for a signed-in
 * viewer — a signed-out visitor is never shown a request that would 401.
 * Hidden and revoked awards are filtered server-side; the client never
 * second-guesses that.
 */
export function ProfileAchievements({ userId }: { userId: string }) {
  const { locale, t } = useI18n();
  const [page, setPage] = useState<PublicAchievementPage | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    apiRequest<PublicAchievementPage>(`/users/${encodeURIComponent(userId)}/achievements`, {
      authenticated: true,
    })
      .then((value) => {
        if (active) setPage(value);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [userId]);

  if (failed)
    return (
      <section className="event-section">
        <div className="section-heading">
          <div>
            <span className="section-number">ACHIEVEMENTS</span>
            <h2>{t("achievements.title")}</h2>
          </div>
        </div>
        <div className="empty-state compact-empty">
          <h2>{t("achievements.publicError")}</h2>
        </div>
      </section>
    );

  if (!page) return null;

  const reputation = page.hostReputation;

  return (
    <section className="event-section">
      <div className="section-heading">
        <div>
          <span className="section-number">ACHIEVEMENTS</span>
          <h2>{t("achievements.title")}</h2>
        </div>
      </div>
      {/* The hero already states how many events this host completed, so only the
          bands the profile cannot derive on its own are repeated here. */}
      {reputation && (reputation.attendanceBand || reputation.continuousOrganizingMonths > 1) && (
        <div className="tag-row profile-reputation">
          {reputation.attendanceBand && (
            <span>{t("achievements.hostAttendance", { band: reputation.attendanceBand })}</span>
          )}
          {reputation.continuousOrganizingMonths > 1 && (
            <span>
              {t("achievements.hostStreak", { count: reputation.continuousOrganizingMonths })}
            </span>
          )}
        </div>
      )}
      {page.items.length ? (
        <div className="award-grid">
          {page.items.map((award) => {
            const code = award.code;
            return (
              <article className="award-card" key={`${code}-${award.ruleVersion}`}>
                <div className="award-body">
                  <strong>
                    {isAchievementCode(code)
                      ? t(achievementNameKey(code))
                      : achievementCodeFallback(code)}
                  </strong>
                  {isAchievementCode(code) && <p>{t(achievementDetailKey(code))}</p>}
                </div>
                <div className="award-meta">
                  <span>
                    {t("achievements.earnedOn", { date: formatDate(award.awardedAt, locale) })}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <h2>{t("achievements.publicEmpty")}</h2>
        </div>
      )}
    </section>
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
