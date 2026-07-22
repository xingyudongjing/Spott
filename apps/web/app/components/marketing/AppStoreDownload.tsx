import type { AppStoreAvailability } from "../../lib/app-store";
import type { MarketingCopy } from "./marketing-copy";
import styles from "./marketing-home.module.css";

type AppStoreDownloadProps = {
  readonly availability: AppStoreAvailability;
  readonly copy: MarketingCopy;
  readonly placement: "header" | "hero" | "final";
};

const officialDownloadBadgeByLocale: Record<MarketingCopy["locale"], string> = {
  "zh-Hans": "https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/zh-cn",
  ja: "https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/ja-jp",
  en: "https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us",
};

function ArrowIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20">
      <path d="M4 10h11M11 5l5 5-5 5" />
    </svg>
  );
}

export function AppStoreDownload({ availability, copy, placement }: AppStoreDownloadProps) {
  const canDownload = availability.state === "available";

  if (placement === "hero") {
    if (canDownload) {
      return (
        <div className={styles.heroActions} id="download">
          <a
            aria-label={copy.hero.appStoreDownload}
            className={styles.appStoreLink}
            href={availability.url}
          >
            {/* Apple requires the official badge artwork to remain unmodified. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              alt=""
              className={styles.appStoreBadge}
              src={officialDownloadBadgeByLocale[copy.locale]}
            />
          </a>
          <a className={styles.secondaryAction} href="/discover">
            <span>{copy.hero.webCta}</span>
            <ArrowIcon />
          </a>
        </div>
      );
    }

    // Apple's official pre-order artwork does not currently have a verified
    // source endpoint in this repository. Pre-order therefore fails closed to
    // the same honest, non-badge state as an unavailable app.
    return (
      <div className={styles.heroActions} id="download">
        <a className={styles.primaryAction} href="/discover">
          <span>{copy.hero.webCta}</span>
          <ArrowIcon />
        </a>
        <p className={styles.storeAvailability}>
          <span aria-hidden="true" className={styles.informationMark}>i</span>
          {copy.hero.appStoreSoon}
        </p>
      </div>
    );
  }

  return (
    <a
      className={placement === "header" ? styles.headerAction : styles.finalAction}
      href={canDownload ? "#download" : "/discover"}
    >
      <span>{canDownload ? copy.nav.download : copy.nav.web}</span>
      <ArrowIcon />
    </a>
  );
}
