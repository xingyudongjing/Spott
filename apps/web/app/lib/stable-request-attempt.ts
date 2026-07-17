export interface StableRequestDescriptor {
  method: string;
  path: string;
  body: unknown;
}

export class StableRequestAttempt {
  private fingerprint: string | null = null;
  private idempotencyKey: string | null = null;

  keyFor(request: StableRequestDescriptor): string {
    const fingerprint = canonicalJSON({
      method: request.method.toUpperCase(),
      path: request.path,
      body: request.body,
    });
    if (this.fingerprint !== fingerprint || !this.idempotencyKey) {
      this.fingerprint = fingerprint;
      this.idempotencyKey = crypto.randomUUID();
    }
    return this.idempotencyKey;
  }

  clear(): void {
    this.fingerprint = null;
    this.idempotencyKey = null;
  }
}

export function canonicalJSON(value: unknown): string {
  return JSON.stringify(normalizeJSON(value));
}

function normalizeJSON(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Stable request values must be finite JSON numbers.");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJSON);
  if (typeof value !== "object") throw new TypeError("Stable request values must be strict JSON.");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Stable request objects must be plain JSON objects.");
  }
  const normalized = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    normalized[key] = normalizeJSON((value as Record<string, unknown>)[key]);
  }
  return normalized;
}
