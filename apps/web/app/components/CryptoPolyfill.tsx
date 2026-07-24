"use client";

// `crypto.randomUUID` (and the rest of the Web Crypto API) is only exposed in a
// secure context — HTTPS or localhost. The IP preview is served over plain HTTP
// on a public host, so `crypto.randomUUID` is undefined in the browser there and
// every idempotency-key / device-id / attempt-id call site throws. This installs
// a spec-shaped v4 fallback built on `crypto.getRandomValues`, which IS available
// in insecure contexts. On HTTPS or localhost the native implementation is kept.
// Remove-safe once the preview is behind TLS.
if (typeof globalThis !== "undefined") {
  const webCrypto = globalThis.crypto as
    | (Crypto & { randomUUID?: () => `${string}-${string}-${string}-${string}-${string}` })
    | undefined;
  if (
    webCrypto &&
    typeof webCrypto.randomUUID !== "function" &&
    typeof webCrypto.getRandomValues === "function"
  ) {
    webCrypto.randomUUID = () => {
      const bytes = webCrypto.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0"));
      return `${hex[0]}${hex[1]}${hex[2]}${hex[3]}-${hex[4]}${hex[5]}-${hex[6]}${hex[7]}-${hex[8]}${hex[9]}-${hex[10]}${hex[11]}${hex[12]}${hex[13]}${hex[14]}${hex[15]}` as `${string}-${string}-${string}-${string}-${string}`;
    };
  }
}

export function CryptoPolyfill() {
  return null;
}
