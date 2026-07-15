import { beforeEach, describe, expect, test } from "vitest";

import {
  clearRegistrationDraft,
  gateDestination,
  loadRegistrationDraft,
  registrationDraftKey,
  saveRegistrationDraft,
  type RegistrationDraft,
} from "../app/lib/registration-draft";

const eventId = "019b0000-0000-7000-8100-000000000001";

const draft: RegistrationDraft = {
  schemaVersion: 1,
  eventId,
  eventVersion: 7,
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
    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7)).toEqual(draft);
  });

  test("never restores a draft for another event contract version", () => {
    saveRegistrationDraft(window.sessionStorage, draft);

    expect(loadRegistrationDraft(window.sessionStorage, eventId, 8)).toBeNull();
    expect(loadRegistrationDraft(window.sessionStorage, "019b0000-0000-7000-8100-000000000002", 7)).toBeNull();
  });

  test("clears only the matching draft after a successful logical submission", () => {
    saveRegistrationDraft(window.sessionStorage, draft);
    clearRegistrationDraft(window.sessionStorage, eventId, 7);

    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7)).toBeNull();
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
    expect(loadRegistrationDraft(blocked, eventId, 7)).toBeNull();

    window.sessionStorage.setItem(registrationDraftKey(eventId, 7), "not-json");
    expect(loadRegistrationDraft(window.sessionStorage, eventId, 7)).toBeNull();
  });
});
