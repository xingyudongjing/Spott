import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("responsive site chrome", () => {
  test("keeps compact header and footer controls at least 44 by 44 points", () => {
    const header = readFileSync(resolve(process.cwd(), "app/components/SiteHeader.module.css"), "utf8");
    const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");

    expect(header).toMatch(/\.region\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
    expect(globals).toMatch(/\.footer-links a\s*\{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px;/);
    expect(globals).toMatch(/\.footer-meta\s+\.language-switcher select\s*\{[\s\S]*?min-height:\s*44px;/);
  });

  test("keeps the mobile preview notice compact and uses a universal language icon", () => {
    const header = readFileSync(resolve(process.cwd(), "app/components/SiteHeader.module.css"), "utf8");
    const globals = readFileSync(resolve(process.cwd(), "app/globals.css"), "utf8");
    const i18n = readFileSync(resolve(process.cwd(), "app/components/I18nProvider.tsx"), "utf8");

    expect(header).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.previewBanner\s*\{[\s\S]*?flex-direction:\s*column;/);
    expect(i18n).toContain("compact-language-icon");
    expect(globals).not.toContain('content: "文"');
  });
});
