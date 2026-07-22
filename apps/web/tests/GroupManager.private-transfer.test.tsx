import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { I18nProvider } from "../app/components/I18nProvider";
import { clearSession, saveSession, type WebSession } from "../app/lib/client-api";
import { groupTransferStorageKey } from "../app/lib/group-transfer-cache";
import { GroupManager } from "../app/studio/groups/[id]/GroupManager";

const groupId = "019b0000-0000-7000-8000-000000000051";
const session: WebSession = {
  accessToken: "group-manager-access",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 1,
  sessionId: "019b0000-0000-7000-8000-000000000052",
  user: {
    id: "019b0000-0000-7000-8000-000000000053",
    publicHandle: "group-owner",
    phoneVerified: true,
    restrictions: [],
  },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("GroupManager private transfer cache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    clearSession();
    saveSession(session);
  });

  afterEach(() => {
    clearSession();
    window.localStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("removes a hydrated transfer from storage and memory when authority returns 403", async () => {
    const cacheKey = groupTransferStorageKey(groupId);
    window.localStorage.setItem(cacheKey, JSON.stringify({
      id: "019b0000-0000-7000-8000-000000000054",
      groupId,
      state: "pending",
    }));
    let resolveActive!: (response: Response) => void;
    const activeResponse = new Promise<Response>((resolve) => { resolveActive = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/groups/${groupId}`)) {
        return json({
          id: groupId,
          slug: "private-group",
          name: "Private group",
          memberCount: 1,
          capacity: 50,
          status: "active",
          membershipRole: "member",
          availableActions: [],
        });
      }
      if (url.endsWith(`/groups/${groupId}/transfers/active`)) return activeResponse;
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <GroupManager groupId={groupId} />
        </AppDialogProvider>
      </I18nProvider>,
    );

    resolveActive(json({ error: { code: "FORBIDDEN" } }, 403));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Private group" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Active ownership transfer" }))
        .not.toBeInTheDocument();
      expect(window.localStorage.getItem(cacheKey)).toBeNull();
    });
  });

  test("removes an active transfer from memory when the signed-in owner changes", async () => {
    const cacheKey = groupTransferStorageKey(groupId);
    const activeTransfer = {
      id: "019b0000-0000-7000-8000-000000000055",
      groupId,
      state: "pending",
    };
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/groups/${groupId}`)) {
        return json({
          id: groupId,
          slug: "private-group",
          name: "Private group",
          memberCount: 1,
          capacity: 50,
          status: "active",
          membershipRole: "member",
          availableActions: [],
        });
      }
      if (url.endsWith(`/groups/${groupId}/transfers/active`)) return json(activeTransfer);
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <GroupManager groupId={groupId} />
        </AppDialogProvider>
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Active ownership transfer" }))
      .toBeVisible();
    expect(window.localStorage.getItem(cacheKey)).not.toBeNull();

    saveSession({
      ...session,
      accessToken: "other-user-access",
      sessionId: "019b0000-0000-7000-8000-000000000056",
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000057" },
    });

    await waitFor(() => {
      expect(screen.queryByRole("heading", { name: "Active ownership transfer" }))
        .not.toBeInTheDocument();
      expect(window.localStorage.getItem(cacheKey)).toBeNull();
    });
  });

  test("ignores an old owner's active-transfer response that arrives after account switch", async () => {
    const cacheKey = groupTransferStorageKey(groupId);
    let resolveActive!: (response: Response) => void;
    const activeResponse = new Promise<Response>((resolve) => { resolveActive = resolve; });
    let observeActive!: () => void;
    const activeObserved = new Promise<void>((resolve) => { observeActive = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/groups/${groupId}`)) {
        return json({
          id: groupId,
          slug: "private-group",
          name: "Private group",
          memberCount: 1,
          capacity: 50,
          status: "active",
          membershipRole: "member",
          availableActions: [],
        });
      }
      if (url.endsWith(`/groups/${groupId}/transfers/active`)) {
        observeActive();
        return activeResponse;
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <GroupManager groupId={groupId} />
        </AppDialogProvider>
      </I18nProvider>,
    );
    await activeObserved;

    saveSession({
      ...session,
      accessToken: "other-user-access",
      sessionId: "019b0000-0000-7000-8000-000000000058",
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000059" },
    });
    resolveActive(json({
      id: "019b0000-0000-7000-8000-000000000060",
      groupId,
      state: "pending",
    }));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Private group" })).toBeVisible());
    expect(screen.queryByRole("heading", { name: "Active ownership transfer" }))
      .not.toBeInTheDocument();
    expect(window.localStorage.getItem(cacheKey)).toBeNull();
  });

  test("does not hydrate an old owner's captured cache after account switch", async () => {
    const cacheKey = groupTransferStorageKey(groupId);
    window.localStorage.setItem(cacheKey, JSON.stringify({
      id: "019b0000-0000-7000-8000-000000000071",
      groupId,
      state: "pending",
    }));
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith(`/groups/${groupId}`)) {
        return json({
          id: groupId,
          slug: "private-group",
          name: "Private group",
          memberCount: 1,
          capacity: 50,
          status: "active",
          membershipRole: "member",
          availableActions: [],
        });
      }
      if (url.endsWith(`/groups/${groupId}/transfers/active`)) {
        return json({ error: { code: "UNAVAILABLE" } }, 503);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <GroupManager groupId={groupId} />
        </AppDialogProvider>
      </I18nProvider>,
    );
    saveSession({
      ...session,
      accessToken: "other-user-access",
      sessionId: "019b0000-0000-7000-8000-000000000072",
      user: { ...session.user, id: "019b0000-0000-7000-8000-000000000073" },
    });

    await waitFor(() => expect(screen.getByRole("heading", { name: "Private group" })).toBeVisible());
    expect(screen.queryByRole("heading", { name: "Active ownership transfer" }))
      .not.toBeInTheDocument();
    expect(window.localStorage.getItem(cacheKey)).toBeNull();
  });
});
