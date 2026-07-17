import { describe, expect, test } from "vitest";

import { safeReturnTo } from "../app/lib/safe-return-to";

describe("safeReturnTo", () => {
  test.each([
    ["/discover", "/discover"],
    ["/e/tokyo-picnic", "/e/tokyo-picnic"],
    ["/discover?city=tokyo", "/discover?city=tokyo"],
    ["/discover?city=tokyo#list", "/discover?city=tokyo#list"],
    ["/g/hikers?tab=posts", "/g/hikers?tab=posts"],
  ])("keeps the same-origin path %s", (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
  });

  test.each([
    // Backslash: browsers normalise "/\" to "//", making this protocol-relative.
    ["/\\evil.example"],
    ["/\\\\evil.example"],
    ["/\\/evil.example"],
    // Protocol-relative and absolute cross-origin targets.
    ["//evil.example"],
    ["//evil.example/path"],
    ["https://evil.example"],
    ["http://evil.example/discover"],
    ["javascript:alert(1)"],
    ["data:text/html,<script>alert(1)</script>"],
    // Control characters browsers strip before parsing.
    ["/\t/evil.example"],
    ["/\n/evil.example"],
    ["\\/evil.example"],
    // Relative, non-absolute paths.
    ["discover"],
    [""],
  ])("rejects the unsafe target %j", (input) => {
    expect(safeReturnTo(input)).toBe("/discover");
  });

  test("honours a caller-supplied fallback", () => {
    expect(safeReturnTo("https://evil.example", "/me")).toBe("/me");
  });

  test("never returns an absolute URL for any input", () => {
    const hostile = [
      "/\\evil.example",
      "//evil.example",
      "https://evil.example",
      "/\t/evil.example",
    ];
    for (const value of hostile) {
      const result = safeReturnTo(value);
      expect(new URL(result, "https://spott.jp").origin).toBe("https://spott.jp");
    }
  });
});
