import type { Locale } from "../i18n/messages";

function intlLocale(locale: Locale = "zh-Hans") {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}

export function eventDate(date: string, locale: Locale = "zh-Hans"): string {
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "Asia/Tokyo", month: "long", day: "numeric", weekday: "short",
  }).format(new Date(date));
}

export function eventTime(start: string, end: string, locale: Locale = "zh-Hans"): string {
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
  });
  return `${formatter.format(new Date(start))}–${formatter.format(new Date(end))}`;
}

export function eventDay(date: string): { month: string; day: string } {
  const parsed = new Date(date);
  return {
    month: new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", month: "short" })
      .format(parsed)
      .toUpperCase(),
    day: new Intl.DateTimeFormat("en", { timeZone: "Asia/Tokyo", day: "2-digit" }).format(parsed),
  };
}
