import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

import { formatMessage } from "../app/i18n/messages";

describe("read-only presentation safeguards", () => {
  test("lets the global mobile dock honor the two-column read-only modifier", () => {
    const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

    expect(styles).toMatch(
      /\.mobile-dock\.mobile-dock--readonly\s*\{\s*grid-template-columns:\s*repeat\(2,/,
    );
  });

  test("uses not-allowed for disabled buttons and wait only for an explicit busy state", () => {
    const styles = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

    expect(styles).toMatch(/button:disabled\s*\{[^}]*cursor:\s*not-allowed;/);
    expect(styles).toMatch(/button\[aria-busy="true"\]:disabled\s*\{[^}]*cursor:\s*wait;/);
    expect(styles).not.toMatch(/button:disabled\s*\{[^}]*cursor:\s*wait;/);
  });

  test("ships distinct Chinese, Japanese, and English community read-only guidance", () => {
    const copy = (["zh-Hans", "ja", "en"] as const)
      .map((locale) => formatMessage(locale, "preview.communityReadOnly"));

    expect(new Set(copy).size).toBe(3);
    expect(copy.every((value) => value.length > 40)).toBe(true);
  });
});
