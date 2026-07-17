import { cookies } from "next/headers";
import { headers } from "next/headers";
import { localeRequestHeader } from "../lib/city-locale";
import { localeFromAcceptLanguage } from "./locale-negotiation";
import { isLocale, type Locale } from "./messages";

export async function serverLocale(): Promise<Locale> {
  const requestHeaders = await headers();
  const routed = requestHeaders.get(localeRequestHeader);
  if (isLocale(routed)) return routed;
  const value = (await cookies()).get("spott_locale")?.value;
  if (isLocale(value)) return value;
  return localeFromAcceptLanguage(requestHeaders.get("accept-language")) ?? "zh-Hans";
}
