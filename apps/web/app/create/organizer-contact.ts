import {
  organizerContactSchema,
  type OrganizerContact,
} from "../lib/event-contract";

export interface OrganizerContactDraft {
  kind: OrganizerContact["kind"];
  label: string;
  value: string;
}

export function organizerContactDraftFromAuthorized(
  contact: OrganizerContact | null,
): OrganizerContactDraft | undefined {
  if (!contact) return undefined;
  return {
    kind: contact.kind,
    label: contact.label ?? "",
    value: contact.value,
  };
}

export function organizerContactPayload(
  draft: OrganizerContactDraft,
): OrganizerContact | undefined {
  const value = draft.value.trim();
  if (!value) return undefined;
  return {
    kind: draft.kind,
    label: draft.label.trim() || null,
    value: draft.kind === "email" ? value.toLowerCase() : value,
  };
}

export function organizerContactValid(draft: OrganizerContactDraft): boolean {
  const payload = organizerContactPayload(draft);
  return payload !== undefined && organizerContactSchema.safeParse(payload).success;
}
