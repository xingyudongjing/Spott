export type SessionMutationRejectionCode =
  | "SESSION_MUTATION_ORIGIN_INVALID"
  | "SESSION_MUTATION_FETCH_SITE_INVALID"
  | "SESSION_MUTATION_FETCH_MODE_INVALID"
  | "SESSION_MUTATION_FETCH_DEST_INVALID";

export type SessionMutationValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: SessionMutationRejectionCode };

type HeaderRecord = Readonly<Record<string, string | readonly string[] | undefined>>;

function singleHeader(headers: HeaderRecord | Headers, name: string): string | null {
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name);
    return value !== null && value !== "" && !value.includes(",") ? value : null;
  }

  let found: string | null = null;
  for (const [headerName, raw] of Object.entries(headers as HeaderRecord)) {
    if (headerName.toLowerCase() !== name) continue;
    if (found !== null || typeof raw !== "string" || raw === "" || raw.includes(",")) return null;
    found = raw;
  }
  return found;
}

export function validateSessionMutationRequest(
  headers: HeaderRecord | Headers,
  canonicalOrigin: string,
): SessionMutationValidation {
  if (singleHeader(headers, "origin") !== canonicalOrigin) {
    return { ok: false, code: "SESSION_MUTATION_ORIGIN_INVALID" };
  }
  if (singleHeader(headers, "sec-fetch-site") !== "same-origin") {
    return { ok: false, code: "SESSION_MUTATION_FETCH_SITE_INVALID" };
  }
  const mode = singleHeader(headers, "sec-fetch-mode");
  if (mode !== "cors" && mode !== "same-origin") {
    return { ok: false, code: "SESSION_MUTATION_FETCH_MODE_INVALID" };
  }
  if (singleHeader(headers, "sec-fetch-dest") !== "empty") {
    return { ok: false, code: "SESSION_MUTATION_FETCH_DEST_INVALID" };
  }
  return { ok: true };
}
