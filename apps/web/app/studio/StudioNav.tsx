"use client";

import { PreviewModeLink as Link } from "../components/PreviewModeLink";
import { useI18n } from "../components/I18nProvider";

export function StudioNav({ current }: { current: "events" | "groups" | "insights" }) {
  const { locale, t } = useI18n();
  return <aside className="studio-nav"><Link className="wordmark" href="/discover">SPOTT</Link><span className="nav-label">{t("nav.hostStudio")}</span><nav><Link href="/studio/events" className={current === "events" ? "active" : ""}>{locale === "ja" ? "イベント管理" : locale === "en" ? "Events" : "活动管理"}</Link><Link href="/studio/groups" className={current === "groups" ? "active" : ""}>{locale === "ja" ? "グループ管理" : locale === "en" ? "Groups" : "群组管理"}</Link><Link href="/studio/insights" className={current === "insights" ? "active" : ""}>{locale === "ja" ? "インサイト" : locale === "en" ? "Insights" : "数据复盘"}</Link></nav><Link className="studio-back-link" href="/me/events">← {t("nav.myEvents")}</Link></aside>;
}
