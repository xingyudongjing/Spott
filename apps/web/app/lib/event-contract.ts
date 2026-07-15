import { z, ZodError } from "zod";

const uuid = z.uuid();
const dateTime = z.iso.datetime({ offset: true });
const nullableDateTime = dateTime.nullable();
const locale = z.enum(["zh-Hans", "ja", "en"]);
const eventStatus = z.enum([
  "draft",
  "pending_review",
  "needs_changes",
  "published",
  "registration_closed",
  "in_progress",
  "ended",
  "cancelled",
  "removed",
  "appeal_pending",
  "archived",
  "deleted",
  "rejected",
]);
const registrationStatus = z.enum([
  "pending",
  "confirmed",
  "waitlisted",
  "offered",
  "checked_in",
  "cancelled",
  "rejected",
  "expired",
  "no_show",
  "correction_pending",
  "attendance_disputed",
  "event_cancelled",
  "final",
]);
const availableAction = z.enum([
  "register",
  "joinWaitlist",
  "cancelRegistration",
  "viewTicket",
  "checkIn",
  "edit",
  "submit",
  "cancelEvent",
  "appeal",
  "joinGroup",
]);

export const eventCoordinateSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  precision: z.enum(["approximate", "exact"]),
}).passthrough();

export const organizerTrustSchema = z.object({
  phoneVerified: z.boolean(),
  completedEventCount: z.number().int().min(0),
  attendanceRateBand: z.enum(["unavailable", "under_70", "70_89", "90_plus"]),
}).passthrough();

export const eventFeeSchema = z.object({
  isFree: z.boolean(),
  amountJPY: z.number().int().min(0).nullable(),
  collectorName: z.string().nullable(),
  method: z.string().nullable(),
  paymentDeadlineText: z.string().nullable(),
  refundPolicy: z.string().nullable(),
}).passthrough();

export const eventOrganizerSchema = z.object({
  id: uuid,
  name: z.string(),
  handle: z.string(),
  viewerFollowing: z.boolean(),
  trust: organizerTrustSchema,
}).passthrough();

export const viewerRegistrationSchema = z.object({
  id: uuid,
  status: z.enum(["pending", "confirmed", "waitlisted", "offered", "checked_in"]),
  partySize: z.number().int().min(1),
  offerExpiresAt: nullableDateTime,
}).passthrough();

const eventSummaryBaseSchema = z.object({
  id: uuid,
  publicSlug: z.string(),
  organizerId: uuid,
  status: eventStatus,
  title: z.string(),
  description: z.string(),
  category: z.string(),
  startsAt: nullableDateTime,
  endsAt: nullableDateTime,
  deadlineAt: nullableDateTime,
  displayTimeZone: z.string().min(1),
  region: z.string(),
  publicArea: z.string(),
  capacity: z.number().int().min(0),
  confirmedCount: z.number().int().min(0),
  availableCapacity: z.number().int().min(0),
  fee: eventFeeSchema,
  coverURL: z.url().nullable(),
  tags: z.array(z.string()).max(5),
  organizer: eventOrganizerSchema,
  favorited: z.boolean(),
  registrationStatus: registrationStatus.nullable(),
  viewerRegistration: viewerRegistrationSchema.nullable(),
  registrationMode: z.enum(["automatic", "approval", "invite_only"]),
  waitlistEnabled: z.boolean(),
  format: z.enum(["in_person", "online", "hybrid"]),
  primaryLocale: locale,
  supportedLocales: z.array(locale).min(1).max(3),
  localeConfirmed: z.boolean(),
  availableActions: z.array(availableAction),
  version: z.number().int().min(1),
  updatedAt: dateTime,
}).passthrough().superRefine((event, context) => {
  if (new Set(event.supportedLocales).size !== event.supportedLocales.length) {
    context.addIssue({ code: "custom", path: ["supportedLocales"], message: "must not contain duplicates" });
  }
  if (!event.supportedLocales.includes(event.primaryLocale)) {
    context.addIssue({ code: "custom", path: ["supportedLocales"], message: "must contain primaryLocale" });
  }
});

