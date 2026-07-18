"use client";

import { PreviewModeLink as Link } from "../../components/PreviewModeLink";

import { LanguageSwitcher, useI18n } from "../../components/I18nProvider";
import styles from "./RegistrationFlow.module.css";

export function RegistrationHeader({ eventSlug }: { eventSlug: string }) {
  const { t } = useI18n();
  return (
    <header className={styles.header}>
      <Link className={styles.wordmark} href="/discover">Spott</Link>
      <div className={styles.headerActions}>
        <LanguageSwitcher compact />
        <Link className={styles.back} href={`/e/${eventSlug}`}>← {t("registration.backEvent")}</Link>
      </div>
    </header>
  );
}
