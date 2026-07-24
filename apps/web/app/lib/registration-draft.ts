export const REGISTRATION_DRAFT_SCHEMA_VERSION = 2 as const;

export type RegistrationStep = "details" | "review";
export type RegistrationAnswer = string | boolean;

export interface RegistrationDraft {
  schemaVersion: typeof REGISTRATION_DRAFT_SCHEMA_VERSION;
  eventId: string;
  eventVersion: number;
  ownerUserId: string | null;
  partySize: number;
  answers: Record<string, RegistrationAnswer>;
  attendeeNote: string;
  acceptedTerms: boolean;
  step: RegistrationStep;
  idempotencyKey: string;
  updatedAt: string;
  /**
   * The ticket tier chosen for this draft. Optional so drafts written before
   * ticket tiers shipped still restore instead of being discarded; a resumed
   * draft always submits under the same idempotency key, so the selection has to
   * travel with it or a resumed submission would book the wrong tier.
   */
  ticketTypeId?: string | null;
}

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type GateSession = { user: { phoneVerified: boolean } } | null;

export function registrationDraftKey(eventId: string, eventVersion: number) {
  return `spott.web.registration-draft.v${REGISTRATION_DRAFT_SCHEMA_VERSION}.${eventId}.v${eventVersion}`;
}

export function loadRegistrationDraft(
  storage: DraftStorage,
  eventId: string,
  eventVersion: number,
  ownerUserId: string | null,
): RegistrationDraft | null {
  const key = registrationDraftKey(eventId, eventVersion);
  try {
    storage.removeItem(`spott.web.registration-draft.v1.${eventId}.v${eventVersion}`);
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRegistrationDraft(parsed, eventId, eventVersion)) {
      storage.removeItem(key);
      return null;
    }
    if (parsed.ownerUserId !== null && parsed.ownerUserId !== ownerUserId) {
      storage.removeItem(key);
      return null;
    }
    return parsed;
  } catch {
    try { storage.removeItem(key); } catch { /* Storage may be blocked entirely. */ }
    return null;
  }
}

export function saveRegistrationDraft(storage: DraftStorage, draft: RegistrationDraft) {
  try {
    storage.setItem(
      registrationDraftKey(draft.eventId, draft.eventVersion),
      JSON.stringify(draft),
    );
  } catch {
    // Registration remains usable when private-mode/browser policy blocks storage.
  }
}

export function clearRegistrationDraft(
  storage: DraftStorage,
  eventId: string,
  eventVersion: number,
) {
  try {
    storage.removeItem(registrationDraftKey(eventId, eventVersion));
  } catch {
    // The successful server result remains authoritative even if cleanup is blocked.
  }
}

export function gateDestination(session: GateSession, returnTo: string) {
  if (!session) return `/login?returnTo=${encodeURIComponent(returnTo)}`;
  if (!session.user.phoneVerified) {
    return `/phone-verification?returnTo=${encodeURIComponent(returnTo)}`;
  }
  return null;
}

function isRegistrationDraft(
  value: unknown,
  eventId: string,
  eventVersion: number,
): value is RegistrationDraft {
  if (!isRecord(value)) return false;
  if (
    value.schemaVersion !== REGISTRATION_DRAFT_SCHEMA_VERSION
    || value.eventId !== eventId
    || value.eventVersion !== eventVersion
    || !(value.ownerUserId === null || typeof value.ownerUserId === "string")
    || !Number.isInteger(value.partySize)
    || Number(value.partySize) < 1
    || typeof value.attendeeNote !== "string"
    || typeof value.acceptedTerms !== "boolean"
    || !["details", "review"].includes(String(value.step))
    || typeof value.idempotencyKey !== "string"
    || typeof value.updatedAt !== "string"
    || !isRecord(value.answers)
    || !(
      value.ticketTypeId === undefined
      || value.ticketTypeId === null
      || typeof value.ticketTypeId === "string"
    )
  ) return false;
  return Object.values(value.answers).every(
    (answer) => typeof answer === "string" || typeof answer === "boolean",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
