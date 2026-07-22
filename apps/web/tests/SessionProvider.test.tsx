import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { I18nProvider } from "../app/components/I18nProvider";
import { SessionProvider } from "../app/components/SessionProvider";
import { clearSession } from "../app/lib/client-api";

describe("SessionProvider bootstrap presentation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    clearSession();
  });

  afterEach(() => {
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  test.each([
    ["zh-Hans", "正在恢复安全会话…"],
    ["ja", "安全なセッションを復元しています…"],
    ["en", "Restoring your secure session…"],
  ] as const)("keeps a stable %s pending surface inert until credentialless bootstrap settles", async (locale, copy) => {
    let resolveBootstrap!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
      resolveBootstrap = resolve;
    }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider initialLocale={locale}>
        <SessionProvider>
          <button>Private action</button>
        </SessionProvider>
      </I18nProvider>,
    );

    const pending = screen.getByRole("status");
    const action = screen.getByRole("button", { name: "Private action" });
    expect(pending).toHaveTextContent(copy);
    expect(action.closest("[aria-busy]"))
      .toHaveAttribute("aria-busy", "true");
    expect(action.parentElement).toHaveAttribute("inert");

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/session/bootstrap",
      expect.objectContaining({ method: "GET", credentials: "include" }),
    ));

    resolveBootstrap(new Response(JSON.stringify({ state: "anonymous" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    expect(action.closest("[aria-busy]"))
      .toHaveAttribute("aria-busy", "false");
    expect(action.parentElement).not.toHaveAttribute("inert");
  });
});
