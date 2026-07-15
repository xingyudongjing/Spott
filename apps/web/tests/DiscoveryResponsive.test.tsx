import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const stylesPath = resolve(process.cwd(), "app/components/discovery/DiscoveryShell.module.css");
const globalsPath = resolve(process.cwd(), "app/globals.css");

describe("responsive discovery safeguards", () => {
  test("locks touch size, mobile rail, safe area, contrast, and reduced motion", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const globals = readFileSync(globalsPath, "utf8");

    expect(styles).toMatch(/min-height:\s*44px/);
    expect(styles).toMatch(/overflow-x:\s*auto/);
    expect(styles).toContain("env(safe-area-inset-bottom)");
    expect(styles).toContain("prefers-contrast: more");
    expect(styles).toContain("prefers-reduced-motion: reduce");
    expect(styles).toContain("content-visibility: auto");
    expect(globals).not.toMatch(/body\s*\{[\s\S]*?min-width:\s*320px/);
  });
});
