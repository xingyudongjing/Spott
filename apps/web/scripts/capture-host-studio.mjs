import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";

import {
  captureAppRoot,
  captureViteConfig,
} from "../tests/marketing-host-capture/vite.config.mjs";

const appRoot = captureAppRoot;
const outputRoot = path.join(appRoot, "public", "marketing", "product");
const captures = [
  { browserLocale: "zh-CN", locale: "zh-Hans", output: "web-host-zh-Hans-desktop.png" },
  { browserLocale: "ja-JP", locale: "ja", output: "web-host-ja-desktop.png" },
  { browserLocale: "en-US", locale: "en", output: "web-host-en-desktop.png" },
];

await mkdir(outputRoot, { recursive: true });

const server = await createServer({
  ...captureViteConfig,
  server: { host: "127.0.0.1", port: 0, strictPort: false },
});

let browser;
try {
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Capture server did not expose a TCP port.");
  const origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ channel: "chrome", headless: true });

  for (const capture of captures) {
    const context = await browser.newContext({
      colorScheme: "light",
      deviceScaleFactor: 1,
      locale: capture.browserLocale,
      reducedMotion: "reduce",
      timezoneId: "Asia/Tokyo",
      viewport: { height: 900, width: 1440 },
    });
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

    await page.goto(
      `${origin}/tests/marketing-host-capture/index.html?locale=${encodeURIComponent(capture.locale)}`,
      { waitUntil: "networkidle" },
    );
    await page.locator('[data-host-studio-capture-ready="true"]').waitFor();
    await page.getByRole("heading", { level: 1 }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForFunction(() => window.scrollX === 0 && window.scrollY === 0);
    if (browserErrors.length) throw new Error(`${capture.locale} capture errors:\n${browserErrors.join("\n")}`);

    const renderState = await page.evaluate(() => {
      const wordmark = document.querySelector(".studio-nav .wordmark")?.getBoundingClientRect();
      const heading = document.querySelector("h1")?.getBoundingClientRect();
      return {
        heading: heading ? { bottom: heading.bottom, left: heading.left, top: heading.top } : null,
        height: document.documentElement.clientHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        width: document.documentElement.clientWidth,
        wordmark: wordmark ? { bottom: wordmark.bottom, left: wordmark.left, top: wordmark.top } : null,
      };
    });
    const dimensions = {
      height: renderState.height,
      width: renderState.width,
    };
    if (dimensions.width !== 1440 || dimensions.height !== 900) {
      throw new Error(`${capture.locale} rendered ${dimensions.width}x${dimensions.height}; expected 1440x900.`);
    }
    if (renderState.scrollX !== 0 || renderState.scrollY !== 0) {
      throw new Error(`${capture.locale} capture was not at the page origin (${renderState.scrollX}, ${renderState.scrollY}).`);
    }
    for (const [name, bounds] of [["wordmark", renderState.wordmark], ["heading", renderState.heading]]) {
      if (!bounds || bounds.top < 0 || bounds.left < 0 || bounds.bottom > dimensions.height) {
        throw new Error(`${capture.locale} ${name} is not fully visible at the top of the capture.`);
      }
    }

    const outputPath = path.join(outputRoot, capture.output);
    await page.screenshot({
      animations: "disabled",
      clip: { height: 900, width: 1440, x: 0, y: 0 },
      path: outputPath,
    });
    process.stdout.write(
      `${capture.locale}\tscroll=${renderState.scrollX},${renderState.scrollY}` +
      `\twordmarkTop=${renderState.wordmark.top.toFixed(2)}` +
      `\theadingTop=${renderState.heading.top.toFixed(2)}\t${outputPath}\n`,
    );
    await context.close();
  }
} finally {
  await browser?.close();
  await server.close();
}
