"use client";

import { PreviewModeLink as Link } from "../components/PreviewModeLink";
import { useI18n } from "../components/I18nProvider";

export function DashboardNav({ current }: { current: "events" | "favorites" | "wallet" | "notifications" | "settings" }) {
  const { t } = useI18n();
  const active = (value: typeof current) => current === value ? { className: "active", "aria-current": "page" as const } : {};
  return (
    <aside className="dashboard-nav">
      <Link className="wordmark" href="/discover">SPOTT</Link>
      <nav>
        <Link {...active("events")} href="/me/events">{t("nav.myEvents")}</Link>
        <Link {...active("favorites")} href="/me/favorites">{t("dashboard.favorites")}</Link>
        <Link {...active("wallet")} href="/me/wallet">{t("dashboard.wallet")}</Link>
        <Link {...active("notifications")} href="/notifications">{t("nav.notifications")}</Link>
        <Link {...active("settings")} href="/me/settings">{t("dashboard.settings")}</Link>
      </nav>
      <Link href="/studio/events">{t("dashboard.hostSwitch")} ↗</Link>
    </aside>
  );
}
