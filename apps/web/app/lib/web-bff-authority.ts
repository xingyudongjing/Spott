import { createHash, createHmac, randomBytes } from "node:crypto";

import type { SessionServerConfig, WebBFFKeyring } from "./session-server-config";

const authorityContext = "spott:web-bff-authority";
const canonicalBodyHashPattern = /^[0-9a-f]{64}$/u;
const canonicalNoncePattern = /^[A-Za-z0-9_-]{32,128}$/u;
const canonicalMethodPattern = /^[A-Z]+$/u;

export interface WebBFFAuthorityFields {
  readonly keyring: WebBFFKeyring;
  readonly version: "v1";
  readonly kid: string;
  readonly method: string;
  readonly path: string;
  readonly timestamp: number;
  readonly nonce: string;
  readonly bodyHash: string;
}

export interface WebBFFAuthorityHeaders {
  readonly "x-spott-bff-version": "v1";
  readonly "x-spott-bff-kid": string;
  readonly "x-spott-bff-timestamp": string;
  readonly "x-spott-bff-nonce": string;
  readonly "x-spott-bff-signature": string;
}

type AuthorityHeaderInput = {
  readonly config: SessionServerConfig;
  readonly method: string;
  readonly path: string;
  readonly timestamp?: number;
} & (
  | { readonly bodyHash: string; readonly body?: never }
  | { readonly body: Uint8Array; readonly bodyHash?: never }
);

function frameFields(fields: readonly (string | Uint8Array)[]): Buffer {
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const bytes = typeof field === "string"
      ? Buffer.from(field.normalize("NFC"), "utf8")
      : Buffer.from(field);
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.byteLength);
    chunks.push(length, bytes);
  }
  return Buffer.concat(chunks);
}

function validateCanonicalPath(path: string): void {
  if (
    !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("?")
    || path.includes("#")
    || path.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error("BFF authority path must be a canonical path without query or fragment");
  }
  const parsed = new URL(path, "https://spott.invalid");
  if (parsed.origin !== "https://spott.invalid" || parsed.pathname !== path) {
    throw new Error("BFF authority path must be canonical");
  }
}

export function signWebBFFAuthority(fields: WebBFFAuthorityFields): string {
  if (fields.version !== "v1") throw new Error("BFF authority version is unsupported");
  if (!canonicalMethodPattern.test(fields.method)) {
    throw new Error("BFF authority method must be canonical uppercase ASCII");
  }
  validateCanonicalPath(fields.path);
  if (!Number.isSafeInteger(fields.timestamp) || fields.timestamp < 0) {
    throw new Error("BFF authority timestamp must be a non-negative safe integer");
  }
  if (!canonicalNoncePattern.test(fields.nonce)) {
    throw new Error("BFF authority nonce must be fresh canonical base64url data");
  }
  if (!canonicalBodyHashPattern.test(fields.bodyHash)) {
    throw new Error("BFF authority body hash must be lowercase SHA-256 hexadecimal");
  }
  const key = fields.keyring.getKey(fields.kid);
  if (key === undefined) throw new Error("BFF authority KID is unknown");

  return createHmac("sha256", key)
    .update(frameFields([
      authorityContext,
      fields.version,
      fields.kid,
      fields.method,
      fields.path,
      String(fields.timestamp),
      fields.nonce,
      fields.bodyHash,
    ]))
    .digest("base64url");
}

export function createWebBFFAuthorityHeaders(input: AuthorityHeaderInput): WebBFFAuthorityHeaders {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = randomBytes(32).toString("base64url");
  const bodyHash = input.bodyHash ?? createHash("sha256").update(input.body).digest("hex");
  const kid = input.config.bffKeys.currentKid;
  const signature = signWebBFFAuthority({
    keyring: input.config.bffKeys,
    version: "v1",
    kid,
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodyHash,
  });
  return Object.freeze({
    "x-spott-bff-version": "v1",
    "x-spott-bff-kid": kid,
    "x-spott-bff-timestamp": String(timestamp),
    "x-spott-bff-nonce": nonce,
    "x-spott-bff-signature": signature,
  });
}
