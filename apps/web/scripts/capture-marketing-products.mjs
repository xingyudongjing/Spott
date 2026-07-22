import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

import {
  productCaptureAppRoot,
  productCaptureViteConfig,
} from "../tests/marketing-product-capture/vite.config.mjs";

const outputRoot = path.join(productCaptureAppRoot, "public", "marketing", "product");
const locales = [
  { browserLocale: "zh-CN", locale: "zh-Hans" },
  { browserLocale: "ja-JP", locale: "ja" },
  { browserLocale: "en-US", locale: "en" },
];
const surfaces = ["discover", "event-detail", "groups"];
const viewports = [
  { height: 900, label: "desktop", width: 1440 },
  { height: 844, label: "mobile", width: 390 },
];

await mkdir(outputRoot, { recursive: true });

const server = await createServer({
  ...productCaptureViteConfig,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Capture server did not expose a TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    args: [
      "--disable-font-subpixel-positioning",
      "--disable-gpu",
      "--disable-lcd-text",
      "--disable-skia-runtime-opts",
      "--disable-threaded-animation",
      "--disable-threaded-scrolling",
      "--deterministic-mode",
      "--font-render-hinting=none",
      "--force-color-profile=srgb",
      "--run-all-compositor-stages-before-draw",
    ],
    channel: "chrome",
    headless: true,
  });

  for (const surface of surfaces) {
    for (const localeConfig of locales) {
      for (const viewport of viewports) {
        const context = await browser.newContext({
          colorScheme: "light",
          deviceScaleFactor: 1,
          locale: localeConfig.browserLocale,
          reducedMotion: "reduce",
          timezoneId: "Asia/Tokyo",
          viewport: { height: viewport.height, width: viewport.width },
        });
        try {
          await context.addInitScript(({ frozenTime }) => {
            const NativeDate = Date;
            class FrozenDate extends NativeDate {
              constructor(...args) {
                super(...(args.length ? args : [frozenTime]));
              }
              static now() { return new NativeDate(frozenTime).getTime(); }
            }
            Object.setPrototypeOf(FrozenDate, NativeDate);
            globalThis.Date = FrozenDate;
          }, { frozenTime: "2026-07-22T12:00:00.000Z" });

          const page = await context.newPage();
          const browserErrors = [];
          page.on("console", (message) => {
            if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
          });
          page.on("pageerror", (error) => browserErrors.push(`page: ${error.message}`));
          page.on("requestfailed", (request) => {
            browserErrors.push(`request: ${request.method()} ${request.url()} ${request.failure()?.errorText ?? "failed"}`);
          });

          await page.goto(
            `${origin}/tests/marketing-product-capture/index.html?surface=${surface}&locale=${encodeURIComponent(localeConfig.locale)}`,
            { waitUntil: "networkidle" },
          );
          await page.addStyleTag({
            content: `
              *, *::before, *::after {
                animation: none !important;
                caret-color: transparent !important;
                transition: none !important;
              }
            `,
          });
          await page.locator('[data-marketing-product-capture-ready="true"]').waitFor();
          await page.getByRole("heading", { level: 1 }).waitFor();
          await page.evaluate(() => new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          }));
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.waitForFunction(() => window.scrollX === 0 && window.scrollY === 0);
          if (browserErrors.length) {
            throw new Error(`${surface}/${localeConfig.locale}/${viewport.label} browser errors:\n${browserErrors.join("\n")}`);
          }

          const renderState = await page.evaluate(() => {
            const root = document.querySelector("[data-marketing-product-capture-ready]");
            const heading = document.querySelector("h1")?.getBoundingClientRect();
            const brand = document.querySelector('[aria-label="Spott"]')?.getBoundingClientRect();
            const forbidden = JSON.parse(root?.getAttribute("data-forbidden-fixture-text") ?? "[]");
            const bodyText = document.body.innerText;
            return {
              brand: brand ? { bottom: brand.bottom, left: brand.left, right: brand.right, top: brand.top } : null,
              forbiddenMatches: forbidden.filter((value) => bodyText.includes(value)),
              heading: heading ? { bottom: heading.bottom, left: heading.left, right: heading.right, top: heading.top } : null,
              headingText: document.querySelector("h1")?.textContent?.trim() ?? "",
              expectedHeading: root?.getAttribute("data-expected-heading") ?? "",
              height: window.innerHeight,
              scrollHeight: document.documentElement.scrollHeight,
              scrollWidth: document.documentElement.scrollWidth,
              scrollX: window.scrollX,
              scrollY: window.scrollY,
              width: window.innerWidth,
            };
          });

          assertRenderState({
            locale: localeConfig.locale,
            renderState,
            surface,
            viewport,
          });

          const output = `web-${surface}-${localeConfig.locale}-${viewport.label}.png`;
          const outputPath = path.join(outputRoot, output);
          await page.screenshot({
            animations: "disabled",
            clip: { height: viewport.height, width: viewport.width, x: 0, y: 0 },
            path: outputPath,
          });
          process.stdout.write(
            `${surface}\t${localeConfig.locale}\t${viewport.label}` +
            `\tscroll=${renderState.scrollX},${renderState.scrollY}` +
            `\tbrandTop=${renderState.brand.top.toFixed(2)}` +
            `\theadingTop=${renderState.heading.top.toFixed(2)}` +
            `\tdocument=${renderState.scrollWidth}x${renderState.scrollHeight}` +
            `\t${outputPath}\n`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
} finally {
  await browser?.close();
  await server.close();
}

function assertRenderState({ locale, renderState, surface, viewport }) {
  const label = `${surface}/${locale}/${viewport.label}`;
  if (renderState.width !== viewport.width || renderState.height !== viewport.height) {
    throw new Error(`${label} rendered ${renderState.width}x${renderState.height}; expected ${viewport.width}x${viewport.height}.`);
  }
  if (renderState.scrollX !== 0 || renderState.scrollY !== 0) {
    throw new Error(`${label} was not at the page origin (${renderState.scrollX}, ${renderState.scrollY}).`);
  }
  if (renderState.scrollWidth > viewport.width) {
    throw new Error(`${label} has horizontal overflow: ${renderState.scrollWidth}px in a ${viewport.width}px viewport.`);
  }
  if (renderState.headingText !== renderState.expectedHeading) {
    throw new Error(`${label} rendered H1 "${renderState.headingText}"; expected "${renderState.expectedHeading}".`);
  }
  if (renderState.forbiddenMatches.length) {
    throw new Error(`${label} contains fixture text from another locale: ${renderState.forbiddenMatches.join(" | ")}`);
  }
  for (const [name, bounds] of [["brand", renderState.brand], ["heading", renderState.heading]]) {
    if (
      !bounds
      || bounds.top < 0
      || bounds.left < 0
      || bounds.right > viewport.width
      || bounds.bottom > viewport.height
    ) {
      throw new Error(`${label} ${name} is not fully visible in the capture viewport.`);
    }
  }
}
