"use client";

import { useCallback, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import type { MessageKey } from "../../i18n/messages";
import { apiRequest, errorMessage } from "../../lib/client-api";

/**
 * How points are earned (`GET /v1/points/rules`, public).
 *
 * Every number comes from the live rule catalogue — values change with the
 * active `points.lifecycle.stage` revision, so nothing here is hardcoded. Only
 * member-facing earning and expiry rules are shown; organiser pricing lives in
 * the host studio.
 */

interface PointRule {
  key: string;
  type: string;
  effectiveValue: number;
  unit: string;
  conditions: Record<string, unknown>;
  description: string;
}

const localizedRuleKeys = new Set([
  "points.reward.attendance",
  "points.reward.daily_checkin",
  "points.reward.feedback",
  "points.reward.host_completed",
  "points.reward.host_verified",
  "points.reward.phone_verified",
  "points.reward.profile_completed",
  "points.reward.referral",
  "points.reward.streak_7",
  "points.reward.streak_30",
  "points.expiry.free_days",
  "points.expiry.launch_welcome_days",
]);

export function PointsRules() {
  const { locale, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [rules, setRules] = useState<PointRule[] | null>(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setMessage("");
    try {
      const payload = await apiRequest<{ items: PointRule[] }>("/points/rules");
      setRules(payload.items);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    // The catalogue is fetched the first time a member asks for it, not on
    // every wallet visit.
    if (next && !rules) void load();
  }

  const rewards = (rules ?? []).filter((rule) => rule.type === "reward");
  const expiry = (rules ?? []).filter((rule) => rule.type === "expiry");
  const numberFormat = new Intl.NumberFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
  );

  function ruleLabel(rule: PointRule): string {
    return localizedRuleKeys.has(rule.key)
      ? t(`rule.${rule.key}` as MessageKey)
      : rule.description;
  }

  function ruleLimit(rule: PointRule): string | null {
    const conditions = rule.conditions ?? {};
    if (typeof conditions.dailyMaxEvents === "number")
      return t("pointsRules.limitDaily", { count: conditions.dailyMaxEvents });
    if (typeof conditions.weeklyMax === "number")
      return t("pointsRules.limitWeekly", { count: conditions.weeklyMax });
    if (typeof conditions.monthlyMax === "number")
      return t("pointsRules.limitMonthly", { count: conditions.monthlyMax });
    if (conditions.oncePerAccount === true || conditions.oncePerPerson === true || conditions.oncePerPhone === true)
      return t("pointsRules.limitOnce");
    return null;
  }

  return (
    <section className="points-rules">
      <div className="section-heading">
        <div>
          <span className="section-number">RULES</span>
          <h2>{t("pointsRules.title")}</h2>
        </div>
        <button
          className="secondary-action compact"
          type="button"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? t("pointsRules.close") : t("pointsRules.open")}
        </button>
      </div>
      {open && (
        <div className="points-rules-body">
          <p>{t("pointsRules.body")}</p>
          {message ? (
            <>
              <p className="form-message" role="alert">
                {t("pointsRules.error")}
              </p>
              <button
                className="secondary-action compact"
                type="button"
                onClick={() => void load()}
              >
                {t("common.retry")}
              </button>
            </>
          ) : rules === null ? (
            <div className="loading-state">
              <span />
              <p>{t("pointsRules.loading")}</p>
            </div>
          ) : (
            <>
              {rewards.length > 0 && (
                <>
                  <h3>{t("pointsRules.earn")}</h3>
                  <ul className="rule-list">
                    {rewards.map((rule) => {
                      const limit = ruleLimit(rule);
                      return (
                        <li key={rule.key}>
                          <div>
                            <strong>{ruleLabel(rule)}</strong>
                            {limit && <small>{limit}</small>}
                          </div>
                          <span>+{numberFormat.format(rule.effectiveValue)}</span>
                        </li>
                      );
                    })}
                  </ul>
                </>
              )}
              {expiry.length > 0 && (
                <>
                  <h3>{t("pointsRules.expiry")}</h3>
                  <ul className="rule-list">
                    {expiry.map((rule) => (
                      <li key={rule.key}>
                        <div>
                          <strong>{ruleLabel(rule)}</strong>
                        </div>
                        <span>{t("pointsRules.days", { count: rule.effectiveValue })}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="rule-spend-order">
                <strong>{t("pointsRules.spendOrder")}</strong>
                <p>{t("pointsRules.spendOrderBody")}</p>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
