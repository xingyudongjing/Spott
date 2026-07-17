import { describe, expect, it } from "vitest";

import { localeFromAcceptLanguage } from "../app/i18n/locale-negotiation";

describe("Accept-Language negotiation", () => {
  it.each([
    ["ja-JP,ja;q=0.9,en;q=0.7", "ja"],
    ["fr;q=0.9,en-US;q=0.8,ja;q=0.6", "en"],
    ["zh-CN,ja;q=0.8", "zh-Hans"],
    ["zh-TW;q=0.7,en;q=0.9", "en"],
  ] as const)("maps %s to %s", (header, expected) => {
    expect(localeFromAcceptLanguage(header)).toBe(expected);
  });

  it("ignores disabled, malformed and unsupported entries", () => {
    expect(localeFromAcceptLanguage("ja;q=0,fr;q=1")).toBeNull();
    expect(localeFromAcceptLanguage("en;q=oops,ja;q=0.5")).toBe("ja");
    expect(localeFromAcceptLanguage(null)).toBeNull();
  });
});
