import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { I18nProvider } from "../app/components/I18nProvider";
import { EventComposer } from "../app/create/EventComposer";
import { composerDraftStorageKey } from "../app/create/event-composer-draft";
import { fetchViewerEvent } from "../app/lib/events-client";
import { makeDetail } from "./event-fixtures";

const mocks = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  fetchViewerEvent: vi.fn(),
  session: {
    accessToken: "access",
    user: { id: "composer-owner", phoneVerified: true },
  } as { accessToken: string; user: { id: string; phoneVerified: boolean } },
  sessionListeners: [] as Array<() => void>,
}));

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return {
    ...actual,
    apiRequest: mocks.apiRequest,
    readSession: () => mocks.session,
    subscribeSessionChanges: (listener: () => void) => {
      mocks.sessionListeners.push(listener);
      return () => {
        const index = mocks.sessionListeners.indexOf(listener);
        if (index >= 0) mocks.sessionListeners.splice(index, 1);
      };
    },
  };
});

vi.mock("../app/lib/events-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/events-client")>();
  return { ...actual, fetchViewerEvent: mocks.fetchViewerEvent };
});

const fetchViewerEventMock = vi.mocked(fetchViewerEvent);

beforeEach(() => {
  window.localStorage.clear();
  mocks.session = {
    accessToken: "access",
    user: { id: "composer-owner", phoneVerified: true },
  };
  mocks.sessionListeners.length = 0;
  mocks.apiRequest.mockReset();
  mocks.apiRequest.mockResolvedValue({ items: [] });
  fetchViewerEventMock.mockReset();
});

