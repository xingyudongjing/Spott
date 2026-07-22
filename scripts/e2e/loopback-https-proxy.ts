import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { request as requestHTTP } from "node:http";
import { createHash, X509Certificate } from "node:crypto";
import {
  createServer as createHTTPSServer,
  type Server as HTTPSServer,
} from "node:https";

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const untrustedForwardingHeaders = new Set([
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

export interface LoopbackCertificatePaths {
  readonly keyPath: string;
  readonly certificatePath: string;
}

export interface LoopbackHTTPSProxyOptions {
  readonly port: number;
  readonly upstreamPort: number;
  readonly key: string | Buffer;
  readonly certificate: string | Buffer;
}

export interface LoopbackHTTPSProxy {
  readonly port: number;
  close(): Promise<void>;
}

export function createLoopbackCertificateArguments(
  paths: LoopbackCertificatePaths,
): string[] {
  return [
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
    "-addext",
    "basicConstraints=critical,CA:FALSE",
    "-keyout",
    paths.keyPath,
    "-out",
    paths.certificatePath,
  ];
}

export function createLoopbackCertificateSPKI(certificate: string | Buffer): string {
  const publicKey = new X509Certificate(certificate).publicKey.export({
    type: "spki",
    format: "der",
  });
  return createHash("sha256").update(publicKey).digest("base64");
}

export function createLoopbackTLSLaunchArguments(
  baseURL: string,
  fingerprint: string | undefined,
): string[] {
  if (fingerprint === undefined) return [];
  let parsed: URL;
  try {
    parsed = new URL(baseURL);
  } catch {
    throw new Error("LOOPBACK_TLS_BASE_URL_REQUIRED");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.origin !== baseURL
    || parsed.username !== ""
    || parsed.password !== ""
  ) {
    throw new Error("LOOPBACK_TLS_BASE_URL_REQUIRED");
  }
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(fingerprint)) {
    throw new Error("LOOPBACK_TLS_SPKI_INVALID");
  }
  const decoded = Buffer.from(fingerprint, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== fingerprint) {
    throw new Error("LOOPBACK_TLS_SPKI_INVALID");
  }
  return [`--ignore-certificate-errors-spki-list=${fingerprint}`];
}

export async function startLoopbackHTTPSProxy(
  options: LoopbackHTTPSProxyOptions,
): Promise<LoopbackHTTPSProxy> {
  assertPort(options.port, true);
  assertPort(options.upstreamPort, false);

  let publicPort = options.port;

  const server = createHTTPSServer(
    { key: options.key, cert: options.certificate },
    (incoming, outgoing) => {
      const publicHost = `127.0.0.1:${publicPort}`;
      if (incoming.headers.host !== publicHost) {
        outgoing.writeHead(421, { "content-type": "text/plain; charset=utf-8" });
        outgoing.end("Misdirected Request");
        return;
      }
      const headers = controlledForwardingHeaders(
        incoming.headers,
        publicHost,
        options.upstreamPort,
      );
      const upstream = requestHTTP({
        hostname: "127.0.0.1",
        port: options.upstreamPort,
        method: incoming.method,
        path: incoming.url,
        headers,
      }, (response) => {
        const responseHeaders = stripHopByHopHeaders(response.headers);
        if (response.statusMessage) {
          outgoing.writeHead(response.statusCode ?? 502, response.statusMessage, responseHeaders);
        } else {
          outgoing.writeHead(response.statusCode ?? 502, responseHeaders);
        }
        response.pipe(outgoing);
      });
      upstream.once("error", () => {
        if (!outgoing.headersSent) {
          outgoing.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        }
        outgoing.end("Bad Gateway");
      });
      incoming.once("aborted", () => upstream.destroy());
      incoming.pipe(upstream);
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("LOOPBACK_HTTPS_PROXY_ADDRESS_INVALID");
  }
  publicPort = address.port;
  return {
    port: address.port,
    close: () => closeServer(server),
  };
}

function controlledForwardingHeaders(
  headers: IncomingHttpHeaders,
  publicHost: string,
  upstreamPort: number,
): OutgoingHttpHeaders {
  const controlled = stripHopByHopHeaders(headers);
  for (const name of untrustedForwardingHeaders) delete controlled[name];
  controlled.host = `127.0.0.1:${upstreamPort}`;
  controlled["x-forwarded-proto"] = "https";
  controlled["x-forwarded-for"] = "127.0.0.1";
  controlled["x-forwarded-host"] = publicHost;
  controlled["x-forwarded-port"] = publicHost.slice(publicHost.lastIndexOf(":") + 1);
  return controlled;
}

function stripHopByHopHeaders(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const sanitized: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || hopByHopHeaders.has(name.toLowerCase())) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

function assertPort(port: number, allowZero: boolean): void {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(port) || port < minimum || port > 65_535) {
    throw new Error("LOOPBACK_HTTPS_PROXY_PORT_INVALID");
  }
}

function closeServer(server: HTTPSServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
