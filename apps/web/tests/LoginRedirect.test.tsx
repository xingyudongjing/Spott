import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { LoginForm } from "../app/login/LoginForm";
import { clearSession } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

const session = {
  state: "authenticated",
  accessToken: "access-token",
  accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
  refreshGeneration: 0,
  sessionId: "019b0000-0000-7000-8000-000000000001",
  user: {
    id: "019b0000-0000-7000-8000-000000000002",
    publicHandle: "tester",
    phoneVerified: true,
    restrictions: [],
  },
};

const challengeId = "019b0000-0000-7000-8000-000000000010";
const attemptId = "019b0000-0000-7000-8000-000000000011";
const bindingId = "019b0000-0000-7000-8000-000000000012";
function stubApi() {
  let completionCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/auth/email/challenges")) {
        return new Response(
          JSON.stringify({
            challengeId,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            retryAfterSeconds: 30,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.endsWith("/api/session/complete")) {
        completionCalls += 1;
        const body = JSON.parse(String(init?.body)) as {
          deviceId: string;
        };
        return new Response(JSON.stringify(completionCalls === 1
          ? {
              state: "completion_ready",
              attemptId,
              expiresAt: Date.now() + 119_000,
            }
          : {
              state: "completion_pending",
              attemptId,
              sessionId: session.sessionId,
              bindingId,
              deviceId: body.deviceId,
              reconcileExpiresAt: Date.now() + 2_678_400_000,
            }), {
          status: completionCalls === 1 ? 202 : 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/session/completion/accept")) {
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
  navigation.replace.mockReset();

  renderWithI18n(<LoginForm returnTo={returnTo} />, "en");

  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "tester@example.jp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send email code" }));

  const codeField = await screen.findByLabelText("6-digit code");
  fireEvent.change(codeField, { target: { value: "123456" } });
  fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));

  await waitFor(() => expect(navigation.replace).toHaveBeenCalled());
  const fetchMock = vi.mocked(fetch);
  const completionCalls = fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith("/api/session/complete"));
  expect(completionCalls).toHaveLength(2);
  const completionBodies = completionCalls.map(([, init]) => {
    expect(init).toMatchObject({ method: "POST", credentials: "include" });
    return JSON.parse(String(init?.body)) as Record<string, unknown>;
  });
  expect(completionBodies[0]).toEqual({
    credential: { provider: "email", challengeId, code: "123456" },
    deviceId: expect.any(String),
  });
  expect(completionBodies[1]).toEqual({
    credential: { provider: "email", challengeId, code: "123456" },
    deviceId: expect.any(String),
    attemptId,
  });
  expect(completionBodies[1]?.deviceId).toBe(completionBodies[0]?.deviceId);
  const acceptCalls = fetchMock.mock.calls.filter(([input]) =>
    String(input).endsWith("/api/session/completion/accept"));
  expect(acceptCalls).toHaveLength(1);
  expect(JSON.parse(String(acceptCalls[0]?.[1]?.body))).toEqual({ attemptId });
  expect(fetchMock.mock.calls.some(([input]) => String(input).includes("/auth/email/verify")))
    .toBe(false);
  expect(window.localStorage.getItem("spott.web.session.v1")).toBeNull();
  return navigation.replace.mock.calls.map((call) => String(call[0]));
}

describe("login returnTo redirect safety", () => {
  beforeEach(() => {
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
    stubApi();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
    navigation.replace.mockReset();
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
