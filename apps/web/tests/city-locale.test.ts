import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { isTokyoPath, tokyoLanguageAlternates, tokyoPath } from "../app/lib/city-locale";
import { proxy } from "../proxy";

describe("Tokyo locale URLs", () => {
  it("uses one stable, distinct indexable URL for every supported language", () => {
    expect(tokyoPath("zh-Hans")).toBe("/tokyo");
    expect(tokyoPath("ja")).toBe("/ja/tokyo");
    expect(tokyoPath("en")).toBe("/en/tokyo");
    expect(tokyoLanguageAlternates).toEqual({
      "zh-Hans": "/tokyo",
      ja: "/ja/tokyo",
      en: "/en/tokyo",
      "x-default": "/tokyo",
    });
    expect(new Set(Object.values(tokyoLanguageAlternates))).toHaveLength(3);
  });

  it("recognizes only the supported Tokyo route family", () => {
    expect(isTokyoPath("/tokyo")).toBe(true);
    expect(isTokyoPath("/ja/tokyo/")).toBe(true);
    expect(isTokyoPath("/en/tokyo")).toBe(true);
    expect(isTokyoPath("/discover")).toBe(false);
    expect(isTokyoPath("/fr/tokyo")).toBe(false);
  });

  it.each(["ja", "en"] as const)("rewrites /%s/tokyo with an authoritative request locale", (locale) => {
    const response = proxy(new NextRequest(`https://spott.jp/${locale}/tokyo?availableOnly=true`));

    const rewritten = response.headers.get("x-middleware-rewrite");
    expect(rewritten).toBe(`https://spott.jp/tokyo?availableOnly=true`);
    expect(response.cookies.get("spott_locale")?.value).toBe(locale);
  });

  it.each([
    "/tokyo?source=pwa",
    "/ja/tokyo?q=coffee",
    "/en/tokyo?date=this-weekend",
    "/tokyo?map",
  ])("deindexes every filtered Tokyo URL while preserving the route", (path) => {
    const response = proxy(new NextRequest(`https://spott.jp${path}`));

    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("keeps every clean Tokyo locale URL eligible for indexing", () => {
    for (const path of ["/tokyo", "/ja/tokyo", "/en/tokyo"]) {
      expect(proxy(new NextRequest(`https://spott.jp${path}`)).headers.get("X-Robots-Tag")).toBeNull();
    }
  });

  it("treats safety as a sensitive route at the response boundary", () => {
    const response = proxy(new NextRequest("https://spott.jp/safety"));

    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("does not rewrite unrelated or unsupported locale routes", () => {
    const response = proxy(new NextRequest("https://spott.jp/fr/tokyo"));
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    expect(response.cookies.get("spott_locale")).toBeUndefined();
  });
});
