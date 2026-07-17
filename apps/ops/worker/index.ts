/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

/**
 * A fresh, unguessable nonce per request. This is what lets `script-src` drop
 * `'unsafe-inline'`: only the scripts this render emitted are allowed to run.
 */
function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // base64url: keeps the nonce free of "+" and "/", which are awkward in both
  // HTML attributes and the CSP grammar.
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * The single origin the console is allowed to talk to, mirroring `opsApiBase()`
 * in app/lib/ops-api.ts. Naming the host explicitly (rather than allowing the
 * whole `https:` scheme) is what stops an operator's console from ever reaching
 * a third-party endpoint.
 */
function apiOrigin(url: URL): string {
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return "http://127.0.0.1:4100";
  return "https://api.spott.jp";
}

/**
 * The control room is the most privileged surface in Spott, so this policy is
 * the strictest of the three: no third-party scripts, no third-party
 * connections, no framing, no plugins. Ads and analytics bundles are
 * unreachable by construction.
 */
function contentSecurityPolicy(url: URL, nonce: string): string {
  const localDevelopment = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // Admin console: same-origin bundles plus this render's nonce. Nothing else.
    `script-src 'self' 'nonce-${nonce}'`,
    `style-src 'self' 'nonce-${nonce}'`,
    // Style attributes cannot carry a nonce; allowed narrowly rather than by
    // weakening style-src as a whole.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin(url)}${localDevelopment ? " ws://127.0.0.1:* ws://localhost:*" : ""}`,
    "media-src 'none'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

function withRequestNonce(request: Request, policy: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  return new Request(request, { headers });
}

function withSecurityHeaders(request: Request, response: Response, policy: string): Response {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  );
  // The control room must never surface in a search index.
  headers.set("X-Robots-Tag", "noindex, nofollow");
  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  } else {
    headers.delete("Strict-Transport-Security");
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const policy = contentSecurityPolicy(url, createNonce());

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const optimized = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(request, optimized, policy);
    }

    const rendered = await handler.fetch(withRequestNonce(request, policy), env, ctx);
    return withSecurityHeaders(request, rendered, policy);
  },
};

export default worker;
