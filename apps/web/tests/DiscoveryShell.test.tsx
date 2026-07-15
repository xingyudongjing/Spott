import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DiscoveryShell } from "../app/components/discovery/DiscoveryShell";
import { searchEvents } from "../app/lib/events-api";
import { eventFixture, makeEvent, makePage, renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/events-api", () => ({ searchEvents: vi.fn() }));

const searchEventsMock = vi.mocked(searchEvents);

beforeEach(() => {
  window.history.replaceState(null, "", "/discover");
  searchEventsMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("URL-authoritative discovery", () => {
  test("reuses the server page and puts a real event immediately after discovery controls", () => {
    renderWithI18n(<DiscoveryShell initialQuery={{}} initialPage={makePage()} />);

    expect(searchEventsMock).not.toHaveBeenCalled();
    const search = screen.getByRole("searchbox");
    const eventLink = screen.getByRole("link", { name: new RegExp(eventFixture.title) });
    expect(search.compareDocumentPosition(eventLink) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("找到兴趣相投的人")).not.toBeInTheDocument();
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
    await user.click(screen.getByText("更多筛选"));
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
