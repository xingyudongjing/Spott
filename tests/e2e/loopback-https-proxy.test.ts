import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLoopbackCertificateArguments,
  createLoopbackCertificateSPKI,
  createLoopbackTLSLaunchArguments,
  startLoopbackHTTPSProxy,
} from "../../scripts/e2e/loopback-https-proxy.js";

void test("owned HTTPS proxies preserve the API/Web CORS boundary and control forwarded authority", async (t) => {
  const observed: Array<{ route: string; host: string | undefined; proto: string | undefined; hostile: string | undefined }> = [];
  const api = createServer((request, response) => {
    observed.push({
      route: "api",
      host: request.headers.host,
      proto: request.headers["x-forwarded-proto"] as string | undefined,
      hostile: request.headers["x-forwarded-host"] as string | undefined,
    });
    response.setHeader("set-cookie", ["one=1; Secure", "two=2; Secure"]);
    response.end("api");
  });
  const web = createServer((request, response) => {
    observed.push({
      route: "web",
      host: request.headers.host,
      proto: request.headers["x-forwarded-proto"] as string | undefined,
      hostile: request.headers["x-forwarded-host"] as string | undefined,
    });
    response.end("web");
  });
  await Promise.all([
    new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve)),
    new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve)),
  ]);
  t.after(() => Promise.all([
    new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve())),
    new Promise<void>((resolve, reject) => web.close((error) => error ? reject(error) : resolve())),
  ]).then(() => undefined));
  const apiAddress = api.address();
  const webAddress = web.address();
  assert(apiAddress && typeof apiAddress === "object");
  assert(webAddress && typeof webAddress === "object");

  const directory = mkdtempSync(join(tmpdir(), "spott-proxy-tls-"));
  const keyPath = join(directory, "loopback.key.pem");
  const certificatePath = join(directory, "loopback.cert.pem");
  const generated = spawnSync(
    "openssl",
    createLoopbackCertificateArguments({ keyPath, certificatePath }),
    { encoding: "utf8" },
  );
  assert.equal(generated.status, 0, generated.stderr);
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const certificate = readFileSync(certificatePath);
  const fingerprint = createLoopbackCertificateSPKI(certificate);
  assert.match(fingerprint, /^[A-Za-z0-9+/]{43}=$/u);
  assert.deepEqual(
    createLoopbackTLSLaunchArguments(`https://127.0.0.1:44321`, fingerprint),
    [`--ignore-certificate-errors-spki-list=${fingerprint}`],
  );
  assert.throws(
    () => createLoopbackTLSLaunchArguments("https://example.com", fingerprint),
    /LOOPBACK_TLS_BASE_URL_REQUIRED/u,
  );
  assert.throws(
    () => createLoopbackTLSLaunchArguments("https://127.0.0.1:44321", "not-a-fingerprint"),
    /LOOPBACK_TLS_SPKI_INVALID/u,
  );

  const apiProxy = await startLoopbackHTTPSProxy({
    port: 0,
    upstreamPort: apiAddress.port,
    key: readFileSync(keyPath),
    certificate,
  });
  const webProxy = await startLoopbackHTTPSProxy({
    port: 0,
    upstreamPort: webAddress.port,
    key: readFileSync(keyPath),
    certificate,
  });
  t.after(() => Promise.all([apiProxy.close(), webProxy.close()]).then(() => undefined));

  const apiResult = await request(apiProxy.port, "/v1/health");
  const webResult = await request(webProxy.port, "/discover");
  assert.equal(apiResult.body, "api");
  assert.deepEqual(apiResult.cookies, ["one=1; Secure", "two=2; Secure"]);
  assert.equal(webResult.body, "web");
  assert.deepEqual(observed, [
    {
      route: "api",
      host: `127.0.0.1:${apiAddress.port}`,
      proto: "https",
      hostile: `127.0.0.1:${apiProxy.port}`,
    },
    {
      route: "web",
      host: `127.0.0.1:${webAddress.port}`,
      proto: "https",
      hostile: `127.0.0.1:${webProxy.port}`,
    },
  ]);

  const rejected = await request(webProxy.port, "/discover", "evil.example");
  assert.equal(rejected.status, 421);
  assert.equal(rejected.body, "Misdirected Request");
});

function request(
  port: number,
  path: string,
  host = `127.0.0.1:${port}`,
): Promise<{ status: number; body: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const call = get({
      hostname: "127.0.0.1",
      port,
      path,
      rejectUnauthorized: false,
      headers: {
        host,
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString("utf8"),
        cookies: response.headers["set-cookie"] ?? [],
      }));
    });
    call.once("error", reject);
  });
}
