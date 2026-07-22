import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  assertLoginDevicePlanCommitted,
  assertLoginDevicePlanCurrent,
  commitLoginDevicePlan,
  deviceId,
  markCurrentDeviceBound,
  prepareEmailLoginDevice,
  rollbackLoginDevicePlan,
} from "../app/lib/browser-device-identity";

const deviceKey = "spott.web.device.v1";
const bindingStateKey = "spott.web.device-binding-state.v1";

describe("browser login device identity", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  test("keeps a fresh candidate private for the first credential login", () => {
    const current = deviceId();

    const plan = prepareEmailLoginDevice({ switching: false });

    expect(plan.kind).toBe("rotate");
    expect(plan.predecessorId).toBe(current);
    expect(plan.deviceId).not.toBe(current);
    expect(window.localStorage.getItem(deviceKey)).toBe(current);
    expect(window.localStorage.getItem(bindingStateKey)).toBe("unbound");
  });

  test("keeps a rotation candidate private until its verified commit", () => {
    const current = deviceId();
    expect(markCurrentDeviceBound()).toBe(true);

    const plan = prepareEmailLoginDevice({ switching: true });

    expect(plan.kind).toBe("rotate");
    expect(plan.predecessorId).toBe(current);
    expect(plan.deviceId).not.toBe(current);
    expect(window.localStorage.getItem(deviceKey)).toBe(current);
    expect(assertLoginDevicePlanCurrent(plan)).toBe(true);

    expect(commitLoginDevicePlan(plan)).toBe(true);
    expect(assertLoginDevicePlanCommitted(plan)).toBe(true);
    expect(window.localStorage.getItem(deviceKey)).toBe(plan.deviceId);
    expect(window.localStorage.getItem(bindingStateKey)).toBe("bound");
  });

  test("treats a legacy identity with unknown ownership as possibly bound", () => {
    const legacy = "019d0000-0000-7000-8000-000000000301";
    window.localStorage.setItem(deviceKey, legacy);

    const plan = prepareEmailLoginDevice({ switching: false });

    expect(plan).toMatchObject({ kind: "rotate", predecessorId: legacy });
    expect(plan.deviceId).not.toBe(legacy);
    expect(window.localStorage.getItem(deviceKey)).toBe(legacy);
  });

  test("rejects a stale competing plan after another plan commits", () => {
    deviceId();
    expect(markCurrentDeviceBound()).toBe(true);
    const first = prepareEmailLoginDevice({ switching: true });
    const stale = prepareEmailLoginDevice({ switching: true });

    expect(commitLoginDevicePlan(first)).toBe(true);

    expect(assertLoginDevicePlanCurrent(stale)).toBe(false);
    expect(commitLoginDevicePlan(stale)).toBe(false);
    expect(window.localStorage.getItem(deviceKey)).toBe(first.deviceId);
  });

  test("never exposes a candidate when the conservative bound write fails", () => {
    const current = deviceId();
    const plan = prepareEmailLoginDevice({ switching: false });
    const nativeSetItem = Storage.prototype.setItem;
    const writes: Array<[string, string]> = [];
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key,
      value,
    ) {
      writes.push([key, value]);
      if (key === bindingStateKey && value === "bound") {
        throw new DOMException("Storage denied", "SecurityError");
      }
      return nativeSetItem.call(this, key, value);
    });

    expect(commitLoginDevicePlan(plan)).toBe(false);

    expect(window.localStorage.getItem(deviceKey)).toBe(current);
    expect(writes).not.toContainEqual([deviceKey, plan.deviceId]);
    const retry = prepareEmailLoginDevice({ switching: false });
    expect(retry.deviceId).not.toBe(plan.deviceId);
  });

  test("never rolls back over a newer tab's committed device", () => {
    deviceId();
    expect(markCurrentDeviceBound()).toBe(true);
    const stale = prepareEmailLoginDevice({ switching: true });
    const winner = "019d0000-0000-7000-8000-000000000302";
    window.localStorage.setItem(deviceKey, winner);

    expect(rollbackLoginDevicePlan(stale)).toBe(false);
    expect(window.localStorage.getItem(deviceKey)).toBe(winner);
  });

  test("verifies a committed candidate through strict persistent readback", () => {
    deviceId();
    const plan = prepareEmailLoginDevice({ switching: false });

    expect(assertLoginDevicePlanCommitted(plan)).toBe(false);
    expect(commitLoginDevicePlan(plan)).toBe(true);
    expect(assertLoginDevicePlanCommitted(plan)).toBe(true);

    window.localStorage.setItem(bindingStateKey, "unbound");
    expect(assertLoginDevicePlanCommitted(plan)).toBe(false);
  });

  test("fails committed verification closed when persistent storage is unreadable", () => {
    deviceId();
    const plan = prepareEmailLoginDevice({ switching: false });
    expect(commitLoginDevicePlan(plan)).toBe(true);
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });

    expect(assertLoginDevicePlanCommitted(plan)).toBe(false);
  });

  test("replaces a malformed stored identity instead of sending it upstream", () => {
    window.localStorage.setItem(deviceKey, "not-a-device-id");
    window.localStorage.setItem(bindingStateKey, "bound");

    const current = deviceId();

    expect(current).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(window.localStorage.getItem(deviceKey)).toBe(current);
    expect(window.localStorage.getItem(bindingStateKey)).toBe("unbound");
  });
});
