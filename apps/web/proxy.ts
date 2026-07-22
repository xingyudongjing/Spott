import { NextRequest, NextResponse } from "next/server";

import { localeRequestHeader } from "./app/lib/city-locale";
import { configuredCanonicalOrigin } from "./app/lib/canonical-origin";
import { isLocale, type Locale } from "./app/i18n/messages";
import {
  marketingLocaleForPath,
  routeShellRequestHeader,
  type RouteShell,
} from "./app/lib/route-shell";

const sensitiveRoutePattern = /^\/(?:api\/session|create|groups\/create|login|me|notifications|phone-verification|register|reports|safety|studio)(?:\/|$)/u;

function requestHeaders(
  request: NextRequest,
  shell: RouteShell,
  locale?: Locale,
): Headers {
  const result = new Headers(request.headers);
  result.delete(routeShellRequestHeader);
  result.delete(localeRequestHeader);
  result.set(routeShellRequestHeader, shell);
  if (locale !== undefined) result.set(localeRequestHeader, locale);
  return result;
}

function isTrustedIPPreviewRequest(request: NextRequest): boolean {
  if (process.env.SPOTT_DEPLOYMENT_PROFILE !== "ip-preview") return false;
  const mode = request.headers.get("x-spott-preview-mode");
  return mode === "read-only" || mode === "internal-test";
}

export function proxy(request: NextRequest) {
  const canonicalOrigin = configuredCanonicalOrigin(process.env);
  if (!isTrustedIPPreviewRequest(request) && request.nextUrl.origin !== canonicalOrigin) {
    const redirectURL = new URL(canonicalOrigin);
    redirectURL.pathname = request.nextUrl.pathname;
    redirectURL.search = request.nextUrl.search;
    const response = NextResponse.redirect(redirectURL, 308);
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    return response;
  }

  const marketingLocale = marketingLocaleForPath(request.nextUrl.pathname);
  const shell: RouteShell = marketingLocale === null ? "product" : "marketing";

  if (request.nextUrl.pathname === "/offline") {
    const locale = request.nextUrl.searchParams.get("locale");
    return NextResponse.next({
      request: {
        headers: requestHeaders(request, shell, isLocale(locale) ? locale : undefined),
      },
    });
  }

  const match = request.nextUrl.pathname.match(/^\/(?:(ja|en)\/)?tokyo\/?$/);
  if (!match) {
    const response = NextResponse.next({
      request: {
        headers: requestHeaders(request, shell, marketingLocale ?? undefined),
      },
    });
    if (
      sensitiveRoutePattern.test(request.nextUrl.pathname)
      || (shell === "marketing" && request.nextUrl.searchParams.size > 0)
    ) {
      response.headers.set("X-Robots-Tag", "noindex, nofollow");
    }
    return response;
  }

  const locale: Locale = match[1] === "ja" || match[1] === "en" ? match[1] : "zh-Hans";
  request.cookies.set("spott_locale", locale);
  const localizedRequestHeaders = requestHeaders(request, "product", locale);
  const rewriteURL = request.nextUrl.clone();
  rewriteURL.pathname = "/tokyo";

  const response = match[1]
    ? NextResponse.rewrite(rewriteURL, { request: { headers: localizedRequestHeaders } })
    : NextResponse.next({ request: { headers: localizedRequestHeaders } });
  if (request.nextUrl.searchParams.size > 0) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  response.cookies.set("spott_locale", locale, {
    httpOnly: false,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    path: "/",
    maxAge: 31_536_000,
  });
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|.*\\.(?:avif|css|gif|ico|jpeg|jpg|js|map|png|svg|txt|webp|woff|woff2)$).*)",
    "/tokyo",
    "/ja/tokyo",
    "/en/tokyo",
    "/offline",
    "/me/:path*",
    "/studio/:path*",
    "/create",
    "/register/:path*",
    "/notifications",
    "/login",
    "/phone-verification",
    "/reports/:path*",
    "/safety",
    "/groups/create",
    "/api/session/:path*",
  ],
};