export const eventSummarySchema = eventSummaryBaseSchema.and(z.object({
  coordinate: eventCoordinateSchema.extend({ precision: z.literal("approximate") }).nullable(),
}).passthrough());

const registrationQuestionSchema = z.object({
  id: uuid,
  prompt: z.string().min(1).max(240),
  kind: z.enum(["text", "single_choice", "boolean"]),
  required: z.boolean(),
  options: z.array(z.string().min(1).max(120)).max(12),
}).passthrough();

const eventMediaSchema = z.object({
  id: uuid,
  assetId: uuid,
  sortOrder: z.number().int().min(0).max(5),
  state: z.string(),
  moderationState: z.string(),
  url: z.url().nullable().optional(),
}).passthrough();

export const eventDetailSchema = eventSummaryBaseSchema.and(z.object({
  coordinate: eventCoordinateSchema.nullable(),
  exactAddress: z.string().nullable(),
  attendeeRequirements: z.string().nullable(),
  riskFlags: z.array(z.string()),
  riskDetails: z.record(z.string(), z.string()),
  exactAddressVisibility: z.enum(["public", "confirmed"]),
  registrationQuestions: z.array(registrationQuestionSchema).max(10),
  media: z.array(eventMediaSchema).max(6),
  mediaCount: z.number().int().min(0).max(6),
  groupId: uuid.nullable().optional(),
  checkinMode: z.enum(["dynamic_qr", "six_digit", "manual"]).optional(),
  commentPermission: z.enum(["disabled", "participants", "group_members"]).optional(),
  posterEnabled: z.boolean().optional(),
}).passthrough());

export const eventPageSchema = z.object({
  items: z.array(eventSummarySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  serverTime: dateTime,
  queryExplanationId: z.string(),
}).passthrough();

export type EventCoordinate = z.infer<typeof eventCoordinateSchema>;
export type EventFormat = z.infer<typeof eventSummaryBaseSchema>["format"];
export type EventLocale = z.infer<typeof locale>;
export type OrganizerTrust = z.infer<typeof organizerTrustSchema>;
export type EventFee = z.infer<typeof eventFeeSchema>;
export type EventOrganizer = z.infer<typeof eventOrganizerSchema>;
export type ViewerRegistration = z.infer<typeof viewerRegistrationSchema>;
export type EventSummary = z.infer<typeof eventSummarySchema>;
export type EventDetail = z.infer<typeof eventDetailSchema>;
export type EventPage = z.infer<typeof eventPageSchema>;

export class EventContractError extends Error {
  readonly issues: ZodError["issues"];

  constructor(contract: string, error: ZodError) {
    const details = error.issues
      .map((issue) => `${issue.path.length ? issue.path.join(".") : "payload"}: ${issue.message}`)
      .join("; ");
    super(`Invalid ${contract}: ${details}`);
    this.name = "EventContractError";
    this.issues = error.issues;
  }
}

export function parseEventSummary(value: unknown): EventSummary {
  return stripLegacyDisplayFields(parseContract("EventSummary", eventSummarySchema, value));
}

export function parseEventDetail(value: unknown): EventDetail {
  return stripLegacyDisplayFields(parseContract("EventDetail", eventDetailSchema, value));
}

export function parseEventPage(value: unknown): EventPage {
  const page = parseContract("EventPage", eventPageSchema, value);
  return { ...page, items: page.items.map(stripLegacyDisplayFields) };
}

function parseContract<Schema extends z.ZodType>(contract: string, schema: Schema, value: unknown): z.infer<Schema> {
  const result = schema.safeParse(value);
  if (!result.success) throw new EventContractError(contract, result.error);
  return result.data;
}

function stripLegacyDisplayFields<Event extends EventSummary | EventDetail>(event: Event): Event {
  const normalized = {
    ...event,
    organizer: { ...event.organizer },
    fee: { ...event.fee },
  } as Event;
  delete (normalized as Record<string, unknown>).categoryLabel;
  delete (normalized as Record<string, unknown>).priceLabel;
  delete (normalized.organizer as Record<string, unknown>).reliability;
  delete (normalized.fee as Record<string, unknown>).boundaryStatement;
  return normalized;
}
