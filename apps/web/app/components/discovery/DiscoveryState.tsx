"use client";

import { useI18n } from "../I18nProvider";
import styles from "./DiscoveryShell.module.css";

export function DiscoveryLoading() {
  const { t } = useI18n();
  return (
    <div className={styles.skeletonList} aria-label={t("common.loading")}>
      {Array.from({ length: 3 }, (_, index) => (
        <span
          key={index}
          className={`${styles.skeletonRow} ${index === 0 ? styles.skeletonFeatured : ""}`}
          data-featured={index === 0 || undefined}
        >
          {index === 0 ? (
            <>
              <span className={styles.skeletonCover} />
              <span className={styles.skeletonCopy} />
            </>
          ) : null}
        </span>
      ))}
    </div>
  );
}

export function DiscoveryEmpty({ onReset }: { onReset: () => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.emptyState}>
      <span className={styles.emptyMark} aria-hidden="true" />
      <h2>{t("discover.emptyTitle")}</h2>
      <p>{t("discover.emptyBody")}</p>
      <button type="button" onClick={onReset}>{t("common.clear")}</button>
    </div>
  );
}

export function DiscoveryError({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className={styles.errorState} role="alert">
      <p>{t("discover.error")}</p>
      <button type="button" onClick={onRetry}>{t("common.retry")}</button>
    </div>
  );
}
