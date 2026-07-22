import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { configuredCanonicalOrigin } from "../app/lib/canonical-origin";
import { config, proxy } from "../proxy";

const originalCanonicalOrigin = process.env.SPOTT_WEB_CANONICAL_ORIGIN;

describe("canonical Web origin boundary", () => {
  beforeEach(() => {
    process.env.SPOTT_WEB_CANONICAL_ORIGIN = "https://spott.jp";
  });

  afterEach(() => {
    if (originalCanonicalOrigin === undefined) delete process.env.SPOTT_WEB_CANONICAL_ORIGIN;
    else process.env.SPOTT_WEB_CANONICAL_ORIGIN = originalCanonicalOrigin;
  });

  test("matches every present and future session route", () => {
    expect(config.matcher).toContain("/api/session/:path*");
  });

  test.each([
    ["GET", "/api/session/bootstrap?returnTo=%2Fme"],
    ["POST", "/api/session/complete?phase=commit"],
    ["POST", "/api/session/refresh"],
    ["POST", "/api/session/logout"],
    ["POST", "/api/session/logout-all"],
  ])("redirects noncanonical %s %s before session handling", (method, path) => {
    const response = proxy(new NextRequest(`https://www.spott.jp${path}`, {
      method,
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "http",
      },
    }));

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe(`https://spott.jp${path}`);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  });

  test("ignores forwarded authority on a canonical request", () => {
    const response = proxy(new NextRequest("https://spott.jp/api/session/bootstrap", {
      headers: {
        host: "attacker.example",
        "x-forwarded-host": "www.spott.jp",
        "x-forwarded-proto": "http",
      },
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  test.each([
    ["missing", undefined],
    ["trailing slash", "https://spott.jp/"],
    ["path", "https://spott.jp/login"],
    ["query", "https://spott.jp?from=www"],
    ["userinfo", "https://user@spott.jp"],
  ])("fails closed for %s canonical configuration", (_label, value) => {
    if (value === undefined) delete process.env.SPOTT_WEB_CANONICAL_ORIGIN;
    else process.env.SPOTT_WEB_CANONICAL_ORIGIN = value;

    expect(() => configuredCanonicalOrigin(process.env)).toThrow(/SPOTT_WEB_CANONICAL_ORIGIN/u);
  });

  test("rejects HTTP canonical origin in production", () => {
    process.env.SPOTT_WEB_CANONICAL_ORIGIN = "http://spott.jp";
    const environment = {
      ...process.env,
      NODE_ENV: "production",
    };

    expect(() => configuredCanonicalOrigin(environment)).toThrow(/HTTPS/u);
  });
});
