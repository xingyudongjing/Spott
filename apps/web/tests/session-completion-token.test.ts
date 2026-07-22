import { createCipheriv, hkdfSync } from "node:crypto";

import { describe, expect, test } from "vitest";

import type { LoginIntentEnvelopeClaims } from "../app/lib/session-cookie-codec";
import {
  encodeSessionCompletionToken,
  parseSessionCompletionToken,
} from "../app/lib/session-completion-token";
import { parseSessionServerConfig } from "../app/lib/session-server-config";

const now = 1_784_246_400_000;
const future = now + 600_000;
const currentMaterial = Buffer.alloc(32, 0x11);
const currentKey = currentMaterial.toString("base64url");
const config = parseSessionServerConfig({
  NODE_ENV: "test",
  SPOTT_WEB_BFF_KEYS: `completion-2026-07:${currentKey}`,
  SPOTT_WEB_BFF_CURRENT_KID: "completion-2026-07",
  SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
  API_INTERNAL_URL: "http://api.internal/v1",
  WEB_SESSION_RECOVERY_SECONDS: "120",
});

const claims: LoginIntentEnvelopeClaims = {
  purpose: "login_intent",
  audience: "https://spott.example",
  phase: "prepare",
  challengeId: "11111111-1111-4111-8111-111111111111",
  deviceId: "22222222-2222-4222-8222-222222222222",
  attemptId: "33333333-3333-4333-8333-333333333333",
  sessionId: null,
  bindingId: "44444444-4444-4444-8444-444444444444",
  bindingGeneration: 0,
  bindingSecret: Buffer.alloc(32, 0x5a).toString("base64url"),
  issuedAt: now,
  expiresAt: future,
};

