"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountControl } from "./AccountControl";
import { LanguageSwitcher, useI18n } from "./I18nProvider";
import { BellIcon, CalendarIcon, SearchIcon, UserIcon, UsersIcon } from "./icons";
import styles from "./SiteHeader.module.css";

const destinations = [
  { href: "/discover", key: "nav.discover" as const },
  { href: "/groups", key: "nav.groups" as const },
  { href: "/me/events", key: "nav.myEvents" as const },
  { href: "/studio/events", key: "nav.hostStudio" as const },
];

function routeIsActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SiteHeader() {
  const pathname = usePathname();
  const { t } = useI18n();
  const region = t("nav.regionValue");

  return (
    <>
      <header className={styles.header}>
        <div className={styles.identity}>
          <Link className={styles.wordmark} href="/discover" aria-label="Spott">
            Spott
          </Link>
          <Link
            className={styles.region}
            href="/discover"
            aria-label={t("nav.region", { region })}
          >
            {region}
            <span aria-hidden="true">⌄</span>
          </Link>
        </div>

        <nav className={styles.desktopNav} aria-label={t("nav.primary")}>
          {destinations.map((destination) => (
            <Link
              key={destination.href}
              href={destination.href}
              aria-current={routeIsActive(pathname, destination.href) ? "page" : undefined}
            >
              {t(destination.key)}
            </Link>
          ))}
        </nav>

        <div className={styles.actions}>
          <span className={styles.locale}><LanguageSwitcher compact /></span>
          <Link
            className={styles.notification}
            href="/notifications"
            aria-label={t("nav.notifications")}
          >
            <BellIcon />
            <span className={styles.notificationDot} aria-hidden="true" />
          </Link>
          <span className={styles.account}><AccountControl /></span>
          <Link className={styles.create} href="/create">
            {t("nav.create")}
          </Link>
        </div>
      </header>

      <nav className={styles.mobileDock} aria-label={t("nav.mobile")}>
        <DockLink pathname={pathname} href="/discover" label={t("nav.discover")} icon={<SearchIcon />} />
        <DockLink pathname={pathname} href="/groups" label={t("nav.groups")} icon={<UsersIcon />} />
        <Link
          className={styles.mobileCreate}
          href="/create"
          aria-label={t("nav.create")}
          aria-current={routeIsActive(pathname, "/create") ? "page" : undefined}
        >
          <span aria-hidden="true">＋</span>
          <small>{t("nav.create")}</small>
        </Link>
        <DockLink pathname={pathname} href="/me/events" label={t("nav.myEvents")} icon={<CalendarIcon />} />
        <DockLink pathname={pathname} href="/me/settings" label={t("nav.account")} icon={<UserIcon />} />
      </nav>
    </>
  );
}

function DockLink({
  pathname,
  href,
  label,
  icon,
}: {
  pathname: string;
  href: string;
  label: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={routeIsActive(pathname, href) ? "page" : undefined}
    >
      {icon}
      <span>{label}</span>
    </Link>
  );
}
