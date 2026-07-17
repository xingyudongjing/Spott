import { formatMessage } from "./i18n/messages";
import { serverLocale } from "./i18n/server";

export default async function Loading() {
  const locale = await serverLocale();
  return (
    <main className="system-loading" role="status" aria-live="polite">
      <span aria-hidden="true" />
      <p>{formatMessage(locale, "system.loading")}</p>
    </main>
  );
}
