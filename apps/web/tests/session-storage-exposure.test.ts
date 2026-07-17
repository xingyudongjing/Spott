import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { saveSession, clearSession, type WebSession } from "../app/lib/client-api";

/**
 * QUARANTINE / KNOWN-VULNERABILITY CHARACTERISTIC TEST — P0-8. NOT AN APPROVAL.
 *
 * This file pins the CURRENT, KNOWN-INSECURE behavior: the 30-day refresh token
 * is serialised into localStorage, where any XSS on the origin can read it.
 * Development doc 8.6 forbids this outright.
 *
 * It exists so the exposure stays visible in CI and cannot be quietly forgotten
 * while the fix is blocked. It is deliberately written to FAIL the moment the
 * S1 Cookie cutover lands.
 *
 * >>> If this test fails because a token is no longer in localStorage: that is
 * >>> the GOAL. Delete this whole file — do not "repair" the assertions.
 *
 * The fix is NOT a Web-only change. It is blocked on the S1 hard dependencies in
 * docs/superpowers/plans/2026-07-17-session-security-s0-api-foundation.md
 * ("S1 Atomic Cutover Hard Dependencies"), which require an atomic coordinated
 * release: same-origin BFF routes, Cookie codecs, a provisioned SPOTT_WEB_BFF_KEYS
 * keyring, and real-browser HTTPS evidence. None of the /auth/web/* Cookie routes
 * exist yet.
 */

const session: WebSession = {
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshToken: "refresh-token-30-day",
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

describe("P0-8 known exposure: refresh token is readable from localStorage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  test("any same-origin script can still read the 30-day refresh token", () => {
    saveSession(session);

    // This is exactly what one line of injected XSS would do.
    const stolen = window.localStorage.getItem("spott.web.session.v1");

    expect(stolen).not.toBeNull();
    expect(stolen).toContain("refresh-token-30-day");
    expect(JSON.parse(stolen as string).refreshToken).toBe("refresh-token-30-day");
  });

  test("the session CustomEvent payload also still carries both tokens", () => {
    const payloads: unknown[] = [];
    const listener = (event: Event) => payloads.push((event as CustomEvent).detail);
    window.addEventListener("spott:session", listener);

    saveSession(session);
    window.removeEventListener("spott:session", listener);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ refreshToken: "refresh-token-30-day" });
  });
});
