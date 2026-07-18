import { describe, expect, test } from "vitest";

import {
  internalTestEntryHref,
} from "../app/lib/internal-test-entry";
import {
  localizedPublicTags,
} from "../app/lib/public-taxonomy";

describe("public taxonomy localization", () => {
  test("localizes every seeded event tag in Simplified Chinese, Japanese, and English", () => {
    expect(localizedPublicTags(["摄影", "城市散步", "初次友好"], "en"))
      .toEqual(["Photography", "City walks", "First-timer friendly"]);
    expect(localizedPublicTags(["音楽", "レコード", "少人数"], "zh-Hans"))
      .toEqual(["音乐", "黑胶", "小规模"]);
    expect(localizedPublicTags(["coast", "morning", "easy pace"], "ja"))
      .toEqual(["海岸", "朝", "ゆったり"]);
  });

  test("deduplicates translated aliases and preserves unknown host-defined tags", () => {
    expect(localizedPublicTags(["city-walk", "城市散步", "night sketch"], "en"))
      .toEqual(["City walks", "night sketch"]);
  });

  test("limits cards after localization without hiding full detail tags", () => {
    expect(localizedPublicTags(["摄影", "城市散步", "初次友好", "coast"], "en", 3))
      .toEqual(["Photography", "City walks", "First-timer friendly"]);
  });
});

describe("internal-test entry boundary", () => {
  test("keeps public conversion on the SSH-only loopback origin", () => {
    expect(internalTestEntryHref("/register/shimokita-vinyl-preview"))
      .toBe("http://localhost:8080/register/shimokita-vinyl-preview");
    expect(internalTestEntryHref("//attacker.invalid/path"))
      .toBe("http://localhost:8080/");
    expect(internalTestEntryHref("https://attacker.invalid/path"))
      .toBe("http://localhost:8080/");
    expect(internalTestEntryHref(null))
      .toBe("http://localhost:8080/");
  });
});
