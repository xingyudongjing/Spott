import { afterEach, describe, expect, test, vi } from "vitest";

import { loadDiscoveryPage } from "../app/lib/discovery-page";
import { eventFixture, makePage } from "./event-fixtures";

const serverTime = "2026-07-19T00:00:00.000Z";

function feedPayload() {
  return {
    banner: null,
    modules: [{
      key: "today",
      title: "服务端标题不应成为界面文案",
      items: [{
        ...eventFixture,
        exactAddress: "東京都墨田区1-2-3",
        recommendation: { score: 1, boosted: false, components: { freshness: 1 } },
      }],
    }],
    moduleOrder: ["today"],
    weights: { freshness: 1 },
    scoringVersion: "recommendation-v1",
    naturalResultsMinRatio: 0.7,
    serverTime,
    generatedAt: serverTime,
    queryExplanationId: "feed-test",
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server-authoritative discovery page source", () => {
  test("uses /discovery/feed for the normalized empty /discover query and strips detail-only location data", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => (
      String(input).includes("/discovery/feed") ? json(feedPayload()) : json(makePage())
    ));
    vi.stubGlobal("fetch", fetchMock);

    const state = await loadDiscoveryPage({ q: "", region: undefined });

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/discovery\/feed\?limit=24$/);
    expect(state.initialPage).toBeNull();
    expect(state.initialFeed?.moduleOrder).toEqual(["today"]);
    expect(state.initialFeed?.modules[0]?.items[0]).not.toHaveProperty("exactAddress");
  });

  test.each([
    ["search", { q: "coffee" }],
    ["explicit filter", { availableOnly: "true" }],
  ])("keeps %s on linear /events/search", async (_label, raw) => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input;
      return json(makePage());
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await loadDiscoveryPage(raw);

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/events\/search\?/);
    expect(state.initialPage?.items).toHaveLength(1);
    expect(state.initialFeed).toBeNull();
  });

  test("keeps a locked-region city landing on linear /events/search", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      void input;
      return json(makePage());
    });
    vi.stubGlobal("fetch", fetchMock);

    const state = await loadDiscoveryPage({}, "tokyo");

    expect(String(fetchMock.mock.calls[0]?.[0])).toMatch(/\/events\/search\?region=tokyo/);
    expect(state.initialFeed).toBeNull();
  });
});
