import { describe, expect, test } from "vitest";

import {
  clearDeviceBindingCookie,
  clearLoginIntentCookie,
  clearLogoutIntentCookie,
  clearMigrationIntentCookie,
  clearRefreshCookie,
  encodeDeviceBindingEnvelope,
  encodeLoginIntentEnvelope,
  encodeLogoutIntent,
  encodeMigrationIntentEnvelope,
  encodeRefreshEnvelope,
  issueDeviceBindingCookie,
  issueLoginIntentCookie,
  issueLogoutIntentCookie,
  issueMigrationIntentCookie,
  issueRefreshCookie,
  parseDeviceBindingEnvelope,
  parseLoginIntentEnvelope,
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
  persistentBindingGeneration: 2,
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

const loginIntentClaims = {
  purpose: "login_intent" as const,
  audience: "https://spott.example",
  phase: "prepare" as const,
  challengeId: "88888888-8888-4888-8888-888888888888",
  deviceId: "44444444-4444-4444-8444-444444444444",
  attemptId: "99999999-9999-4999-8999-999999999999",
  sessionId: null,
  bindingId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  bindingGeneration: 0 as const,
  bindingSecret: Buffer.alloc(32, 0x7c).toString("base64url"),
  issuedAt: now,
  expiresAt: future,
};

describe("host-only session Cookie contracts", () => {
  test.each([
    [issueRefreshCookie("value"), "__Host-spott_refresh=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000; Priority=High"],
    [issueDeviceBindingCookie("value"), "__Host-spott_device_binding=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2678400; Priority=High"],
    [issueLoginIntentCookie("value"), "__Host-spott_login_intent=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600; Priority=High"],
    [issueMigrationIntentCookie("value"), "__Host-spott_migration_intent=value; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=600; Priority=High"],
    [issueLogoutIntentCookie("v1.1.current"), "__Host-spott_logout_intent=v1.1.current; Path=/; Secure; SameSite=Strict; Max-Age=2678400; Priority=High"],
    [clearRefreshCookie(), "__Host-spott_refresh=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
    [clearDeviceBindingCookie(), "__Host-spott_device_binding=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
    [clearLoginIntentCookie(), "__Host-spott_login_intent=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0; Priority=High"],
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

  test("round-trips a v2 current-session switch reservation without changing revocation hints", () => {
    const sessionHint = "11111111-1111-4111-8111-111111111111";
    const preservedSwitchChallengeId = "22222222-2222-4222-8222-222222222222";
    const encoded = encodeLogoutIntent({
      epoch: 6,
      scope: "current",
      sessionHint,
      preservedSwitchChallengeId,
    });

    expect(encoded.length).toBeLessThanOrEqual(128);
    expect(parseLogoutIntent(encoded)).toEqual({
      version: "v2",
      epoch: 6,
      scope: "current",
      sessionHint,
      preservedSwitchChallengeId,
    });
    expect(issueLogoutIntentCookie(encoded)).toContain(
      `__Host-spott_logout_intent=${encoded};`,
    );
  });

  test("rejects v2 switch reservations without exact current session and challenge identity", () => {
    expect(() => encodeLogoutIntent({
      epoch: 6,
      scope: "all",
      sessionHint: "11111111-1111-4111-8111-111111111111",
      preservedSwitchChallengeId: "22222222-2222-4222-8222-222222222222",
    })).toThrow();
    expect(() => encodeLogoutIntent({
      epoch: 6,
      scope: "current",
      preservedSwitchChallengeId: "22222222-2222-4222-8222-222222222222",
    })).toThrow();
    expect(() => encodeLogoutIntent({
      epoch: 6,
      scope: "current",
      sessionHint: "11111111-1111-4111-8111-111111111111",
      preservedSwitchChallengeId: "not-a-challenge",
    })).toThrow();
    expect(parseLogoutIntent(
      "v2.6.all.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222",
    )).toBeNull();
    expect(parseLogoutIntent(
      "v2.6.current.11111111-1111-4111-8111-111111111111",
    )).toBeNull();
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
    "v2.1.current.11111111-1111-4111-8111-111111111111.not-a-challenge",
    "v2.1.current.11111111-1111-4111-8111-111111111111.22222222-2222-4222-8222-222222222222.extra",
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

    expect(refresh).toBe("v1.cookie-2026-07.eyJwdXJwb3NlIjoicmVmcmVzaCIsImF1ZGllbmNlIjoiaHR0cHM6Ly9zcG90dC5leGFtcGxlIiwicmVmcmVzaFRva2VuIjoiczIuMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExLjMuQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQSIsInNlc3Npb25JZCI6IjExMTExMTExLTExMTEtNDExMS04MTExLTExMTExMTExMTExMSIsImZhbWlseUlkIjoiMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyIiwiZ2VuZXJhdGlvbiI6MywidHJhbnNwb3J0Q2xhc3MiOiJ3ZWJfYmZmIiwicGVyc2lzdGVudEJpbmRpbmdJZCI6IjMzMzMzMzMzLTMzMzMtNDMzMy04MzMzLTMzMzMzMzMzMzMzMyIsInBlcnNpc3RlbnRCaW5kaW5nR2VuZXJhdGlvbiI6MiwiYmZmQXR0ZW1wdEtpZCI6ImNvb2tpZS0yMDI2LTA3IiwiaXNzdWVkQXQiOjE3ODQyNDY0MDAwMDAsImV4cGlyZXNBdCI6MTc4NDI0NzAwMDAwMH0.B-l7qx-RvfYBzXYd1BZBEiLeGyfQ7nVWhLQlESgXuC0");
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
    const missingBindingGeneration = { ...refreshClaims } as Record<string, unknown>;
    delete missingBindingGeneration.persistentBindingGeneration;

    expect(() => encodeRefreshEnvelope(
      missingBindingGeneration as unknown as typeof refreshClaims,
      config,
    )).toThrow();
    expect(() => encodeRefreshEnvelope({
      ...refreshClaims,
      unexpected: true,
    } as typeof refreshClaims, config)).toThrow();
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, generation: -1 }, config)).toThrow();
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, persistentBindingGeneration: -1 }, config)).toThrow();
    expect(() => encodeDeviceBindingEnvelope({ ...bindingClaims, secret: "short" }, config)).toThrow();
    expect(() => encodeMigrationIntentEnvelope({ ...migrationClaims, audience: "https://evil.example" }, config)).toThrow();
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, transportClass: "native" as "web_bff" }, config)).toThrow();
    expect(() => encodeRefreshEnvelope({ ...refreshClaims, bffAttemptKid: "removed-kid" }, config)).toThrow();
  });
});

