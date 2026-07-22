import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { I18nProvider } from "../app/components/I18nProvider";
import { SettingsClient } from "../app/me/settings/SettingsClient";
import { clearSession, saveSession, type WebSession } from "../app/lib/client-api";

const session: WebSession = {
  accessToken: "settings-access",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 1,
  sessionId: "019d0000-0000-7000-8000-000000000201",
  user: {
    id: "019d0000-0000-7000-8000-000000000202",
    publicHandle: "settings-user",
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

describe("Settings logout truthfulness", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
    clearSession();
    saveSession(session);
  });

  afterEach(() => {
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.cookie = "__Host-spott_logout_intent=; Path=/; Secure; SameSite=Strict; Max-Age=0";
    vi.unstubAllGlobals();
  });

  test("keeps the user on Settings and reports a retryable failure instead of pretending logout succeeded", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/me/achievements/evaluate")) {
        return json({ metrics: {
          checked_in_count: 0,
          hosted_ended_count: 0,
          owned_group_members: 0,
        } });
      }
      if (url.endsWith("/me/profile")) {
        return json({
          userId: session.user.id,
          nickname: "Settings User",
          bio: "",
          regionId: "tokyo",
          preferredLocale: "en",
          contentLanguages: ["en"],
          avatarURL: null,
          version: 1,
          updatedAt: new Date().toISOString(),
        });
      }
      if (url.endsWith("/notifications/preferences")) return json({ items: [] });
      if (url.endsWith("/me/achievements")) return json({ items: [] });
      if (url === "/api/session/logout") {
        return json({ error: { code: "LOGOUT_PENDING", retryable: true } }, 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <SettingsClient />
        </AppDialogProvider>
      </I18nProvider>,
    );

    expect(await screen.findByDisplayValue("Settings User")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Log out" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "We could not finish signing you out. Please try again.",
    );
  });

  test("does not claim logout-all succeeded when server-wide revocation is unconfirmed", async () => {
    const registrationDraft = "spott.web.registration-draft.v2.event.v1";
    const composerDraft = `spott.event-composer.v3.user.${session.user.id}`;
    window.sessionStorage.setItem(registrationDraft, "private");
    window.localStorage.setItem(composerDraft, "private");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/me/achievements/evaluate")) {
        return json({ metrics: {
          checked_in_count: 0,
          hosted_ended_count: 0,
          owned_group_members: 0,
        } });
      }
      if (url.endsWith("/me/profile")) {
        return json({
          userId: session.user.id,
          nickname: "Settings User",
          bio: "",
          regionId: "tokyo",
          preferredLocale: "en",
          contentLanguages: ["en"],
          avatarURL: null,
          version: 1,
          updatedAt: new Date().toISOString(),
        });
      }
      if (url.endsWith("/notifications/preferences")) return json({ items: [] });
      if (url.endsWith("/me/achievements")) return json({ items: [] });
      if (url === "/api/session/logout-all") {
        return json({ error: { code: "LOGOUT_ALL_UNCONFIRMED", retryable: false } }, 409);
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(
      <I18nProvider initialLocale="en">
        <AppDialogProvider>
          <SettingsClient />
        </AppDialogProvider>
      </I18nProvider>,
    );

    expect(await screen.findByDisplayValue("Settings User")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Log out everywhere" }));
    const dialog = await screen.findByRole("dialog", { name: "Log out everywhere" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Log out everywhere" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "We could not finish signing you out. Please try again.",
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "We could not finish signing you out. Please try again.",
    );
    expect(window.sessionStorage.getItem(registrationDraft)).toBeNull();
    expect(window.localStorage.getItem(composerDraft)).toBeNull();
  });
});
