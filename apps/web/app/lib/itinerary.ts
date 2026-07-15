import type {
  RegistrationItineraryItem,
  RegistrationItineraryPage,
} from "./event-contract";

export type ItineraryGroup = "pending" | "waitlist" | "upcoming" | "past";

export type ItineraryNextAction =
  | { kind: "accept_offer"; registrationId: string }
  | { kind: "check_in"; registrationId: string }
  | { kind: "correct_attendance"; registrationId: string }
  | { kind: "leave_feedback"; registrationId: string }
  | { kind: "view_status"; registrationId: string }
  | { kind: "open_event"; publicSlug: string }
  | { kind: "unavailable" };

export type GroupedItinerary = Record<ItineraryGroup, RegistrationItineraryItem[]>;

const pastRegistrationStatuses = new Set([
  "cancelled",
  "rejected",
  "expired",
  "no_show",
  "correction_pending",
  "attendance_disputed",
  "event_cancelled",
  "final",
]);

const pastEventStatuses = new Set(["ended", "cancelled", "archived"]);

export function groupItinerary(page: RegistrationItineraryPage): GroupedItinerary {
  const groups: GroupedItinerary = {
    pending: [],
    waitlist: [],
    upcoming: [],
    past: [],
  };
  const serverTime = Date.parse(page.serverTime);

  for (const item of page.items) groups[groupFor(item, serverTime)].push(item);
  groups.pending.sort(byUpdatedDescending);
  groups.waitlist.sort((left, right) => byWaitlistPriority(left, right, serverTime));
  groups.upcoming.sort(byUpcomingTime);
  groups.past.sort(byPastTime);
  return groups;
}

export function itineraryNextAction(
  item: RegistrationItineraryItem,
  serverTime: string,
): ItineraryNextAction {
  const registration = item.registration;
  if (
    registration.status === "offered"
    && registration.offerExpiresAt
    && Date.parse(registration.offerExpiresAt) > Date.parse(serverTime)
  ) {
    return { kind: "accept_offer", registrationId: registration.id };
  }
  if (
    registration.status === "confirmed"
    && registration.availableActions.includes("checkIn")
  ) {
    return { kind: "check_in", registrationId: registration.id };
  }
  if (
    ["confirmed", "no_show", "attendance_disputed"].includes(registration.status)
    && isWithinPostEventWindow(item, serverTime, 48 * 60 * 60 * 1_000)
  ) {
    return { kind: "correct_attendance", registrationId: registration.id };
  }
  if (
    registration.status === "checked_in"
    && isWithinPostEventWindow(item, serverTime, 30 * 24 * 60 * 60 * 1_000)
  ) {
    return { kind: "leave_feedback", registrationId: registration.id };
  }
  if (["pending", "waitlisted", "offered"].includes(registration.status)) {
    return { kind: "view_status", registrationId: registration.id };
  }
  if (item.event) return { kind: "open_event", publicSlug: item.event.publicSlug };
  return { kind: "unavailable" };
}

function isWithinPostEventWindow(
  item: RegistrationItineraryItem,
  serverTime: string,
  duration: number,
) {
  const endsAt = timestamp(item.event?.endsAt);
  const now = timestamp(serverTime);
  if (endsAt === null || now === null) return false;
  return now >= endsAt && now <= endsAt + duration;
}

function timestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function groupFor(item: RegistrationItineraryItem, serverTime: number): ItineraryGroup {
  if (item.registration.status === "pending") return "pending";
  if (["waitlisted", "offered"].includes(item.registration.status)) return "waitlist";
  if (pastRegistrationStatuses.has(item.registration.status)) return "past";
  if (item.event) {
    if (pastEventStatuses.has(item.event.status)) return "past";
    if (item.event.endsAt && Date.parse(item.event.endsAt) < serverTime) return "past";
  }
  return "upcoming";
}

function byUpdatedDescending(left: RegistrationItineraryItem, right: RegistrationItineraryItem) {
  return Date.parse(right.registration.updatedAt) - Date.parse(left.registration.updatedAt)
    || right.registration.id.localeCompare(left.registration.id);
}

function byWaitlistPriority(
  left: RegistrationItineraryItem,
  right: RegistrationItineraryItem,
  serverTime: number,
) {
  const leftExpiry = activeOfferExpiry(left, serverTime);
  const rightExpiry = activeOfferExpiry(right, serverTime);
  if (leftExpiry !== null && rightExpiry !== null) return leftExpiry - rightExpiry;
  if (leftExpiry !== null) return -1;
  if (rightExpiry !== null) return 1;
  return byUpdatedDescending(left, right);
}

function activeOfferExpiry(item: RegistrationItineraryItem, serverTime: number) {
  if (item.registration.status !== "offered" || !item.registration.offerExpiresAt) return null;
  const expiry = Date.parse(item.registration.offerExpiresAt);
  return expiry > serverTime ? expiry : null;
}

function byUpcomingTime(left: RegistrationItineraryItem, right: RegistrationItineraryItem) {
  const leftStart = left.event?.startsAt ? Date.parse(left.event.startsAt) : Number.POSITIVE_INFINITY;
  const rightStart = right.event?.startsAt ? Date.parse(right.event.startsAt) : Number.POSITIVE_INFINITY;
  return leftStart - rightStart || byUpdatedDescending(left, right);
}

function byPastTime(left: RegistrationItineraryItem, right: RegistrationItineraryItem) {
  const leftEnd = left.event?.endsAt ? Date.parse(left.event.endsAt) : Date.parse(left.registration.updatedAt);
  const rightEnd = right.event?.endsAt ? Date.parse(right.event.endsAt) : Date.parse(right.registration.updatedAt);
  return rightEnd - leftEnd || byUpdatedDescending(left, right);
}
