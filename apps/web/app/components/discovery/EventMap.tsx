"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap, MapEventType, Marker as MapLibreMarker } from "maplibre-gl";

import type { MapBounds } from "../../lib/discovery-query";
import type { EventSummary } from "../../lib/event-contract";
import styles from "./DiscoveryShell.module.css";

export interface EventMarkerFact {
  eventId: string;
  title: string;
  latitude: number;
  longitude: number;
  precision: "approximate" | "exact";
}

export function eventMarkerFacts(events: EventSummary[]): EventMarkerFact[] {
  return events.flatMap((event) => event.coordinate ? [{
    eventId: event.id,
    title: event.title,
    latitude: event.coordinate.latitude,
    longitude: event.coordinate.longitude,
    precision: event.coordinate.precision,
  }] : []);
}

export function EventMap({
  events,
  styleURL,
  bounds,
  selectedEventId,
  mapLabel,
  approximateLabel,
  loadTimeoutMs = 10_000,
  onBoundsChange,
  onFailure,
  onSelect,
}: {
  events: EventSummary[];
  styleURL: string;
  bounds?: MapBounds;
  selectedEventId?: string | null;
  mapLabel: string;
  approximateLabel: string;
  loadTimeoutMs?: number;
  onBoundsChange: (bounds: MapBounds) => void;
  onFailure: () => void;
  onSelect?: (eventId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const markerElementsRef = useRef(new Map<string, HTMLButtonElement>());
  const selectedEventIdRef = useRef(selectedEventId);

  useEffect(() => {
    selectedEventIdRef.current = selectedEventId;
    for (const [eventId, element] of markerElementsRef.current) {
      const isSelected = eventId === selectedEventId;
      element.setAttribute("aria-pressed", String(isSelected));
      if (isSelected) element.setAttribute("aria-controls", `map-preview-${eventId}`);
      else element.removeAttribute("aria-controls");
    }
  }, [selectedEventId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !styleURL) return;
    const markerElements = markerElementsRef.current;

    let disposed = false;
    let failed = false;
    let map: MapLibreMap | null = null;
    let markers: MapLibreMarker[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    let loadTimer: ReturnType<typeof setTimeout> | null = null;
    let handleMoveEnd: ((event: MapEventType["moveend"] & object) => void) | null = null;
    let ignoreProgrammaticMove = true;
    let ready = false;
    let lastBounds = bounds ? boundsKey(bounds) : "";

    const fail = () => {
      if (ready || failed || disposed) return;
      failed = true;
      if (loadTimer) clearTimeout(loadTimer);
      onFailure();
    };
    const markReady = () => {
      if (disposed || failed) return;
      ready = true;
      ignoreProgrammaticMove = false;
      if (loadTimer) clearTimeout(loadTimer);
      loadTimer = null;
    };

    loadTimer = setTimeout(fail, loadTimeoutMs);

    void (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (disposed) return;
        const facts = eventMarkerFacts(events);
        const first = facts[0];
        const discoveredBounds = markerBounds(facts);
        const markerOffsets = collisionSafeMarkerOffsets(facts);
        map = new maplibre.Map({
          container,
          style: styleURL,
          ...(bounds
            ? { bounds: [[bounds.west, bounds.south], [bounds.east, bounds.north]], fitBoundsOptions: { padding: 44 } }
            : discoveredBounds
              ? { bounds: discoveredBounds, fitBoundsOptions: { padding: 56, maxZoom: 11 } }
              : { center: first ? [first.longitude, first.latitude] : [138.2529, 36.2048], zoom: first ? 11 : 4 }),
          attributionControl: false,
        });

        handleMoveEnd = (event) => {
          if (!map || ignoreProgrammaticMove || !event.originalEvent) return;
          if (moveTimer) clearTimeout(moveTimer);
          moveTimer = setTimeout(() => {
            if (!map || disposed) return;
            const visible = map.getBounds();
            const next = normalizeBounds({
              west: visible.getWest(),
              south: visible.getSouth(),
              east: visible.getEast(),
              north: visible.getNorth(),
            });
            const key = boundsKey(next);
            if (key === lastBounds) return;
            lastBounds = key;
            onBoundsChange(next);
          }, 300);
        };

        map.on("moveend", handleMoveEnd);
        map.on("error", fail);
        map.once("idle", markReady);

        markers = facts.map((fact) => {
          const markerElement = document.createElement("button");
          markerElement.type = "button";
          markerElement.className = fact.precision === "approximate"
            ? `${styles.mapMarker} ${styles.approximateMarker}`
            : styles.mapMarker;
          markerElement.setAttribute(
            "aria-label",
            fact.precision === "approximate" ? `${fact.title} · ${approximateLabel}` : fact.title,
          );
          const isSelected = fact.eventId === selectedEventIdRef.current;
          if (isSelected) markerElement.setAttribute("aria-controls", `map-preview-${fact.eventId}`);
          markerElement.setAttribute("aria-pressed", String(isSelected));
          markerElement.addEventListener("click", () => onSelect?.(fact.eventId));
          markerElements.set(fact.eventId, markerElement);
          return new maplibre.Marker({
            element: markerElement,
            anchor: "center",
            offset: markerOffsets.get(fact.eventId) ?? [0, 0],
          })
            .setLngLat([fact.longitude, fact.latitude])
            .addTo(map as MapLibreMap);
        });

        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => map?.resize());
          resizeObserver.observe(container);
        }
      } catch {
        fail();
      }
    })();

    return () => {
      disposed = true;
      if (loadTimer) clearTimeout(loadTimer);
      if (moveTimer) clearTimeout(moveTimer);
      resizeObserver?.disconnect();
      markers.forEach((marker) => marker.remove());
      markers = [];
      markerElements.clear();
      if (map && handleMoveEnd) map.off("moveend", handleMoveEnd);
      map?.off("error", fail);
      map?.remove();
      map = null;
    };
  }, [approximateLabel, bounds, events, loadTimeoutMs, onBoundsChange, onFailure, onSelect, styleURL]);

  return <div ref={containerRef} className={styles.mapCanvas} role="region" aria-label={mapLabel} />;
}

