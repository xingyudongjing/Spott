import { describe, expect, test, vi } from "vitest";

import { StableRequestAttempt } from "../app/lib/stable-request-attempt";

describe("StableRequestAttempt", () => {
  test("reuses one UUID for canonically equal JSON in the same request scope", () => {
    const randomUUID = vi
      .spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111");
    const attempt = new StableRequestAttempt();

    const first = attempt.keyFor({
      method: "post",
      path: "/reports",
      body: { targetId: "event", nested: { b: 2, a: 1 }, evidence: ["a", "b"] },
    });
    const retry = attempt.keyFor({
      method: "POST",
      path: "/reports",
      body: { evidence: ["a", "b"], nested: { a: 1, b: 2 }, targetId: "event" },
    });

    expect(retry).toBe(first);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  test("rotates for array order, transmitted values, and request scope changes", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333")
      .mockReturnValueOnce("44444444-4444-4444-8444-444444444444");
    const attempt = new StableRequestAttempt();

    const first = attempt.keyFor({ method: "POST", path: "/reports", body: { ids: ["a", "b"], value: 1 } });
    const reordered = attempt.keyFor({ method: "POST", path: "/reports", body: { ids: ["b", "a"], value: 1 } });
    const changed = attempt.keyFor({ method: "POST", path: "/reports", body: { ids: ["b", "a"], value: 2 } });
    const newScope = attempt.keyFor({ method: "POST", path: "/reports/preview", body: { ids: ["b", "a"], value: 2 } });

    expect(new Set([first, reordered, changed, newScope]).size).toBe(4);
  });

  test("clear makes the next identical logical attempt receive a new UUID", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const attempt = new StableRequestAttempt();
    const request = { method: "POST", path: "/reports", body: { reason: "fraud" } };

    const first = attempt.keyFor(request);
    attempt.clear();

    expect(attempt.keyFor(request)).not.toBe(first);
  });

  test("rejects values that cannot be represented as strict JSON", () => {
    const attempt = new StableRequestAttempt();

    expect(() => attempt.keyFor({ method: "POST", path: "/reports", body: { value: undefined } })).toThrow();
    expect(() => attempt.keyFor({ method: "POST", path: "/reports", body: { value: Number.NaN } })).toThrow();
    expect(() => attempt.keyFor({ method: "POST", path: "/reports", body: new Date() })).toThrow();
  });

  test("preserves JSON keys that are special on ordinary object prototypes", () => {
    vi.spyOn(globalThis.crypto, "randomUUID")
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("22222222-2222-4222-8222-222222222222");
    const attempt = new StableRequestAttempt();
    const special = JSON.parse('{"__proto__":{"polluted":true},"value":1}') as unknown;

    const first = attempt.keyFor({ method: "POST", path: "/reports", body: special });
    const second = attempt.keyFor({ method: "POST", path: "/reports", body: { value: 1 } });

    expect(second).not.toBe(first);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
