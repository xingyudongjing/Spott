import { Buffer } from "node:buffer";

const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const canonicalBase64URLPattern = /^[A-Za-z0-9_-]+$/u;
const maximumRecoverySeconds = 900;

export interface WebBFFKeyring extends Iterable<readonly [string, Buffer]> {
  readonly currentKid: string;
  getKey(kid: string): Buffer | undefined;
  entries(): IterableIterator<readonly [string, Buffer]>;
}

export interface SessionServerConfig {
  readonly nodeEnvironment: "development" | "test" | "production";
  readonly bffKeys: WebBFFKeyring;
  readonly canonicalOrigin: string;
  readonly apiInternalURL: string;
  readonly recoverySeconds: number;
}

function configurationError(variable: string, reason: string): Error {
  return new Error(`${variable}: ${reason}`);
}

type SessionServerEnvironment = Readonly<Record<string, string | undefined>>;

function required(environment: SessionServerEnvironment, variable: string): string {
  const value = environment[variable];
  if (value === undefined || value === "") {
    throw configurationError(variable, "required server configuration is missing");
  }
  return value;
}

function immutableKeyring(source: ReadonlyMap<string, Buffer>, currentKid: string): WebBFFKeyring {
  const keys = new Map([...source].map(([kid, key]) => [kid, Buffer.from(key)] as const));
  const entries = function* (): IterableIterator<readonly [string, Buffer]> {
    for (const [kid, key] of keys) yield [kid, Buffer.from(key)] as const;
  };

  return Object.freeze({
    currentKid,
    getKey(kid: string): Buffer | undefined {
      const key = keys.get(kid);
      return key === undefined ? undefined : Buffer.from(key);
    },
    entries,
    [Symbol.iterator]: entries,
  });
}

function parseKeyring(value: string, currentKid: string): WebBFFKeyring {
  if (!keyIdPattern.test(currentKid)) {
    throw configurationError("SPOTT_WEB_BFF_CURRENT_KID", "current KID is invalid");
  }

  const keys = new Map<string, Buffer>();
  const materialFingerprints = new Set<string>();
  for (const entry of value.split(",")) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator !== entry.lastIndexOf(":")) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "every entry must use KID:base64url format");
    }
    const kid = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (!keyIdPattern.test(kid)) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "a KID is invalid");
    }
    if (keys.has(kid)) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "duplicate KIDs are forbidden");
    }
    if (!canonicalBase64URLPattern.test(encoded)) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "key material must be canonical base64url");
    }
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "key material must be canonical base64url");
    }
    if (decoded.byteLength < 32) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "each key must contain at least 32 bytes");
    }
    const fingerprint = decoded.toString("hex");
    if (materialFingerprints.has(fingerprint)) {
      throw configurationError("SPOTT_WEB_BFF_KEYS", "duplicate decoded key material is forbidden");
    }
    keys.set(kid, Buffer.from(decoded));
    materialFingerprints.add(fingerprint);
  }
  if (keys.size === 0) {
    throw configurationError("SPOTT_WEB_BFF_KEYS", "keyring must not be empty");
  }
  if (!keys.has(currentKid)) {
    throw configurationError("SPOTT_WEB_BFF_CURRENT_KID", "current KID is not present in the keyring");
  }
  return immutableKeyring(keys, currentKid);
}

function parseCanonicalOrigin(value: string, production: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("SPOTT_WEB_CANONICAL_ORIGIN", "must be one canonical HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.origin !== value
    || url.pathname !== "/"
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw configurationError("SPOTT_WEB_CANONICAL_ORIGIN", "must be one canonical HTTP(S) origin");
  }
  if (production && url.protocol !== "https:") {
    throw configurationError("SPOTT_WEB_CANONICAL_ORIGIN", "must use HTTPS in production");
  }
  return value;
}

function parseInternalAPIURL(value: string): string {
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw configurationError("API_INTERNAL_URL", "must be an absolute canonical HTTP(S) /v1 URL");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.pathname !== "/v1"
    || url.search !== ""
    || url.hash !== ""
    || url.toString() !== normalized
  ) {
    throw configurationError("API_INTERNAL_URL", "must be an absolute canonical HTTP(S) URL ending in /v1");
  }
  return normalized;
}

function parseRecoverySeconds(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw configurationError("WEB_SESSION_RECOVERY_SECONDS", "must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > maximumRecoverySeconds) {
    throw configurationError("WEB_SESSION_RECOVERY_SECONDS", "must be between 1 and 900 seconds");
  }
  return parsed;
}

export function parseSessionServerConfig(environment: SessionServerEnvironment): SessionServerConfig {
  const nodeEnvironment = environment.NODE_ENV;
  if (nodeEnvironment !== "development" && nodeEnvironment !== "test" && nodeEnvironment !== "production") {
    throw configurationError("NODE_ENV", "must be development, test, or production");
  }
  const currentKid = required(environment, "SPOTT_WEB_BFF_CURRENT_KID");
  const config: SessionServerConfig = {
    nodeEnvironment,
    bffKeys: parseKeyring(required(environment, "SPOTT_WEB_BFF_KEYS"), currentKid),
    canonicalOrigin: parseCanonicalOrigin(
      required(environment, "SPOTT_WEB_CANONICAL_ORIGIN"),
      nodeEnvironment === "production",
    ),
    apiInternalURL: parseInternalAPIURL(required(environment, "API_INTERNAL_URL")),
    recoverySeconds: parseRecoverySeconds(required(environment, "WEB_SESSION_RECOVERY_SECONDS")),
  };
  return Object.freeze(config);
}
