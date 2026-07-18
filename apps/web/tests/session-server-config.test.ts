import { describe, expect, test } from "vitest";

import { parseSessionServerConfig } from "../app/lib/session-server-config";

const keyA = Buffer.alloc(32, 0x11).toString("base64url");
const keyB = Buffer.alloc(32, 0x22).toString("base64url");

function environment(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return Object.assign({
    NODE_ENV: "test",
    SPOTT_WEB_BFF_KEYS: `current:${keyA},retired:${keyB}`,
    SPOTT_WEB_BFF_CURRENT_KID: "current",
    SPOTT_WEB_CANONICAL_ORIGIN: "https://spott.example",
    API_INTERNAL_URL: "http://api.internal:4100/v1/",
    WEB_SESSION_RECOVERY_SECONDS: "120",
  }, overrides);
}

describe("parseSessionServerConfig", () => {
  test("returns an immutable canonical server-only configuration", () => {
    const config = parseSessionServerConfig(environment());

    expect(config.canonicalOrigin).toBe("https://spott.example");
    expect(config.apiInternalURL).toBe("http://api.internal:4100/v1");
    expect(config.recoverySeconds).toBe(120);
    expect(config.bffKeys.currentKid).toBe("current");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.bffKeys)).toBe(true);
  });

  test("returns defensive key copies", () => {
    const config = parseSessionServerConfig(environment());
    const first = config.bffKeys.getKey("current");
    first?.fill(0);

    expect(config.bffKeys.getKey("current")).toEqual(Buffer.alloc(32, 0x11));
    const entry = [...config.bffKeys][0]?.[1];
    entry?.fill(0);
    expect(config.bffKeys.getKey("current")).toEqual(Buffer.alloc(32, 0x11));
  });

  test.each([
    ["empty", { SPOTT_WEB_BFF_KEYS: "" }],
    ["duplicate KID", { SPOTT_WEB_BFF_KEYS: `current:${keyA},current:${keyB}` }],
    ["duplicate material", { SPOTT_WEB_BFF_KEYS: `current:${keyA},retired:${keyA}` }],
    ["padding", { SPOTT_WEB_BFF_KEYS: `current:${keyA}=`, SPOTT_WEB_BFF_CURRENT_KID: "current" }],
    ["short key", { SPOTT_WEB_BFF_KEYS: `current:${Buffer.alloc(31).toString("base64url")}` }],
    ["invalid KID", { SPOTT_WEB_BFF_KEYS: `bad kid:${keyA}`, SPOTT_WEB_BFF_CURRENT_KID: "bad kid" }],
    ["unknown current", { SPOTT_WEB_BFF_CURRENT_KID: "missing" }],
  ])("rejects an invalid keyring: %s", (_label, overrides) => {
    expect(() => parseSessionServerConfig(environment(overrides))).toThrow();
  });

  test.each([
    ["path", "https://spott.example/path"],
    ["query", "https://spott.example?x=1"],
    ["hash", "https://spott.example#x"],
    ["userinfo", "https://user@spott.example"],
    ["trailing slash", "https://spott.example/"],
    ["non-HTTP", "ftp://spott.example"],
  ])("rejects a noncanonical origin with %s", (_label, value) => {
    expect(() => parseSessionServerConfig(environment({ SPOTT_WEB_CANONICAL_ORIGIN: value }))).toThrow();
  });

  test("requires HTTPS for the production canonical origin", () => {
    expect(() => parseSessionServerConfig(environment({
      NODE_ENV: "production",
      SPOTT_WEB_CANONICAL_ORIGIN: "http://spott.example",
    }))).toThrow(/HTTPS/u);
  });

  test.each([
    ["wrong suffix", "http://api.internal/auth"],
    ["query", "http://api.internal/v1?x=1"],
    ["hash", "http://api.internal/v1#x"],
    ["userinfo", "http://user@api.internal/v1"],
    ["non-HTTP", "file:///v1"],
  ])("rejects an invalid internal API URL: %s", (_label, value) => {
    expect(() => parseSessionServerConfig(environment({ API_INTERNAL_URL: value }))).toThrow();
  });

  test.each(["0", "-1", "1.5", "901", "not-a-number"])(
    "rejects an unsafe recovery window %s",
    (value) => {
      expect(() => parseSessionServerConfig(environment({ WEB_SESSION_RECOVERY_SECONDS: value }))).toThrow();
    },
  );

  test("does not leak key material through diagnostics", () => {
    let message = "";
    try {
      parseSessionServerConfig(environment({ SPOTT_WEB_BFF_CURRENT_KID: "missing" }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toContain(keyA);
    expect(message).not.toContain(Buffer.alloc(32, 0x11).toString("hex"));
  });
});
