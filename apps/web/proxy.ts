import { NextRequest, NextResponse } from "next/server";

import { localeRequestHeader } from "./app/lib/city-locale";
import { isLocale, type Locale } from "./app/i18n/messages";

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === "/offline") {
    const locale = request.nextUrl.searchParams.get("locale");
    if (!isLocale(locale)) return NextResponse.next();
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set(localeRequestHeader, locale);
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  const match = request.nextUrl.pathname.match(/^\/(?:(ja|en)\/)?tokyo\/?$/);
  if (!match) {
    const response = NextResponse.next();
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
    return response;
  }

  const locale: Locale = match[1] === "ja" || match[1] === "en" ? match[1] : "zh-Hans";
  request.cookies.set("spott_locale", locale);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(localeRequestHeader, locale);
  const rewriteURL = request.nextUrl.clone();
  rewriteURL.pathname = "/tokyo";

  const response = match[1]
    ? NextResponse.rewrite(rewriteURL, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
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
  ],
};
