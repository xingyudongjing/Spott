"use client";

import { useEffect, useState, type ReactNode } from "react";

import { useI18n } from "./I18nProvider";
import { bootstrapSession, subscribeSessionChanges } from "../lib/client-api";
import styles from "./SessionProvider.module.css";

/** Restores access material from the same-origin HttpOnly-Cookie BFF after reload. */
export function SessionProvider({ children }: { readonly children: ReactNode }) {
  const { locale } = useI18n();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeSessionChanges(() => undefined);
    void bootstrapSession().finally(() => {
      if (active) setReady(true);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const pendingCopy = locale === "ja"
    ? "安全なセッションを復元しています…"
    : locale === "en"
      ? "Restoring your secure session…"
      : "正在恢复安全会话…";

  return (
    <div className={styles.shell} aria-busy={!ready}>
      <div className={ready ? styles.content : styles.contentPending} inert={!ready}>
        {children}
      </div>
      {!ready && (
        <div className={styles.pending} role="status" aria-live="polite">
          <span aria-hidden="true" />
          <p>{pendingCopy}</p>
        </div>
      )}
    </div>
  );
}
