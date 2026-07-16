import { formatMessage, type Locale } from "../../i18n/messages";
import type { RegistrationItineraryItem } from "../../lib/event-contract";
import type { ItineraryGroup } from "../../lib/itinerary";

type RegistrationStatus = RegistrationItineraryItem["registration"]["status"];

export function itineraryCopy(locale: Locale) {
  const text = (key: Parameters<typeof formatMessage>[1]) => formatMessage(locale, key);
  return {
    title: text("itinerary.title"),
    body: text("itinerary.body"),
    discover: text("itinerary.discover"),
    refresh: text("itinerary.refresh"),
    refreshing: text("itinerary.refreshing"),
    loading: text("itinerary.loading"),
    empty: text("itinerary.empty"),
    emptyBody: text("itinerary.emptyBody"),
    unavailable: text("itinerary.unavailable"),
    status: text("itinerary.status"),
    areaPending: text("event.areaTBA"),
    online: text("detail.online"),
    partySize: text("itinerary.partySize"),
    accept: text("itinerary.accept"),
    checkIn: text("itinerary.checkIn"),
    viewStatus: text("itinerary.viewStatus"),
    open: text("itinerary.open"),
    more: text("itinerary.more"),
    cancel: text("itinerary.cancel"),
    cancelConfirmation: text("itinerary.cancelConfirmation"),
    checkInCredential: text("itinerary.checkInCredential"),
    correction: text("itinerary.correction"),
    correctionPrompt: text("itinerary.correctionPrompt"),
    correctionSent: text("itinerary.correctionSent"),
    tabs: {
      upcoming: text("itinerary.tabUpcoming"),
      waitlist: text("itinerary.tabWaitlist"),
      pending: text("itinerary.tabPending"),
      past: text("itinerary.tabPast"),
    } satisfies Record<ItineraryGroup, string>,
    statuses: {
      pending: text("itinerary.statusPending"),
      confirmed: text("itinerary.statusConfirmed"),
      waitlisted: text("itinerary.statusWaitlisted"),
      offered: text("itinerary.statusOffered"),
      checked_in: text("itinerary.statusCheckedIn"),
      cancelled: text("itinerary.statusCancelled"),
      rejected: text("itinerary.statusRejected"),
      expired: text("itinerary.statusExpired"),
      no_show: text("itinerary.statusNoShow"),
      correction_pending: text("itinerary.statusCorrectionPending"),
      attendance_disputed: text("itinerary.statusAttendanceDisputed"),
      event_cancelled: text("itinerary.statusEventCancelled"),
      final: text("itinerary.statusFinal"),
    } satisfies Record<RegistrationStatus, string>,
  };
}

export type ItineraryCopy = ReturnType<typeof itineraryCopy>;
