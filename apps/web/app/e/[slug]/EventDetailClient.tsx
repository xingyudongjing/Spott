"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { EventDetailView } from "../../components/event/EventDetail";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import { formatMessage, type Locale } from "../../i18n/messages";
import { trackProductEvent } from "../../lib/analytics";
import {
  errorMessage,
  readSession,
  subscribeSessionChanges,
  type WebSession,
} from "../../lib/client-api";
import { publicSafeEventDetail, type EventDetail } from "../../lib/event-contract";
import { fetchViewerEvent } from "../../lib/events-client";
import { EventActions } from "./EventActions";
import { EventFeedbackSummary } from "./EventFeedbackSummary";

export interface RouteBoundEventSnapshot {
  readonly routeId: string;
  readonly event: EventDetail;
}

export function visibleEventForRoute(
  snapshot: RouteBoundEventSnapshot,
  publicEvent: EventDetail,
): EventDetail {
  return snapshot.routeId === publicEvent.id ? snapshot.event : publicEvent;
}

export function EventDetailClient({
  event,
  locale,
}: {
  event: EventDetail;
  locale: Locale;
}) {
  const isReadOnly = usePreviewMode() === "read-only";
  const publicEvent = useMemo(() => publicSafeEventDetail(event), [event]);
  const [liveSnapshot, setLiveSnapshot] = useState<RouteBoundEventSnapshot>({
    routeId: event.id,
    event: publicEvent,
  });
  const [viewerSession, setViewerSession] = useState<WebSession | null>(null);
  const [viewerMessage, setViewerMessage] = useState("");
  const requestGeneration = useRef(0);
  const liveEvent = visibleEventForRoute(liveSnapshot, publicEvent);
  const snapshotMatchesRoute = liveSnapshot.routeId === event.id;
  const visibleViewerSession = snapshotMatchesRoute ? viewerSession : null;
  const visibleViewerMessage = snapshotMatchesRoute ? viewerMessage : "";

  useEffect(() => {
    if (isReadOnly) return;
    void trackProductEvent("event_detail_viewed", {
      eventId: event.id,
      category: event.category,
      region: event.region,
      status: event.status,
      availableCapacity: event.availableCapacity,
    });
  }, [event.availableCapacity, event.category, event.id, event.region, event.status, isReadOnly]);

  useEffect(() => {
    let active = true;
    const synchronizeViewer = async () => {
      const generation = ++requestGeneration.current;
      // A server detail can belong to the request Cookie while the browser has
      // already logged out or switched accounts. Remove old private facts
      // synchronously, before reading or awaiting the next viewer authority.
      setLiveSnapshot({ routeId: event.id, event: publicEvent });
      setViewerSession(null);
      setViewerMessage("");
      if (isReadOnly) return;
      const requestedSession = readSession();
      if (!requestedSession) return;

      try {
        const authorizedEvent = await fetchViewerEvent(event.id);
        if (authorizedEvent.id !== event.id) {
          throw new Error(formatMessage(locale, "discover.error"));
        }
        const currentSession = readSession();
        if (
          !active
          || generation !== requestGeneration.current
          || currentSession?.user.id !== requestedSession.user.id
        ) return;
        setLiveSnapshot({ routeId: event.id, event: authorizedEvent });
        setViewerSession(currentSession);
      } catch (error) {
        if (!active || generation !== requestGeneration.current) return;
        const currentSession = readSession();
        if (currentSession?.user.id !== requestedSession.user.id) return;
        setViewerMessage(errorMessage(error));
      }
    };

    void synchronizeViewer();
    const unsubscribe = subscribeSessionChanges(() => void synchronizeViewer());
    return () => {
      active = false;
      requestGeneration.current += 1;
      unsubscribe();
    };
  }, [event.id, isReadOnly, locale, publicEvent]);

  return (
    <EventDetailView
      event={liveEvent}
      locale={locale}
      actions={(
        <EventActions
          key={[
            visibleViewerSession?.user.id ?? "anonymous",
            liveEvent.version,
            liveEvent.favorited,
            liveEvent.organizer.viewerFollowing,
          ].join(":")}
          event={liveEvent}
          session={visibleViewerSession}
          viewerMessage={visibleViewerMessage}
        />
      )}
      supplementary={<EventFeedbackSummary eventId={liveEvent.id} locale={locale} />}
    />
  );
}
