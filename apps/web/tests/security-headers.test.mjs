import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/", headers = {}, origin = "https://spott.jp") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`${origin}${path}`, { headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("serves a Content-Security-Policy on rendered pages", async () => {
  const response = await render("/discover");
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.ok(csp, "expected a Content-Security-Policy response header");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test("does not weaken script-src with unsafe-inline or unsafe-eval", async () => {
  const response = await render("/discover");
  const csp = response.headers.get("content-security-policy");
  const scriptSrc = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("script-src"));
  assert.ok(scriptSrc, "expected a script-src directive");
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
  assert.doesNotMatch(scriptSrc, /'unsafe-eval'/);
});

// A nonce is attacker-opaque random data; never interpolate it into a regex raw.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

test("issues a fresh script nonce per request and binds it to the rendered scripts", async () => {
  const first = await render("/discover");
  const second = await render("/discover");

  const nonceOf = (response) =>
    /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];

  const firstNonce = nonceOf(first);
  const secondNonce = nonceOf(second);
  assert.ok(firstNonce, "expected a nonce in the CSP header");
  assert.ok(secondNonce, "expected a nonce in the CSP header");
  assert.notEqual(firstNonce, secondNonce, "nonce must be generated per request");

  // Every inline script in the document must carry the request's nonce, or the
  // page breaks under the policy we just advertised.
  const html = await first.text();
  const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>/g)].map((m) => m[1]);
  assert.ok(inlineScripts.length > 0, "expected the app shell to contain inline bootstrap scripts");
  for (const attributes of inlineScripts) {
    assert.match(
      attributes,
      new RegExp(`nonce="${escapeRegExp(firstNonce)}"`),
      `inline script missing nonce: <script${attributes}>`,
    );
  }
});

test("sets the remaining baseline security headers", async () => {
  const response = await render("/discover");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.ok(response.headers.get("permissions-policy"), "expected a Permissions-Policy header");
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
});
