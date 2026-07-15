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
  mapLabel,
  approximateLabel,
  onBoundsChange,
  onFailure,
  onSelect,
}: {
  events: EventSummary[];
  styleURL: string;
  bounds?: MapBounds;
  mapLabel: string;
  approximateLabel: string;
  onBoundsChange: (bounds: MapBounds) => void;
  onFailure: () => void;
  onSelect?: (eventId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !styleURL) return;

    let disposed = false;
    let failed = false;
    let map: MapLibreMap | null = null;
    let markers: MapLibreMarker[] = [];
    let resizeObserver: ResizeObserver | null = null;
    let moveTimer: ReturnType<typeof setTimeout> | null = null;
    let handleMoveEnd: ((event: MapEventType["moveend"] & object) => void) | null = null;
    let ignoreProgrammaticMove = true;
    let lastBounds = bounds ? boundsKey(bounds) : "";

    const fail = () => {
      if (failed || disposed) return;
      failed = true;
      onFailure();
    };

    void (async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (disposed) return;
        const facts = eventMarkerFacts(events);
        const first = facts[0];
        map = new maplibre.Map({
          container,
          style: styleURL,
          ...(bounds
            ? { bounds: [[bounds.west, bounds.south], [bounds.east, bounds.north]], fitBoundsOptions: { padding: 44 } }
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
          }, 280);
        };

        map.on("moveend", handleMoveEnd);
        map.on("error", fail);
        map.once("idle", () => { ignoreProgrammaticMove = false; });

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
          markerElement.addEventListener("click", () => onSelect?.(fact.eventId));
          return new maplibre.Marker({ element: markerElement, anchor: "center" })
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
      if (moveTimer) clearTimeout(moveTimer);
      resizeObserver?.disconnect();
      markers.forEach((marker) => marker.remove());
      markers = [];
      if (map && handleMoveEnd) map.off("moveend", handleMoveEnd);
      map?.off("error", fail);
      map?.remove();
      map = null;
    };
  }, [approximateLabel, bounds, events, onBoundsChange, onFailure, onSelect, styleURL]);

  return <div ref={containerRef} className={styles.mapCanvas} role="region" aria-label={mapLabel} />;
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
