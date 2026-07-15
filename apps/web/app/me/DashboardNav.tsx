"use client";

import Link from "next/link";
import { useI18n } from "../components/I18nProvider";

export function DashboardNav({ current }: { current: "events" | "favorites" | "wallet" | "notifications" | "settings" }) {
  const { locale, t } = useI18n();
  const labels = locale === "ja" ? { favorites: "保存したイベント", wallet: "ポイント", settings: "プロフィールと設定", switch: "主催者スタジオへ" } : locale === "en" ? { favorites: "Saved events", wallet: "Points wallet", settings: "Profile & settings", switch: "Open host studio" } : { favorites: "我的收藏", wallet: "积分钱包", settings: "资料与设置", switch: "切换到主办方工作台" };
  return <aside className="dashboard-nav"><Link className="wordmark" href="/">SPOTT</Link><nav><Link className={current === "events" ? "active" : ""} href="/me/events">{t("nav.myEvents")}</Link><Link className={current === "favorites" ? "active" : ""} href="/me/favorites">{labels.favorites}</Link><Link className={current === "wallet" ? "active" : ""} href="/me/wallet">{labels.wallet}</Link><Link className={current === "notifications" ? "active" : ""} href="/notifications">{t("nav.notifications")}</Link><Link className={current === "settings" ? "active" : ""} href="/me/settings">{labels.settings}</Link></nav><Link href="/studio/events">{labels.switch} ↗</Link></aside>;
}
