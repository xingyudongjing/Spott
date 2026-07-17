"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { formatMessage, localeNames, locales, type Locale, type MessageKey } from "../i18n/messages";
import { isTokyoPath, tokyoPath } from "../lib/city-locale";

interface I18nValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function I18nProvider({ initialLocale, children }: { initialLocale: Locale; children: React.ReactNode }) {
  const [locale, setLocaleState] = useState(initialLocale);

  useEffect(() => {
    document.cookie = `spott_locale=${encodeURIComponent(initialLocale)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    if (!isTokyoPath(window.location.pathname)) return;
    try {
      window.localStorage.setItem("spott_locale", initialLocale);
    } catch {
      // Cookies remain the source of truth when storage is unavailable.
    }
  }, [initialLocale]);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    try {
      window.localStorage.setItem("spott_locale", next);
    } catch {
      // A hardened browser may deny storage; the locale cookie still works.
    }
    document.cookie = `spott_locale=${encodeURIComponent(next)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    if (isTokyoPath(window.location.pathname)) {
      window.location.assign(`${tokyoPath(next)}${window.location.search}${window.location.hash}`);
      return;
    }
    window.location.reload();
  }, []);
  const t = useCallback((key: MessageKey, values?: Record<string, string | number>) => formatMessage(locale, key, values), [locale]);
  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}

export function LanguageSwitcher({ compact = false }: { compact?: boolean }) {
  const { locale, setLocale, t } = useI18n();
  return <label className={`language-switcher${compact ? " compact-language" : ""}`}>
    <span className="sr-only">{t("nav.language")}</span>
    <select value={locale} onChange={(event) => setLocale(event.target.value as Locale)} aria-label={t("nav.language")}>
      {locales.map((value) => <option key={value} value={value}>{localeNames[value]}</option>)}
    </select>
  </label>;
}
