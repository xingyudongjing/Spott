"use client";

import { useEffect } from "react";
import { useI18n } from "./I18nProvider";

export function ServiceWorkerRegistrar() {
  const { locale } = useI18n();

  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;

    const announceLocale = (worker?: ServiceWorker | null) => {
      worker?.postMessage({ type: "SPOTT_LOCALE", locale });
    };
    const onControllerChange = () => announceLocale(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    void navigator.serviceWorker.register("/sw.js", { scope: "/" })
      .then(async (registration) => {
        announceLocale(registration.active ?? registration.waiting ?? registration.installing);
        const ready = await navigator.serviceWorker.ready;
        announceLocale(ready.active);
        announceLocale(navigator.serviceWorker.controller);
      })
      .catch(() => undefined);

    return () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
  }, [locale]);
  return null;
}
