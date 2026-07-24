"use client";

import { useEffect, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import type { Locale } from "../../i18n/messages";
import {
  apiRequest,
  errorMessage,
  type WalletTransaction,
  type WalletView,
} from "../../lib/client-api";
import { trackProductEvent } from "../../lib/analytics";
import { DashboardNav } from "../DashboardNav";
import { DailyCheckinCard } from "./DailyCheckinCard";

export function WalletClient() {
  const { locale } = useI18n();
  const [wallet, setWallet] = useState<WalletView | null>(null);
  const [rows, setRows] = useState<WalletTransaction[]>([]);
  const [message, setMessage] = useState("");

  // Points funnel (product §P1): entering the wallet is the "查看钱包" step.
  useEffect(() => {
    void trackProductEvent("wallet_viewed", {});
  }, []);

  useEffect(() => {
    Promise.all([
      apiRequest<WalletView>("/wallet", { authenticated: true }),
      apiRequest<{ items: WalletTransaction[] }>("/wallet/transactions?limit=100", {
        authenticated: true,
      }),
    ])
      .then(([balance, history]) => {
        setWallet(balance);
        setRows(history.items);
      })
      .catch((error) => setMessage(errorMessage(error)));
  }, []);

  const copy =
    locale === "ja"
      ? {
          title: "ポイント",
          body: "Web と iOS は同じ台帳を使い、残高と履歴は分かれません。",
          get: "ポイントを入手",
          store:
            "有料ポイントは iOS の Apple StoreKit で購入できます。購入後はここに自動同期されます。",
          total: "合計ポイント",
          totalBody: "無料・有料ポイントの合計",
          free: "無料ポイント",
          paid: "有料ポイント",
          expiry: "直近の期限",
          noExpiry: "期限が近いポイントはありません",
          never: "有料ポイントに有効期限はありません",
          history: "ポイント履歴",
          empty: "ポイント履歴はまだありません",
          syncing: "ポイント台帳を同期中…",
          boundary: "ポイントと参加費は完全に別です",
          boundaryBody:
            "Spott ポイントはプラットフォーム上のデジタル機能だけに使われ、参加費の支払いや換金、代理受領には使えません。",
        }
      : locale === "en"
        ? {
            title: "Points wallet",
            body: "Web and iOS use one ledger, so balances and history never split.",
            get: "Get points",
            store:
              "Paid points are purchased through Apple StoreKit on iOS and sync here automatically.",
            total: "Total points",
            totalBody: "Free and paid points combined",
            free: "Free points",
            paid: "Paid points",
            expiry: "Next expiry",
            noExpiry: "No points are expiring soon",
            never: "Paid points do not expire",
            history: "Points history",
            empty: "No points activity yet",
            syncing: "Syncing points ledger…",
            boundary: "Points and event fees are separate",
            boundaryBody:
              "Spott points unlock digital platform features only. They cannot pay event fees, be cashed out, or be used to collect offline fees.",
          }
        : {
            title: "积分钱包",
            body: "Web 与 iOS 共用同一账本，余额和流水不会分开计算。",
            get: "获取积分",
            store: "付费积分通过 iOS 的 Apple StoreKit 购买；购买完成后会自动同步到这里。",
            total: "总积分",
            totalBody: "付费与免费积分的合计",
            free: "免费积分",
            paid: "付费积分",
            expiry: "最近到期",
            noExpiry: "当前无即将到期积分",
            never: "付费积分不会过期",
            history: "积分流水",
            empty: "还没有积分流水",
            syncing: "正在同步钱包账本…",
            boundary: "积分与活动费完全分离",
            boundaryBody: "Spott 积分只兑换平台数字功能，不能抵扣、提现或代收线下活动费用。",
          };

  return (
    <main className="dashboard-shell">
      <DashboardNav current="wallet" />
      <section className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">WALLET / SYNCED</span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <button
            className="create-button"
            type="button"
            onClick={() => {
              // Points funnel (product §P1): opening the purchase path is "进入购买".
              void trackProductEvent("points_purchase_viewed", {
                total_balance: wallet?.totalBalance ?? 0,
              });
              setMessage(copy.store);
            }}
          >
            {copy.get}
          </button>
        </div>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        <DailyCheckinCard locale={locale} onWalletUpdate={setWallet} />
        {wallet ? (
          <>
            <div className="wallet-cards">
              <div className="wallet-total">
                <span>{copy.total}</span>
                <strong>{wallet.totalBalance.toLocaleString(intlLocale(locale))}</strong>
                <p>{copy.totalBody}</p>
              </div>
              <div>
                <span>{copy.free}</span>
                <strong>{wallet.freeBalance.toLocaleString(intlLocale(locale))}</strong>
                <p>
                  {wallet.nextFreeExpiry
                    ? `${copy.expiry}: ${new Intl.DateTimeFormat(intlLocale(locale)).format(new Date(wallet.nextFreeExpiry))}`
                    : copy.noExpiry}
                </p>
              </div>
              <div>
                <span>{copy.paid}</span>
                <strong>{wallet.paidBalance.toLocaleString(intlLocale(locale))}</strong>
                <p>{copy.never}</p>
              </div>
            </div>
            <section className="ledger">
              <div className="section-heading">
                <div>
                  <span className="section-number">HISTORY</span>
                  <h2>{copy.history}</h2>
                </div>
              </div>
              {rows.length ? (
                rows.map((row) => {
                  const delta = row.freeDelta + row.paidDelta;
                  return (
                    <div className="ledger-row" key={row.id}>
                      <div>
                        <strong>{transactionLabel(row.type, locale)}</strong>
                        <span>
                          {new Intl.DateTimeFormat(intlLocale(locale), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(row.occurredAt))}
                        </span>
                      </div>
                      <span>{bucketLabel(row, locale)}</span>
                      <strong className={delta > 0 ? "positive" : ""}>
                        {delta > 0 ? "+" : ""}
                        {delta.toLocaleString(intlLocale(locale))}
                      </strong>
                    </div>
                  );
                })
              ) : (
                <div className="empty-ledger">{copy.empty}</div>
              )}
            </section>
          </>
        ) : (
          !message && (
            <div className="loading-state">
              <span />
              <p>{copy.syncing}</p>
            </div>
          )
        )}
        <aside className="fee-boundary">
          <span className="fee-icon">i</span>
          <div>
            <strong>{copy.boundary}</strong>
            <p>{copy.boundaryBody}</p>
          </div>
        </aside>
      </section>
    </main>
  );
}

function transactionLabel(type: string, locale: Locale): string {
  const labels: Record<string, [string, string, string]> = {
    phone_verified_reward: ["手机验证奖励", "電話番号認証ボーナス", "Phone verification reward"],
    profile_completed_reward: ["资料完善奖励", "プロフィール完成ボーナス", "Profile completion reward"],
    registration_fee: ["活动报名", "イベント申込", "Event registration"],
    registration_cancel_refund: ["报名取消退回", "申込キャンセル返還", "Registration refund"],
    event_publish_hold: ["活动发布预留", "公開ポイント確保", "Event publish hold"],
    event_publish: ["活动发布", "イベント公開", "Event published"],
    storekit_credit: ["积分购买", "ポイント購入", "Points purchase"],
    daily_checkin_reward: ["每日签到奖励", "毎日チェックインボーナス", "Daily check-in reward"],
    streak_7_reward: ["连续 7 天签到奖励", "7日連続ボーナス", "7-day streak bonus"],
    streak_30_reward: ["连续 30 天签到奖励", "30日連続ボーナス", "30-day streak bonus"],
    attendance_reward: ["活动到场奖励", "参加ボーナス", "Attendance reward"],
    feedback_reward: ["反馈奖励", "フィードバックボーナス", "Feedback reward"],
    host_completion_reward: ["活动完成奖励", "主催完了ボーナス", "Host completion reward"],
    manual_adjustment: ["运营调整", "運営による調整", "Manual adjustment"],
  };
  return labels[type]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? type.replaceAll("_", " ");
}

function bucketLabel(row: WalletTransaction, locale: Locale): string {
  if (row.freeDelta && row.paidDelta)
    return locale === "ja" ? "無料 + 有料" : locale === "en" ? "Free + paid" : "免费 + 付费积分";
  if (row.paidDelta)
    return locale === "ja" ? "有料ポイント" : locale === "en" ? "Paid points" : "付费积分";
  return locale === "ja" ? "無料ポイント" : locale === "en" ? "Free points" : "免费积分";
}

function intlLocale(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}