describe("EventComposer contact persistence boundary", () => {
  test("scrubs a legacy local secret immediately and restores only from the authorized cloud detail", async () => {
    const storageKey = composerDraftStorageKey(mocks.session.user.id);
    window.localStorage.setItem(storageKey, JSON.stringify({
      draft: {
        title: "Keep this event",
        contactKind: "email",
        contactLabel: "Legacy private desk",
        contactValue: "legacy-secret@example.jp",
      },
      remote: {
        id: makeDetail().id,
        publicSlug: makeDetail().publicSlug,
        version: makeDetail().version,
        status: "draft",
      },
      uploadedNames: [],
    }));
    fetchViewerEventMock.mockResolvedValue(makeDetail({
      organizerContact: {
        kind: "email",
        label: "Encrypted cloud desk",
        value: "cloud-host@example.jp",
      },
    }));

    render(
      <I18nProvider initialLocale="zh-Hans">
        <AppDialogProvider>
          <EventComposer />
        </AppDialogProvider>
      </I18nProvider>,
    );

    await waitFor(() => expect(fetchViewerEventMock).toHaveBeenCalledWith(makeDetail().id));
    await waitFor(() => {
      const persisted = window.localStorage.getItem(storageKey) ?? "";
      expect(persisted).toContain("Keep this event");
      expect(persisted).not.toContain("contactKind");
      expect(persisted).not.toContain("contactLabel");
      expect(persisted).not.toContain("contactValue");
      expect(persisted).not.toContain("legacy-secret@example.jp");
      expect(persisted).not.toContain("cloud-host@example.jp");
    });
  });

  test("runtime-picks an over-wide create API response before persisting its remote reference", async () => {
    const user = userEvent.setup();
    const storageKey = composerDraftStorageKey(mocks.session.user.id);
    window.localStorage.setItem(storageKey, JSON.stringify({
      draft: {
        title: "Tokyo architecture walk",
        description: "A careful architecture walk with a clear route, safety briefing, rest stops, and a welcoming introduction for first-time attendees.",
        categoryId: "walk",
        tags: "architecture,walk",
      },
      uploadedNames: ["cover.jpg"],
    }));
    mocks.apiRequest.mockImplementation(async (path) => {
      if (path === "/me/groups") return { items: [] };
      if (path === "/events/drafts") {
        return {
          id: makeDetail().id,
          publicSlug: makeDetail().publicSlug,
          version: 7,
          status: "draft",
          organizerContact: {
            kind: "email",
            label: "Over-wide API private desk",
            value: "over-wide-secret@example.jp",
          },
          exactAddress: "server-private-address-not-from-draft",
          attendeeRequirements: "server-private-note-not-from-draft",
          viewerRegistration: { id: "private-registration" },
        };
      }
      throw new Error(`Unexpected API path: ${String(path)}`);
    });

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <EventComposer />
        </AppDialogProvider>
      </I18nProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "Save & continue →" }));
    await screen.findByText("Draft saved to the cloud. You can continue on iOS.");

    await waitFor(() => {
      const persisted = window.localStorage.getItem(storageKey) ?? "";
      expect(persisted).toContain(`\"publicSlug\":\"${makeDetail().publicSlug}\"`);
      expect(persisted).not.toContain("organizerContact");
      expect(persisted).not.toContain("Over-wide API private desk");
      expect(persisted).not.toContain("over-wide-secret@example.jp");
      expect(persisted).not.toContain("server-private-address-not-from-draft");
      expect(persisted).not.toContain("server-private-note-not-from-draft");
      expect(persisted).not.toContain("private-registration");
    });
  });

  test("does not overwrite a newly entered contact when cloud restoration resolves late", async () => {
    const user = userEvent.setup();
    const remote = composerRemote();
    seedCompleteRemoteDraft(mocks.session.user.id, remote);
    let resolveRestore!: (event: ReturnType<typeof makeDetail>) => void;
    fetchViewerEventMock.mockReturnValue(new Promise((resolve) => { resolveRestore = resolve; }));
    mockComposerSaves(remote);

    renderComposer();
    await advanceToContactStep(user);
    const input = screen.getByRole("textbox", { name: /Contact email/ });
    await user.type(input, "new-owner@example.jp");

    await act(async () => resolveRestore(makeDetail({
      organizerContact: {
        kind: "email",
        label: "Old cloud contact",
        value: "old-cloud@example.jp",
      },
    })));

    expect(input).toHaveValue("new-owner@example.jp");
    expect(screen.queryByText("Old cloud contact")).not.toBeInTheDocument();
    expect(screen.queryByText("old-cloud@example.jp")).not.toBeInTheDocument();
  });

  test("rejects contact restoration when the authorized response is for another event", async () => {
    const user = userEvent.setup();
    const remote = composerRemote();
    seedCompleteRemoteDraft(mocks.session.user.id, remote);
    fetchViewerEventMock.mockResolvedValue(makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-cloud-event",
      organizerContact: {
        kind: "email",
        label: "Wrong event cloud contact",
        value: "wrong-cloud@example.jp",
      },
    }));
    mockComposerSaves(remote);

    renderComposer();
    await advanceToContactStep(user);

    expect(screen.getByRole("alert")).toHaveTextContent("We couldn't restore the contact");
    expect(screen.getByRole("textbox", { name: /Contact email/ })).toHaveValue("");
    expect(screen.queryByText("Wrong event cloud contact")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-cloud@example.jp")).not.toBeInTheDocument();
  });

  test("does not allow an A response to return after an A to B to A owner cycle", async () => {
    const user = userEvent.setup();
    const remote = composerRemote();
    seedCompleteRemoteDraft("composer-owner", remote);
    let resolveOldA!: (event: ReturnType<typeof makeDetail>) => void;
    let resolveCurrentA!: (event: ReturnType<typeof makeDetail>) => void;
    fetchViewerEventMock
      .mockReturnValueOnce(new Promise((resolve) => { resolveOldA = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { resolveCurrentA = resolve; }));
    mockComposerSaves(remote);

    renderComposer();
    await waitFor(() => expect(fetchViewerEventMock).toHaveBeenCalledTimes(1));

    act(() => {
      mocks.session = { accessToken: "b", user: { id: "composer-owner-b", phoneVerified: true } };
      mocks.sessionListeners.forEach((listener) => listener());
    });
    act(() => {
      mocks.session = { accessToken: "a-new", user: { id: "composer-owner", phoneVerified: true } };
      mocks.sessionListeners.forEach((listener) => listener());
    });
    await waitFor(() => expect(fetchViewerEventMock).toHaveBeenCalledTimes(2));
    await act(async () => resolveCurrentA(makeDetail({
      organizerContact: {
        kind: "email",
        label: "Current A contact",
        value: "current-a@example.jp",
      },
    })));

    await advanceToContactStep(user);
    const input = screen.getByRole("textbox", { name: /Contact email/ });
    expect(input).toHaveValue("current-a@example.jp");

    await act(async () => resolveOldA(makeDetail({
      organizerContact: {
        kind: "email",
        label: "Stale A contact",
        value: "stale-a@example.jp",
      },
    })));

    expect(input).toHaveValue("current-a@example.jp");
    expect(screen.queryByText("Stale A contact")).not.toBeInTheDocument();
    expect(screen.queryByText("stale-a@example.jp")).not.toBeInTheDocument();
  });

  test("does not let a late create response mutate state after an A to B to A owner cycle", async () => {
    const user = userEvent.setup();
    const created = composerRemote();
    seedCompleteNewDraft("composer-owner");
    let resolveCreate!: (event: ReturnType<typeof composerRemote>) => void;
    const pendingCreate = new Promise<ReturnType<typeof composerRemote>>((resolve) => {
      resolveCreate = resolve;
    });
    mocks.apiRequest.mockImplementation(async (path) => {
      if (path === "/me/groups") return { items: [] };
      if (path === "/events/drafts") return pendingCreate;
      throw new Error(`Unexpected API path: ${String(path)}`);
    });

    renderComposer();
    await user.click(await screen.findByRole("button", { name: "Save & continue →" }));
    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      "/events/drafts",
      expect.objectContaining({ method: "POST" }),
    ));

    act(() => {
      mocks.session = { accessToken: "b", user: { id: "composer-owner-b", phoneVerified: true } };
      mocks.sessionListeners.forEach((listener) => listener());
    });
    act(() => {
      mocks.session = { accessToken: "a-new", user: { id: "composer-owner", phoneVerified: true } };
      mocks.sessionListeners.forEach((listener) => listener());
    });
    await act(async () => resolveCreate(created));

    await waitFor(() => {
      const persisted = window.localStorage.getItem(composerDraftStorageKey("composer-owner")) ?? "";
      expect(persisted).not.toContain(`\"remote\"`);
      expect(persisted).not.toContain(created.id);
    });
    expect(screen.queryByText("Draft saved to the cloud. You can continue on iOS.")).not.toBeInTheDocument();
  });

  test("rejects a PATCH response whose event id differs from the requested cloud draft", async () => {
    const user = userEvent.setup();
    const remote = composerRemote();
    const wrongRemote = {
      ...remote,
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-patch-event",
    };
    seedCompleteRemoteDraft(mocks.session.user.id, remote);
    fetchViewerEventMock.mockResolvedValue(makeDetail({
      organizerContact: { kind: "email", label: "Current desk", value: "current@example.jp" },
    }));
    mocks.apiRequest.mockImplementation(async (path) => {
      if (path === "/me/groups") return { items: [] };
      if (path === `/events/${remote.id}`) return wrongRemote;
      throw new Error(`Unexpected API path: ${String(path)}`);
    });

    renderComposer();
    await user.click(await screen.findByRole("button", { name: "Save & continue →" }));

    await waitFor(() => {
      const persisted = window.localStorage.getItem(composerDraftStorageKey(mocks.session.user.id)) ?? "";
      expect(persisted).toContain(remote.id);
      expect(persisted).not.toContain(wrongRemote.id);
    });
    expect(screen.queryByText("Draft saved to the cloud. You can continue on iOS.")).not.toBeInTheDocument();
  });

  test("rejects a submit response whose event id differs from the saved cloud draft", async () => {
    const user = userEvent.setup();
    const remote = composerRemote();
    const wrongSubmitted = {
      ...remote,
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-submitted-event",
      status: "pending_review",
    };
    seedCompleteRemoteDraft(mocks.session.user.id, remote);
    fetchViewerEventMock.mockResolvedValue(makeDetail({
      organizerContact: { kind: "email", label: "Current desk", value: "current@example.jp" },
    }));
    mocks.apiRequest.mockImplementation(async (path) => {
      if (path === "/me/groups") return { items: [] };
      if (path === `/events/${remote.id}`) return remote;
      if (path === "/quotes") return { id: "quote", amount: 100 };
      if (path === `/events/${remote.id}/submit`) return wrongSubmitted;
      throw new Error(`Unexpected API path: ${String(path)}`);
    });

    renderComposer();
    await advanceToReviewStep(user);
    await user.click(screen.getByRole("button", { name: "Confirm points & submit" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & submit" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("invalid event version");
    expect(screen.queryByRole("heading", { name: "Submitted for review" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(composerDraftStorageKey(mocks.session.user.id))).not.toBeNull();
  });

  test("dismisses an in-flight submit dialog and ignores its late response after owner change", async () => {
    const user = userEvent.setup();
    const remote = composerRemote();
    seedCompleteRemoteDraft(mocks.session.user.id, remote);
    fetchViewerEventMock.mockResolvedValue(makeDetail({
      organizerContact: { kind: "email", label: "Current desk", value: "current@example.jp" },
    }));
    let resolveSubmit!: (event: ReturnType<typeof composerRemote>) => void;
    const pendingSubmit = new Promise<ReturnType<typeof composerRemote>>((resolve) => {
      resolveSubmit = resolve;
    });
    mocks.apiRequest.mockImplementation(async (path) => {
      if (path === "/me/groups") return { items: [] };
      if (path === `/events/${remote.id}`) return remote;
      if (path === "/quotes") return { id: "quote", amount: 100 };
      if (path === `/events/${remote.id}/submit`) return pendingSubmit;
      throw new Error(`Unexpected API path: ${String(path)}`);
    });

    renderComposer();
    await advanceToReviewStep(user);
    await user.click(screen.getByRole("button", { name: "Confirm points & submit" }));
    await user.click(await screen.findByRole("button", { name: "Confirm & submit" }));
    await waitFor(() => expect(mocks.apiRequest).toHaveBeenCalledWith(
      `/events/${remote.id}/submit`,
      expect.objectContaining({ method: "POST" }),
    ));

    act(() => {
      mocks.session = { accessToken: "b", user: { id: "composer-owner-b", phoneVerified: true } };
      mocks.sessionListeners.forEach((listener) => listener());
    });

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await act(async () => resolveSubmit({ ...remote, status: "pending_review" }));
    expect(screen.queryByRole("heading", { name: "Submitted for review" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem(composerDraftStorageKey("composer-owner-b")) ?? "")
      .not.toContain(remote.id);
  });
});

function composerRemote() {
  return {
    id: makeDetail().id,
    publicSlug: makeDetail().publicSlug,
    version: makeDetail().version,
    status: "draft",
  };
}

function seedCompleteRemoteDraft(ownerId: string, remote: ReturnType<typeof composerRemote>) {
  window.localStorage.setItem(composerDraftStorageKey(ownerId), JSON.stringify({
    draft: {
      title: "Tokyo architecture walk",
      description: "A careful architecture walk with a clear route, safety briefing, rest stops, and a welcoming introduction for first-time attendees.",
      categoryId: "walk",
      tags: "architecture,walk",
      startsAt: "2026-08-01T10:00",
      endsAt: "2026-08-01T12:00",
      deadlineAt: "2026-08-01T09:00",
      regionId: "tokyo",
      publicArea: "Kiyosumi-Shirakawa station",
      exactAddress: "1-2-3 Hirano, Koto-ku",
    },
    remote,
    uploadedNames: ["cover.jpg"],
  }));
}

function seedCompleteNewDraft(ownerId: string) {
  window.localStorage.setItem(composerDraftStorageKey(ownerId), JSON.stringify({
    draft: {
      title: "Tokyo architecture walk",
      description: "A careful architecture walk with a clear route, safety briefing, rest stops, and a welcoming introduction for first-time attendees.",
      categoryId: "walk",
      tags: "architecture,walk",
      startsAt: "2026-08-01T10:00",
      endsAt: "2026-08-01T12:00",
      deadlineAt: "2026-08-01T09:00",
      regionId: "tokyo",
      publicArea: "Kiyosumi-Shirakawa station",
      exactAddress: "1-2-3 Hirano, Koto-ku",
    },
    uploadedNames: ["cover.jpg"],
  }));
}

function mockComposerSaves(remote: ReturnType<typeof composerRemote>) {
  mocks.apiRequest.mockImplementation(async (path) => {
    if (path === "/me/groups") return { items: [] };
    if (path === `/events/${remote.id}`) return remote;
    throw new Error(`Unexpected API path: ${String(path)}`);
  });
}

function renderComposer() {
  return render(
    <I18nProvider initialLocale="en">
      <AppDialogProvider>
        <EventComposer />
      </AppDialogProvider>
    </I18nProvider>,
  );
}

async function advanceToContactStep(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Save & continue →" }));
  await screen.findByText("Draft saved to the cloud. You can continue on iOS.");
  await user.click(screen.getByRole("button", { name: "Save & continue →" }));
  await screen.findByRole("textbox", { name: /Contact email/ });
}

async function advanceToReviewStep(user: ReturnType<typeof userEvent.setup>) {
  await advanceToContactStep(user);
  for (let step = 0; step < 3; step += 1) {
    await user.click(screen.getByRole("button", { name: "Save & continue →" }));
    await waitFor(() => expect(screen.getByRole("button", {
      name: step === 2 ? "Confirm points & submit" : "Save & continue →",
    })).toBeEnabled());
  }
}
