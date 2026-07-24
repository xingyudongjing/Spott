"use client";

import Link from "next/link";
import { useI18n } from "../components/I18nProvider";

export function DashboardNav({ current }: { current: "events" | "favorites" | "wallet" | "achievements" | "notifications" | "settings" }) {
  const { t } = useI18n();
  const active = (value: typeof current) => current === value ? { className: "active", "aria-current": "page" as const } : {};
  return (
    <aside className="dashboard-nav">
      <Link className="wordmark" href="/">SPOTT</Link>
      <nav>
        <Link {...active("events")} href="/me/events">{t("nav.myEvents")}</Link>
        <Link {...active("favorites")} href="/me/favorites">{t("dashboard.favorites")}</Link>
        <Link {...active("wallet")} href="/me/wallet">{t("dashboard.wallet")}</Link>
        <Link {...active("achievements")} href="/me/achievements">{t("achievements.title")}</Link>
        <Link {...active("notifications")} href="/notifications">{t("nav.notifications")}</Link>
        <Link {...active("settings")} href="/me/settings">{t("dashboard.settings")}</Link>
      </nav>
      <Link href="/studio/events">{t("dashboard.hostSwitch")} ↗</Link>
    </aside>
  );
}
