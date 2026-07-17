"use client";

import { useI18n } from "./I18nProvider";

export function ReadOnlyCommunityNotice() {
  const { t } = useI18n();

  return (
    <aside className="read-only-surface-note" role="note">
      <strong>{t("preview.readOnlyBadge")}</strong>
      <span>{t("preview.communityReadOnly")}</span>
    </aside>
  );
}
