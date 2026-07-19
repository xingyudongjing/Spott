import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventResults, MapEventPreview } from "../app/components/discovery/EventResults";
import { EventMap, eventMarkerFacts } from "../app/components/discovery/EventMap";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { messages } from "../app/i18n/messages";
import { eventFixture, makeEvent, makePage, renderWithI18n } from "./event-fixtures";

const mapBoundary = vi.hoisted(() => ({
  remove: vi.fn(),
  resize: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  onceHandlers: new Map<string, (...args: unknown[]) => void>(),
  markerElements: [] as HTMLElement[],
  mapOptions: null as Record<string, unknown> | null,
  markerOptions: [] as Array<Record<string, unknown>>,
  addControl: vi.fn(),
  navigationOptions: null as Record<string, unknown> | null,
  resizeObserverCallback: null as ResizeObserverCallback | null,
  resizeObserverDisconnect: vi.fn(),
  bounds: {
    getWest: () => 139.6,
    getSouth: () => 35.5,
    getEast: () => 139.9,
    getNorth: () => 35.8,
  },
}));

vi.mock("maplibre-gl", () => {
  class MapBoundary {
    constructor(options: Record<string, unknown>) {
      mapBoundary.mapOptions = options;
      const canvas = document.createElement("canvas");
      const locale = options.locale as Record<string, string> | undefined;
      canvas.setAttribute("aria-label", locale?.["Map.Title"] ?? "Map");
      canvas.setAttribute("role", "region");
      (options.container as HTMLElement).appendChild(canvas);
    }
    addControl(control: unknown, position?: string) { mapBoundary.addControl(control, position); return this; }
    on(name: string, handler: (...args: unknown[]) => void) { mapBoundary.handlers.set(name, handler); return this; }
    off(name: string) { mapBoundary.handlers.delete(name); return this; }
    once(name: string, handler: (...args: unknown[]) => void) { mapBoundary.onceHandlers.set(name, handler); return this; }
    getBounds() { return mapBoundary.bounds; }
    resize() { mapBoundary.resize(); }
    remove() { mapBoundary.remove(); }
  }
  class MarkerBoundary {
    constructor(options: { element: HTMLElement } & Record<string, unknown>) {
      mapBoundary.markerElements.push(options.element);
      mapBoundary.markerOptions.push(options);
    }
    setLngLat() { return this; }
    addTo() { return this; }
    remove() { return this; }
  }
  class NavigationControlBoundary {
    constructor(options: Record<string, unknown>) { mapBoundary.navigationOptions = options; }
  }
  return { Map: MapBoundary, Marker: MarkerBoundary, NavigationControl: NavigationControlBoundary };
});

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    prefetch?: boolean;
  }) => <a {...props} data-next-navigation="true" data-prefetch={prefetch === false ? "false" : undefined} />,
}));

beforeEach(() => {
  mapBoundary.remove.mockReset();
  mapBoundary.resize.mockReset();
  mapBoundary.handlers.clear();
  mapBoundary.onceHandlers.clear();
  mapBoundary.markerElements.length = 0;
  mapBoundary.mapOptions = null;
  mapBoundary.markerOptions.length = 0;
  mapBoundary.addControl.mockReset();
  mapBoundary.navigationOptions = null;
  mapBoundary.resizeObserverCallback = null;
  mapBoundary.resizeObserverDisconnect.mockReset();
});

