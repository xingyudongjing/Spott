import { Buffer } from "node:buffer";
import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

import type { LoginIntentEnvelopeClaims } from "./session-cookie-codec";
import type { SessionServerConfig } from "./session-server-config";

const tokenVersion = "v1" as const;
const tokenPurpose = "login_intent" as const;
const keyDerivationContext = "spott:web-session-completion-token:key:v1";
const authenticatedContext = "spott:web-session-completion-token:aad:v1";
const canonicalBase64URLPattern = /^[A-Za-z0-9_-]+$/u;
const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const nonceLength = 12;
const authenticationTagLength = 16;
const maximumCiphertextLength = 2_048;
const maximumTokenLength = 4_096;
const maximumTokenTTL = 600_000;

const loginIntentKeys = [
  "purpose", "audience", "phase", "challengeId", "deviceId", "attemptId", "sessionId", "bindingId",
  "bindingGeneration", "bindingSecret", "issuedAt", "expiresAt",
] as const;

function frameFields(fields: readonly (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const value = typeof field === "string" ? Buffer.from(field.normalize("NFC"), "utf8") : Buffer.from(field);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.byteLength);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

function completionKey(masterKey: Uint8Array, kid: string): Buffer {
  return Buffer.from(hkdfSync(
    "sha256",
    masterKey,
    Buffer.alloc(0),
    frameFields([keyDerivationContext, tokenVersion, kid]),
    32,
  ));
}

function completionAAD(kid: string, audience: string): Buffer {
  return frameFields([authenticatedContext, tokenVersion, kid, tokenPurpose, audience]);
}

function validSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validUUID(value: unknown): value is string {
  return typeof value === "string" && canonicalUUIDPattern.test(value);
}

function validSecret(value: unknown): value is string {
  if (typeof value !== "string" || !canonicalBase64URLPattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function hasExactKeys(value: Record<string, unknown>, requireCanonicalOrder: boolean): boolean {
  const actual = Object.keys(value);
  return actual.length === loginIntentKeys.length
    && (requireCanonicalOrder
      ? actual.every((key, index) => key === loginIntentKeys[index])
      : loginIntentKeys.every((key) => Object.hasOwn(value, key)));
}

function validClaims(
  value: Record<string, unknown>,
  config: SessionServerConfig,
  now?: number,
  requireCanonicalOrder = true,
): value is Record<keyof LoginIntentEnvelopeClaims, unknown> {
  return hasExactKeys(value, requireCanonicalOrder)
    && value.purpose === tokenPurpose
    && value.audience === config.canonicalOrigin
    && value.phase === "prepare"
    && validUUID(value.challengeId)
    && validUUID(value.deviceId)
    && validUUID(value.attemptId)
    && value.sessionId === null
    && validUUID(value.bindingId)
    && value.bindingGeneration === 0
    && validSecret(value.bindingSecret)
    && validSafeInteger(value.issuedAt)
    && validSafeInteger(value.expiresAt)
    && value.expiresAt > value.issuedAt
    && value.expiresAt - value.issuedAt <= maximumTokenTTL
    && (now === undefined
      || (validSafeInteger(now) && value.issuedAt <= now && now < value.expiresAt));
}

function canonicalPayload(claims: LoginIntentEnvelopeClaims): Buffer {
  return Buffer.from(JSON.stringify({
    purpose: claims.purpose,
    audience: claims.audience,
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
  }), "utf8");
}

function decodeCanonicalBase64URL(value: string): Buffer | null {
  if (!canonicalBase64URLPattern.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export function encodeSessionCompletionToken(
  claims: LoginIntentEnvelopeClaims,
  config: SessionServerConfig,
): string {
  const candidate = claims as unknown as Record<string, unknown>;
  if (!validClaims(candidate, config, undefined, false)) {
    throw new Error("Session completion token claims are invalid");
  }

  const kid = config.bffKeys.currentKid;
  const masterKey = config.bffKeys.getKey(kid);
  if (masterKey === undefined) throw new Error("Session completion token KID is unknown");
  const plaintext = canonicalPayload(claims);
  if (plaintext.byteLength === 0 || plaintext.byteLength > maximumCiphertextLength) {
    throw new Error("Session completion token payload is too large");
  }

  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", completionKey(masterKey, kid), nonce, {
    authTagLength: authenticationTagLength,
  });
  cipher.setAAD(completionAAD(kid, config.canonicalOrigin), { plaintextLength: plaintext.byteLength });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();
  const encoded = [
    tokenVersion,
    kid,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    authenticationTag.toString("base64url"),
  ].join(".");
  if (encoded.length > maximumTokenLength) throw new Error("Session completion token is too large");
  return encoded;
}

export function parseSessionCompletionToken(
  value: unknown,
  config: SessionServerConfig,
  now = Date.now(),
): LoginIntentEnvelopeClaims | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumTokenLength) return null;
  const parts = value.split(".");
  if (parts.length < 5) return null;
  const version = parts[0];
  const encodedNonce = parts.at(-3);
  const encodedCiphertext = parts.at(-2);
  const encodedAuthenticationTag = parts.at(-1);
  const kid = parts.slice(1, -3).join(".");
  if (version !== tokenVersion || !kid || !keyIdPattern.test(kid)) return null;

  const nonce = encodedNonce === undefined ? null : decodeCanonicalBase64URL(encodedNonce);
  const ciphertext = encodedCiphertext === undefined ? null : decodeCanonicalBase64URL(encodedCiphertext);
  const authenticationTag = encodedAuthenticationTag === undefined
    ? null
    : decodeCanonicalBase64URL(encodedAuthenticationTag);
  if (
    nonce === null
    || nonce.byteLength !== nonceLength
    || ciphertext === null
    || ciphertext.byteLength === 0
    || ciphertext.byteLength > maximumCiphertextLength
    || authenticationTag === null
    || authenticationTag.byteLength !== authenticationTagLength
  ) return null;

  const masterKey = config.bffKeys.getKey(kid);
  if (masterKey === undefined) return null;
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", completionKey(masterKey, kid), nonce, {
      authTagLength: authenticationTagLength,
    });
    decipher.setAAD(completionAAD(kid, config.canonicalOrigin), { plaintextLength: ciphertext.byteLength });
    decipher.setAuthTag(authenticationTag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return null;
  }

  let decoded: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    if (Buffer.from(json, "utf8").compare(plaintext) !== 0) return null;
    decoded = JSON.parse(json) as unknown;
    if (JSON.stringify(decoded) !== json) return null;
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  const candidate = decoded as Record<string, unknown>;
  return validClaims(candidate, config, now)
    ? Object.freeze(candidate) as unknown as LoginIntentEnvelopeClaims
    : null;
}
