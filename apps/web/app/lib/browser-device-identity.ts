"use client";

const DEVICE_KEY = "spott.web.device.v1";
const DEVICE_BINDING_STATE_KEY = "spott.web.device-binding-state.v1";
const DEVICE_PROBE_PREFIX = "spott.web.device-probe.v1.";
const UNBOUND_STATE = "unbound";
const BOUND_STATE = "bound";
const canonicalDeviceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

let volatileDeviceId: string | null = null;

export interface LoginDevicePlan {
  readonly kind: "reuse" | "rotate";
  readonly predecessorId: string;
  readonly deviceId: string;
}

export class DeviceIdentityStorageError extends Error {
  constructor() {
    super("Secure browser device storage is unavailable.");
    this.name = "DeviceIdentityStorageError";
  }
}

function canonicalDeviceId(value: string | null): value is string {
  return value !== null && canonicalDeviceIdPattern.test(value);
}

function generateDeviceId(): string {
  if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();

  // randomUUID is restricted to secure contexts, while getRandomValues remains
  // available on raw-HTTP preview origins. Keep the same RFC 4122 v4 contract.
  const bytes = window.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function browserStorage(): Storage {
  if (typeof window === "undefined") throw new DeviceIdentityStorageError();
  try {
    return window.localStorage;
  } catch {
    throw new DeviceIdentityStorageError();
  }
}

function writeAndReadBack(storage: Storage, key: string, value: string): boolean {
  try {
    storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

function storageIsWritable(storage: Storage): boolean {
  const key = `${DEVICE_PROBE_PREFIX}${generateDeviceId()}`;
  try {
    storage.setItem(key, "1");
    if (storage.getItem(key) !== "1") return false;
    storage.removeItem(key);
    return storage.getItem(key) === null;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // The caller fails closed; a non-secret probe may remain in a broken store.
    }
    return false;
  }
}

export function deviceId(): string {
  if (typeof window === "undefined") return "00000000-0000-4000-8000-000000000000";
  try {
    const storage = browserStorage();
    const stored = storage.getItem(DEVICE_KEY);
    if (canonicalDeviceId(stored)) {
      volatileDeviceId = stored;
      return stored;
    }
    const generated = volatileDeviceId && canonicalDeviceId(volatileDeviceId)
      ? volatileDeviceId
      : generateDeviceId();
    volatileDeviceId = generated;
    if (writeAndReadBack(storage, DEVICE_KEY, generated)) {
      writeAndReadBack(storage, DEVICE_BINDING_STATE_KEY, UNBOUND_STATE);
    }
    return generated;
  } catch {
    if (!volatileDeviceId || !canonicalDeviceId(volatileDeviceId)) {
      volatileDeviceId = generateDeviceId();
    }
    return volatileDeviceId;
  }
}

export function markCurrentDeviceBound(): boolean {
  if (typeof window === "undefined") return false;
  const current = deviceId();
  try {
    const storage = browserStorage();
    return storage.getItem(DEVICE_KEY) === current
      && writeAndReadBack(storage, DEVICE_BINDING_STATE_KEY, BOUND_STATE);
  } catch {
    return false;
  }
}

export function prepareEmailLoginDevice(options: {
  readonly switching: boolean;
}): LoginDevicePlan {
  void options;
  const current = deviceId();
  const storage = browserStorage();
  let stored: string | null;
  try {
    stored = storage.getItem(DEVICE_KEY);
  } catch {
    throw new DeviceIdentityStorageError();
  }
  if (stored !== current || !canonicalDeviceId(stored) || !storageIsWritable(storage)) {
    throw new DeviceIdentityStorageError();
  }
  // The browser cannot prove which account owns an existing device while it is
  // anonymous. Always use an uncommitted candidate for credential login, even
  // when the predecessor is labelled unbound: a prior completion may have
  // reached the server before that label could be updated locally.
  return Object.freeze({
    kind: "rotate",
    predecessorId: current,
    deviceId: generateDeviceId(),
  });
}

function validPlan(plan: LoginDevicePlan): boolean {
  return canonicalDeviceId(plan.predecessorId)
    && canonicalDeviceId(plan.deviceId)
    && (
      (plan.kind === "reuse" && plan.predecessorId === plan.deviceId)
      || (plan.kind === "rotate" && plan.predecessorId !== plan.deviceId)
    );
}

export function assertLoginDevicePlanCurrent(plan: LoginDevicePlan): boolean {
  if (!validPlan(plan)) return false;
  try {
    const storage = browserStorage();
    if (!storageIsWritable(storage) || storage.getItem(DEVICE_KEY) !== plan.predecessorId) {
      return false;
    }
    return plan.kind === "rotate"
      || storage.getItem(DEVICE_BINDING_STATE_KEY) === UNBOUND_STATE;
  } catch {
    return false;
  }
}

export function assertLoginDevicePlanCommitted(plan: LoginDevicePlan): boolean {
  if (!validPlan(plan)) return false;
  try {
    const storage = browserStorage();
    return storageIsWritable(storage)
      && storage.getItem(DEVICE_KEY) === plan.deviceId
      && storage.getItem(DEVICE_BINDING_STATE_KEY) === BOUND_STATE;
  } catch {
    return false;
  }
}

export function commitLoginDevicePlan(plan: LoginDevicePlan): boolean {
  if (!assertLoginDevicePlanCurrent(plan)) return false;
  try {
    const storage = browserStorage();
    // Persist the conservative ownership state first. If the following device
    // write is interrupted, the predecessor remains marked as possibly bound;
    // we never leave a new server-bound candidate labelled `unbound`.
    if (!writeAndReadBack(storage, DEVICE_BINDING_STATE_KEY, BOUND_STATE)) {
      return false;
    }
    if (plan.kind === "rotate" && !writeAndReadBack(storage, DEVICE_KEY, plan.deviceId)) {
      rollbackLoginDevicePlan(plan);
      return false;
    }
    volatileDeviceId = plan.deviceId;
    return true;
  } catch {
    return false;
  }
}

export function rollbackLoginDevicePlan(plan: LoginDevicePlan): boolean {
  if (!validPlan(plan)) return false;
  try {
    const storage = browserStorage();
    const current = storage.getItem(DEVICE_KEY);
    if (plan.kind === "rotate") {
      // Compare-and-swap: never overwrite a device committed by a newer tab.
      if (current !== plan.deviceId) {
        if (current !== plan.predecessorId) return false;
        volatileDeviceId = plan.predecessorId;
        return true;
      }
      if (!writeAndReadBack(storage, DEVICE_BINDING_STATE_KEY, BOUND_STATE)) return false;
      if (!writeAndReadBack(storage, DEVICE_KEY, plan.predecessorId)) return false;
    } else if (current !== plan.predecessorId) {
      return false;
    }
    volatileDeviceId = plan.predecessorId;
    return true;
  } catch {
    return false;
  }
}
