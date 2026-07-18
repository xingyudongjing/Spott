"use client";

import { usePathname } from "next/navigation";

import { internalTestEntryHref } from "../lib/internal-test-entry";
import { useI18n } from "./I18nProvider";

export function ReadOnlyCommunityNotice() {
  const { t } = useI18n();
  const pathname = usePathname();

  return (
    <aside className="read-only-surface-note" role="note">
      <strong>{t("preview.readOnlyBadge")}</strong>
      <span>{t("preview.communityReadOnly")}</span>
      <a href={internalTestEntryHref(pathname)} target="_blank" rel="noreferrer">
        {t("preview.openInternalTest")}
      </a>
    </aside>
  );
}
