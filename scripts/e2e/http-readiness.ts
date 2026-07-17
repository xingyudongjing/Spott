import { get } from "node:http";

export interface HTTPProbeResult {
  status?: number;
  error?: string;
}

/**
 * Resolve as soon as the server publishes response headers. SSR responses may
 * stream their body, so a readiness probe must not wait for that stream to end.
 */
export function probeHTTPStatus(url: string, timeout = 5_000): Promise<HTTPProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: HTTPProbeResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const request = get(url, { headers: { connection: "close" } }, (response) => {
        const status = response.statusCode;
        response.destroy();
        finish(status === undefined ? { error: "response omitted an HTTP status" } : { status });
      });
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