describe("MapLibre adapter", () => {
  test("passes only real coordinates to the adapter and preserves approximate precision", () => {
    const facts = eventMarkerFacts([
      eventFixture,
      makeEvent({ id: "019b0000-0000-7000-8100-000000000002", coordinate: null }),
    ]);

    expect(facts).toEqual([
      {
        eventId: eventFixture.id,
        title: eventFixture.title,
        latitude: 35.68,
        longitude: 139.79,
        precision: "approximate",
      },
    ]);
  });

  test("announces map loading until the first rendered frame becomes idle", async () => {
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        onBoundsChange={vi.fn()}
        onFailure={vi.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("正在加载地图…");
    await waitFor(() => expect(mapBoundary.onceHandlers.has("idle")).toBe(true));
    act(() => { mapBoundary.onceHandlers.get("idle")?.(); });
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  test("uses MapLibre zoom controls without adding a location or compass permission surface", async () => {
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        zoomInLabel="放大地图"
        zoomOutLabel="缩小地图"
        approximateLabel="约在此区域"
        onBoundsChange={vi.fn()}
        onFailure={vi.fn()}
      />,
    );

    await waitFor(() => expect(mapBoundary.addControl).toHaveBeenCalledTimes(1));
    expect(mapBoundary.navigationOptions).toEqual({
      showCompass: false,
      showZoom: true,
      visualizePitch: false,
    });
    expect(mapBoundary.mapOptions).toMatchObject({
      locale: {
        "Map.Title": "活动地图",
        "NavigationControl.ZoomIn": "放大地图",
        "NavigationControl.ZoomOut": "缩小地图",
      },
    });
    expect(mapBoundary.addControl).toHaveBeenCalledWith(expect.anything(), "top-right");
  });

  test("exposes one localized map region instead of nesting a second region around MapLibre", async () => {
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        onBoundsChange={vi.fn()}
        onFailure={vi.fn()}
      />,
    );

    await waitFor(() => expect(mapBoundary.mapOptions).not.toBeNull());
    expect(screen.getAllByRole("region")).toHaveLength(1);
    expect(screen.getByRole("region", { name: "活动地图" })).toHaveProperty("tagName", "CANVAS");
  });

  test("provides localized zoom control labels in Chinese, Japanese, and English", () => {
    const labelKeys = ["discover.zoomIn", "discover.zoomOut"] as const;

    expect(labelKeys.map((key) => messages["zh-Hans"][key])).toEqual(["放大地图", "缩小地图"]);
    expect(labelKeys.map((key) => messages.ja[key])).toEqual(["地図を拡大", "地図を縮小"]);
    expect(labelKeys.map((key) => messages.en[key])).toEqual(["Zoom in", "Zoom out"]);
  });

  test("normalizes one real camera move and tears down the WebGL boundary", async () => {
    const onBoundsChange = vi.fn();
    const { unmount } = render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        onBoundsChange={onBoundsChange}
        onFailure={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("region", { name: "活动地图" })).toBeInTheDocument();
    await waitFor(() => expect(mapBoundary.handlers.has("moveend")).toBe(true));
    vi.useFakeTimers();
    try {
      mapBoundary.handlers.get("moveend")?.({ originalEvent: undefined });
      await act(async () => { await vi.advanceTimersByTimeAsync(301); });
      expect(onBoundsChange).not.toHaveBeenCalled();

      mapBoundary.onceHandlers.get("idle")?.();
      mapBoundary.handlers.get("moveend")?.({ originalEvent: new MouseEvent("mouseup") });
      await act(async () => { await vi.advanceTimersByTimeAsync(299); });
      expect(onBoundsChange).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(onBoundsChange).toHaveBeenCalledTimes(1);
      expect(onBoundsChange).toHaveBeenCalledWith({ west: 139.6, south: 35.5, east: 139.9, north: 35.8 });
    } finally {
      unmount();
      vi.useRealTimers();
    }
    expect(mapBoundary.handlers.has("moveend")).toBe(false);
    expect(mapBoundary.remove).toHaveBeenCalledTimes(1);
  });

  test("defers resize work to one animation frame and cancels it during teardown", async () => {
    let scheduledFrame: FrameRequestCallback | null = null;
    const requestFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 42;
    });
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { mapBoundary.resizeObserverCallback = callback; }
      observe() {}
      unobserve() {}
      disconnect() { mapBoundary.resizeObserverDisconnect(); }
    });

    try {
      const { unmount } = render(
        <EventMap
          events={[eventFixture]}
          styleURL="https://media.spott.jp/map/style.json"
          mapLabel="活动地图"
          loadingLabel="正在加载地图…"
          emptyLabel="这些活动暂未提供可公开显示的地图位置。"
          approximateLabel="约在此区域"
          onBoundsChange={vi.fn()}
          onFailure={vi.fn()}
        />,
      );
      await waitFor(() => expect(mapBoundary.resizeObserverCallback).not.toBeNull());

      act(() => {
        mapBoundary.resizeObserverCallback?.([], {} as ResizeObserver);
        mapBoundary.resizeObserverCallback?.([], {} as ResizeObserver);
      });
      expect(mapBoundary.resize).not.toHaveBeenCalled();
      expect(requestFrame).toHaveBeenCalledTimes(1);

      act(() => { scheduledFrame?.(0); });
      expect(mapBoundary.resize).toHaveBeenCalledTimes(1);

      act(() => { mapBoundary.resizeObserverCallback?.([], {} as ResizeObserver); });
      unmount();
      expect(cancelFrame).toHaveBeenCalledWith(42);
      expect(mapBoundary.resizeObserverDisconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });

  test("turns a marker selection into an actionable localized detail preview", async () => {
    const onSelect = vi.fn();
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        onBoundsChange={vi.fn()}
        onFailure={vi.fn()}
        onSelect={onSelect}
      />,
    );
    await waitFor(() => expect(mapBoundary.markerElements).toHaveLength(1));
    mapBoundary.markerElements[0]?.click();
    expect(onSelect).toHaveBeenCalledWith(eventFixture.id);

    renderWithI18n(<MapEventPreview event={eventFixture} />);
    const preview = screen.getByRole("region", { name: `${eventFixture.title} 活动预览` });
    expect(preview).toHaveTextContent(eventFixture.publicArea ?? "");
    expect(screen.getByRole("link", { name: "查看活动详情" })).toHaveAttribute(
      "href",
      `/e/${eventFixture.publicSlug}`,
    );
  });

  test("only exposes aria-controls from the selected marker", async () => {
    const events = [eventFixture];
    const onBoundsChange = vi.fn();
    const onFailure = vi.fn();
    const onSelect = vi.fn();
    const { rerender } = render(
      <EventMap
        events={events}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        selectedEventId={null}
        onBoundsChange={onBoundsChange}
        onFailure={onFailure}
        onSelect={onSelect}
      />,
    );

    await waitFor(() => expect(mapBoundary.markerElements).toHaveLength(1));
    const marker = mapBoundary.markerElements[0];
    expect(marker).not.toHaveAttribute("aria-controls");

    rerender(
      <EventMap
        events={events}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        selectedEventId={eventFixture.id}
        onBoundsChange={onBoundsChange}
        onFailure={onFailure}
        onSelect={onSelect}
      />,
    );
    expect(marker).toHaveAttribute("aria-controls", `map-preview-${eventFixture.id}`);

    rerender(
      <EventMap
        events={events}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        selectedEventId={null}
        onBoundsChange={onBoundsChange}
        onFailure={onFailure}
        onSelect={onSelect}
      />,
    );
    expect(marker).not.toHaveAttribute("aria-controls");
  });

  test("uses document navigation from the public read-only map preview", () => {
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <MapEventPreview event={eventFixture} />
      </PreviewModeProvider>,
    );

    const link = screen.getByRole("link", { name: "查看活动详情" });
    expect(link).not.toHaveAttribute("data-next-navigation");
    expect(link).toHaveAttribute("href", `/e/${eventFixture.publicSlug}`);
  });

  test("fits every public marker inside the map and separates identical approximate points", async () => {
    const duplicate = makeEvent({
      id: "019b0000-0000-7000-8100-000000000002",
      coordinate: eventFixture.coordinate,
    });
    const northern = makeEvent({
      id: "019b0000-0000-7000-8100-000000000003",
      coordinate: { latitude: 35.727, longitude: 139.7668, precision: "approximate" },
    });
    render(
      <EventMap
        events={[eventFixture, duplicate, northern]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        onBoundsChange={vi.fn()}
        onFailure={vi.fn()}
      />,
    );

    await waitFor(() => expect(mapBoundary.markerElements).toHaveLength(3));
    expect(mapBoundary.mapOptions).toMatchObject({
      bounds: [[139.7668, 35.68], [139.79, 35.727]],
      fitBoundsOptions: { padding: 56, maxZoom: 11 },
    });
    const offsets = mapBoundary.markerOptions.map(({ offset }) => offset);
    expect(offsets[0]).not.toEqual(offsets[1]);
    expect(offsets[2]).toEqual([0, 0]);
  });

  test("shows a localized empty map state when results expose no public coordinate", async () => {
    renderWithI18n(
      <EventResults
        page={makePage([makeEvent({ coordinate: null })])}
        loading={false}
        refreshing={false}
        loadingMore={false}
        error={null}
        mode="map"
        mapStyleURL="https://media.spott.jp/map/style.json"
        mapAttempt={0}
        selectedEventId={eventFixture.id}
        onRetry={vi.fn()}
        onReset={vi.fn()}
        onLoadMore={vi.fn()}
        onBoundsChange={vi.fn()}
        onMapFailure={vi.fn()}
        onRetryMap={vi.fn()}
        onUseList={vi.fn()}
        onSelectEvent={vi.fn()}
      />,
    );

    await waitFor(() => expect(mapBoundary.onceHandlers.has("idle")).toBe(true));
    act(() => { mapBoundary.onceHandlers.get("idle")?.(); });
    expect(await screen.findByText("这些活动暂未提供可公开显示的地图位置。")).toBeVisible();
    expect(screen.queryByRole("region", { name: `${eventFixture.title} 活动预览` })).not.toBeInTheDocument();
  });

  test("keeps a non-empty empty-state announcement for invalid untyped callers", async () => {
    render(
      <EventMap
        events={[]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="Event map"
        loadingLabel="Loading map…"
        emptyLabel={undefined as never}
        approximateLabel="Approximate area"
        onBoundsChange={vi.fn()}
        onFailure={vi.fn()}
      />,
    );

    await waitFor(() => expect(mapBoundary.onceHandlers.has("idle")).toBe(true));
    act(() => { mapBoundary.onceHandlers.get("idle")?.(); });
    expect(await screen.findByRole("status")).not.toBeEmptyDOMElement();
  });

  test("fails once when the map cannot become idle before its loading deadline", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        loadTimeoutMs={1_000}
        onBoundsChange={vi.fn()}
        onFailure={onFailure}
      />,
    );

    await act(async () => { await Promise.resolve(); });
    await vi.waitFor(() => expect(mapBoundary.onceHandlers.has("idle")).toBe(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    expect(onFailure).toHaveBeenCalledTimes(1);

    mapBoundary.handlers.get("error")?.();
    expect(onFailure).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("cancels the loading deadline after idle and ignores later recoverable map errors", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="http://127.0.0.1:4201/style.json"
        mapLabel="活动地图"
        loadingLabel="正在加载地图…"
        emptyLabel="这些活动暂未提供可公开显示的地图位置。"
        approximateLabel="约在此区域"
        loadTimeoutMs={1_000}
        onBoundsChange={vi.fn()}
        onFailure={onFailure}
      />,
    );

    await act(async () => { await Promise.resolve(); });
    await vi.waitFor(() => expect(mapBoundary.onceHandlers.has("idle")).toBe(true));
    mapBoundary.onceHandlers.get("idle")?.();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
    mapBoundary.handlers.get("error")?.();
    expect(onFailure).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  test("keeps results actionable when map loading fails and offers retry or list mode", async () => {
    const onRetryMap = vi.fn();
    const onUseList = vi.fn();
    renderWithI18n(
      <EventResults
        page={makePage([eventFixture])}
        loading={false}
        refreshing={false}
        loadingMore={false}
        error="map"
        mode="map"
        mapStyleURL="https://media.spott.jp/map/style.json"
        mapAttempt={0}
        onRetry={vi.fn()}
        onReset={vi.fn()}
        onLoadMore={vi.fn()}
        onBoundsChange={vi.fn()}
        onMapFailure={vi.fn()}
        onRetryMap={onRetryMap}
        onUseList={onUseList}
        onSelectEvent={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("地图暂时不可用");
    expect(screen.getByRole("link", { name: new RegExp(eventFixture.title) })).toBeInTheDocument();
    expect(screen.getByTestId("discovery-event")).not.toHaveAttribute("data-featured");
    await userEvent.click(screen.getByRole("button", { name: "重试地图" }));
    await userEvent.click(screen.getByRole("button", { name: "查看列表" }));
    expect(onRetryMap).toHaveBeenCalledTimes(1);
    expect(onUseList).toHaveBeenCalledTimes(1);
  });
});
