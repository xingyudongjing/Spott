import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";

import { parseSessionServerConfig } from "../app/lib/session-server-config";
import {
  createWebBFFAuthorityHeaders,
  signWebBFFAuthority,
} from "../app/lib/web-bff-authority";

const fixedKey = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const fixedBodyHash = "b9e9bfd687bf53a9ceb4de7c56bf4b78ae43e157f03f31556f39a007b36da6ad";
const fixedNonce = "nonce-0000000000000000000000000001";
const config = parseSessionServerConfig({
  NODE_ENV: "test",
  SPOTT_WEB_BFF_KEYS: `bff-2026-07:${fixedKey}`,
  SPOTT_WEB_BFF_CURRENT_KID: "bff-2026-07",
  SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
  API_INTERNAL_URL: "http://api.internal/v1",
  WEB_SESSION_RECOVERY_SECONDS: "120",
});

describe("Web BFF authority", () => {
  test("matches the API committed fixed vector exactly", () => {
    expect(signWebBFFAuthority({
      keyring: config.bffKeys,
      version: "v1",
      kid: "bff-2026-07",
      method: "POST",
      path: "/v1/auth/refresh",
      timestamp: 1_784_246_400_000,
      nonce: fixedNonce,
      bodyHash: fixedBodyHash,
    })).toBe("9hpIJXAoFYB0tzzG6dzzVjOxLHkqbwZDOvEiPPFrjaM");
  });

  test("generates the exact authority header contract with a fresh nonce per call", () => {
    const first = createWebBFFAuthorityHeaders({
      config,
      method: "POST",
      path: "/v1/auth/refresh",
      timestamp: 1_784_246_400_000,
      bodyHash: fixedBodyHash,
    });
    const second = createWebBFFAuthorityHeaders({
      config,
      method: "POST",
      path: "/v1/auth/refresh",
      timestamp: 1_784_246_400_000,
      bodyHash: fixedBodyHash,
    });

    expect(Object.keys(first).sort()).toEqual([
      "x-spott-bff-kid",
      "x-spott-bff-nonce",
      "x-spott-bff-signature",
      "x-spott-bff-timestamp",
      "x-spott-bff-version",
    ]);
    expect(first["x-spott-bff-version"]).toBe("v1");
    expect(first["x-spott-bff-kid"]).toBe("bff-2026-07");
    expect(first["x-spott-bff-nonce"]).not.toBe(second["x-spott-bff-nonce"]);
    expect(first["x-spott-bff-nonce"]).toMatch(/^[A-Za-z0-9_-]{32,128}$/u);
  });

  test("hashes a byte body as lowercase SHA-256", () => {
    const body = new TextEncoder().encode('{"hello":"world"}');
    const expected = createHash("sha256").update(body).digest("hex");
    const headers = createWebBFFAuthorityHeaders({
      config,
      method: "POST",
      path: "/v1/auth/refresh",
      timestamp: 1_784_246_400_000,
      body,
    });
    expect(headers["x-spott-bff-signature"]).toHaveLength(43);
    expect(expected).toMatch(/^[0-9a-f]{64}$/u);
  });

  test.each([
    ["lowercase method", { method: "post" }],
    ["absolute URL", { path: "https://api.example/v1/auth/refresh" }],
    ["query", { path: "/v1/auth/refresh?x=1" }],
    ["fragment", { path: "/v1/auth/refresh#x" }],
    ["noncanonical path", { path: "/v1/auth/../auth/refresh" }],
    ["unsafe timestamp", { timestamp: Number.MAX_SAFE_INTEGER + 1 }],
    ["uppercase body hash", { bodyHash: fixedBodyHash.toUpperCase() }],
    ["unknown KID", { kid: "missing" }],
  ])("rejects %s", (_label, mutation) => {
    expect(() => signWebBFFAuthority({
      keyring: config.bffKeys,
      version: "v1",
      kid: "bff-2026-07",
      method: "POST",
      path: "/v1/auth/refresh",
      timestamp: 1_784_246_400_000,
      nonce: fixedNonce,
      bodyHash: fixedBodyHash,
      ...mutation,
    })).toThrow();
  });
});
