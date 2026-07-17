export interface PersistedComposerDraft<TDraft = Record<string, unknown>, TRemote = unknown> {
  draft?: Partial<TDraft> & { registrationQuestion?: string };
  remote?: TRemote;
  uploadedNames?: string[];
}

export function composerDraftStorageKey(ownerId: string | null): string {
  return ownerId
    ? `spott.event-composer.v3.user.${ownerId}`
    : "spott.event-composer.v3.anonymous";
}

export function parseComposerDraft<TDraft = Record<string, unknown>, TRemote = unknown>(
  source: string | null,
): PersistedComposerDraft<TDraft, TRemote> | null {
  if (!source) return null;
  try {
    const value = JSON.parse(source) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const envelope = value as PersistedComposerDraft<TDraft, TRemote>;
    if (envelope.draft !== undefined && (
      !envelope.draft
      || typeof envelope.draft !== "object"
      || Array.isArray(envelope.draft)
    )) return null;
    if (envelope.uploadedNames !== undefined && (
      !Array.isArray(envelope.uploadedNames)
      || envelope.uploadedNames.some((name) => typeof name !== "string")
    )) return null;
    return envelope;
  } catch {
    return null;
  }
}
