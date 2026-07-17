import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { probeHTTPStatus } from "../../scripts/e2e/http-readiness.js";

void test("readiness resolves from response headers without waiting for a streaming body", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.write("<!doctype html><title>ready</title>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert(address && typeof address === "object");
  const startedAt = Date.now();
  const result = await probeHTTPStatus(`http://127.0.0.1:${address.port}/stream`, 1_000);

  assert.equal(result.status, 200);
  assert.equal(result.error, undefined);
  assert(Date.now() - startedAt < 500, "probe waited for the unclosed response body");
});

void test("readiness exposes a non-success HTTP status", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert(address && typeof address === "object");
  const result = await probeHTTPStatus(`http://127.0.0.1:${address.port}/health`, 1_000);

  assert.equal(result.status, 503);
  assert.equal(result.error, undefined);
});
