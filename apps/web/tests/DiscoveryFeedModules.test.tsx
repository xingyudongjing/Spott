import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DiscoveryShell } from "../app/components/discovery/DiscoveryShell";
import type { DiscoveryFeed } from "../app/lib/discovery-feed";
import { apiRequest, readSession } from "../app/lib/client-api";
import type { EventSummary } from "../app/lib/event-contract";
import { makeEvent, makePage, renderWithI18n } from "./event-fixtures";

vi.mock("next/dynamic", () => ({ default: () => () => null }));
vi.mock("../app/lib/client-api", () => ({ apiRequest: vi.fn(), readSession: vi.fn() }));
vi.mock("../app/lib/analytics", () => ({ trackProductEvent: vi.fn() }));

const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);

type FeedShellProps = Parameters<typeof DiscoveryShell>[0] & {
  readonly initialFeed: DiscoveryFeed | null;
};
const FeedShell = DiscoveryShell as ComponentType<FeedShellProps>;

const knownModuleCopies = {
  "zh-Hans": [
    "今天就能参加", "本周末", "附近热门", "兴趣推荐",
    "新活动", "认证主办方", "关注动态", "为你推荐",
  ],
  ja: [
    "今日参加できる", "今週末", "近くで人気", "興味に合うイベント",
    "新着イベント", "認証済み主催者", "フォロー中の最新情報", "あなたへのおすすめ",
  ],
  en: [
    "Happening today", "This weekend", "Popular nearby", "For your interests",
    "New events", "Verified hosts", "Updates from people you follow", "Recommended for you",
  ],
} as const;

const knownKeys = [
  "today",
  "weekend",
  "nearby_hot",
  "interest",
  "new_events",
  "verified_hosts",
  "followed_updates",
  "future_signal",
] as const;

function eventAt(index: number, title: string): EventSummary {
  return makeEvent({
    id: `019b0000-0000-7000-8100-${String(index).padStart(12, "0")}`,
    publicSlug: `feed-event-${index}`,
    title,
  });
}

function feed(
  moduleOrder: readonly string[],
  modules: DiscoveryFeed["modules"],
): DiscoveryFeed {
  return {
    modules: [...modules],
    moduleOrder: [...moduleOrder],
    serverTime: "2026-07-19T00:00:00.000Z",
    generatedAt: "2026-07-19T00:00:00.000Z",
    queryExplanationId: "feed-render-test",
  };
}

function feedEnvelope(value: DiscoveryFeed) {
  return {
    banner: null,
    modules: value.modules.map((module) => ({
      key: module.key,
      title: module.serverTitle,
      items: module.items.map((event) => ({
        ...event,
        recommendation: { score: 1, boosted: false, components: { freshness: 1 } },
      })),
    })),
    moduleOrder: value.moduleOrder,
    weights: { freshness: 1 },
    scoringVersion: "recommendation-v1",
    naturalResultsMinRatio: 0.7,
    serverTime: value.serverTime,
    generatedAt: value.generatedAt,
    queryExplanationId: value.queryExplanationId,
  };
}

function renderFeed(initialFeed: DiscoveryFeed, locale: "zh-Hans" | "ja" | "en" = "zh-Hans", mapStyleURL = "") {
  return renderWithI18n(
    <FeedShell
      initialQuery={{}}
      initialPage={null}
      initialFeed={initialFeed}
      mapStyleURL={mapStyleURL}
    />,
    locale,
  );
}

beforeEach(() => {
  window.history.replaceState(null, "", "/discover");
  apiRequestMock.mockReset();
  readSessionMock.mockReset();
  readSessionMock.mockReturnValue(null);
});

describe("server-ordered discovery feed modules", () => {
  test("follows moduleOrder, deduplicates event IDs across modules, and never trusts server titles", () => {
    const shared = eventAt(101, "周末优先保留");
    const todayDuplicate = { ...shared, title: "今天重复项不应出现" };
    const initialFeed = feed(
      ["weekend", "future_signal", "today"],
      [
        { key: "today", serverTitle: "SERVER TODAY", items: [todayDuplicate, eventAt(102, "今天独有")] },
        { key: "weekend", serverTitle: "SERVER WEEKEND", items: [shared, eventAt(103, "周末独有")] },
        { key: "future_signal", serverTitle: "<img src=x onerror=alert(1)>", items: [eventAt(104, "未来模块活动")] },
      ],
    );

    renderFeed(initialFeed);

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual(["本周末", "为你推荐", "今天就能参加"]);
    expect(screen.getAllByRole("link", { name: /周末优先保留/ })).toHaveLength(1);
    expect(screen.queryByText("今天重复项不应出现")).not.toBeInTheDocument();
    expect(screen.queryByText(/SERVER/)).not.toBeInTheDocument();
    expect(screen.queryByText(/onerror/)).not.toBeInTheDocument();
  });

  test.each(Object.entries(knownModuleCopies) as Array<[
    keyof typeof knownModuleCopies,
    (typeof knownModuleCopies)[keyof typeof knownModuleCopies],
  ]>)("uses safe localized headings for every known module and an unknown fallback in %s", (locale, copies) => {
    const modules = knownKeys.map((key, index) => ({
      key,
      serverTitle: `untrusted-${key}`,
      items: [eventAt(200 + index, `event-${key}`)],
    }));

    renderFeed(feed(knownKeys, modules), locale);

    expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent))
      .toEqual([...copies]);
    expect(screen.queryByText(/untrusted-/)).not.toBeInTheDocument();
  });

  test("uses the same cross-module deduplicated event set in map mode without exposing an exact address", async () => {
    const shared = Object.assign(eventAt(301, "共享活动"), {
      exactAddress: "東京都新宿区秘密会场 9-9-9",
    });
    const initialFeed = feed(["today", "weekend"], [
      { key: "today", serverTitle: "today", items: [shared, eventAt(302, "今天活动")] },
      { key: "weekend", serverTitle: "weekend", items: [shared, eventAt(303, "周末活动")] },
    ]);
    renderFeed(initialFeed, "zh-Hans", "https://media.spott.jp/map/style.json");

    fireEvent.click(screen.getByRole("button", { name: "地图" }));

    await waitFor(() => expect(screen.getAllByTestId("discovery-event")).toHaveLength(3));
    expect(screen.getByText("推荐顺序")).toBeInTheDocument();
    expect(screen.queryByText("时间优先")).not.toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /共享活动/ })).toHaveLength(1);
    expect(screen.queryByText(/秘密会场/)).not.toBeInTheDocument();
  });

  test("switches explicit filters to search and returns an empty normalized query to feed", async () => {
    const initialFeed = feed(["today"], [
      { key: "today", serverTitle: "today", items: [eventAt(401, "默认推荐")] },
    ]);
    apiRequestMock.mockImplementation(async (path) => (
      path.startsWith("/discovery/feed")
        ? feedEnvelope(initialFeed)
        : makePage([eventAt(402, "筛选结果")])
    ));
    renderFeed(initialFeed);

    const availability = screen.getByRole("button", { name: "只看有名额" });
    fireEvent.click(availability);
    await waitFor(() => expect(apiRequestMock).toHaveBeenLastCalledWith(
      "/events/search?availableOnly=true&limit=24",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByText("筛选结果")).toBeInTheDocument();

    fireEvent.click(availability);
    await waitFor(() => expect(apiRequestMock).toHaveBeenLastCalledWith(
      "/discovery/feed?limit=24",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    ));
    expect(await screen.findByText("默认推荐")).toBeInTheDocument();
  });
});
