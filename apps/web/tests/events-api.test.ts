import { beforeEach, describe, expect, test, vi } from "vitest";

import { fetchEvent, searchEvents } from "../app/lib/events-api";
import { makeDetail, makePage } from "./event-fixtures";

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("discovery authentication boundary", () => {
  test("adds the current viewer bearer without leaking it into the query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(makePage()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await searchEvents({ region: "tokyo" }, { accessToken: "viewer-access-token" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toContain("region=tokyo");
    expect(url).not.toContain("viewer-access-token");
    expect(headers.get("Authorization")).toBe("Bearer viewer-access-token");
  });

  test("forwards only explicit detail credentials and strictly parses the detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(makeDetail()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchEvent("tokyo-afterglow-walk", { cookie: "__Host-spott_session=signed" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/events\/tokyo-afterglow-walk$/);
    expect(new Headers(init.headers).get("Cookie")).toBe("__Host-spott_session=signed");
  });
});
