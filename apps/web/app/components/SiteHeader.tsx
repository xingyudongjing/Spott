"use client";

import Link from "next/link";
import { BellIcon, CalendarIcon, SearchIcon, UserIcon, UsersIcon } from "./icons";
import { AccountControl } from "./AccountControl";
import { LanguageSwitcher } from "./I18nProvider";
import { useI18n } from "./I18nProvider";

export function SiteHeader() {
  const { t } = useI18n();
  return (
    <>
      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="Spott">
          SPOTT
        </Link>
        <nav className="desktop-nav" aria-label="Primary navigation">
          <Link href="/discover">{t("nav.discover")}</Link>
          <Link href="/groups">{t("nav.groups")}</Link>
          <Link href="/me/events">{t("nav.myEvents")}</Link>
          <Link href="/studio/events">{t("nav.hostStudio")}</Link>
        </nav>
        <div className="header-actions">
          <LanguageSwitcher compact />
          <Link
            className="icon-button header-search"
            href="/discover#search"
            aria-label={t("nav.search")}
          >
            <SearchIcon />
          </Link>
          <Link className="icon-button" href="/notifications" aria-label={t("nav.notifications")}>
            <BellIcon />
          </Link>
          <AccountControl />
          <Link className="create-button" href="/create">
            {t("nav.create")} <span aria-hidden="true">＋</span>
          </Link>
        </div>
      </header>
      <nav className="mobile-dock" aria-label="Mobile navigation">
        <Link href="/discover">
          <SearchIcon />
          <span>{t("nav.discover")}</span>
        </Link>
        <Link href="/groups">
          <UsersIcon />
          <span>{t("nav.groups")}</span>
        </Link>
        <Link className="mobile-create" href="/create" aria-label={t("nav.create")}>
          <b>＋</b>
        </Link>
        <Link href="/me/events">
          <CalendarIcon />
          <span>{t("nav.myEvents")}</span>
        </Link>
        <Link href="/me/settings">
          <UserIcon />
          <span>{t("nav.account")}</span>
        </Link>
      </nav>
    </>
  );
}
