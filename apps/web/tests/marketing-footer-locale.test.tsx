import { describe, expect, test } from "vitest";

import { languageHrefWithCurrentHash } from "../app/components/marketing/MarketingFooter";

describe("marketing footer language navigation", () => {
  test("keeps the current section anchor when changing locale", () => {
    expect(languageHrefWithCurrentHash("/ja", "#community")).toBe("/ja#community");
    expect(languageHrefWithCurrentHash("/en", "")).toBe("/en");
  });
});
