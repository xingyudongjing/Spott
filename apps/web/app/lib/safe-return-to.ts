/**
 * Resolves a caller-supplied `returnTo` against the current origin and only
 * accepts it when it stays on that exact origin.
 *
 * Prefix checks such as `value.startsWith('/') && !value.startsWith('//')` are
 * not sufficient. Browsers normalise a backslash to a forward slash while
 * parsing, so `/\evil.example` passes both prefix checks and then navigates to
 * the protocol-relative target `//evil.example`. Parsing with WHATWG `URL` and
 * comparing origins reproduces the browser's own normalisation, which is the
 * only comparison that matches what the address bar will actually do.
 */
export function safeReturnTo(value: string | null | undefined, fallback = "/discover"): string {
  if (typeof value !== "string" || value.length === 0) return fallback;

  // Browsers strip tab/newline/carriage-return anywhere in a URL before
  // parsing, so strip them first rather than letting a smuggled "/\t/host"
  // survive the origin check and be re-normalised during navigation.
  const stripped = value.replace(/[\t\n\r]/g, "");
  if (!stripped.startsWith("/")) return fallback;

  // A leading "/\" or "//" is protocol-relative once normalised.
  if (stripped.length > 1 && (stripped[1] === "/" || stripped[1] === "\\")) return fallback;

  const base = typeof window !== "undefined" ? window.location.origin : "https://spott.jp";

  let resolved: URL;
  try {
    resolved = new URL(stripped, base);
  } catch {
    return fallback;
  }
  if (resolved.origin !== base) return fallback;

  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}
