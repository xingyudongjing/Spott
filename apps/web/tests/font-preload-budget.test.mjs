import assert from "node:assert/strict";
import test from "node:test";

async function render(path) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("keeps HTML preload headers inside a conservative proxy budget", async () => {
  const response = await render("/discover");
  assert.equal(response.status, 200);
  const link = response.headers.get("link") ?? "";
  const bytes = Buffer.byteLength(link);

  assert.ok(bytes < 8_192, `preload Link header is ${bytes} bytes; expected less than 8192`);
  assert.doesNotMatch(
    link,
    /_vinext_fonts\/noto-sans-(?:jp|sc)-/,
    "large CJK font families must load from CSS instead of preloading every subset",
  );
});
