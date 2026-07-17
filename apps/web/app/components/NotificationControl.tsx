"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import {
  apiRequest,
  readSession,
  subscribeSessionChanges,
  type NotificationView,
} from "../lib/client-api";
import { BellIcon } from "./icons";
import { useI18n } from "./I18nProvider";
import styles from "./SiteHeader.module.css";

export function NotificationControl() {
  const { t } = useI18n();
  const [hasUnread, setHasUnread] = useState(false);

  const refresh = useCallback(async () => {
    const ownerId = readSession()?.user.id;
    if (!ownerId) {
      setHasUnread(false);
      return;
    }
    try {
      const payload = await apiRequest<{ items: NotificationView[] }>(
        "/notifications?limit=100",
        { authenticated: true },
      );
      if (readSession()?.user.id === ownerId) {
        setHasUnread(payload.items.some((item) => !item.readAt));
      }
    } catch {
      if (readSession()?.user.id === ownerId) setHasUnread(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    const unsubscribe = subscribeSessionChanges(() => void refresh());
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh]);

  return (
    <Link
      className={styles.notification}
      href="/notifications"
      aria-label={t("nav.notifications")}
      data-unread={hasUnread ? "true" : "false"}
    >
      <BellIcon />
      {hasUnread ? <span className={styles.notificationDot} aria-hidden="true" /> : null}
    </Link>
  );
}
