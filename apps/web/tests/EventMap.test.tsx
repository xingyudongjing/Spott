import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventMap, eventMarkerFacts } from "../app/components/discovery/EventMap";
import { eventFixture, makeEvent } from "./event-fixtures";

const mapBoundary = vi.hoisted(() => ({
  remove: vi.fn(),
  resize: vi.fn(),
  handlers: new Map<string, (...args: unknown[]) => void>(),
  onceHandlers: new Map<string, (...args: unknown[]) => void>(),
  bounds: {
    getWest: () => 139.6,
    getSouth: () => 35.5,
    getEast: () => 139.9,
    getNorth: () => 35.8,
  },
}));

vi.mock("maplibre-gl", () => {
  class MapBoundary {
    constructor() {}
    on(name: string, handler: (...args: unknown[]) => void) { mapBoundary.handlers.set(name, handler); return this; }
    off(name: string) { mapBoundary.handlers.delete(name); return this; }
    once(name: string, handler: (...args: unknown[]) => void) { mapBoundary.onceHandlers.set(name, handler); return this; }
    getBounds() { return mapBoundary.bounds; }
    resize() { mapBoundary.resize(); }
    remove() { mapBoundary.remove(); }
  }
  class MarkerBoundary {
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
});
