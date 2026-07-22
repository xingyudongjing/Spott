import type { Locale } from "../i18n/messages";

export const routeShellRequestHeader = "x-spott-route-shell";

export type RouteShell = "marketing" | "product";

function normalizedPagePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

export function marketingLocaleForPath(pathname: string): Locale | null {
  switch (normalizedPagePath(pathname)) {
    case "/": return "zh-Hans";
    case "/ja": return "ja";
    case "/en": return "en";
    default: return null;
  }
}

export function routeShellFromHeader(value: string | null): RouteShell {
  return value === "marketing" ? "marketing" : "product";
}
