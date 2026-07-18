import { describe, expect, test } from "vitest";

import {
  clearDeviceBindingCookie,
  clearLogoutIntentCookie,
  clearMigrationIntentCookie,
  clearRefreshCookie,
  encodeDeviceBindingEnvelope,
  encodeLogoutIntent,
  encodeMigrationIntentEnvelope,
  encodeRefreshEnvelope,
  issueDeviceBindingCookie,
  issueLogoutIntentCookie,
  issueMigrationIntentCookie,
  issueRefreshCookie,
  parseDeviceBindingEnvelope,
  parseLogoutIntent,
  parseMigrationIntentEnvelope,
  parseRefreshEnvelope,
} from "../app/lib/session-cookie-codec";
import { parseSessionServerConfig } from "../app/lib/session-server-config";

const now = 1_784_246_400_000;
const future = now + 600_000;
const key = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
const config = parseSessionServerConfig({
  NODE_ENV: "test",
  SPOTT_WEB_BFF_KEYS: `cookie-2026-07:${key}`,
  SPOTT_WEB_BFF_CURRENT_KID: "cookie-2026-07",
  SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
  API_INTERNAL_URL: "http://api.internal/v1",
  WEB_SESSION_RECOVERY_SECONDS: "120",
});

const refreshClaims = {
  purpose: "refresh" as const,
  audience: "https://spott.example",
  refreshToken: "s2.11111111-1111-4111-8111-111111111111.3.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  sessionId: "11111111-1111-4111-8111-111111111111",
  familyId: "22222222-2222-4222-8222-222222222222",
  generation: 3,
  transportClass: "web_bff" as const,
  persistentBindingId: "33333333-3333-4333-8333-333333333333",
  bffAttemptKid: "cookie-2026-07",
  issuedAt: now,
  expiresAt: future,
};

const bindingClaims = {
  purpose: "device_binding" as const,
  audience: "https://spott.example",
  bindingId: "33333333-3333-4333-8333-333333333333",
  deviceId: "44444444-4444-4444-8444-444444444444",
  userId: "55555555-5555-4555-8555-555555555555",
  sessionId: "11111111-1111-4111-8111-111111111111",
  generation: 2,
  secret: Buffer.alloc(32, 0x5a).toString("base64url"),
  issuedAt: now,
  expiresAt: future,
};

const migrationClaims = {
  purpose: "migration_intent" as const,
  audience: "https://spott.example",
  intentId: "66666666-6666-4666-8666-666666666666",
  attemptId: "77777777-7777-4777-8777-777777777777",
  temporarySecret: Buffer.alloc(32, 0x6b).toString("base64url"),
  issuedAt: now,
  expiresAt: future,
};

