import { describe, expect, it } from "vitest";

import { legalDocument, type LegalKind } from "../app/components/legal/legal-content";
import { locales, messages } from "../app/i18n/messages";

function placeholders(value: string): string[] {
  return [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
    .map((match) => match[1])
    .toSorted();
}

describe("web localization parity", () => {
  it("keeps the same non-empty message keys in zh-Hans, ja, and en", () => {
    const referenceKeys = Object.keys(messages["zh-Hans"]).toSorted();

    for (const locale of locales) {
      const entries = Object.entries(messages[locale]);
      expect(entries.map(([key]) => key).toSorted()).toEqual(referenceKeys);
      expect(
        entries.filter(([, value]) => value.trim().length === 0).map(([key]) => key),
      ).toEqual([]);
    }
  });

  it("preserves interpolation variables across every locale", () => {
    for (const key of Object.keys(messages["zh-Hans"]) as Array<
      keyof (typeof messages)["zh-Hans"]
    >) {
      const expected = placeholders(messages["zh-Hans"][key]);
      for (const locale of locales) {
        expect(placeholders(messages[locale][key]), `${locale}:${key}`).toEqual(expected);
      }
    }
  });

  it("localizes every part of the registration legal consent in all three languages", () => {
    const legalConsentKeys = [
      "registration.legalBeforeTerms",
      "registration.legalTerms",
      "registration.legalBetween",
      "registration.legalPrivacy",
      "registration.legalAfterPrivacy",
      "registration.opensNewWindow",
    ];

    for (const locale of locales) {
      const localizedMessages = messages[locale] as Record<string, string>;
      for (const key of legalConsentKeys) {
        expect(localizedMessages[key], `${locale}:${key}`).toBeTruthy();
      }
    }
  });

  it("keeps complete, distinct Terms and Privacy documents in every locale", () => {
    const kinds: LegalKind[] = ["terms", "privacy"];
    const referenceSectionIds = Object.fromEntries(kinds.map((kind) => [
      kind,
      legalDocument("zh-Hans", kind).sections.map(({ id }) => id),
    ])) as Record<LegalKind, string[]>;

    for (const locale of locales) {
      for (const kind of kinds) {
        const document = legalDocument(locale, kind);
        expect(document.title.length).toBeGreaterThan(3);
        expect(document.metaDescription.length).toBeGreaterThan(40);
        expect(document.introduction.length).toBeGreaterThan(60);
        expect(document.sections.map(({ id }) => id)).toEqual(referenceSectionIds[kind]);
        expect(document.sections.length).toBeGreaterThanOrEqual(8);
        expect(document.sections.every(({ title, paragraphs }) => (
          title.trim().length > 0 && paragraphs.every((paragraph) => paragraph.trim().length > 0)
        ))).toBe(true);
      }

      const terms = legalDocument(locale, "terms");
      const privacy = legalDocument(locale, "privacy");
      expect(terms.title).not.toBe(privacy.title);
      expect(terms.sections.map(({ title }) => title)).not.toEqual(
        privacy.sections.map(({ title }) => title),
      );
    }
  });
});
