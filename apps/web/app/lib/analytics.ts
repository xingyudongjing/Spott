"use client";

import { apiRequest, deviceId } from "./client-api";

const CONSENT_KEY = "spott.analytics.consent.v1";
const SESSION_KEY = "spott.analytics.session.v1";
const forbiddenProperty = /(^|_)(phone|email|address|otp|code|token|password|evidence|statement|body|message)($|_)/i;
let fallbackSessionId: string | null = null;

export type AnalyticsProperties = Record<string, unknown>;

export function analyticsConsent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CONSENT_KEY) === "granted";
  } catch {
    return false;
  }
}

export function setAnalyticsConsent(granted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_KEY, granted ? "granted" : "denied");
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  window.dispatchEvent(new CustomEvent("spott:analytics-consent", { detail: granted }));
}

export async function trackProductEvent(
  eventName: string,
  properties: AnalyticsProperties = {},
): Promise<void> {
  if (typeof window === "undefined" || !analyticsConsent()) return;
  if (!/^[a-z][a-z0-9_]{2,79}$/.test(eventName)) return;

  try {
    await apiRequest<{ accepted: number }>("/analytics/events/batch", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            eventName,
            schemaVersion: 1,
            anonymousId: deviceId(),
            sessionId: analyticsSessionId(),
            platform: "web",
            properties: sanitizeProperties(properties),
            occurredAt: new Date().toISOString(),
          },
        ],
      }),
    });
  } catch {
    // Product analytics is best-effort and must never block a user workflow.
  }
}

function analyticsSessionId(): string {
  try {
    let value = window.sessionStorage.getItem(SESSION_KEY);
    if (!value) {
      value = window.crypto.randomUUID();
      window.sessionStorage.setItem(SESSION_KEY, value);
    }
    return value;
  } catch {
    fallbackSessionId ??= window.crypto.randomUUID();
    return fallbackSessionId;
  }
}

function sanitizeProperties(properties: AnalyticsProperties): AnalyticsProperties {
  const sanitized = sanitizeValue(properties, 0);
  return sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
    ? (sanitized as AnalyticsProperties)
    : {};
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return value.slice(0, 160);
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (depth >= 3) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 20)
      .map((item) => sanitizeValue(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== "object") return undefined;

  const result: AnalyticsProperties = {};
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenProperty.test(key) || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) continue;
    const sanitized = sanitizeValue(child, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}
