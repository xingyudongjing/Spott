"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { AccountControl } from "./AccountControl";
import { LanguageSwitcher, useI18n } from "./I18nProvider";
import { CalendarIcon, SearchIcon, UserIcon, UsersIcon } from "./icons";
import { NotificationControl } from "./NotificationControl";
import { usePreviewMode } from "./PreviewModeProvider";
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
  const isReadOnly = usePreviewMode() === "read-only";
  const region = t("nav.regionValue");
  const registrationRoute = pathname.startsWith("/register/");
  const ownsMobileAction = registrationRoute || pathname.startsWith("/e/");

  if (registrationRoute && !isReadOnly) return null;

  const visibleDestinations = isReadOnly ? destinations.slice(0, 2) : destinations;
  if (registrationRoute) return <ReadOnlyBanner />;

  return (
    <>
      <header className={`${styles.header} site-header`}>
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
          </Link>
        </div>

        <nav className={styles.desktopNav} aria-label={t("nav.primary")}>
          {visibleDestinations.map((destination) => (
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
          {!isReadOnly ? (
            <>
              <NotificationControl />
              <span className={styles.account}><AccountControl /></span>
              <Link className={styles.create} href="/create">
                {t("nav.create")}
              </Link>
            </>
          ) : null}
        </div>
      </header>

      {isReadOnly ? <ReadOnlyBanner /> : null}

      {!ownsMobileAction ? <nav className={`${styles.mobileDock} ${isReadOnly ? `${styles.mobileDockReadonly} mobile-dock--readonly` : ""} mobile-dock`} aria-label={t("nav.mobile")}>
        <DockLink pathname={pathname} href="/discover" label={t("nav.discover")} icon={<SearchIcon />} />
        <DockLink pathname={pathname} href="/groups" label={t("nav.groups")} icon={<UsersIcon />} />
        {!isReadOnly ? (
          <>
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
          </>
        ) : null}
      </nav> : null}
    </>
  );
}

function ReadOnlyBanner() {
  const { t } = useI18n();
  return (
    <div className={styles.previewBanner} role="status">
      <strong>{t("preview.readOnlyBadge")}</strong>
      <span>{t("preview.readOnlyBody")}</span>
    </div>
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
