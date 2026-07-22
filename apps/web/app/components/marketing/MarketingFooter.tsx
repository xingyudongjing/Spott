"use client";

import type { MouseEvent } from "react";

import type { MarketingCopy } from "./marketing-copy";
import styles from "./marketing-home.module.css";

type MarketingFooterProps = {
  readonly copy: MarketingCopy;
  readonly showAppleTrademarkCredit?: boolean;
};

export function languageHrefWithCurrentHash(href: string, hash: string): string {
  return `${href}${hash}`;
}

export function MarketingFooter({ copy, showAppleTrademarkCredit = false }: MarketingFooterProps) {
  function changeLanguage(event: MouseEvent<HTMLAnchorElement>, href: string) {
    event.preventDefault();
    window.location.assign(languageHrefWithCurrentHash(href, window.location.hash));
  }

  return (
    <footer className={styles.marketingFooter}>
      <div className={styles.footerInner}>
        <a aria-label={copy.nav.brandHomeLabel} className={styles.footerWordmark} href={copy.homePath}>
          Spott<span aria-hidden="true" />
        </a>

        <nav aria-label={copy.footer.primaryLabel} className={styles.footerLinks}>
          <a href="/discover">{copy.footer.web}</a>
          <a href="/privacy">{copy.footer.privacy}</a>
          <a href="/terms">{copy.footer.terms}</a>
          <a href="/safety">{copy.footer.safety}</a>
          <a href="/safety#safety-account-title">{copy.footer.support}</a>
        </nav>

        <nav aria-label={copy.footer.languagesLabel} className={styles.footerLanguages}>
          {copy.nav.languages.map((language) => (
            <a
              aria-current={language.current ? "page" : undefined}
              href={language.href}
              hrefLang={language.locale}
              key={language.locale}
              lang={language.locale}
              onClick={(event) => changeLanguage(event, language.href)}
            >
              {language.label}
            </a>
          ))}
        </nav>
      </div>
      {showAppleTrademarkCredit ? (
        <p className={styles.footerTrademarkCredit} lang="en">
          Apple, the Apple logo, and iPhone are trademarks of Apple Inc., registered in the U.S.
          and other countries and regions. App Store is a service mark of Apple Inc.
        </p>
      ) : null}
    </footer>
  );
}
