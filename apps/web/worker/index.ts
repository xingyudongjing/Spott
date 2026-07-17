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
 * `'unsafe-inline'`: only the scripts this render emitted are allowed to run,
 * so an injected `<script>` is inert even if it reaches the document.
 */
function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  // base64url: keeps the nonce free of "+" and "/", which are awkward in both
  // HTML attributes and the CSP grammar.
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/**
 * vinext resolves the script nonce from the incoming request's
 * `Content-Security-Policy` header (see vinext/server/csp), so the policy has
 * to be attached to the request *before* rendering, and to the response on the
 * way back out. Both carry the identical policy string.
 */
function withRequestNonce(request: Request, policy: string): Request {
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  return new Request(request, { headers });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const policy = contentSecurityPolicy(url, createNonce());

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withProductionSecurityHeaders(request, response, policy);
    }

    const rendered = await handler.fetch(withRequestNonce(request, policy), env, ctx);
    return withProductionSecurityHeaders(request, rendered, policy);
  },
};

function contentSecurityPolicy(url: URL, nonce: string): string {
  const localDevelopment = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    // No 'unsafe-inline'/'unsafe-eval': vinext stamps this nonce onto every
    // inline bootstrap script it emits. 'strict-dynamic' is deliberately NOT
    // used — it would make browsers ignore 'self' and drop the modulepreload
    // links the app shell depends on.
    `script-src 'self' 'nonce-${nonce}'`,
    // The only inline <style> is vinext's font block, which also receives the
    // nonce. Stylesheets are ordinary same-origin files.
    `style-src 'self' 'nonce-${nonce}'`,
    // React renders a handful of `style={{ width }}` progress bars into markup.
    // Style *attributes* cannot carry a nonce, so they are allowed explicitly
    // here rather than by weakening style-src as a whole.
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' https: wss:${localDevelopment ? " http: ws:" : ""}`,
    "media-src 'self' blob: https:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join("; ");
}

function withProductionSecurityHeaders(request: Request, response: Response, policy: string): Response {
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  headers.set("Content-Security-Policy", policy);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), payment=(), usb=(), clipboard-write=(self)",
  );
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

export default worker;
