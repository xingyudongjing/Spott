import type { EventSummary } from "../../lib/event-contract";
import { EventResultCard } from "./EventResultCard";
import styles from "./DiscoveryShell.module.css";

export function EventList({
  events,
  selectedEventId,
  featuredFirst = true,
}: {
  events: EventSummary[];
  selectedEventId?: string | null;
  featuredFirst?: boolean;
}) {
  return (
    <div className={styles.eventList} data-testid="event-list">
      {events.map((event, index) => (
        <EventResultCard
          key={`${event.id}-${index}`}
          event={event}
          priority={index === 0}
          selected={selectedEventId === event.id}
          featured={featuredFirst && index === 0}
        />
      ))}
    </div>
  );
}
