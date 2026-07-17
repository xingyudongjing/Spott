import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventResults, MapEventPreview } from "../app/components/discovery/EventResults";
import { EventMap, eventMarkerFacts } from "../app/components/discovery/EventMap";
import { eventFixture, makeEvent, makePage, renderWithI18n } from "./event-fixtures";

const mapBoundary = vi.hoisted(() => ({
  remove: vi.fn(),
  resize: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  onceHandlers: new Map<string, (...args: unknown[]) => void>(),
  markerElements: [] as HTMLElement[],
  mapOptions: null as Record<string, unknown> | null,
  markerOptions: [] as Array<Record<string, unknown>>,
  bounds: {
    getWest: () => 139.6,
    getSouth: () => 35.5,
    getEast: () => 139.9,
    getNorth: () => 35.8,
  },
}));

vi.mock("maplibre-gl", () => {
  class MapBoundary {
    constructor(options: Record<string, unknown>) { mapBoundary.mapOptions = options; }
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
  return { Map: MapBoundary, Marker: MarkerBoundary };
});

beforeEach(() => {
  mapBoundary.remove.mockReset();
  mapBoundary.resize.mockReset();
  mapBoundary.handlers.clear();
  mapBoundary.onceHandlers.clear();
  mapBoundary.markerElements.length = 0;
  mapBoundary.mapOptions = null;
  mapBoundary.markerOptions.length = 0;
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

  test("normalizes one real camera move and tears down the WebGL boundary", async () => {
    const onBoundsChange = vi.fn();
    const { unmount } = render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
        approximateLabel="约在此区域"
        onBoundsChange={onBoundsChange}
        onFailure={vi.fn()}
      />,
    );
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole("region", { name: "活动地图" })).toBeInTheDocument();
    await waitFor(() => expect(mapBoundary.handlers.has("moveend")).toBe(true));
    vi.useFakeTimers();
    mapBoundary.handlers.get("moveend")?.({ originalEvent: undefined });
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(onBoundsChange).not.toHaveBeenCalled();

    mapBoundary.onceHandlers.get("idle")?.();
    mapBoundary.handlers.get("moveend")?.({ originalEvent: new MouseEvent("mouseup") });
    await act(async () => { await vi.advanceTimersByTimeAsync(301); });
    expect(onBoundsChange).toHaveBeenCalledTimes(1);
    expect(onBoundsChange).toHaveBeenCalledWith({ west: 139.6, south: 35.5, east: 139.9, north: 35.8 });

    unmount();
    expect(mapBoundary.handlers.has("moveend")).toBe(false);
    expect(mapBoundary.remove).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  test("turns a marker selection into an actionable localized detail preview", async () => {
    const onSelect = vi.fn();
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
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

  test("fails once when the map cannot become idle before its loading deadline", async () => {
    vi.useFakeTimers();
    const onFailure = vi.fn();
    render(
      <EventMap
        events={[eventFixture]}
        styleURL="https://media.spott.jp/map/style.json"
        mapLabel="活动地图"
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
    await userEvent.click(screen.getByRole("button", { name: "重试地图" }));
    await userEvent.click(screen.getByRole("button", { name: "查看列表" }));
    expect(onRetryMap).toHaveBeenCalledTimes(1);
    expect(onUseList).toHaveBeenCalledTimes(1);
  });
});
