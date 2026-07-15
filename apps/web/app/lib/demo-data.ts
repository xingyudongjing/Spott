import type { EventDetail, EventSummary } from "./event-contract";

type StripIndexSignature<Value> = {
  [Key in keyof Value as string extends Key ? never : number extends Key ? never : Key]: Value[Key];
};

type KnownEventSummary = StripIndexSignature<EventSummary>;
type KnownEventDetail = StripIndexSignature<EventDetail>;

/**
 * Temporary presentation bridge for screens that Task 5 and Task 6 will move
 * directly onto EventSummary/EventDetail. It can only be constructed from a
 * validated contract; there is no demo event fallback or fabricated fact.
 */
export type EventView = Omit<
  KnownEventSummary,
  "coordinate" | "fee" | "organizer" | "startsAt" | "endsAt"
> & {
  startsAt: string;
  endsAt: string;
  coordinate: KnownEventDetail["coordinate"];
  categoryLabel: string;
  priceLabel: string;
  fee: (Exclude<KnownEventSummary["fee"], null> & { boundaryStatement?: string }) | null;
  organizer: KnownEventSummary["organizer"] & { reliability: string };
  exactAddress?: KnownEventDetail["exactAddress"];
  attendeeRequirements?: KnownEventDetail["attendeeRequirements"];
  riskFlags?: KnownEventDetail["riskFlags"];
  riskDetails?: KnownEventDetail["riskDetails"];
  exactAddressVisibility?: KnownEventDetail["exactAddressVisibility"];
  registrationQuestions?: KnownEventDetail["registrationQuestions"];
  media?: KnownEventDetail["media"];
  mediaCount?: KnownEventDetail["mediaCount"];
  groupId?: KnownEventDetail["groupId"];
  checkinMode?: KnownEventDetail["checkinMode"];
  commentPermission?: KnownEventDetail["commentPermission"];
  posterEnabled?: KnownEventDetail["posterEnabled"];
};
