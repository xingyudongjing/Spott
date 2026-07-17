"use client";

import { useEffect, useRef, useState } from "react";

import { EventDetailView } from "../../components/event/EventDetail";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import type { Locale } from "../../i18n/messages";
import { trackProductEvent } from "../../lib/analytics";
import {
  errorMessage,
  readSession,
  subscribeSessionChanges,
  type WebSession,
} from "../../lib/client-api";
import type { EventDetail } from "../../lib/event-contract";
import { fetchViewerEvent } from "../../lib/events-client";
import { EventActions } from "./EventActions";
import { EventFeedbackSummary } from "./EventFeedbackSummary";

export function EventDetailClient({
  event,
  locale,
}: {
  event: EventDetail;
  locale: Locale;
}) {
  const isReadOnly = usePreviewMode() === "read-only";
  const [liveEvent, setLiveEvent] = useState(event);
  const [viewerSession, setViewerSession] = useState<WebSession | null>(null);
  const [viewerMessage, setViewerMessage] = useState("");
  const requestGeneration = useRef(0);

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
      setLiveEvent(event);
      setViewerSession(null);
      setViewerMessage("");
      if (isReadOnly) return;
      const requestedSession = readSession();
      if (!requestedSession) return;

      try {
        const authorizedEvent = await fetchViewerEvent(event.id);
        const currentSession = readSession();
        if (
          !active
          || generation !== requestGeneration.current
          || currentSession?.user.id !== requestedSession.user.id
        ) return;
        setLiveEvent(authorizedEvent);
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
  }, [event, isReadOnly]);

  return (
    <EventDetailView
      event={liveEvent}
      locale={locale}
      actions={(
        <EventActions
          key={[
            viewerSession?.user.id ?? "anonymous",
            liveEvent.version,
            liveEvent.favorited,
            liveEvent.organizer.viewerFollowing,
          ].join(":")}
          event={liveEvent}
          session={viewerSession}
          viewerMessage={viewerMessage}
        />
      )}
      supplementary={<EventFeedbackSummary eventId={liveEvent.id} locale={locale} />}
    />
  );
}
