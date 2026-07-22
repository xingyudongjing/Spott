import { get as getHTTP } from "node:http";
import type { IncomingMessage } from "node:http";
import { get as getHTTPS } from "node:https";

export interface HTTPProbeResult {
  status?: number;
  error?: string;
}

export interface HTTPProbeOptions {
  timeout?: number;
  trustedLoopbackCertificate?: string | Buffer;
}

/**
 * Resolve as soon as the server publishes response headers. SSR responses may
 * stream their body, so a readiness probe must not wait for that stream to end.
 */
export function probeHTTPStatus(
  url: string,
  options: HTTPProbeOptions = {},
): Promise<HTTPProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HTTPProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const parsed = new URL(url);
      const timeout = options.timeout ?? 5_000;
      const trustedCertificate = options.trustedLoopbackCertificate;
      if (
        trustedCertificate !== undefined
        && (
          parsed.protocol !== "https:"
          || (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost" && parsed.hostname !== "::1")
        )
      ) {
        finish({ error: "custom TLS trust is restricted to loopback HTTPS URLs" });
        return;
      }
      const handleResponse = (response: IncomingMessage) => {
        const status = response.statusCode;
        response.destroy();
        finish(status === undefined ? { error: "response omitted an HTTP status" } : { status });
      };
      const request = parsed.protocol === "https:"
        ? getHTTPS(url, {
            headers: { connection: "close" },
            ...(trustedCertificate === undefined ? {} : { ca: trustedCertificate }),
          }, handleResponse)
        : getHTTP(url, { headers: { connection: "close" } }, handleResponse);
      request.setTimeout(timeout, () => {
        request.destroy(new Error(`request timed out after ${timeout}ms`));
      });
      request.once("error", (error) => finish({ error: describeError(error) }));
    } catch (error) {
      finish({ error: describeError(error) });
    }
  });
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error && error.cause instanceof Error
    ? `: ${error.cause.message}`
    : "";
  return `${error.message}${cause}`;
}