function frameFields(fields: readonly string[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(field.normalize("NFC"), "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function sealRawPayload(
  payload: string | Buffer,
  options: {
    readonly kid?: string;
    readonly audience?: string;
    readonly key?: Buffer;
  } = {},
): string {
  const kid = options.kid ?? "completion-2026-07";
  const audience = options.audience ?? "https://spott.example";
  const key = options.key ?? currentMaterial;
  const nonce = Buffer.alloc(12, 0x22);
  const derived = Buffer.from(hkdfSync(
    "sha256",
    key,
    Buffer.alloc(0),
    frameFields(["spott:web-session-completion-token:key:v1", "v1", kid]),
    32,
  ));
  const cipher = createCipheriv("aes-256-gcm", derived, nonce, { authTagLength: 16 });
  const bytes = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  cipher.setAAD(frameFields([
    "spott:web-session-completion-token:aad:v1",
    "v1",
    kid,
    "login_intent",
    audience,
  ]), { plaintextLength: bytes.byteLength });
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return [
    "v1",
    kid,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
  ].join(".");
}

function canonicalClaimsJSON(value: LoginIntentEnvelopeClaims = claims): string {
  return JSON.stringify({
    purpose: value.purpose,
    audience: value.audience,
    phase: value.phase,
    challengeId: value.challengeId,
    deviceId: value.deviceId,
    attemptId: value.attemptId,
    sessionId: value.sessionId,
    bindingId: value.bindingId,
    bindingGeneration: value.bindingGeneration,
    bindingSecret: value.bindingSecret,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function mutateCanonicalSegment(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

describe("session completion token", () => {
  test("round-trips a token whose configured KID contains dots", () => {
    const dotted = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `completion.2026.07:${currentKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: "completion.2026.07",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });

    const encoded = encodeSessionCompletionToken(claims, dotted);
    expect(parseSessionCompletionToken(encoded, dotted, now)).toEqual(claims);
  });

  test("round-trips exact login-intent claims under the current KID", () => {
    const encoded = encodeSessionCompletionToken(claims, config);

    expect(encoded.split(".").slice(0, 2)).toEqual(["v1", "completion-2026-07"]);
    expect(parseSessionCompletionToken(encoded, config, now)).toEqual(claims);
    expect(Object.isFrozen(parseSessionCompletionToken(encoded, config, now))).toBe(true);
  });

  test("is opaque, randomized, compact, and browser-storage safe", () => {
    const first = encodeSessionCompletionToken(claims, config);
    const second = encodeSessionCompletionToken(claims, config);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^v1\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{1,2731}\.[A-Za-z0-9_-]{22}$/u);
    expect(first.length).toBeLessThanOrEqual(4_096);
    for (const sensitive of [
      claims.challengeId,
      claims.deviceId,
      claims.attemptId,
      claims.bindingId,
      claims.bindingSecret,
    ]) {
      expect(first).not.toContain(sensitive);
    }
  });

  test("rejects every authenticated segment mutation and an unknown KID", () => {
    const encoded = encodeSessionCompletionToken(claims, config);
    const [version, kid, nonce, ciphertext, tag] = encoded.split(".") as [string, string, string, string, string];

    expect(parseSessionCompletionToken(`v2.${kid}.${nonce}.${ciphertext}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.missing.${nonce}.${ciphertext}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${mutateCanonicalSegment(nonce)}.${ciphertext}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.${mutateCanonicalSegment(ciphertext)}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.${ciphertext}.${mutateCanonicalSegment(tag)}`, config, now)).toBeNull();
  });

  test("supports key rotation only while the issuing KID remains configured", () => {
    const encoded = encodeSessionCompletionToken(claims, config);
    const nextKey = Buffer.alloc(32, 0x33).toString("base64url");
    const rotatedWithOldKey = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `completion-2026-07:${currentKey},completion-2026-08:${nextKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: "completion-2026-08",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });
    const rotatedWithoutOldKey = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `completion-2026-08:${nextKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: "completion-2026-08",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });

    expect(parseSessionCompletionToken(encoded, rotatedWithOldKey, now)).toEqual(claims);
    expect(parseSessionCompletionToken(encoded, rotatedWithoutOldKey, now)).toBeNull();
    expect(encodeSessionCompletionToken(claims, rotatedWithOldKey).split(".")[1]).toBe("completion-2026-08");
  });

  test("authenticates the canonical audience and enforces issuance, expiry, and maximum TTL", () => {
    const encoded = encodeSessionCompletionToken(claims, config);
    const wrongAudience = parseSessionServerConfig({
      NODE_ENV: "test",
      SPOTT_WEB_BFF_KEYS: `completion-2026-07:${currentKey}`,
      SPOTT_WEB_BFF_CURRENT_KID: "completion-2026-07",
      SPOTT_WEB_CANONICAL_ORIGIN: "https://other.example",
      API_INTERNAL_URL: "http://api.internal/v1",
      WEB_SESSION_RECOVERY_SECONDS: "120",
    });

    expect(parseSessionCompletionToken(encoded, wrongAudience, now)).toBeNull();
    expect(parseSessionCompletionToken(encoded, config, now - 1)).toBeNull();
    expect(parseSessionCompletionToken(encoded, config, future)).toBeNull();
    expect(() => encodeSessionCompletionToken({ ...claims, expiresAt: now }, config)).toThrow();
    expect(() => encodeSessionCompletionToken({ ...claims, expiresAt: now + 600_001 }, config)).toThrow();
    expect(() => encodeSessionCompletionToken({ ...claims, audience: "https://other.example" }, config)).toThrow();
  });

  test("rejects malformed, oversized, and noncanonical outer encodings", () => {
    const encoded = encodeSessionCompletionToken(claims, config);
    const [version, kid, nonce, ciphertext, tag] = encoded.split(".") as [string, string, string, string, string];

    expect(parseSessionCompletionToken(undefined, config, now)).toBeNull();
    expect(parseSessionCompletionToken("", config, now)).toBeNull();
    expect(parseSessionCompletionToken("x".repeat(4_097), config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.${ciphertext}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.${ciphertext}.${tag}.extra`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.bad kid.${nonce}.${ciphertext}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}=.${ciphertext}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.A.${ciphertext}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.A.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.${"A".repeat(2_732)}.${tag}`, config, now)).toBeNull();
    expect(parseSessionCompletionToken(`${version}.${kid}.${nonce}.${ciphertext}.A`, config, now)).toBeNull();
  });

  test("requires exact canonical encrypted claims", () => {
    const reordered = JSON.stringify({
      audience: claims.audience,
      purpose: claims.purpose,
      phase: claims.phase,
      challengeId: claims.challengeId,
      deviceId: claims.deviceId,
      attemptId: claims.attemptId,
      sessionId: claims.sessionId,
      bindingId: claims.bindingId,
      bindingGeneration: claims.bindingGeneration,
      bindingSecret: claims.bindingSecret,
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
    });
    const withExtra = canonicalClaimsJSON(claims).replace(/\}$/u, ',"extra":true}');
    const withWhitespace = canonicalClaimsJSON(claims).replace("{", "{ ");
    const duplicatePurpose = canonicalClaimsJSON(claims).replace(
      '"purpose":"login_intent",',
      '"purpose":"login_intent","purpose":"login_intent",',
    );

    expect(parseSessionCompletionToken(sealRawPayload(reordered), config, now)).toBeNull();
    expect(parseSessionCompletionToken(sealRawPayload(withExtra), config, now)).toBeNull();
    expect(parseSessionCompletionToken(sealRawPayload(withWhitespace), config, now)).toBeNull();
    expect(parseSessionCompletionToken(sealRawPayload(duplicatePurpose), config, now)).toBeNull();
    expect(parseSessionCompletionToken(sealRawPayload(Buffer.from([0xff, 0xfe])), config, now)).toBeNull();
  });

  test("rejects noncanonical UUIDs, base64url secrets, and any missing or extra input claim", () => {
    const missing = { ...claims } as Record<string, unknown>;
    delete missing.attemptId;

    expect(() => encodeSessionCompletionToken(missing as unknown as LoginIntentEnvelopeClaims, config)).toThrow();
    expect(() => encodeSessionCompletionToken({ ...claims, extra: true } as LoginIntentEnvelopeClaims, config)).toThrow();
    expect(() => encodeSessionCompletionToken({ ...claims, purpose: "refresh" as "login_intent" }, config)).toThrow();
    expect(() => encodeSessionCompletionToken({
      ...claims,
      challengeId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    }, config)).toThrow();
    expect(() => encodeSessionCompletionToken({ ...claims, bindingGeneration: 1 as 0 }, config)).toThrow();
    expect(() => encodeSessionCompletionToken({ ...claims, bindingSecret: `${claims.bindingSecret}=` }, config)).toThrow();
    expect(() => encodeSessionCompletionToken({
      ...claims,
      bindingSecret: Buffer.alloc(31, 0x5a).toString("base64url"),
    }, config)).toThrow();
  });
});
