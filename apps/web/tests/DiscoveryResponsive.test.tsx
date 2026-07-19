import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { DiscoveryLoading } from "../app/components/discovery/DiscoveryState";
import { renderWithI18n } from "./event-fixtures";

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
    expect(styles).toMatch(/\.mapMarker\[aria-pressed="true"\]::after\s*\{[\s\S]*?transform:\s*scale\(1\.2\);/);
    expect(styles).toMatch(/:global\(\.maplibregl-ctrl-group\)[\s\S]*?backdrop-filter:\s*blur\(16px\);/);
    expect(styles).toMatch(/:global\(\.maplibregl-ctrl-group button\)\s*\{[\s\S]*?width:\s*44px;[\s\S]*?height:\s*44px;/);
    expect(styles).toMatch(/:global\(\.maplibregl-ctrl-zoom-in\)::after\s*\{[\s\S]*?border-left:\s*2px solid currentColor;/);
    expect(styles).toMatch(/:global\(\.maplibregl-ctrl-zoom-out\)::before\s*\{[\s\S]*?border-top:\s*2px solid currentColor;/);
    expect(styles).not.toMatch(/:global\(\.maplibregl-ctrl-zoom-(?:in|out)\)::before\s*\{[\s\S]*?linear-gradient/);
    expect(styles).toMatch(/\.filterDialog::backdrop/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.regionField\s*\{\s*display:\s*none;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.filterRail\s*>\s*label\s*\{\s*display:\s*none;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.filterRail\s*\{[\s\S]*?gap:\s*5px;[\s\S]*?overflow-x:\s*auto;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.filterRail\s*>\s*button,[\s\S]*?\.moreFilters\s*>\s*button\s*\{[\s\S]*?gap:\s*5px;[\s\S]*?padding-inline:\s*5px;/);
    expect(styles).toMatch(/\.intro h1\s*\{[\s\S]*?text-wrap:\s*balance;/);
    expect(styles).toMatch(/\.eventCard\[data-featured="true"\][\s\S]*?\.eventLink\s*\{[\s\S]*?grid-template-columns:/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.eventCard\[data-featured="true"\][\s\S]*?\.coverFrame\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.mapLayout \.eventLink\s*\{\s*grid-template-columns:\s*132px minmax\(0, 1fr\);/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.mapLayout \.eventFacts span:nth-child\(n\+2\)\s*\{\s*display:\s*inline-flex;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.mapShell\s*\{[\s\S]*?min-height:\s*340px;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.capacity\s*\{[\s\S]*?grid-column:\s*1\s*\/\s*-1;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.capacity strong\s*\{[\s\S]*?white-space:\s*normal;/);
    expect(styles).toMatch(/\.eventLink:focus-visible\s*\{/);
    expect(styles).not.toMatch(/@media \(max-width: 780px\)[\s\S]*?\.eventFacts span:nth-child\(3\)\s*\{\s*display:\s*none;/);
    expect(styles).toMatch(/\.skeletonFeatured\s*\{[\s\S]*?height:\s*296px;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.skeletonFeatured\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(styles).toMatch(/\.recommendationModule\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
    expect(styles).toMatch(/\.recommendationRail\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/);
    expect(styles).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.recommendationRail\s*\{[\s\S]*?grid-auto-flow:\s*column;[\s\S]*?grid-auto-columns:\s*min\(82vw, 312px\);[\s\S]*?overflow-x:\s*auto;/);
    expect(globals).toMatch(/\.group-tile-link:focus-visible\s*\{[\s\S]*?outline-offset:\s*-3px;/);
    expect(globals).toMatch(/\.group-skeleton-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);[\s\S]*?gap:\s*18px;/);
    expect(globals).toMatch(/\.group-skeleton-card\s*\{[\s\S]*?grid-template-rows:\s*auto 1fr;[\s\S]*?border-radius:\s*24px;/);
    expect(globals).toMatch(/\.group-skeleton-artwork\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*8\.4;/);
    expect(globals).toMatch(/\.group-skeleton-copy\s*\{[\s\S]*?min-height:\s*218px;/);
    expect(globals).toMatch(/@media \(max-width: 780px\)[\s\S]*?\.group-skeleton-artwork\s*\{[\s\S]*?aspect-ratio:\s*16\s*\/\s*9;/);
    expect(globals).not.toMatch(/body\s*\{[\s\S]*?min-width:\s*320px/);
  });

  test("renders one featured skeleton before compact rows to prevent first-viewport layout shift", () => {
    renderWithI18n(<DiscoveryLoading />);

    const loading = screen.getByLabelText(/加载/);
    expect(loading.children).toHaveLength(3);
    expect(loading.children[0]).toHaveAttribute("data-featured", "true");
    expect(loading.children[1]).not.toHaveAttribute("data-featured");
    expect(loading.children[2]).not.toHaveAttribute("data-featured");
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
