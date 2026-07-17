import type { Locale } from "../i18n/messages";

export const localeRequestHeader = "x-spott-route-locale";

export function tokyoPath(locale: Locale): string {
  if (locale === "ja") return "/ja/tokyo";
  if (locale === "en") return "/en/tokyo";
  return "/tokyo";
}

export const tokyoLanguageAlternates: Record<Locale | "x-default", string> = {
  "zh-Hans": "/tokyo",
  ja: "/ja/tokyo",
  en: "/en/tokyo",
  "x-default": "/tokyo",
};

export function isTokyoPath(pathname: string): boolean {
  return pathname === "/tokyo"
    || pathname === "/tokyo/"
    || pathname === "/ja/tokyo"
    || pathname === "/ja/tokyo/"
    || pathname === "/en/tokyo"
    || pathname === "/en/tokyo/";
}
