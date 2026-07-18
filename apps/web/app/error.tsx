"use client";

import { useI18n } from "./components/I18nProvider";
import { PreviewModeLink as Link } from "./components/PreviewModeLink";

export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  return (
    <main className="system-fallback" role="alert">
      <span>{t("system.errorEyebrow")}</span>
      <h1>{t("system.errorTitle")}</h1>
      <p>{t("system.errorBody")}</p>
      <div>
        <button type="button" onClick={reset}>{t("system.errorRetry")}</button>
        <Link href="/discover">{t("system.notFoundAction")}</Link>
      </div>
    </main>
  );
}
