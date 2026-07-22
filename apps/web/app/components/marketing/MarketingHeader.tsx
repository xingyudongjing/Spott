import type { AppStoreAvailability } from "../../lib/app-store";
import { AppStoreDownload } from "./AppStoreDownload";
import { MarketingMenu } from "./MarketingMenu.client";
import type { MarketingCopy } from "./marketing-copy";
import styles from "./marketing-home.module.css";

type MarketingHeaderProps = {
  readonly availability: AppStoreAvailability;
  readonly copy: MarketingCopy;
};

export function MarketingHeader({ availability, copy }: MarketingHeaderProps) {
  return (
    <header className={styles.marketingHeader}>
      <div className={styles.headerInner}>
        <a aria-label={copy.nav.brandHomeLabel} className={styles.wordmark} href={copy.homePath}>
          Spott<span aria-hidden="true" />
        </a>

        <nav aria-label={copy.nav.primaryLabel} className={styles.desktopNavigation}>
          {copy.nav.items.map((item) => (
            <a href={item.href} key={item.href}>{item.label}</a>
          ))}
        </nav>

        <div className={styles.headerControls}>
          <MarketingMenu
            currentLanguage={copy.currentLanguage}
            languageLabel={copy.nav.languageLabel}
            languages={copy.nav.languages}
            menuCloseLabel={copy.nav.menuCloseLabel}
            menuOpenLabel={copy.nav.menuOpenLabel}
            navigationLabel={copy.nav.primaryLabel}
            navItems={copy.nav.items}
          />
          <AppStoreDownload availability={availability} copy={copy} placement="header" />
        </div>
      </div>
    </header>
  );
}
