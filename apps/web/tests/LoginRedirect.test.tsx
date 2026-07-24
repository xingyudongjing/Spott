import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LoginForm } from "../app/login/LoginForm";
import { renderWithI18n } from "./event-fixtures";

const session = {
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshToken: "refresh-token",
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

function stubApi() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/auth/password/login")) {
        return new Response(JSON.stringify(session), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

async function loginWith(returnTo: string): Promise<string[]> {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign, pathname: "/login", search: "" },
  });

  renderWithI18n(<LoginForm returnTo={returnTo} />, "en");

  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "tester@example.jp" },
  });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "Str0ngPass!23" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));

  await waitFor(() => expect(assign).toHaveBeenCalled());
  return assign.mock.calls.map((call) => String(call[0]));
}

describe("login returnTo redirect safety", () => {
  beforeEach(() => {
    window.localStorage.clear();
    stubApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  test("follows a safe same-origin returnTo", async () => {
    expect(await loginWith("/e/tokyo-picnic")).toEqual(["/e/tokyo-picnic"]);
  });

  test("preserves query and hash on a safe returnTo", async () => {
    expect(await loginWith("/discover?city=tokyo#list")).toEqual([
      "/discover?city=tokyo#list",
    ]);
  });

  // A backslash after the leading slash is normalised by browsers to "//",
  // which turns the target into a protocol-relative cross-origin URL.
  test("refuses a backslash-smuggled off-site returnTo", async () => {
    const destinations = await loginWith("/\\evil.example");

    expect(destinations).toEqual(["/discover"]);
    for (const destination of destinations) {
      expect(new URL(destination, "https://spott.jp").origin).toBe("https://spott.jp");
    }
  });

  test("refuses a protocol-relative returnTo", async () => {
    expect(await loginWith("//evil.example/steal")).toEqual(["/discover"]);
  });

  test("refuses an absolute cross-origin returnTo", async () => {
    expect(await loginWith("https://evil.example/steal")).toEqual(["/discover"]);
  });
});
