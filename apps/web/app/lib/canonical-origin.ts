type CanonicalOriginEnvironment = Readonly<Record<string, string | undefined>>;

function configurationError(reason: string): Error {
  return new Error(`SPOTT_WEB_CANONICAL_ORIGIN: ${reason}`);
}

export function parseWebCanonicalOrigin(
  value: string | undefined,
  production: boolean,
): string {
  if (value === undefined || value === "") {
    throw configurationError("required server configuration is missing");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw configurationError("must be one canonical HTTP(S) origin");
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
    throw configurationError("must be one canonical HTTP(S) origin");
  }
  if (production && url.protocol !== "https:") {
    throw configurationError("must use HTTPS in production");
  }
  return value;
}

export function configuredCanonicalOrigin(environment: CanonicalOriginEnvironment): string {
  return parseWebCanonicalOrigin(
    environment.SPOTT_WEB_CANONICAL_ORIGIN,
    environment.NODE_ENV === "production",
  );
}
