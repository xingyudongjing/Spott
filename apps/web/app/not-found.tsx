import type { Metadata } from "next";
import { PreviewModeLink as Link } from "./components/PreviewModeLink";
import { formatMessage } from "./i18n/messages";
import { serverLocale } from "./i18n/server";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function NotFound() {
  const locale = await serverLocale();
  return (
    <main className="flow-page">
      <div className="empty-state">
        <span className="spotlight-empty" />
        <span className="section-number">{formatMessage(locale, "system.notFoundEyebrow")}</span>
        <h1>{formatMessage(locale, "system.notFoundTitle")}</h1>
        <p>{formatMessage(locale, "system.notFoundBody")}</p>
        <Link className="primary-action compact" href="/discover">
          {formatMessage(locale, "system.notFoundAction")}
        </Link>
      </div>
    </main>
  );
}
