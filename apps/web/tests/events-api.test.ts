import { beforeEach, describe, expect, test, vi } from "vitest";

import { fetchEvent, searchEvents } from "../app/lib/events-api";
import { makeDetail, makePage } from "./event-fixtures";

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery authentication boundary", () => {
  test("ignores caller-supplied credentials for anonymous discovery", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(makePage()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const untrustedOptions = {
      accessToken: "viewer-access-token",
      cookie: "__Host-spott_refresh=refresh-token",
    } as unknown as Parameters<typeof searchEvents>[1];

    await searchEvents({ region: "tokyo" }, untrustedOptions);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toContain("region=tokyo");
    expect(url).not.toContain("viewer-access-token");
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
    expect(init.credentials).toBe("omit");
  });

  test("keeps detail retrieval credentialless and strictly parses the detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(makeDetail()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const untrustedOptions = {
      accessToken: "viewer-access-token",
      cookie: "__Host-spott_refresh=refresh-token",
    } as unknown as Parameters<typeof fetchEvent>[1];

    await fetchEvent("tokyo-afterglow-walk", untrustedOptions);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/events\/tokyo-afterglow-walk$/);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Cookie")).toBeNull();
    expect(init.credentials).toBe("omit");
  });
});
