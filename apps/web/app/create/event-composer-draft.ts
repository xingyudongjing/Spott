export interface ComposerRemoteReference {
  id: string;
  publicSlug: string;
  version: number;
  status: string;
}

export interface PersistedComposerDraft<TDraft = Record<string, unknown>> {
  draft?: Partial<TDraft> & { registrationQuestion?: string };
  remote?: ComposerRemoteReference;
  uploadedNames?: string[];
}

interface ComposerDraftStorageInput<TDraft> {
  draft?: Partial<TDraft> & { registrationQuestion?: string };
  remote?: unknown;
  uploadedNames?: string[];
}

const canonicalEventIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const publicSlugPattern = /^[a-z0-9][a-z0-9-]{0,199}$/u;
const remoteStatusPattern = /^[a-z][a-z0-9_]{0,63}$/u;
const safeComposerDraftKeys = [
  "title",
  "description",
  "categoryId",
  "tags",
  "startsAt",
  "endsAt",
  "deadlineAt",
  "regionId",
  "publicArea",
  "exactAddress",
  "exactAddressVisibility",
  "capacity",
  "registrationMode",
  "waitlistEnabled",
  "attendeeRequirements",
  "registrationQuestion",
  "registrationQuestions",
  "isFree",
  "amountJPY",
  "collectorName",
  "paymentMethod",
  "paymentDeadlineText",
  "refundPolicy",
  "riskFlags",
  "riskDetails",
  "groupId",
  "checkinMode",
  "commentPermission",
  "posterEnabled",
] as const;

export function composerDraftStorageKey(ownerId: string | null): string {
  return ownerId
    ? `spott.event-composer.v3.user.${ownerId}`
    : "spott.event-composer.v3.anonymous";
}

export function parseComposerDraft<TDraft = Record<string, unknown>>(
  source: string | null,
): PersistedComposerDraft<TDraft> | null {
  if (!source) return null;
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as ComposerDraftStorageInput<TDraft>;
    if (envelope.draft !== undefined && (
      !envelope.draft
      || typeof envelope.draft !== "object"
      || Array.isArray(envelope.draft)
    )) return null;
    if (envelope.uploadedNames !== undefined && (
      !Array.isArray(envelope.uploadedNames)
      || envelope.uploadedNames.some((name) => typeof name !== "string")
    )) return null;
    const remote = pickComposerRemoteReference(envelope.remote);
    return {
      ...(envelope.draft ? { draft: pickSafeComposerDraft(envelope.draft) } : {}),
      ...(remote ? { remote } : {}),
      ...(envelope.uploadedNames !== undefined ? { uploadedNames: envelope.uploadedNames } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeComposerDraft<
  TDraft = Record<string, unknown>,
>(envelope: ComposerDraftStorageInput<TDraft>): string {
  const remote = pickComposerRemoteReference(envelope.remote);
  return JSON.stringify({
    ...(envelope.draft ? { draft: pickSafeComposerDraft(envelope.draft) } : {}),
    ...(remote ? { remote } : {}),
    ...(envelope.uploadedNames !== undefined ? { uploadedNames: envelope.uploadedNames } : {}),
  });
}

export function pickComposerRemoteReference(value: unknown): ComposerRemoteReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string"
    || !canonicalEventIdPattern.test(candidate.id)
    || typeof candidate.publicSlug !== "string"
    || !publicSlugPattern.test(candidate.publicSlug)
    || !Number.isInteger(candidate.version)
    || (candidate.version as number) < 1
    || typeof candidate.status !== "string"
    || !remoteStatusPattern.test(candidate.status)
  ) return null;
  return {
    id: candidate.id,
    publicSlug: candidate.publicSlug,
    version: candidate.version as number,
    status: candidate.status,
  };
}

function pickSafeComposerDraft<TDraft>(
  draft: Partial<TDraft> & { registrationQuestion?: string },
): Partial<TDraft> & { registrationQuestion?: string } {
  const source = draft as Record<string, unknown>;
  return Object.fromEntries(
    safeComposerDraftKeys
      .filter((key) => Object.hasOwn(source, key))
      .map((key) => [key, source[key]]),
  ) as Partial<TDraft> & { registrationQuestion?: string };
}
