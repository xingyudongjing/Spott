import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHTTPSServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const result = await probeHTTPStatus(`http://127.0.0.1:${address.port}/stream`, {
    timeout: 1_000,
  });

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
  const result = await probeHTTPStatus(`http://127.0.0.1:${address.port}/health`, {
    timeout: 1_000,
  });

  assert.equal(result.status, 503);
  assert.equal(result.error, undefined);
});

void test("readiness accepts an explicitly scoped self-signed loopback certificate", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "spott-readiness-tls-"));
  const keyPath = join(directory, "loopback.key.pem");
  const certificatePath = join(directory, "loopback.cert.pem");
  const generated = spawnSync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
  ], { encoding: "utf8" });
  assert.equal(generated.status, 0, generated.stderr);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const server = createHTTPSServer(
    { key: readFileSync(keyPath), cert: readFileSync(certificatePath) },
    (_request, response) => {
      response.writeHead(204);
      response.end();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert(address && typeof address === "object");
  const url = `https://127.0.0.1:${address.port}/health`;

  const rejected = await probeHTTPStatus(url, { timeout: 1_000 });
  assert.equal(rejected.status, undefined);
  assert.match(rejected.error ?? "", /certificate|self-signed/u);

  const certificate = readFileSync(certificatePath);
  const accepted = await probeHTTPStatus(url, {
    timeout: 1_000,
    trustedLoopbackCertificate: certificate,
  });
  assert.equal(accepted.status, 204);
  assert.equal(accepted.error, undefined);
});

void test("readiness never disables certificate verification for a non-loopback host", async () => {
  const result = await probeHTTPStatus("https://example.com/health", {
    timeout: 1,
    trustedLoopbackCertificate: Buffer.from("not a certificate"),
  });
  assert.equal(result.status, undefined);
  assert.equal(result.error, "custom TLS trust is restricted to loopback HTTPS URLs");
});