describe("host-only session Cookie contracts", () => {
  test.each([
    [issueRefreshCookie("value"), "__Host-spott_refresh=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000; Priority=High"],
    [issueDeviceBindingCookie("value"), "__Host-spott_device_binding=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2678400; Priority=High"],
    [issueMigrationIntentCookie("value"), "__Host-spott_migration_intent=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600; Priority=High"],
    [issueLogoutIntentCookie("v1.1.current"), "__Host-spott_logout_intent=v1.1.current; Path=/; Secure; SameSite=Strict; Max-Age=2678400; Priority=High"],
    [clearRefreshCookie(), "__Host-spott_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
    [clearDeviceBindingCookie(), "__Host-spott_device_binding=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
    [clearMigrationIntentCookie(), "__Host-spott_migration_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
    [clearLogoutIntentCookie(), "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
  ])("serializes an exact immutable contract", (actual, expected) => {
    expect(actual).toBe(expected);
    expect(actual).not.toContain("Domain=");
  });

  test.each(["line\nbreak", "semi;colon", "comma,value", "space value", "\u0000"])(
    "rejects Cookie separator/control injection %j",
    (value) => expect(() => issueRefreshCookie(value)).toThrow(),
  );
});

describe("logout intent", () => {
  test("round-trips current/all hints without treating them as credential authority", () => {
    expect(parseLogoutIntent(encodeLogoutIntent({ epoch: 4, scope: "current" }))).toEqual({
      version: "v1", epoch: 4, scope: "current", sessionHint: undefined,
    });
    expect(parseLogoutIntent(encodeLogoutIntent({
      epoch: 5,
      scope: "all",
      sessionHint: "11111111-1111-4111-8111-111111111111",
    }))).toEqual({
      version: "v1", epoch: 5, scope: "all", sessionHint: "11111111-1111-4111-8111-111111111111",
    });
  });

  test.each([
    "v2.1.current",
    "v1.-1.current",
    "v1.01.current",
    "v1.9007199254740992.current",
    "v1.1.some",
    "v1.1.current.not-a-uuid",
    "v1.1.current.11111111-1111-4111-8111-11111111111A",
    "v1.1.current.11111111-1111-4111-8111-111111111111.extra",
  ])("rejects malformed value %s", (value) => expect(parseLogoutIntent(value)).toBeNull());

  test("fails closed for non-string or oversized input", () => {
    expect(parseLogoutIntent(undefined)).toBeNull();
    expect(parseLogoutIntent("x".repeat(129))).toBeNull();
  });

  test("refuses to issue a noncanonical logout hint even when it is Cookie-safe", () => {
    expect(() => issueLogoutIntentCookie("credential-looking-but-cookie-safe")).toThrow();
  });
});

describe("purpose-separated HttpOnly envelopes", () => {
  test("commits deterministic fixed vectors and parses exact claims", () => {
    const refresh = encodeRefreshEnvelope(refreshClaims, config);
    const binding = encodeDeviceBindingEnvelope(bindingClaims, config);
    const migration = encodeMigrationIntentEnvelope(migrationClaims, config);

    expect(refresh).toBe("v1.cookie-2026-07.eyJwdXJwb3NlIjoicmVmcmVzaCIsImF1ZGllbmNlIjoiaHR0cHM6Ly9zcG90dC5leGFtcGxlIiwicmVmcmVzaFRva2VuIjoiczIuMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLjMuQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsInNlc3Npb25JZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsImZhbWlseUlkIjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwiZ2VuZXJhdGlvbiI6MywidHJhbnNwb3J0Q2xhc3MiOiJ3ZWJfYmZmIiwicGVyc2lzdGVudEJpbmRpbmdJZCI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsImJmZkF0dGVtcHRLaWQiOiJjb29raWUtMjAyNi0wNyIsImlzc3VlZEF0IjoxNzg0MjQ2NDAwMDAwLCJleHBpcmVzQXQiOjE3ODQyNDcwMDAwMDB9.4jMOnzlTNiB8Q0LGBo1fw9iRbPlPyAmr3UmgsPitC88");
    expect(binding).toBe("v1.cookie-2026-07.eyJwdXJwb3NlIjoiZGV2aWNlX2JpbmRpbmciLCJhdWRpZW5jZSI6Imh0dHBzOi8vc3BvdHQuZXhhbXBsZSIsImJpbmRpbmdJZCI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsImRldmljZUlkIjoiNDQ0NDQ0NDQtNDQ0NC00NDQ0LTg0NDQtNDQ0NDQ0NDQ0NDQ0IiwidXNlcklkIjoiNTU1NTU1NTUtNTU1NS00NTU1LTg1NTUtNTU1NTU1NTU1NTU1Iiwic2Vzc2lvbklkIjoiMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExIiwiZ2VuZXJhdGlvbiI6Miwic2VjcmV0IjoiV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdscGFXbHBhV2xwYVdsbyIsImlzc3VlZEF0IjoxNzg0MjQ2NDAwMDAwLCJleHBpcmVzQXQiOjE3ODQyNDcwMDAwMDB9.vXjLdFTTwc_zU46SI_EClsETRqlRhNBDdBZseHF26C4");
    expect(migration).toBe("v1.cookie-2026-07.eyJwdXJwb3NlIjoibWlncmF0aW9uX2ludGVudCIsImF1ZGllbmNlIjoiaHR0cHM6Ly9zcG90dC5leGFtcGxlIiwiaW50ZW50SWQiOiI2NjY2NjY2Ni02NjY2LTQ2NjYtODY2Ni02NjY2NjY2NjY2NjYiLCJhdHRlbXB0SWQiOiI3Nzc3Nzc3Ny03Nzc3LTQ3NzctODc3Ny03Nzc3Nzc3Nzc3NzciLCJ0ZW1wb3JhcnlTZWNyZXQiOiJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJ0cmEydHJhMnRyYTJzIiwiaXNzdWVkQXQiOjE3ODQyNDY0MDAwMDAsImV4cGlyZXNBdCI6MTc4NDI0NzAwMDAwMH0.NJiBeKER-xqyC_r6kAU4MyipMBYbhBH3SjFnp5JZIYA");
    expect(parseRefreshEnvelope(refresh, config, now)).toEqual(refreshClaims);
    expect(parseDeviceBindingEnvelope(binding, config, now)).toEqual(bindingClaims);
    expect(parseMigrationIntentEnvelope(migration, config, now)).toEqual(migrationClaims);
  });

  test("does not substitute one purpose for another", () => {
    const refresh = encodeRefreshEnvelope(refreshClaims, config);
    const binding = encodeDeviceBindingEnvelope(bindingClaims, config);
    const migration = encodeMigrationIntentEnvelope(migrationClaims, config);

    expect(parseRefreshEnvelope(binding, config, now)).toBeNull();
    expect(parseRefreshEnvelope(migration, config, now)).toBeNull();
    expect(parseDeviceBindingEnvelope(refresh, config, now)).toBeNull();
    expect(parseMigrationIntentEnvelope(refresh, config, now)).toBeNull();
  });

  test("fails closed for envelope mutations, unknown keys, future issuance, and expiry", () => {
    const encoded = encodeRefreshEnvelope(refreshClaims, config);
    const [version, kid, payload, mac] = encoded.split(".");
    const mutate = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

    expect(parseRefreshEnvelope(`v2.${kid}.${payload}.${mac}`, config, now)).toBeNull();
    expect(parseRefreshEnvelope(`${version}.missing.${payload}.${mac}`, config, now)).toBeNull();
    expect(parseRefreshEnvelope(`${version}.${kid}.${mutate(payload!)}.${mac}`, config, now)).toBeNull();
    expect(parseRefreshEnvelope(`${version}.${kid}.${payload}.${mutate(mac!)}`, config, now)).toBeNull();
    expect(parseRefreshEnvelope(`${version}.${kid}.${payload}=.${mac}`, config, now)).toBeNull();
    expect(parseRefreshEnvelope(encoded, config, now - 1)).toBeNull();
    expect(parseRefreshEnvelope(encoded, config, future + 1)).toBeNull();
    expect(parseRefreshEnvelope(undefined, config, now)).toBeNull();
    expect(parseRefreshEnvelope("x".repeat(4_097), config, now)).toBeNull();
  });

  test("rejects unknown, missing, duplicate, noncanonical, and unsafe payload fields", () => {
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, generation: -1 }, config)).toThrow();
    expect(() => encodeDeviceBindingEnvelope({ ...bindingClaims, secret: "short" }, config)).toThrow();
    expect(() => encodeMigrationIntentEnvelope({ ...migrationClaims, audience: "https://evil.example" }, config)).toThrow();
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, transportClass: "native" as "web_bff" }, config)).toThrow();
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, bffAttemptKid: "removed-kid" }, config)).toThrow();
  });
});
