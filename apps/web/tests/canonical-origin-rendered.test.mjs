import assert from "node:assert/strict";
import test from "node:test";

process.env.SPOTT_WEB_CANONICAL_ORIGIN = "https://spott.jp";

async function dispatch(path, method, origin) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`${origin}${path}`, {
      method,
      headers: {
        accept: "application/json",
        cookie: "__Host-spott_refresh=partial",
      },
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("runs canonical middleware before every built session route handler", async () => {
  const routes = [
    ["GET", "/api/session/bootstrap"],
    ["POST", "/api/session/complete"],
    ["POST", "/api/session/completion/accept"],
    ["POST", "/api/session/completion/discard"],
    ["POST", "/api/session/refresh"],
    ["POST", "/api/session/logout"],
    ["POST", "/api/session/logout-all"],
  ];

  for (const [method, path] of routes) {
    const redirected = await dispatch(path, method, "https://www.spott.jp");
    assert.equal(redirected.status, 308, `${method} ${path} must preserve its method`);
    assert.equal(redirected.headers.get("location"), `https://spott.jp${path}`);
    assert.equal(redirected.headers.get("set-cookie"), null);

    const handled = await dispatch(path, method, "https://spott.jp");
    assert.notEqual(handled.status, 308, `${method} ${path} can dispatch only on canonical origin`);
  }
});
