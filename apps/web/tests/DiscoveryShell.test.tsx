import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DiscoveryShell } from "../app/components/discovery/DiscoveryShell";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { apiRequest, readSession } from "../app/lib/client-api";
import { parseDiscoveryQuery } from "../app/lib/discovery-query";
import { searchEvents } from "../app/lib/events-api";
import { eventFixture, makeEvent, makePage, renderWithI18n } from "./event-fixtures";

const analyticsMocks = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));

vi.mock("../app/lib/events-api", () => ({ searchEvents: vi.fn() }));
vi.mock("../app/lib/client-api", () => ({ apiRequest: vi.fn(), readSession: vi.fn() }));
vi.mock("../app/lib/analytics", () => ({ trackProductEvent: analyticsMocks.trackProductEvent }));

const searchEventsMock = vi.mocked(searchEvents);
const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);

beforeEach(() => {
  window.history.replaceState(null, "", "/discover");
  searchEventsMock.mockReset();
  apiRequestMock.mockReset();
  apiRequestMock.mockImplementation((path, init) => {
    const query = parseDiscoveryQuery(path.split("?")[1] ?? "");
    return searchEventsMock(query, { signal: init?.signal ?? undefined }) as ReturnType<typeof apiRequest>;
  });
  readSessionMock.mockReset();
  readSessionMock.mockReturnValue(null);
  analyticsMocks.trackProductEvent.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("URL-authoritative discovery", () => {
  test("keeps mobile quick filters editorial and moves detailed facets into the sheet", async () => {
    const user = userEvent.setup();
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    const weekend = screen.getByRole("button", { name: "本周末" });
    const availability = screen.getByRole("button", { name: "只看有名额" });
    expect(weekend.querySelector("svg")).not.toBeNull();
    expect(availability.querySelector("svg")).not.toBeNull();
    expect(weekend).not.toHaveTextContent("▣");
    expect(availability).not.toHaveTextContent("♙");

    await user.click(screen.getByRole("button", { name: "更多筛选" }));
    const sheet = screen.getByRole("dialog", { name: "更多筛选" });
    expect(within(sheet).getByRole("combobox", { name: "活动形式" })).toBeInTheDocument();
    expect(within(sheet).getByRole("combobox", { name: "费用" })).toBeInTheDocument();
    expect(within(sheet).getByRole("combobox", { name: "语言" })).toBeInTheDocument();
  });

  test("uses compact, complete English copy for the 390px availability filter", () => {
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(
      <DiscoveryShell initialQuery={{}} initialPage={makePage()} />,
      "en",
    );

    const availability = screen.getByRole("button", { name: "Open spots" });
    expect(availability).toHaveTextContent("Open spots");
    expect(availability.textContent?.trim()).toHaveLength(10);
  });

  test("keeps analytics off and exposes region inside the filter dialog at 390px in read-only mode", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    searchEventsMock.mockResolvedValue(makePage());

    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <DiscoveryShell initialQuery={{}} initialPage={makePage()} />
      </PreviewModeProvider>,
    );

    await user.click(screen.getByRole("button", { name: "更多筛选" }));
    const dialog = screen.getByRole("dialog", { name: "更多筛选" });
    const region = within(dialog).getByRole("combobox", { name: "地区" });
    await user.selectOptions(region, "osaka");

    await waitFor(() => expect(window.location.search).toContain("region=osaka"));
    expect(searchEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ region: "osaka" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(readSessionMock).not.toHaveBeenCalled();
    expect(analyticsMocks.trackProductEvent).not.toHaveBeenCalled();
  });

  test("reuses the server page and puts a real event immediately after discovery controls", () => {
    renderWithI18n(<DiscoveryShell
      initialQuery={{}}
      initialPage={makePage([
        eventFixture,
        makeEvent({
          id: "019b0000-0000-7000-8100-000000000004",
          publicSlug: "second-event",
          title: "第二场真实活动",
        }),
      ])}
    />);

    expect(searchEventsMock).not.toHaveBeenCalled();
    const search = screen.getByRole("searchbox");
    const eventLink = screen.getByRole("link", { name: new RegExp(eventFixture.title) });
    expect(search.compareDocumentPosition(eventLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("找到兴趣相投的人")).not.toBeInTheDocument();
    const cards = screen.getAllByTestId("discovery-event");
    expect(cards[0]).toHaveAttribute("data-featured", "true");
    expect(cards[1]).not.toHaveAttribute("data-featured");
  });

  test("round-trips filters through the URL and the real API query", async () => {
    const user = userEvent.setup();
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    await user.selectOptions(screen.getByRole("combobox", { name: "地区" }), "osaka");
    await user.click(screen.getByRole("button", { name: "只看有名额" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "活动形式" }), "hybrid");
    await user.selectOptions(screen.getByRole("combobox", { name: "费用" }), "paid");
    await user.selectOptions(screen.getByRole("combobox", { name: "语言" }), "en");
    await user.click(screen.getByRole("button", { name: "更多筛选" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "分类" }), "music");

    await waitFor(() => {
      expect(window.location.search).toContain("region=osaka");
      expect(window.location.search).toContain("availableOnly=true");
      expect(window.location.search).toContain("format=hybrid");
      expect(window.location.search).toContain("price=paid");
      expect(window.location.search).toContain("language=en");
      expect(window.location.search).toContain("category=music");
    });
    expect(searchEventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        region: "osaka",
        availableOnly: true,
        format: "hybrid",
        price: "paid",
        language: "en",
        category: "music",
      }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  test("round-trips explicit start and end dates through the accessible filter sheet", async () => {
    const user = userEvent.setup();
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    const opener = screen.getByRole("button", { name: "更多筛选" });
    await user.click(opener);
    const sheet = screen.getByRole("dialog", { name: "更多筛选" });
    expect(sheet).toHaveAttribute("open");

    await user.type(screen.getByLabelText("开始日期"), "2026-08-01");
    await user.type(screen.getByLabelText("结束日期"), "2026-08-03");

    await waitFor(() => {
      const restored = new URLSearchParams(window.location.search);
      expect(restored.get("startsAfter")).toBe("2026-07-31T15:00:00.000Z");
      expect(restored.get("startsBefore")).toBe("2026-08-03T15:00:00.000Z");
    });

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "更多筛选" })).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  test("does not announce a custom date range as the weekend shortcut", async () => {
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(
      <DiscoveryShell
        initialQuery={{
          startsAfter: "2026-08-02T15:00:00.000Z",
          startsBefore: "2026-08-03T15:00:00.000Z",
        }}
        initialPage={makePage()}
      />,
    );

    const weekend = screen.getByRole("button", { name: "本周末" });
    expect(weekend).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(weekend);

    await waitFor(() => expect(weekend).toHaveAttribute("aria-pressed", "true"));
  });

  test("rejects an end date before the start date without mutating the URL or issuing a request", async () => {
    const user = userEvent.setup();
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    await user.click(screen.getByRole("button", { name: "更多筛选" }));
    await user.type(screen.getByLabelText("开始日期"), "2026-08-03");
    await waitFor(() => expect(window.location.search).toContain("startsAfter=2026-08-02T15"));
    const requestsAfterStart = searchEventsMock.mock.calls.length;

    await user.type(screen.getByLabelText("结束日期"), "2026-08-01");

    expect(screen.getByLabelText("结束日期")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("结束日期不能早于开始日期。", { selector: "p" })).toBeInTheDocument();
    expect(window.location.search).not.toContain("startsBefore");
    expect(searchEventsMock).toHaveBeenCalledTimes(requestsAfterStart);
  });

  test("revalidates the default feed once through the refresh-aware client path so viewer facts are current", async () => {
    readSessionMock.mockReturnValue({
      accessToken: "viewer-access-token",
      accessTokenExpiresAt: "2026-07-16T01:00:00.000Z",
      refreshToken: "viewer-refresh-token",
      sessionId: "019b0000-0000-7000-8100-000000000091",
      user: {
        id: "019b0000-0000-7000-8100-000000000092",
        publicHandle: "viewer",
        phoneVerified: true,
        restrictions: [],
      },
    });
    const viewerEvent = makeEvent({
      registrationStatus: "confirmed",
      viewerRegistration: {
        id: "019b0000-0000-7000-8100-000000000090",
        status: "confirmed",
        partySize: 1,
        offerExpiresAt: null,
      },
    });
    apiRequestMock.mockResolvedValue({
      banner: null,
      modules: [{
        key: "today",
        title: "server title",
        items: [{
          ...viewerEvent,
          recommendation: { score: 1, boosted: false, components: { freshness: 1 } },
        }],
      }],
      moduleOrder: ["today"],
      weights: { freshness: 1 },
      scoringVersion: "recommendation-v1",
      naturalResultsMinRatio: 0.7,
      serverTime: "2026-07-19T00:00:00.000Z",
      generatedAt: "2026-07-19T00:00:00.000Z",
      queryExplanationId: "viewer-feed",
    });

    renderWithI18n(<DiscoveryShell
      initialQuery={{}}
      initialPage={null}
      initialFeed={{
        modules: [{ key: "today", serverTitle: "server title", items: [eventFixture] }],
        moduleOrder: ["today"],
        serverTime: "2026-07-19T00:00:00.000Z",
        generatedAt: "2026-07-19T00:00:00.000Z",
        queryExplanationId: "anonymous-feed",
      }}
    />);

    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(1));
    expect(apiRequestMock).toHaveBeenCalledWith(
      "/discovery/feed?limit=24",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(searchEventsMock).not.toHaveBeenCalled();
    expect(await screen.findByText("已报名")).toBeInTheDocument();
  });

  test("aborts older searches and ignores a late response", async () => {
    vi.useFakeTimers();
    let resolveOld!: (page: ReturnType<typeof makePage>) => void;
    let resolveNew!: (page: ReturnType<typeof makePage>) => void;
    searchEventsMock
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveOld = resolve; }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => { resolveNew = resolve; }),
      );
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "a" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    const firstSignal = searchEventsMock.mock.calls[0]?.[1]?.signal;
    fireEvent.change(input, { target: { value: "ab" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });

    expect(firstSignal?.aborted).toBe(true);
    await act(async () => { resolveNew(makePage([makeEvent({ id: "019b0000-0000-7000-8100-000000000002", title: "最新结果" })])); });
    expect(screen.getByText("最新结果")).toBeInTheDocument();
    await act(async () => { resolveOld(makePage([makeEvent({ title: "过期结果" })])); });
    expect(screen.getByText("最新结果")).toBeInTheDocument();
    expect(screen.queryByText("过期结果")).not.toBeInTheDocument();
  });

  test("popstate restores every URL filter with exactly one request", async () => {
    searchEventsMock.mockResolvedValue(makePage());
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    window.history.pushState(null, "", "/discover?region=osaka&format=online&availableOnly=true");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => expect(searchEventsMock).toHaveBeenCalledTimes(1));
    expect(searchEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ region: "osaka", format: "online", availableOnly: true }),
      expect.any(Object),
    );
  });

  test("keeps a city landing page locked to its authoritative region", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/tokyo?region=osaka");
    searchEventsMock.mockResolvedValue(makePage());

    renderWithI18n(
      <DiscoveryShell
        initialQuery={{ region: "osaka" }}
        initialPage={makePage()}
        lockedRegion="tokyo"
      />,
    );

    const region = screen.getByRole("combobox", { name: "地区" });
    expect(region).toHaveValue("tokyo");
    expect(region).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "更多筛选" }));
    const dialogRegion = within(screen.getByRole("dialog", { name: "更多筛选" }))
      .getByRole("combobox", { name: "地区" });
    expect(dialogRegion).toHaveValue("tokyo");
    expect(dialogRegion).toBeDisabled();
    await user.click(within(screen.getByRole("dialog", { name: "更多筛选" }))
      .getByRole("button", { name: "关闭" }));

    await user.click(screen.getByRole("button", { name: "只看有名额" }));
    await waitFor(() => expect(searchEventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ region: "tokyo", availableOnly: true }),
      expect.any(Object),
    ));
    expect(new URLSearchParams(window.location.search).get("region")).toBe("tokyo");

    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    await waitFor(() => expect(searchEventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ region: "tokyo" }),
      expect.any(Object),
    ));

    window.history.pushState(null, "", "/tokyo?region=kyoto&format=online");
    window.dispatchEvent(new PopStateEvent("popstate"));
    await waitFor(() => expect(searchEventsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ region: "tokyo", format: "online" }),
      expect.any(Object),
    ));
    expect(new URLSearchParams(window.location.search).get("region")).toBe("tokyo");
  });

  test("keeps stale results when refresh fails and announces the error", async () => {
    const user = userEvent.setup();
    searchEventsMock.mockRejectedValue(new Error("network unavailable"));
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    await user.click(screen.getByRole("button", { name: "只看有名额" }));

    expect(await screen.findByRole("status")).toHaveTextContent("活动没有加载成功");
    expect(screen.getByText(eventFixture.title)).toBeInTheDocument();
  });

  test("shows initial failure without a simultaneous empty state", () => {
    renderWithI18n(
      <DiscoveryShell initialQuery={{}} initialPage={null} initialError="offline" />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("活动没有加载成功");
    expect(screen.queryByText("暂时没有符合条件的活动")).not.toBeInTheDocument();
  });

  test("surfaces a broken cursor contract and never silently deduplicates pages", async () => {
    const user = userEvent.setup();
    const firstRender = renderWithI18n(
      <DiscoveryShell
        initialQuery={{}}
        initialPage={makePage([], { hasMore: true, nextCursor: null })}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("结果分页暂时不可用");

    firstRender.unmount();
    renderWithI18n(
      <DiscoveryShell
        initialQuery={{}}
        initialPage={makePage([eventFixture], { hasMore: true, nextCursor: "next" })}
      />,
    );
    searchEventsMock.mockResolvedValue(makePage([eventFixture]));
    await user.click(screen.getByRole("button", { name: "加载更多" }));
    await waitFor(() =>
      expect(screen.getAllByRole("article", { name: eventFixture.title })).toHaveLength(2),
    );
  });

  test("hides map mode when no style URL is configured", () => {
    renderWithI18n(
      <DiscoveryShell initialQuery={{}} initialPage={makePage()} mapStyleURL="" />,
    );
    expect(screen.queryByRole("button", { name: "地图" })).not.toBeInTheDocument();
  });
});
