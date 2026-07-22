import assert from "node:assert/strict";
import test from "node:test";

process.env.SPOTT_WEB_CANONICAL_ORIGIN = "https://spott.jp";

async function render(path = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("marketing-test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`https://spott.jp${path}`, { headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("renders three fixed-language, indexable product website roots", async () => {
  const cases = [
    ["/", "zh-Hans", "Spott｜发现日本本地活动，连接持续的社群", "https://spott.jp/"],
    ["/ja", "ja", "Spott｜日本のローカルイベントと、続いていくつながり", "https://spott.jp/ja"],
    ["/en", "en", "Spott | Local events and lasting communities in Japan", "https://spott.jp/en"],
  ];

  for (const [path, locale, title, canonical] of cases) {
    const response = await render(path, {
      cookie: "spott_locale=en",
      "x-spott-route-shell": "product",
      "x-spott-route-locale": "en",
    });
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`<html[^>]+lang="${locale}"`));
    assert.match(html, /<body[^>]+data-route-shell="marketing"/);
    assert.match(html, new RegExp(`<title>${title.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}<\\/title>`));
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll("/", "\\/")}"`));
    assert.match(html, /hreflang="zh-Hans" href="https:\/\/spott\.jp\/"/i);
    assert.match(html, /hreflang="ja" href="https:\/\/spott\.jp\/ja"/i);
    assert.match(html, /hreflang="en" href="https:\/\/spott\.jp\/en"/i);
    assert.match(html, /hreflang="x-default" href="https:\/\/spott\.jp\/"/i);
    assert.equal((html.match(/<h1\b/gu) ?? []).length, 1);
    for (const id of ["discover", "before-you-go", "community", "host", "cross-surface", "safety", "download"]) {
      assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.match(html, /"@type":"Organization"/);
    assert.match(html, /"@type":"WebSite"/);
    assert.doesNotMatch(html, /apps\.apple\.com|installUrl|aggregateRating|ratingValue/);
    assert.doesNotMatch(html, /mobile-dock|spott-main-content|service-worker/);
  }
});

test("deindexes query-shaped marketing variants without losing the page", async () => {
  const response = await render("/ja?campaign=preview");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  const html = await response.text();
  assert.match(html, /<html[^>]+lang="ja"/);
  assert.match(html, /name="robots" content="noindex, nofollow"/);
  assert.match(html, /<body[^>]+data-route-shell="marketing"/);
});

test("ignores forged marketing headers on product routes", async () => {
  const response = await render("/discover", {
    "x-spott-route-shell": "marketing",
    "x-spott-route-locale": "ja",
  });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<body[^>]+data-route-shell="product"/);
  assert.match(html, /id="spott-main-content"/);
  assert.doesNotMatch(html, /marketing-hero-title/);
});
