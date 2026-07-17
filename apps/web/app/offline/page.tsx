import type { Metadata } from "next";
import { OfflineRetry } from "./OfflineRetry";
import { formatMessage, isLocale } from "../i18n/messages";
import { serverLocale } from "../i18n/server";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Offline({ searchParams }: { searchParams: SearchParams }) {
  const requested = (await searchParams).locale;
  const routedLocale = Array.isArray(requested) ? requested[0] : requested;
  const locale = isLocale(routedLocale) ? routedLocale : await serverLocale();
  return (
    <main className="flow-page">
      <div className="empty-state">
        <span className="spotlight-empty" />
        <span className="section-number">{formatMessage(locale, "offline.eyebrow")}</span>
        <h1>{formatMessage(locale, "offline.title")}</h1>
        <p>{formatMessage(locale, "offline.body")}</p>
        <OfflineRetry label={formatMessage(locale, "offline.action")} />
      </div>
    </main>
  );
}
