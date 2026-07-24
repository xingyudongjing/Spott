"use client";

import { useState } from "react";

import type { Locale } from "../../i18n/messages";
import {
  apiRequest,
  errorMessage,
  type WalletView,
} from "../../lib/client-api";
import styles from "./DailyCheckinCard.module.css";

export interface DailyCheckinResult {
  alreadyCheckedIn: boolean;
  streak: number;
  civilDay: string;
  rewards: Array<{ type: string; points: number }>;
  wallet: WalletView;
}

export function DailyCheckinCard({
  locale,
  onWalletUpdate,
}: {
  locale: Locale;
  onWalletUpdate?: (wallet: WalletView) => void;
}) {
  const copy = checkinCopy(locale);
  const [result, setResult] = useState<DailyCheckinResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function checkin() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      const value = await apiRequest<DailyCheckinResult>("/points/checkin", {
        method: "POST",
        authenticated: true,
      });
      setResult(value);
      onWalletUpdate?.(value.wallet);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const done = result !== null;
  const buttonLabel = busy
    ? copy.working
    : done
      ? (result.alreadyCheckedIn ? copy.alreadyDone : copy.done)
      : copy.action;

  return (
    <section className={styles.card} aria-label={copy.title}>
      <div className={styles.copy}>
        <span className={styles.eyebrow}>{copy.eyebrow}</span>
        <h2>{copy.title}</h2>
        <p>{done && result.alreadyCheckedIn ? copy.alreadyBody : copy.body}</p>
        {done ? (
          <p className={styles.streak} role="status">
            {copy.streak.replaceAll("{count}", String(result.streak))}
          </p>
        ) : null}
        {done && result.rewards.length ? (
          <ul className={styles.rewards}>
            {result.rewards.map((reward) => (
              <li key={reward.type}>
                <strong>+{reward.points}</strong>
                <span>{rewardLabel(reward.type, locale)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {message ? <p className={styles.error} role="alert">{message}</p> : null}
      </div>
      <button
        type="button"
        className={styles.action}
        disabled={busy || done}
        onClick={() => void checkin()}
      >
        {buttonLabel}
      </button>
    </section>
  );
}

function rewardLabel(type: string, locale: Locale): string {
  const labels: Record<string, [string, string, string]> = {
    daily_checkin_reward: ["每日签到奖励", "毎日チェックインボーナス", "Daily check-in reward"],
    streak_7_reward: ["连续 7 天奖励", "7日連続ボーナス", "7-day streak bonus"],
    streak_30_reward: ["连续 30 天奖励", "30日連続ボーナス", "30-day streak bonus"],
  };
  return labels[type]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? type.replaceAll("_", " ");
}

function checkinCopy(locale: Locale) {
  if (locale === "ja") {
    return {
      eyebrow: "DAILY / JST",
      title: "毎日チェックイン",
      body: "毎日1回チェックインして無料ポイントを受け取れます。7日・30日連続でボーナスも。",
      alreadyBody: "本日はチェックイン済みです。また明日（日本時間）お越しください。",
      action: "今日のチェックイン",
      working: "チェックイン中…",
      done: "受け取りました",
      alreadyDone: "本日チェックイン済み",
      streak: "連続チェックイン {count} 日目",
    };
  }
  if (locale === "en") {
    return {
      eyebrow: "DAILY / JST",
      title: "Daily check-in",
      body: "Check in once a day for free points, with bonuses at 7- and 30-day streaks.",
      alreadyBody: "You already checked in today. Come back tomorrow (Japan time).",
      action: "Check in today",
      working: "Checking in…",
      done: "Points collected",
      alreadyDone: "Checked in today",
      streak: "{count}-day streak",
    };
  }
  return {
    eyebrow: "每日 / 日本时间",
    title: "每日签到",
    body: "每天签到一次可领取免费积分；连续 7 天和 30 天还有额外奖励。",
    alreadyBody: "今天已经签到过了，明天（日本时间）再来吧。",
    action: "立即签到",
    working: "正在签到…",
    done: "已领取积分",
    alreadyDone: "今日已签到",
    streak: "已连续签到 {count} 天",
  };
}
