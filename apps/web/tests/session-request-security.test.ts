import { describe, expect, test } from "vitest";

import { validateSessionMutationRequest } from "../app/lib/session-request-security";

const origin = "https://spott.example";
const validHeaders = {
  origin,
  "sec-fetch-site": "same-origin",
  "sec-fetch-mode": "cors",
  "sec-fetch-dest": "empty",
};

describe("validateSessionMutationRequest", () => {
  test.each(["cors", "same-origin"])("accepts an exact same-origin %s mutation", (mode) => {
    expect(validateSessionMutationRequest({ ...validHeaders, "sec-fetch-mode": mode }, origin)).toEqual({ ok: true });
  });

  test.each([
    ["missing origin", { origin: undefined }, "SESSION_MUTATION_ORIGIN_INVALID"],
    ["mismatched origin", { origin: "https://evil.example" }, "SESSION_MUTATION_ORIGIN_INVALID"],
    ["folded origin", { origin: `${origin}, https://evil.example` }, "SESSION_MUTATION_ORIGIN_INVALID"],
    ["repeated origin", { origin: [origin, origin] }, "SESSION_MUTATION_ORIGIN_INVALID"],
    ["cross-site", { "sec-fetch-site": "cross-site" }, "SESSION_MUTATION_FETCH_SITE_INVALID"],
    ["missing site", { "sec-fetch-site": undefined }, "SESSION_MUTATION_FETCH_SITE_INVALID"],
    ["navigate", { "sec-fetch-mode": "navigate" }, "SESSION_MUTATION_FETCH_MODE_INVALID"],
    ["no-cors", { "sec-fetch-mode": "no-cors" }, "SESSION_MUTATION_FETCH_MODE_INVALID"],
    ["non-empty destination", { "sec-fetch-dest": "document" }, "SESSION_MUTATION_FETCH_DEST_INVALID"],
    ["missing destination", { "sec-fetch-dest": undefined }, "SESSION_MUTATION_FETCH_DEST_INVALID"],
  ])("rejects %s without reflecting the supplied value", (_label, mutation, code) => {
    const result = validateSessionMutationRequest({ ...validHeaders, ...mutation }, origin);
    expect(result).toEqual({ ok: false, code });
    expect(JSON.stringify(result)).not.toContain("evil.example");
    expect(JSON.stringify(result)).not.toContain("cross-site");
  });

  test("does not infer authority from Host or forwarded headers", () => {
    expect(validateSessionMutationRequest({
      ...validHeaders,
      origin: undefined,
      host: "spott.example",
      "x-forwarded-host": "spott.example",
      "x-forwarded-proto": "https",
    }, origin)).toEqual({ ok: false, code: "SESSION_MUTATION_ORIGIN_INVALID" });
  });
});
