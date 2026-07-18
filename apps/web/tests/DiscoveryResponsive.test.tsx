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
    expect(styles).toMatch(/\.mapMarker\s*\{[\s\S]*?width:\s*46px;[\s\S]*?height:\s*46px;/);
    expect(styles).toMatch(/\.filterDialog::backdrop/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.regionField\s*\{\s*display:\s*none;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.filterRail\s*>\s*label\s*\{\s*display:\s*none;/);
    expect(styles).toMatch(/\.intro h1\s*\{[\s\S]*?text-wrap:\s*balance;/);
    expect(globals).not.toMatch(/body\s*\{[\s\S]*?min-width:\s*320px/);
  });

  test("uses actual mint and amber text mixes that exceed 4.5:1 on white", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const tokens = readFileSync(resolve(process.cwd(), "../../packages/design-tokens/src/tokens.css"), "utf8");
    const colors = Object.fromEntries(
      [...tokens.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]]),
    );

    const mixes = [
      extractTextMix(styles, /\[data-tone="verified"\]\s*\{/),
      extractTextMix(styles, /\[data-tone="pending"\]\s*\{/),
      extractTextMix(styles, /\.capacity\s*\{/),
    ];
    for (const { token, percentage } of mixes) {
      const foreground = mixHex(colors[`spott-${token}`], colors["spott-ink"], percentage / 100);
      expect(contrastRatio(foreground, colors["spott-surface"])).toBeGreaterThanOrEqual(4.5);
    }
  });
});

function extractTextMix(styles: string, selector: RegExp) {
  const start = styles.search(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = styles.slice(start, styles.indexOf("}", start) + 1);
  const match = block.match(/color:\s*color-mix\(in srgb, var\(--spott-(mint|amber)\)\s+(\d+)%,\s*var\(--spott-ink\)\)/);
  expect(match).not.toBeNull();
  return { token: match?.[1] ?? "mint", percentage: Number(match?.[2] ?? 100) };
}

function mixHex(first: string, second: string, firstWeight: number) {
  const channels = (hex: string) => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const a = channels(first);
  const b = channels(second);
  return `#${a.map((value, index) => Math.round(value * firstWeight + b[index] * (1 - firstWeight))
    .toString(16).padStart(2, "0")).join("")}`;
}

function contrastRatio(first: string, second: string) {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5]
      .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}
