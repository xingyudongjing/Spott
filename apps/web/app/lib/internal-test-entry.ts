const INTERNAL_TEST_ORIGIN = "http://localhost:8080";

export function internalTestEntryHref(pathname: string | null | undefined) {
  const candidate = (pathname ?? "/").trim();
  if (
    !candidate.startsWith("/")
    || candidate.startsWith("//")
    || candidate.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    return `${INTERNAL_TEST_ORIGIN}/`;
  }

  const url = new URL(candidate, INTERNAL_TEST_ORIGIN);
  if (url.origin !== INTERNAL_TEST_ORIGIN) return `${INTERNAL_TEST_ORIGIN}/`;
  return `${INTERNAL_TEST_ORIGIN}${url.pathname}${url.search}`;
}