function markerBounds(facts: EventMarkerFact[]): [[number, number], [number, number]] | null {
  if (facts.length < 2) return null;
  const longitudes = facts.map(({ longitude }) => longitude);
  const latitudes = facts.map(({ latitude }) => latitude);
  const west = Math.min(...longitudes);
  const east = Math.max(...longitudes);
  const south = Math.min(...latitudes);
  const north = Math.max(...latitudes);
  return west === east && south === north ? null : [[west, south], [east, north]];
}

function collisionSafeMarkerOffsets(facts: EventMarkerFact[]) {
  const groups = new Map<string, EventMarkerFact[]>();
  for (const fact of facts) {
    const key = `${fact.longitude.toFixed(6)}:${fact.latitude.toFixed(6)}`;
    groups.set(key, [...(groups.get(key) ?? []), fact]);
  }

  const result = new Map<string, [number, number]>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.set(group[0].eventId, [0, 0]);
      continue;
    }
    const radius = Math.max(24, 14 * group.length);
    group.forEach((fact, index) => {
      const angle = -Math.PI / 2 + (index * 2 * Math.PI) / group.length;
      result.set(fact.eventId, [
        Math.round(Math.cos(angle) * radius),
        Math.round(Math.sin(angle) * radius),
      ]);
    });
  }
  return result;
}

function normalizeBounds(bounds: MapBounds): MapBounds {
  const rounded = (value: number) => Number(value.toFixed(4));
  return {
    west: rounded(bounds.west),
    south: rounded(bounds.south),
    east: rounded(bounds.east),
    north: rounded(bounds.north),
  };
}

function boundsKey(bounds: MapBounds) {
  return [bounds.west, bounds.south, bounds.east, bounds.north].join(",");
}