describe("login-intent envelope", () => {
  test("round-trips prepare and reconcile phases under a dotted KID", () => {
    const dotted = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `cookie.2026.07:${key}`,
      SPOTT_WEB_BFF_CURRENT_KID: "cookie.2026.07",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });
    const prepare = encodeLoginIntentEnvelope(loginIntentClaims, dotted);
    const reconcileClaims = {
      ...loginIntentClaims,
      phase: "reconcile" as const,
      sessionId: "11111111-1111-4111-8111-111111111111",
      expiresAt: now + 2_678_400_000,
    };
    const reconcile = encodeLoginIntentEnvelope(reconcileClaims, dotted);

    expect(parseLoginIntentEnvelope(prepare, dotted, now)).toEqual(loginIntentClaims);
    expect(parseLoginIntentEnvelope(reconcile, dotted, now)).toEqual(reconcileClaims);
  });

  test("requires phase and session ID to agree exactly", () => {
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      sessionId: "11111111-1111-4111-8111-111111111111",
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      phase: "reconcile" as const,
      sessionId: null,
    }, config)).toThrow();
  });

  test("serializes the exact canonical claims order and round-trips the stable proof", () => {
    const encoded = encodeLoginIntentEnvelope(loginIntentClaims, config);
    const [, kid, payload] = encoded.split(".");

    expect(kid).toBe("cookie-2026-07");
    expect(Buffer.from(payload!, "base64url").toString("utf8")).toBe(
      '{"purpose":"login_intent","audience":"https://spott.example","phase":"prepare","challengeId":"88888888-8888-4888-8888-888888888888","deviceId":"44444444-4444-4444-8444-444444444444","attemptId":"99999999-9999-4999-8999-999999999999","sessionId":null,"bindingId":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","bindingGeneration":0,"bindingSecret":"fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHw","issuedAt":1784246400000,"expiresAt":1784247000000}',
    );
    expect(parseLoginIntentEnvelope(encoded, config, now)).toEqual(loginIntentClaims);
    expect(Object.isFrozen(parseLoginIntentEnvelope(encoded, config, now))).toBe(true);
  });

  test("keeps login intent cryptographically separate from migration and session authority", () => {
    const loginIntent = encodeLoginIntentEnvelope(loginIntentClaims, config);
    const migration = encodeMigrationIntentEnvelope(migrationClaims, config);

    expect(parseLoginIntentEnvelope(migration, config, now)).toBeNull();
    expect(parseMigrationIntentEnvelope(loginIntent, config, now)).toBeNull();
    expect(parseRefreshEnvelope(loginIntent, config, now)).toBeNull();
    expect(parseDeviceBindingEnvelope(loginIntent, config, now)).toBeNull();
  });

  test("rejects noncanonical identifiers, generation, secret, audience, and time claims", () => {
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      bindingId: loginIntentClaims.bindingId.toUpperCase(),
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      bindingGeneration: 1 as 0,
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      bindingSecret: `${loginIntentClaims.bindingSecret}=`,
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      bindingSecret: Buffer.alloc(31, 0x7c).toString("base64url"),
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      audience: "https://evil.example",
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      expiresAt: loginIntentClaims.issuedAt,
    }, config)).toThrow();
    expect(() => encodeLoginIntentEnvelope({
      ...loginIntentClaims,
      unexpected: true,
    } as typeof loginIntentClaims, config)).toThrow();
  });

  test("fails closed for tampering, removed KIDs, future issuance, and expiry", () => {
    const encoded = encodeLoginIntentEnvelope(loginIntentClaims, config);
    const [version, kid, payload, mac] = encoded.split(".");
    const mutate = (value: string) => `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;

    expect(parseLoginIntentEnvelope(`${version}.${kid}.${mutate(payload!)}.${mac}`, config, now)).toBeNull();
    expect(parseLoginIntentEnvelope(`${version}.${kid}.${payload}.${mutate(mac!)}`, config, now)).toBeNull();
    expect(parseLoginIntentEnvelope(encoded, config, now - 1)).toBeNull();
    expect(parseLoginIntentEnvelope(encoded, config, future)).toBeNull();
    expect(parseLoginIntentEnvelope(undefined, config, now)).toBeNull();

    const nextKey = Buffer.from("abcdef0123456789abcdef0123456789").toString("base64url");
    const rotatedWithOldKey = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `cookie-2026-07:${key},cookie-2026-08:${nextKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: "cookie-2026-08",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });
    const rotatedWithoutOldKey = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `cookie-2026-08:${nextKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: "cookie-2026-08",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });

    expect(parseLoginIntentEnvelope(encoded, rotatedWithOldKey, now)).toEqual(loginIntentClaims);
    expect(parseLoginIntentEnvelope(encoded, rotatedWithoutOldKey, now)).toBeNull();
  });
});
