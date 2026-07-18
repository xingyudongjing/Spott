import { describe, expect, test } from "vitest";

import {
  organizerContactDraftFromAuthorized,
  organizerContactPayload,
  organizerContactValid,
} from "../app/create/organizer-contact";

describe("event composer organizer contact", () => {
  test.each([
    ["email", "HOST@EXAMPLE.JP", "host@example.jp"],
    ["line", "spott_host-01", "spott_host-01"],
    ["website", "https://example.jp/contact", "https://example.jp/contact"],
  ] as const)("normalizes a valid %s channel", (kind, value, normalized) => {
    const draft = { kind, label: "  Event desk  ", value: `  ${value}  ` };

    expect(organizerContactValid(draft)).toBe(true);
    expect(organizerContactPayload(draft)).toEqual({
      kind,
      label: "Event desk",
      value: normalized,
    });
  });

  test.each([
    { kind: "email", label: "", value: "not-an-email" },
    { kind: "line", label: "", value: "contains spaces" },
    { kind: "website", label: "", value: "http://example.jp/contact" },
    { kind: "website", label: "", value: "javascript:alert(1)" },
    { kind: "email", label: "", value: "" },
  ] as const)("rejects missing or unsafe contact %#", (draft) => {
    expect(organizerContactValid(draft)).toBe(false);
  });

  test("omits a blank contact so an early cloud save cannot delete an existing encrypted channel", () => {
    expect(organizerContactPayload({ kind: "email", label: "", value: "  " })).toBeUndefined();
  });

  test("restores contact state only from an authorized remote detail", () => {
    expect(organizerContactDraftFromAuthorized({
      kind: "line",
      label: null,
      value: "spott_host",
    })).toEqual({ kind: "line", label: "", value: "spott_host" });
    expect(organizerContactDraftFromAuthorized(null)).toBeUndefined();
  });
});
