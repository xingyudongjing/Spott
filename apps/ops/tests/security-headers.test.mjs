import assert from "node:assert/strict";
import test from "node:test";

async function render(path = "/", origin = "https://ops.spott.jp") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`${origin}${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("the control room serves a Content-Security-Policy", async () => {
  const response = await render("/");
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy");
  assert.ok(csp, "expected a Content-Security-Policy response header");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test("the control room forbids third-party script and connect origins", async () => {
  const csp = (await render("/ops/users")).headers.get("content-security-policy");
  const directive = (name) =>
    csp.split(";").map((value) => value.trim()).find((value) => value.startsWith(`${name} `));

  const scriptSrc = directive("script-src");
  assert.ok(scriptSrc, "expected a script-src directive");
  assert.doesNotMatch(scriptSrc, /'unsafe-inline'/);
  assert.doesNotMatch(scriptSrc, /'unsafe-eval'/);
  // An admin console must never be able to pull in an ad or analytics bundle.
  assert.doesNotMatch(scriptSrc, /https:(?!\/\/)/);
  assert.doesNotMatch(scriptSrc, /\*/);

  const connectSrc = directive("connect-src");
  assert.ok(connectSrc, "expected a connect-src directive");
  assert.doesNotMatch(connectSrc, /https:(?!\/\/)/);
  assert.doesNotMatch(connectSrc, /\*/);
});

// A nonce is attacker-opaque random data; never interpolate it into a regex raw.
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

test("issues a fresh nonce per request and binds it to every inline script", async () => {
  const first = await render("/");
  const second = await render("/");
  const nonceOf = (response) =>
    /'nonce-([A-Za-z0-9+/=_-]+)'/.exec(response.headers.get("content-security-policy") ?? "")?.[1];

  const firstNonce = nonceOf(first);
  assert.ok(firstNonce, "expected a nonce in the CSP header");
  assert.notEqual(firstNonce, nonceOf(second), "nonce must be generated per request");

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
  const response = await render("/");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.ok(response.headers.get("permissions-policy"), "expected a Permissions-Policy header");
  assert.match(response.headers.get("strict-transport-security") ?? "", /max-age=\d+/);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
});

test("does not advertise HSTS over plaintext http", async () => {
  const response = await render("/", "http://localhost");
  assert.equal(response.headers.get("strict-transport-security"), null);
});
