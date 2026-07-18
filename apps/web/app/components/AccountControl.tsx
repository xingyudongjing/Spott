"use client";

import { PreviewModeLink as Link } from "./PreviewModeLink";
import { useEffect, useState } from "react";
import { readSession, type WebSession } from "../lib/client-api";
import { useI18n } from "./I18nProvider";

export function AccountControl() {
  const { t } = useI18n();
  const [session, setSession] = useState<WebSession | null | undefined>(undefined);

  useEffect(() => {
    const update = () => setSession(readSession());
    update();
    window.addEventListener("storage", update);
    window.addEventListener("spott:session", update);
    return () => {
      window.removeEventListener("storage", update);
      window.removeEventListener("spott:session", update);
    };
  }, []);

  if (session === undefined) return <span className="account-placeholder" aria-hidden="true" />;
  if (!session) return <Link className="login-link" href="/login">{t("nav.login")}</Link>;

  return <Link className="avatar" href="/me/settings" aria-label={t("nav.account")} title={`@${session.user.publicHandle}`}>
    {session.user.publicHandle.slice(0, 1).toUpperCase()}
  </Link>;
}
