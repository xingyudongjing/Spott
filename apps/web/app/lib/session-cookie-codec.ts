import { createHmac, timingSafeEqual } from "node:crypto";

import type { SessionServerConfig } from "./session-server-config";

const canonicalBase64URLPattern = /^[A-Za-z0-9_-]+$/u;
const canonicalUUIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const cookieValuePattern = /^[!#$%&'*+\-.0-9A-Z^_`a-z|~:]+$/u;
const maximumEnvelopeLength = 4_096;

const refreshContext = "spott:web-refresh-cookie";
const deviceBindingContext = "spott:web-device-binding-cookie";
const migrationIntentContext = "spott:web-migration-intent-cookie";

export interface RefreshEnvelopeClaims {
  readonly purpose: "refresh";
  readonly audience: string;
  readonly refreshToken: string;
  readonly sessionId: string;
  readonly familyId: string;
  readonly generation: number;
  readonly transportClass: "web_bff";
  readonly persistentBindingId: string;
  readonly bffAttemptKid: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface DeviceBindingEnvelopeClaims {
  readonly purpose: "device_binding";
  readonly audience: string;
  readonly bindingId: string;
  readonly deviceId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly generation: number;
  readonly secret: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface MigrationIntentEnvelopeClaims {
  readonly purpose: "migration_intent";
  readonly audience: string;
  readonly intentId: string;
  readonly attemptId: string;
  readonly temporarySecret: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface LogoutIntent {
  readonly version: "v1";
  readonly epoch: number;
  readonly scope: "current" | "all";
  readonly sessionHint?: string;
}

const refreshKeys = [
  "purpose", "audience", "refreshToken", "sessionId", "familyId", "generation",
  "transportClass", "persistentBindingId", "bffAttemptKid", "issuedAt", "expiresAt",
] as const;
const deviceBindingKeys = [
  "purpose", "audience", "bindingId", "deviceId", "userId", "sessionId", "generation",
  "secret", "issuedAt", "expiresAt",
] as const;
const migrationIntentKeys = [
  "purpose", "audience", "intentId", "attemptId", "temporarySecret", "issuedAt", "expiresAt",
] as const;

function assertCookieValue(value: string): void {
  if (value === "" || !cookieValuePattern.test(value)) {
    throw new Error("Session Cookie value contains forbidden characters");
  }
}

function issueCookie(name: string, value: string, maxAge: number, httpOnly: boolean): string {
  assertCookieValue(value);
  return `${name}=${value}; Path=/;${httpOnly ? " HttpOnly;" : ""} Secure; SameSite=Strict; Max-Age=${maxAge}; Priority=High`;
}

function clearCookie(name: string, httpOnly: boolean): string {
  return `${name}=; Path=/;${httpOnly ? " HttpOnly;" : ""} Secure; SameSite=Strict; Max-Age=0; Priority=High`;
}

export const issueRefreshCookie = (value: string): string => issueCookie("__Host-spott_refresh", value, 2_592_000, true);
export const issueDeviceBindingCookie = (value: string): string => issueCookie("__Host-spott_device_binding", value, 2_678_400, true);
export const issueMigrationIntentCookie = (value: string): string => issueCookie("__Host-spott_migration_intent", value, 600, true);
export function issueLogoutIntentCookie(value: string): string {
  if (parseLogoutIntent(value) === null) throw new Error("Logout intent Cookie value is invalid");
  return issueCookie("__Host-spott_logout_intent", value, 2_678_400, false);
}
export const clearRefreshCookie = (): string => clearCookie("__Host-spott_refresh", true);
export const clearDeviceBindingCookie = (): string => clearCookie("__Host-spott_device_binding", true);
export const clearMigrationIntentCookie = (): string => clearCookie("__Host-spott_migration_intent", true);
export const clearLogoutIntentCookie = (): string => clearCookie("__Host-spott_logout_intent", false);

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

function validTimes(issuedAt: unknown, expiresAt: unknown, now?: number): boolean {
  if (!validSafeInteger(issuedAt) || !validSafeInteger(expiresAt) || expiresAt <= issuedAt) return false;
  return now === undefined || (validSafeInteger(now) && issuedAt <= now && now < expiresAt);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  requireCanonicalOrder = true,
): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length
    && (requireCanonicalOrder
      ? actual.every((key, index) => key === expected[index])
      : expected.every((key) => Object.hasOwn(value, key)));
}

function frameFields(fields: readonly (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const bytes = typeof field === "string" ? Buffer.from(field.normalize("NFC"), "utf8") : Buffer.from(field);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function envelopeMac(
  context: string,
  version: "v1",
  kid: string,
  audience: string,
  payload: Uint8Array,
  config: SessionServerConfig,
): Buffer {
  const key = config.bffKeys.getKey(kid);
  if (key === undefined) throw new Error("Session Cookie envelope KID is unknown");
  return createHmac("sha256", key)
    .update(frameFields([context, version, kid, audience, payload]))
    .digest();
}

function encodeEnvelope(
  context: string,
  payloadObject: Record<string, unknown>,
  config: SessionServerConfig,
): string {
  const version = "v1" as const;
  const kid = config.bffKeys.currentKid;
  const payload = Buffer.from(JSON.stringify(payloadObject), "utf8");
  const mac = envelopeMac(context, version, kid, config.canonicalOrigin, payload, config);
  return `${version}.${kid}.${payload.toString("base64url")}.${mac.toString("base64url")}`;
}

function decodeEnvelope(
  value: unknown,
  context: string,
  config: SessionServerConfig,
): Record<string, unknown> | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumEnvelopeLength) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [version, kid, encodedPayload, encodedMac] = parts;
  if (
    version !== "v1"
    || !kid
    || !keyIdPattern.test(kid)
    || !encodedPayload
    || !encodedMac
    || !canonicalBase64URLPattern.test(encodedPayload)
    || !canonicalBase64URLPattern.test(encodedMac)
  ) return null;
  const payload = Buffer.from(encodedPayload, "base64url");
  const suppliedMac = Buffer.from(encodedMac, "base64url");
  if (payload.toString("base64url") !== encodedPayload || suppliedMac.toString("base64url") !== encodedMac) return null;
  let expectedMac: Buffer;
  try {
    expectedMac = envelopeMac(context, version, kid, config.canonicalOrigin, payload, config);
  } catch {
    return null;
  }
  if (suppliedMac.byteLength !== expectedMac.byteLength || !timingSafeEqual(suppliedMac, expectedMac)) return null;
  let decoded: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    if (Buffer.from(json, "utf8").compare(payload) !== 0) return null;
    decoded = JSON.parse(json);
    if (JSON.stringify(decoded) !== json) return null;
  } catch {
    return null;
  }
  if (decoded === null || typeof decoded !== "object" || Array.isArray(decoded)) return null;
  return decoded as Record<string, unknown>;
}

function validateRefresh(
  value: Record<string, unknown>,
  config: SessionServerConfig,
  now?: number,
  requireCanonicalOrder = true,
): boolean {
  return hasExactKeys(value, refreshKeys, requireCanonicalOrder)
    && value.purpose === "refresh"
    && value.audience === config.canonicalOrigin
    && typeof value.refreshToken === "string"
    && value.refreshToken.length > 0
    && value.refreshToken.length <= 512
    && cookieValuePattern.test(value.refreshToken)
    && validUUID(value.sessionId)
    && validUUID(value.familyId)
    && validSafeInteger(value.generation)
    && value.transportClass === "web_bff"
    && validUUID(value.persistentBindingId)
    && typeof value.bffAttemptKid === "string"
    && keyIdPattern.test(value.bffAttemptKid)
    && config.bffKeys.getKey(value.bffAttemptKid) !== undefined
    && validTimes(value.issuedAt, value.expiresAt, now);
}

function validateDeviceBinding(
  value: Record<string, unknown>,
  config: SessionServerConfig,
  now?: number,
  requireCanonicalOrder = true,
): boolean {
  return hasExactKeys(value, deviceBindingKeys, requireCanonicalOrder)
    && value.purpose === "device_binding"
    && value.audience === config.canonicalOrigin
    && validUUID(value.bindingId)
    && validUUID(value.deviceId)
    && validUUID(value.userId)
    && validUUID(value.sessionId)
    && validSafeInteger(value.generation)
    && validSecret(value.secret)
    && validTimes(value.issuedAt, value.expiresAt, now);
}

function validateMigrationIntent(
  value: Record<string, unknown>,
  config: SessionServerConfig,
  now?: number,
  requireCanonicalOrder = true,
): boolean {
  return hasExactKeys(value, migrationIntentKeys, requireCanonicalOrder)
    && value.purpose === "migration_intent"
    && value.audience === config.canonicalOrigin
    && validUUID(value.intentId)
    && validUUID(value.attemptId)
    && validSecret(value.temporarySecret)
    && validTimes(value.issuedAt, value.expiresAt, now);
}

export function encodeRefreshEnvelope(claims: RefreshEnvelopeClaims, config: SessionServerConfig): string {
  const value = claims as unknown as Record<string, unknown>;
  if (!validateRefresh(value, config, undefined, false)) throw new Error("Refresh Cookie claims are invalid");
  return encodeEnvelope(refreshContext, {
    purpose: claims.purpose,
    audience: claims.audience,
    refreshToken: claims.refreshToken,
    sessionId: claims.sessionId,
    familyId: claims.familyId,
    generation: claims.generation,
    transportClass: claims.transportClass,
    persistentBindingId: claims.persistentBindingId,
    bffAttemptKid: claims.bffAttemptKid,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  }, config);
}

export function encodeDeviceBindingEnvelope(claims: DeviceBindingEnvelopeClaims, config: SessionServerConfig): string {
  const value = claims as unknown as Record<string, unknown>;
  if (!validateDeviceBinding(value, config, undefined, false)) throw new Error("Device-binding Cookie claims are invalid");
  return encodeEnvelope(deviceBindingContext, {
    purpose: claims.purpose,
    audience: claims.audience,
    bindingId: claims.bindingId,
    deviceId: claims.deviceId,
    userId: claims.userId,
    sessionId: claims.sessionId,
    generation: claims.generation,
    secret: claims.secret,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  }, config);
}

export function encodeMigrationIntentEnvelope(claims: MigrationIntentEnvelopeClaims, config: SessionServerConfig): string {
  const value = claims as unknown as Record<string, unknown>;
  if (!validateMigrationIntent(value, config, undefined, false)) throw new Error("Migration-intent Cookie claims are invalid");
  return encodeEnvelope(migrationIntentContext, {
    purpose: claims.purpose,
    audience: claims.audience,
    intentId: claims.intentId,
    attemptId: claims.attemptId,
    temporarySecret: claims.temporarySecret,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
  }, config);
}

export function parseRefreshEnvelope(value: unknown, config: SessionServerConfig, now = Date.now()): RefreshEnvelopeClaims | null {
  const decoded = decodeEnvelope(value, refreshContext, config);
  return decoded !== null && validateRefresh(decoded, config, now)
    ? Object.freeze(decoded) as unknown as RefreshEnvelopeClaims
    : null;
}

export function parseDeviceBindingEnvelope(value: unknown, config: SessionServerConfig, now = Date.now()): DeviceBindingEnvelopeClaims | null {
  const decoded = decodeEnvelope(value, deviceBindingContext, config);
  return decoded !== null && validateDeviceBinding(decoded, config, now)
    ? Object.freeze(decoded) as unknown as DeviceBindingEnvelopeClaims
    : null;
}

export function parseMigrationIntentEnvelope(value: unknown, config: SessionServerConfig, now = Date.now()): MigrationIntentEnvelopeClaims | null {
  const decoded = decodeEnvelope(value, migrationIntentContext, config);
  return decoded !== null && validateMigrationIntent(decoded, config, now)
    ? Object.freeze(decoded) as unknown as MigrationIntentEnvelopeClaims
    : null;
}

export function encodeLogoutIntent(input: Omit<LogoutIntent, "version">): string {
  if (!validSafeInteger(input.epoch) || (input.scope !== "current" && input.scope !== "all")) {
    throw new Error("Logout intent is invalid");
  }
  if (input.sessionHint !== undefined && !validUUID(input.sessionHint)) {
    throw new Error("Logout intent session hint is invalid");
  }
  return `v1.${input.epoch}.${input.scope}${input.sessionHint === undefined ? "" : `.${input.sessionHint}`}`;
}

export function parseLogoutIntent(value: unknown): LogoutIntent | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  const parts = value.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [version, encodedEpoch, scope, sessionHint] = parts;
  if (version !== "v1" || !/^(0|[1-9][0-9]*)$/u.test(encodedEpoch ?? "")) return null;
  const epoch = Number(encodedEpoch);
  if (!validSafeInteger(epoch) || (scope !== "current" && scope !== "all")) return null;
  if (sessionHint !== undefined && !validUUID(sessionHint)) return null;
  return Object.freeze({ version: "v1", epoch, scope, sessionHint });
}
