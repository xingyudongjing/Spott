import { describe, expect, test } from "vitest";

import {
  composerDraftStorageKey,
  parseComposerDraft,
} from "../app/create/event-composer-draft";

describe("EventComposer owner-scoped draft persistence", () => {
  test("isolates anonymous and authenticated owners", () => {
    expect(composerDraftStorageKey(null)).toBe("spott.event-composer.v3.anonymous");
    expect(composerDraftStorageKey("owner-a")).toBe("spott.event-composer.v3.user.owner-a");
    expect(composerDraftStorageKey("owner-b")).toBe("spott.event-composer.v3.user.owner-b");
    expect(composerDraftStorageKey("owner-a")).not.toBe(composerDraftStorageKey("owner-b"));
  });

  test("fails closed on corrupted JSON instead of leaking another draft", () => {
    expect(parseComposerDraft("{ definitely-not-json")).toBeNull();
    expect(parseComposerDraft(null)).toBeNull();
  });

  test("accepts only the expected persisted envelope", () => {
    expect(parseComposerDraft(JSON.stringify({ draft: { title: "A" }, uploadedNames: [] })))
      .toMatchObject({ draft: { title: "A" }, uploadedNames: [] });
    expect(parseComposerDraft(JSON.stringify(["not", "an", "envelope"]))).toBeNull();
  });
});
