import { beforeEach, describe, expect, test } from "vitest";

import {
  clearAllRegistrationDrafts,
  clearRegistrationDraft,
  gateDestination,
  loadRegistrationDraft,
  REGISTRATION_DRAFT_SCHEMA_VERSION,
  registrationDraftKey,
  saveRegistrationDraft,
  type RegistrationDraft,
} from "../app/lib/registration-draft";

const eventId = "019b0000-0000-7000-8100-000000000001";

const draft: RegistrationDraft = {
  schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
  eventId,
  eventVersion: 7,
  ownerUserId: "019b0000-0000-7000-8000-000000000001",
  partySize: 3,
  answers: {
    "019b0000-0000-7000-8300-000000000001": "Vegetarian",
    "019b0000-0000-7000-8300-000000000002": true,
  },
  attendeeNote: "Near the lift, please",
  acceptedTerms: true,
  step: "review",
  idempotencyKey: "019b0000-0000-7000-8400-000000000001",
  updatedAt: "2026-07-16T03:00:00.000Z",
};

beforeEach(() => window.sessionStorage.clear());

describe("versioned registration draft", () => {
  test("round-trips every gate-critical field under event id and event version", () => {
    saveRegistrationDraft(window.sessionStorage, draft);

    expect(registrationDraftKey(eventId, 7)).toContain(`${eventId}.v7`);
    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7, draft.ownerUserId)).toEqual(draft);
  });

  test("never restores a draft for another event contract version", () => {
    saveRegistrationDraft(window.sessionStorage, draft);

    expect(loadRegistrationDraft(window.sessionStorage, eventId, 8, draft.ownerUserId)).toBeNull();
    expect(loadRegistrationDraft(window.sessionStorage, "019b0000-0000-7000-8100-000000000002", 7, draft.ownerUserId)).toBeNull();
  });

  test("clears only the matching draft after a successful logical submission", () => {
    saveRegistrationDraft(window.sessionStorage, draft);
    clearRegistrationDraft(window.sessionStorage, eventId, 7);

    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7, draft.ownerUserId)).toBeNull();
  });

  test("clears every registration draft version without removing unrelated session state", () => {
    const secondEventId = "019b0000-0000-7000-8100-000000000002";
    saveRegistrationDraft(window.sessionStorage, draft);
    saveRegistrationDraft(window.sessionStorage, {
      ...draft,
      eventId: secondEventId,
      eventVersion: 8,
    });
    window.sessionStorage.setItem(
      `spott.web.registration-draft.v1.${secondEventId}.v6`,
      JSON.stringify({ legacy: true }),
    );
    window.sessionStorage.setItem("spott.web.registration-draft-settings", "keep-me");

    clearAllRegistrationDrafts(window.sessionStorage);

    expect(window.sessionStorage.getItem(registrationDraftKey(eventId, 7))).toBeNull();
    expect(window.sessionStorage.getItem(registrationDraftKey(secondEventId, 8))).toBeNull();
    expect(window.sessionStorage.getItem(`spott.web.registration-draft.v1.${secondEventId}.v6`)).toBeNull();
    expect(window.sessionStorage.getItem("spott.web.registration-draft-settings")).toBe("keep-me");
  });

  test("keeps a draft through token refresh for the same owner", () => {
    saveRegistrationDraft(window.sessionStorage, draft);

    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7, draft.ownerUserId)).toEqual(draft);
  });

  test("deletes another owner's private draft instead of restoring it", () => {
    saveRegistrationDraft(window.sessionStorage, draft);

    expect(loadRegistrationDraft(
      window.sessionStorage,
      eventId,
      7,
      "019b0000-0000-7000-8000-000000000002",
    )).toBeNull();
    expect(window.sessionStorage.getItem(registrationDraftKey(eventId, 7))).toBeNull();
  });

  test("allows an anonymous gate draft to be claimed by the account that returns", () => {
    const anonymousDraft: RegistrationDraft = { ...draft, ownerUserId: null };
    saveRegistrationDraft(window.sessionStorage, anonymousDraft);

    expect(loadRegistrationDraft(
      window.sessionStorage,
      eventId,
      7,
      "019b0000-0000-7000-8000-000000000002",
    )).toEqual(anonymousDraft);
  });

  test("returns the correct gate without mutating the return path", () => {
    const path = `/register/evening-walk?source=detail`;
    expect(gateDestination(null, path)).toBe(`/login?returnTo=${encodeURIComponent(path)}`);
    expect(gateDestination({ user: { phoneVerified: false } }, path)).toBe(
      `/phone-verification?returnTo=${encodeURIComponent(path)}`,
    );
    expect(gateDestination({ user: { phoneVerified: true } }, path)).toBeNull();
  });

  test("fails safely when browser storage is blocked or malformed", () => {
    const blocked = {
      getItem: () => { throw new DOMException("blocked"); },
      setItem: () => { throw new DOMException("blocked"); },
      removeItem: () => { throw new DOMException("blocked"); },
    };
    expect(() => saveRegistrationDraft(blocked, draft)).not.toThrow();
    expect(loadRegistrationDraft(blocked, eventId, 7, draft.ownerUserId)).toBeNull();

    window.sessionStorage.setItem(registrationDraftKey(eventId, 7), "not-json");
    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7, draft.ownerUserId)).toBeNull();
  });
});
