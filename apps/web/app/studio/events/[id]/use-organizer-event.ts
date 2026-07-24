"use client";

import { useCallback, useEffect, useState } from "react";
import { apiRequest, errorMessage } from "../../../lib/client-api";
import type { EventView } from "../../../lib/demo-data";

export interface OrganizerEventState {
  event: EventView | null;
  loading: boolean;
  error: string;
  reload: () => Promise<void>;
}

/**
 * Loads the organizer's own view of an event for the studio sub-pages. The
 * request is authenticated so the response carries organizer-only facts
 * (availableActions, exact address, fee terms) rather than the public shape.
 */
export function useOrganizerEvent(eventId: string): OrganizerEventState {
  const [event, setEvent] = useState<EventView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const value = await apiRequest<EventView>(`/events/${eventId}`, { authenticated: true });
      setEvent(value);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [eventId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 0);
    return () => window.clearTimeout(timer);
  }, [reload]);

  return { event, loading, error, reload };
}
