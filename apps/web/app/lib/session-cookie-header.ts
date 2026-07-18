const maximumEnvelopeLength = 4_096;
const maximumCookieHeaderLength = 16_384;
const logoutIntentPresencePattern = /(?:^|;)[\t ]*__Host-spott_logout_intent[\t ]*(?:=|;|$)/u;

export interface ParsedSessionCookieHeader {
  readonly kind: 'parsed';
  readonly refreshEnvelope: string | null;
  readonly deviceBindingEnvelope: string | null;
}

export interface InvalidSessionCookieHeader {
  readonly kind: 'invalid';
}

export interface LogoutIntentCookiePresent {
  readonly kind: 'logout_intent_present';
}

export type SessionCookieHeaderResult =
  ParsedSessionCookieHeader | InvalidSessionCookieHeader | LogoutIntentCookiePresent;

function cookieName(segment: string): string {
  const separator = segment.indexOf('=');
  return segment.slice(0, separator < 0 ? undefined : separator).trim();
}

export function parseSessionCookieHeader(
  header: string | null | undefined,
): SessionCookieHeaderResult {
  let refreshEnvelope: string | null = null;
  let deviceBindingEnvelope: string | null = null;

  if (header !== null && header !== undefined && logoutIntentPresencePattern.test(header)) {
    return { kind: 'logout_intent_present' };
  }
  if (header !== null && header !== undefined && header.length > maximumCookieHeaderLength) {
    return { kind: 'invalid' };
  }

  for (const segment of header?.split(';') ?? []) {
    const separator = segment.indexOf('=');
    const name = cookieName(segment);
    const recognized = name === '__Host-spott_refresh' || name === '__Host-spott_device_binding';
    if (!recognized) continue;
    if (separator < 0) return { kind: 'invalid' };
    const value = segment.slice(separator + 1).trim();
    if (value === '' || value.length > maximumEnvelopeLength) return { kind: 'invalid' };
    if (name === '__Host-spott_refresh') {
      if (refreshEnvelope !== null) return { kind: 'invalid' };
      refreshEnvelope = value;
    }
    if (name === '__Host-spott_device_binding') {
      if (deviceBindingEnvelope !== null) return { kind: 'invalid' };
      deviceBindingEnvelope = value;
    }
  }

  return { kind: 'parsed', refreshEnvelope, deviceBindingEnvelope };
}
