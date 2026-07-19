import type { Locale } from "../i18n/messages";
import { formatMessage } from "../i18n/messages";
import type { EventFee, EventFormat, EventLocale } from "./event-contract";

function intlLocale(locale: Locale = "zh-Hans") {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}

export function eventDate(
  date: string | null | undefined,
  locale: Locale = "zh-Hans",
  timeZone = "Asia/Tokyo",
): string {
  if (!date) return formatMessage(locale, "event.timeTBA");
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone, month: "long", day: "numeric", weekday: "short",
  }).format(new Date(date));
}

export function eventTime(
  start: string | null | undefined,
  end: string | null | undefined,
  locale: Locale = "zh-Hans",
  timeZone = "Asia/Tokyo",
): string {
  if (!start) return formatMessage(locale, "event.timeTBA");
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone, hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const startDate = new Date(start);
  if (!end) return formatter.format(startDate);

  const endDate = new Date(end);
  const endPrefix = eventEndPrefix(startDate, endDate, locale, timeZone);
  return `${formatter.format(startDate)}–${endPrefix}${formatter.format(endDate)}`;
}

function eventEndPrefix(
  start: Date,
  end: Date,
  locale: Locale = "zh-Hans",
  timeZone = "Asia/Tokyo",
): string {
  const dayDifference = calendarDay(end, timeZone) - calendarDay(start, timeZone);
  if (dayDifference === 1) return `${formatMessage(locale, "event.nextDay")} `;
  if (dayDifference <= 1) return "";

  const endDate = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone,
    year: "numeric",
    month: locale === "en" ? "short" : "long",
    day: "numeric",
  }).format(end);
  return `${endDate} · `;
}

function calendarDay(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return Date.UTC(value("year"), value("month") - 1, value("day")) / 86_400_000;
}

export function eventDay(
  date: string | null | undefined,
  timeZone = "Asia/Tokyo",
): { month: string; day: string } {
  if (!date) return { month: "TBA", day: "—" };
  const parsed = new Date(date);
  return {
    month: new Intl.DateTimeFormat("en", { timeZone, month: "short" })
      .format(parsed)
      .toUpperCase(),
    day: new Intl.DateTimeFormat("en", { timeZone, day: "2-digit" }).format(parsed),
  };
}

export function eventFeeLabel(fee: EventFee | null | undefined, locale: Locale): string {
  if (!fee) return formatMessage(locale, "event.feeTBA");
  if (fee.isFree) return formatMessage(locale, "common.free");
  if (fee.amountJPY === null) return formatMessage(locale, "event.feeTBA");
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "JPY",
    maximumFractionDigits: 0,
  }).format(fee.amountJPY);
}

export function eventFormatLabel(format: EventFormat, locale: Locale): string {
  if (format === "in_person") return formatMessage(locale, "event.formatInPerson");
  if (format === "online") return formatMessage(locale, "event.formatOnline");
  return formatMessage(locale, "event.formatHybrid");
}

export function eventLanguageLabel(language: EventLocale, locale: Locale): string {
  if (language === "zh-Hans") return formatMessage(locale, "event.languageChinese");
  if (language === "ja") return formatMessage(locale, "event.languageJapanese");
  return formatMessage(locale, "event.languageEnglish");
}
