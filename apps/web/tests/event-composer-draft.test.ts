import { beforeEach, describe, expect, test } from "vitest";

import {
  clearAllComposerDrafts,
  composerDraftStorageKey,
  parseComposerDraft,
  serializeComposerDraft,
} from "../app/create/event-composer-draft";

beforeEach(() => window.localStorage.clear());

describe("EventComposer owner-scoped draft persistence", () => {
  test("isolates anonymous and authenticated owners", () => {
    expect(composerDraftStorageKey(null)).toBe("spott.event-composer.v3.anonymous");
    expect(composerDraftStorageKey("owner-a")).toBe("spott.event-composer.v3.user.owner-a");
    expect(composerDraftStorageKey("owner-b")).toBe("spott.event-composer.v3.user.owner-b");
    expect(composerDraftStorageKey("owner-a")).not.toBe(composerDraftStorageKey("owner-b"));
  });

  test("clears every owner draft without removing unrelated local state", () => {
    window.localStorage.setItem(composerDraftStorageKey("owner-a"), JSON.stringify({ draft: { title: "A" } }));
    window.localStorage.setItem(composerDraftStorageKey("owner-b"), JSON.stringify({ draft: { title: "B" } }));
    window.localStorage.setItem(composerDraftStorageKey(null), JSON.stringify({ draft: { title: "Anonymous" } }));
    window.localStorage.setItem("spott.event-composer-settings", "keep-me");

    clearAllComposerDrafts(window.localStorage);

    expect(window.localStorage.getItem(composerDraftStorageKey("owner-a"))).toBeNull();
    expect(window.localStorage.getItem(composerDraftStorageKey("owner-b"))).toBeNull();
    expect(window.localStorage.getItem(composerDraftStorageKey(null))).toBeNull();
    expect(window.localStorage.getItem("spott.event-composer-settings")).toBe("keep-me");
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

  test("never serializes organizer contact secrets or channel metadata to localStorage", () => {
    const serialized = serializeComposerDraft({
      draft: {
        title: "Night walk",
        contactKind: "email",
        contactLabel: "Private event desk",
        contactValue: "secret-host@example.jp",
      },
      remote: {
        id: "019b0000-0000-7000-8100-000000000001",
        publicSlug: "night-walk",
        version: 4,
        status: "draft",
        organizerContact: {
          kind: "email",
          label: "Remote private desk",
          value: "remote-secret@example.jp",
        },
      },
      uploadedNames: ["cover.jpg"],
    });

    expect(serialized).toContain("Night walk");
    expect(serialized).not.toContain("contactKind");
    expect(serialized).not.toContain("contactLabel");
    expect(serialized).not.toContain("contactValue");
    expect(serialized).not.toContain("Private event desk");
    expect(serialized).not.toContain("secret-host@example.jp");
    expect(serialized).not.toContain("organizerContact");
    expect(serialized).not.toContain("Remote private desk");
    expect(serialized).not.toContain("remote-secret@example.jp");
  });

  test("scrubs organizer contact fields from legacy persisted drafts while preserving safe work", () => {
    const parsed = parseComposerDraft<Record<string, unknown>>(JSON.stringify({
      draft: {
        title: "Keep this title",
        contactKind: "line",
        contactLabel: "Private LINE",
        contactValue: "private_line_id",
      },
      remote: {
        id: "019b0000-0000-7000-8100-000000000001",
        publicSlug: "night-walk",
        version: 4,
        status: "draft",
        organizerContact: {
          kind: "line",
          label: "Remote private LINE",
          value: "remote_private_line",
        },
      },
    }));

    expect(parsed?.draft).toEqual({ title: "Keep this title" });
    expect(parsed?.remote).toEqual({
      id: "019b0000-0000-7000-8100-000000000001",
      publicSlug: "night-walk",
      version: 4,
      status: "draft",
    });
    expect(JSON.stringify(parsed)).not.toContain("private_line_id");
    expect(JSON.stringify(parsed)).not.toContain("remote_private_line");
  });

  test("uses a safe-field allowlist so nested and historical contact aliases never survive", () => {
    const source = JSON.stringify({
      draft: {
        title: "Keep this title",
        description: "Keep this description",
        organizerContact: { kind: "email", value: "nested-secret@example.jp" },
        contact: { value: "historical-secret@example.jp" },
        contactChannel: "historical_line",
        hostContactValue: "host-secret@example.jp",
        arbitraryPrivateEnvelope: { contactValue: "deep-secret@example.jp" },
      },
      uploadedNames: [],
    });

    const parsed = parseComposerDraft<Record<string, unknown>>(source);
    const serialized = serializeComposerDraft(parsed ?? {});

    expect(parsed?.draft).toEqual({
      title: "Keep this title",
      description: "Keep this description",
    });
    expect(serialized).not.toContain("organizerContact");
    expect(serialized).not.toContain("nested-secret@example.jp");
    expect(serialized).not.toContain("historical-secret@example.jp");
    expect(serialized).not.toContain("deep-secret@example.jp");
  });

  test.each([
    "event-1",
    "../../auth/refresh",
    "019B0000-0000-7000-8100-000000000001",
    "019b0000-0000-0000-0000-000000000001",
  ])("rejects a non-canonical remote event id: %s", (id) => {
    const parsed = parseComposerDraft(JSON.stringify({
      draft: { title: "Safe title" },
      remote: {
        id,
        publicSlug: "night-walk",
        version: 4,
        status: "draft",
      },
    }));

    expect(parsed).toEqual({ draft: { title: "Safe title" } });
  });
});
