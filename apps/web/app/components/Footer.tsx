"use client";

import { LanguageSwitcher, useI18n } from "./I18nProvider";
import { PreviewModeLink as Link } from "./PreviewModeLink";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="footer">
      <div>
        <div className="wordmark footer-wordmark">SPOTT</div>
        <p>{t("footer.tagline")}</p>
      </div>
      <div className="footer-links">
        <Link href="/discover" prefetch={false}>{t("nav.discover")}</Link>
        <Link href="/groups" prefetch={false}>{t("nav.groups")}</Link>
        <Link href="/safety" prefetch={false}>{t("footer.safety")}</Link>
        <Link href="/privacy" prefetch={false}>{t("footer.privacy")}</Link>
        <Link href="/terms" prefetch={false}>{t("footer.terms")}</Link>
      </div>
      <div className="footer-meta"><LanguageSwitcher /><p>Tokyo · 2026</p></div>
    </footer>
  );
}
