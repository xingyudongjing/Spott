import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";

import { ProductStage } from "../app/components/marketing/ProductStage";
import { marketingCopy } from "../app/components/marketing/marketing-copy";
import type { Locale } from "../app/i18n/messages";

const locales = ["zh-Hans", "ja", "en"] as const satisfies readonly Locale[];
const marketingStyles = readFileSync(
  resolve(process.cwd(), "app/components/marketing/marketing-home.module.css"),
  "utf8",
);

afterEach(cleanup);

function assetImage(container: HTMLElement, slot: string): HTMLImageElement {
  const image = container.querySelector<HTMLImageElement>(
    `[data-product-asset-slot="${slot}"] img`,
  );
  if (!image) throw new Error(`Missing real product image for ${slot}`);
  return image;
}

function mobilePngSource(container: HTMLElement, slot: string): HTMLSourceElement {
  const source = container.querySelector<HTMLSourceElement>(
    `[data-product-asset-slot="${slot}"] source[media]:not([type])`,
  );
  if (!source) throw new Error(`Missing mobile PNG product source for ${slot}`);
  return source;
}

function ruleBodies(selector: string): readonly string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...marketingStyles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "g"))]
    .map((match) => match[1]);
}

describe("marketing product evidence", () => {
  test.each(["hero", "detail", "community", "host", "cross"] as const)(
    "offers AVIF and WebP sources for every %s product image while keeping PNG fallback",
    (variant) => {
      const copy = marketingCopy("en");
      const { container } = render(
        <ProductStage
          labels={[copy.assets.crossWeb, copy.assets.crossApp]}
          locale="en"
          variant={variant}
        />,
      );

      for (const picture of container.querySelectorAll("picture")) {
        expect(picture.querySelector('source[type="image/avif"]')?.getAttribute("srcset"))
          .toContain(".avif");
        expect(picture.querySelector('source[type="image/webp"]')?.getAttribute("srcset"))
          .toContain(".webp");
        expect(picture.querySelector("img")?.getAttribute("src")).toContain(".png");
      }
    },
  );

  test.each(locales)("uses the matching %s iOS community capture without a shared-language fallback", (locale) => {
    const copy = marketingCopy(locale);
    const { container } = render(
      <ProductStage labels={[copy.assets.community]} locale={locale} variant="community" />,
    );

    expect(assetImage(container, "community").getAttribute("src")).toContain(
      `/marketing/product/ios-community-${locale}-light.png`,
    );
  });

  test.each(locales)("uses matching %s discovery captures in the hero", (locale) => {
    const copy = marketingCopy(locale);
    const { container } = render(
      <ProductStage labels={[copy.assets.hero]} locale={locale} variant="hero" />,
    );

    expect(assetImage(container, "hero-discovery-web").getAttribute("src")).toContain(
      `/marketing/product/web-discover-${locale}-desktop.png`,
    );
    expect(assetImage(container, "hero-discovery-mobile").getAttribute("src")).toContain(
      `/marketing/product/web-discover-${locale}-mobile.png`,
    );
  });

  test.each(locales)("uses matching %s event-detail captures on desktop and mobile", (locale) => {
    const copy = marketingCopy(locale);
    const { container } = render(
      <ProductStage labels={[copy.assets.detail]} locale={locale} variant="detail" />,
    );

    expect(assetImage(container, "before-you-go-detail").getAttribute("src")).toContain(
      `/marketing/product/web-event-detail-${locale}-desktop.png`,
    );
    expect(mobilePngSource(container, "before-you-go-detail").getAttribute("srcset")).toContain(
      `/marketing/product/web-event-detail-${locale}-mobile.png`,
    );
  });

  test.each(locales)("uses the matching %s community capture on the cross-surface proof", (locale) => {
    const copy = marketingCopy(locale);
    const { container } = render(
      <ProductStage
        labels={[copy.assets.crossWeb, copy.assets.crossApp]}
        locale={locale}
        variant="cross"
      />,
    );

    expect(assetImage(container, "cross-app").getAttribute("src")).toContain(
      `/marketing/product/ios-community-${locale}-light.png`,
    );
    expect(assetImage(container, "cross-web").getAttribute("src")).toContain(
      `/marketing/product/web-groups-${locale}-desktop.png`,
    );
    expect(mobilePngSource(container, "cross-web").getAttribute("srcset")).toContain(
      `/marketing/product/web-groups-${locale}-mobile.png`,
    );
  });

  test("keeps cross-surface Web evidence complete at its desktop and mobile intrinsic geometry", () => {
    const copy = marketingCopy("en");
    const { container } = render(
      <ProductStage
        labels={[copy.assets.crossWeb, copy.assets.crossApp]}
        locale="en"
        variant="cross"
      />,
    );
    const webImage = assetImage(container, "cross-web");
    const mobileSource = mobilePngSource(container, "cross-web");
    const wideRules = ruleBodies(".pairedWideCanvas");
    const tallRules = ruleBodies(".pairedTallCanvas");

    expect(webImage).toHaveAttribute("width", "1440");
    expect(webImage).toHaveAttribute("height", "900");
    expect(mobileSource).toHaveAttribute("width", "390");
    expect(mobileSource).toHaveAttribute("height", "844");
    expect(marketingStyles).toMatch(
      /\.pairedWideCanvas\s+\.assetPicture img\s*\{[^}]*object-fit:\s*contain;/,
    );
    expect(wideRules).toEqual(expect.arrayContaining([
      expect.stringMatching(/height:\s*auto;[\s\S]*aspect-ratio:\s*16\s*\/\s*10;/),
      expect.stringMatching(/width:\s*min\(56%,\s*220px\);[\s\S]*height:\s*auto;[\s\S]*aspect-ratio:\s*390\s*\/\s*844;/),
    ]));
    expect(tallRules).toEqual(expect.arrayContaining([
      expect.stringMatching(/aspect-ratio:\s*1206\s*\/\s*2622;/),
      expect.stringMatching(/width:\s*min\(44%,\s*220px\);[\s\S]*height:\s*auto;/),
    ]));
  });

  test.each(locales)("shows a traceable %s host-studio capture instead of generated placeholder UI", (locale) => {
    const copy = marketingCopy(locale);
    const { container } = render(
      <ProductStage labels={[copy.assets.hostWeb]} locale={locale} variant="host" />,
    );

    expect(assetImage(container, "host-web").getAttribute("src")).toContain(
      `/marketing/product/web-host-${locale}-desktop.png`,
    );
    expect(container.querySelector("[data-product-asset-slot=\"host-web\"]")).not.toHaveAttribute(
      "role",
      "img",
    );
  });
});
