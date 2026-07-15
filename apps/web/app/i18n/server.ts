import { cookies } from "next/headers";
import { isLocale, type Locale } from "./messages";

export async function serverLocale(): Promise<Locale> {
  const value = (await cookies()).get("spott_locale")?.value;
  return isLocale(value) ? value : "zh-Hans";
}
