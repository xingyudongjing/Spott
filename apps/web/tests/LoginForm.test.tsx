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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubAssign(): ReturnType<typeof vi.fn> {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign, pathname: "/login", search: "" },
  });
  return assign;
}

describe("login legal consent", () => {
  test.each([
    ["zh-Hans", "服务条款", "隐私政策"],
    ["ja", "利用規約", "プライバシーポリシー"],
    ["en", "Terms", "Privacy Policy"],
  ] as const)("links to both legal documents in %s", (locale, terms, privacy) => {
    renderWithI18n(<LoginForm />, locale);

    expect(screen.getByRole("link", { name: terms })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: privacy })).toHaveAttribute("href", "/privacy");
  });
});

describe("password auth as the primary path", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  test("login tab is active by default and posts credentials to /auth/password/login", async () => {
    const assign = stubAssign();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.includes("/auth/password/login")) return jsonResponse(session);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithI18n(<LoginForm returnTo="/e/tokyo-picnic" />, "en");

    expect(screen.getByRole("tab", { name: "Log in" })).toHaveAttribute("aria-selected", "true");

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "tester@example.jp" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Str0ngPass!23" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/e/tokyo-picnic"));

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/auth/password/login");
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body.email).toBe("tester@example.jp");
    expect(body.password).toBe("Str0ngPass!23");
    expect(body.deviceId).toBeTruthy();

    const stored = window.localStorage.getItem("spott.web.session.v1");
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored as string).sessionId).toBe(session.sessionId);
  });

  test("register tab posts nickname to /auth/password/register and saves the session", async () => {
    const assign = stubAssign();
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async (input) => {
      const url = String(input);
      if (url.includes("/auth/password/register")) return jsonResponse(session);
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderWithI18n(<LoginForm />, "en");
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "fresh@example.jp" },
    });
    fireEvent.change(screen.getByLabelText("Nickname (optional)"), {
      target: { value: "Kai" },
    });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Str0ngPass!23" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/discover"));

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String(init?.body)) as Record<string, string>;
    expect(body.nickname).toBe("Kai");
    expect(window.localStorage.getItem("spott.web.session.v1")).toContain(session.sessionId);
  });

  test("register mode shows a strength hint and blocks short passwords client-side", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    renderWithI18n(<LoginForm />, "en");
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));

    expect(
      screen.getByText(/At least 8 characters\. Mixing cases, numbers, or symbols/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "fresh@example.jp" },
    });
    const passwordField = screen.getByLabelText("Password");
    fireEvent.change(passwordField, { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(screen.getByText("Password must be at least 8 characters.")).toBeInTheDocument();
    expect(passwordField).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("INVALID_CREDENTIALS renders as a password field error", async () => {
    stubAssign();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "INVALID_CREDENTIALS", message: "邮箱或密码不正确。" } }, 401),
      ),
    );

    renderWithI18n(<LoginForm />, "en");
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "tester@example.jp" },
    });
    const passwordField = screen.getByLabelText("Password");
    fireEvent.change(passwordField, { target: { value: "wrong-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Log in" }));

    expect(await screen.findByText("Incorrect email or password.")).toBeInTheDocument();
    expect(passwordField).toHaveAttribute("aria-invalid", "true");
    expect(window.localStorage.getItem("spott.web.session.v1")).toBeNull();
  });

  test("EMAIL_ALREADY_REGISTERED renders as an email field error with a switch-to-login action", async () => {
    stubAssign();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { error: { code: "EMAIL_ALREADY_REGISTERED", message: "该邮箱已注册，请直接登录。" } },
          409,
        ),
      ),
    );

    renderWithI18n(<LoginForm />, "en");
    fireEvent.click(screen.getByRole("tab", { name: "Sign up" }));

    const emailField = screen.getByLabelText("Email address");
    fireEvent.change(emailField, { target: { value: "taken@example.jp" } });
    fireEvent.change(screen.getByLabelText("Password"), {
      target: { value: "Str0ngPass!23" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("This email is already registered. Log in instead."),
    ).toBeInTheDocument();
    expect(emailField).toHaveAttribute("aria-invalid", "true");

    fireEvent.click(screen.getByRole("button", { name: "Go to log in" }));
    expect(screen.getByRole("tab", { name: "Log in" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "Log in" })).toBeInTheDocument();
  });

  test("email OTP stays available as a secondary method and still logs in", async () => {
    const assign = stubAssign();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/auth/email/challenges")) {
          return jsonResponse({
            challengeId: "challenge-1",
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            retryAfterSeconds: 30,
          });
        }
        if (url.includes("/auth/email/verify")) return jsonResponse(session);
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    renderWithI18n(<LoginForm />, "en");

    expect(screen.getByText("Other ways to log in")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "tester@example.jp" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));

    const codeField = await screen.findByLabelText("6-digit code");
    fireEvent.change(codeField, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));

    await waitFor(() => expect(assign).toHaveBeenCalledWith("/discover"));
    expect(window.localStorage.getItem("spott.web.session.v1")).toContain(session.sessionId);
  });
});
