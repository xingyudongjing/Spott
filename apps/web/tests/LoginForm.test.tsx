import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { LoginForm } from "../app/login/LoginForm";
import {
  clearSession,
  deviceId,
  readSession,
  saveSession,
  type WebSession,
} from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: navigation.replace }),
}));

function completionReady(attemptId: string): Response {
  return new Response(JSON.stringify({
    state: "completion_ready",
    attemptId,
    expiresAt: Date.now() + 119_000,
  }), { status: 202, headers: { "Content-Type": "application/json" } });
}

function completionPending(input: {
  attemptId: string;
  bindingId: string;
  sessionId: string;
  deviceId: string;
}): Response {
  return new Response(JSON.stringify({
    state: "completion_pending",
    reconcileExpiresAt: Date.now() + 2_678_400_000,
    ...input,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("login legal consent", () => {
  afterEach(() => {
    clearSession();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    navigation.replace.mockReset();
  });
  test.each([
    ["zh-Hans", "服务条款", "隐私政策"],
    ["ja", "利用規約", "プライバシーポリシー"],
    ["en", "Terms", "Privacy Policy"],
  ] as const)("links to both legal documents in %s", (locale, terms, privacy) => {
    renderWithI18n(<LoginForm />, locale);

    expect(screen.getByRole("link", { name: terms })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: privacy })).toHaveAttribute("href", "/privacy");
  });

  test("localizes an unavailable challenge request instead of exposing fetch diagnostics", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    renderWithI18n(<LoginForm />, "zh-Hans");

    fireEvent.change(screen.getByLabelText("邮箱地址"), {
      target: { value: "codex-ui@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送邮箱验证码" }));

    expect(await screen.findByRole("status")).toHaveTextContent("暂时无法连接，请检查网络后重试。");
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  test("completes a real re-login after stale BFF Cookies are atomically rejected", async () => {
    const challengeId = "019d0000-0000-7000-8000-000000000101";
    const attemptId = "019d0000-0000-7000-8000-000000000104";
    const bindingId = "019d0000-0000-7000-8000-000000000105";
    const signedIn = {
      state: "authenticated",
      accessToken: "fresh-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshGeneration: 0,
      sessionId: "019d0000-0000-7000-8000-000000000102",
      user: {
        id: "019d0000-0000-7000-8000-000000000103",
        publicHandle: "relogin-user",
        phoneVerified: true,
        restrictions: [],
      },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/email/challenges")) {
        return new Response(JSON.stringify({
          challengeId,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          retryAfterSeconds: 60,
          developmentCode: "123456",
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/session/complete") {
        const completionCall = fetchMock.mock.calls
          .filter(([candidate]) => String(candidate) === "/api/session/complete").length;
        if (completionCall === 1) {
          return new Response(JSON.stringify({
            error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
          }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        if (completionCall === 2) return completionReady(attemptId);
        const body = JSON.parse(String(init?.body)) as { deviceId: string };
        return completionPending({
          attemptId,
          bindingId,
          sessionId: signedIn.sessionId,
          deviceId: body.deviceId,
        });
      }
      if (url === "/api/session/completion/accept") {
        expect(JSON.parse(String(init?.body))).toEqual({ attemptId });
        return new Response(JSON.stringify(signedIn), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithI18n(<LoginForm returnTo="/me/events" />, "en");

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "relogin@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    expect(await screen.findByLabelText("6-digit code")).toHaveValue("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));

    await waitFor(() => expect(readSession()).toMatchObject({
      accessToken: signedIn.accessToken,
      accessTokenExpiresAt: signedIn.accessTokenExpiresAt,
      refreshGeneration: signedIn.refreshGeneration,
      sessionId: signedIn.sessionId,
      user: signedIn.user,
    }));
    expect(fetchMock.mock.calls.filter(([input]) => String(input) === "/api/session/complete"))
      .toHaveLength(3);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === "/api/session/completion/accept")).toHaveLength(1);
    expect(navigation.replace).toHaveBeenCalledWith("/me/events");
    expect(screen.queryByText("Unable to complete sign in.")).not.toBeInTheDocument();
  });

  test("does not replace an unresolved completion attempt with a new challenge", async () => {
    const firstAttemptId = "019d0000-0000-7000-8000-000000000116";
    const secondAttemptId = "019d0000-0000-7000-8000-000000000117";
    const secondBindingId = "019d0000-0000-7000-8000-000000000118";
    const signedIn: WebSession = {
      accessToken: "replacement-challenge-access-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshGeneration: 0,
      sessionId: "019d0000-0000-7000-8000-000000000112",
      user: {
        id: "019d0000-0000-7000-8000-000000000113",
        publicHandle: "replacement-challenge-user",
        phoneVerified: true,
        restrictions: [],
      },
    };
    let challengeCalls = 0;
    let completionCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/auth/email/challenges")) {
        challengeCalls += 1;
        return new Response(JSON.stringify({
          challengeId: challengeCalls === 1
            ? "019d0000-0000-7000-8000-000000000114"
            : "019d0000-0000-7000-8000-000000000115",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          retryAfterSeconds: 60,
          developmentCode: "123456",
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/session/completion/accept") {
        expect(JSON.parse(String(init?.body))).toEqual({ attemptId: secondAttemptId });
        return new Response(JSON.stringify({ state: "authenticated", ...signedIn }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url !== "/api/session/complete") throw new Error(`Unexpected request: ${url}`);
      completionCalls += 1;
      if (completionCalls === 1) return completionReady(firstAttemptId);
      if (completionCalls === 2) {
        return new Response(JSON.stringify({
          error: { code: "SESSION_COMPLETION_UNAVAILABLE", retryable: true },
        }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      if (completionCalls === 3) {
        return new Response(JSON.stringify({
          error: { code: "SESSION_REAUTH_REQUIRED", retryable: false },
        }), { status: 401, headers: { "Content-Type": "application/json" } });
      }
      if (completionCalls === 4) {
        return completionReady(secondAttemptId);
      }
      const body = JSON.parse(String(init?.body)) as { deviceId: string };
      return completionPending({
        attemptId: secondAttemptId,
        bindingId: secondBindingId,
        sessionId: signedIn.sessionId,
        deviceId: body.deviceId,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithI18n(<LoginForm />, "en");

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "abandoned@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    expect(await screen.findByLabelText("6-digit code")).toHaveValue("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Unable to complete sign in.");

    fireEvent.click(screen.getByRole("button", { name: "Use another email" }));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "replacement@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    expect(await screen.findByLabelText("6-digit code")).toHaveValue("123456");
    fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Unable to complete sign in.");
    expect(readSession()).toBeNull();
    expect(challengeCalls).toBe(2);
    expect(completionCalls).toBe(2);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input) === "/api/session/completion/accept")).toHaveLength(0);
  });

  test("keeps a fresh account-switch device private until completion and uses it consistently", async () => {
    const previousDeviceId = "019d0000-0000-7000-8000-000000000201";
    const attemptId = "019d0000-0000-7000-8000-000000000207";
    const bindingId = "019d0000-0000-7000-8000-000000000208";
    window.localStorage.setItem("spott.web.device.v1", previousDeviceId);
    const currentSession: WebSession = {
      accessToken: "current-account-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshGeneration: 0,
      sessionId: "019d0000-0000-7000-8000-000000000202",
      user: {
        id: "019d0000-0000-7000-8000-000000000203",
        publicHandle: "current-account",
        phoneVerified: true,
        restrictions: [],
      },
    };
    const nextSession: WebSession = {
      ...currentSession,
      accessToken: "next-account-token",
      sessionId: "019d0000-0000-7000-8000-000000000204",
      user: {
        ...currentSession.user,
        id: "019d0000-0000-7000-8000-000000000205",
        publicHandle: "next-account",
      },
    };
    saveSession(currentSession);
    let candidateDeviceId = "";
    let completionCalls = 0;
    const requests: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/auth/email/challenges")) {
        const body = JSON.parse(String(init?.body)) as { deviceId: string };
        candidateDeviceId = body.deviceId;
        expect(candidateDeviceId).not.toBe(previousDeviceId);
        expect(new Headers(init?.headers).get("X-Spott-Device-Id")).toBe(candidateDeviceId);
        expect(window.localStorage.getItem("spott.web.device.v1")).toBe(previousDeviceId);
        return new Response(JSON.stringify({
          challengeId: "019d0000-0000-7000-8000-000000000206",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          retryAfterSeconds: 60,
          developmentCode: "123456",
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url === "/api/session/logout") {
        expect(window.localStorage.getItem("spott.web.device.v1")).toBe(previousDeviceId);
        return new Response(JSON.stringify({ state: "anonymous" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/session/complete") {
        const body = JSON.parse(String(init?.body)) as { deviceId: string };
        expect(body.deviceId).toBe(candidateDeviceId);
        expect(window.localStorage.getItem("spott.web.device.v1")).toBe(previousDeviceId);
        completionCalls += 1;
        if (completionCalls === 1) return completionReady(attemptId);
        return completionPending({
          attemptId,
          bindingId,
          sessionId: nextSession.sessionId,
          deviceId: body.deviceId,
        });
      }
      if (url === "/api/session/completion/accept") {
        expect(JSON.parse(String(init?.body))).toEqual({ attemptId });
        expect(window.localStorage.getItem("spott.web.device.v1")).toBe(candidateDeviceId);
        return new Response(JSON.stringify({ state: "authenticated", ...nextSession }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithI18n(<LoginForm />, "en");

    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "next-account@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send email code" }));
    expect(await screen.findByLabelText("6-digit code")).toHaveValue("123456");
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(previousDeviceId);

    fireEvent.click(screen.getByRole("button", { name: "Verify and log in" }));

    await waitFor(() => expect(readSession()).toEqual(nextSession));
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(candidateDeviceId);
    expect(requests.slice(-4)).toEqual([
      "/api/session/logout",
      "/api/session/complete",
      "/api/session/complete",
      "/api/session/completion/accept",
    ]);
  });

  test("rotates a previously bound device even after the prior account logged out", async () => {
    const previousDeviceId = "019d0000-0000-7000-8000-000000000211";
    window.localStorage.setItem("spott.web.device.v1", previousDeviceId);
    saveSession({
      accessToken: "prior-account-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshGeneration: 0,
      sessionId: "019d0000-0000-7000-8000-000000000212",
      user: {
        id: "019d0000-0000-7000-8000-000000000213",
        publicHandle: "prior-account",
        phoneVerified: true,
        restrictions: [],
      },
    });
    clearSession();
    let candidateDeviceId = "";
    let requestHeaderDeviceId = "";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { deviceId: string };
      candidateDeviceId = body.deviceId;
      requestHeaderDeviceId = new Headers(init?.headers).get("X-Spott-Device-Id") ?? "";
      return new Response(JSON.stringify({
        challengeId: "019d0000-0000-7000-8000-000000000214",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        retryAfterSeconds: 60,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithI18n(<LoginForm />, "zh-Hans");

    fireEvent.change(screen.getByLabelText("邮箱地址"), {
      target: { value: "another-account@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送邮箱验证码" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(candidateDeviceId).not.toBe(previousDeviceId);
    expect(requestHeaderDeviceId).toBe(candidateDeviceId);
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(previousDeviceId);
  });

  test("keeps a first-login candidate private until completion", async () => {
    window.localStorage.clear();
    const initialDeviceId = deviceId();
    let requestedDeviceId = "";
    let requestHeaderDeviceId = "";
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { deviceId: string };
      requestedDeviceId = body.deviceId;
      requestHeaderDeviceId = new Headers(init?.headers).get("X-Spott-Device-Id") ?? "";
      return new Response(JSON.stringify({
        challengeId: "019d0000-0000-7000-8000-000000000221",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        retryAfterSeconds: 60,
      }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithI18n(<LoginForm />, "ja");

    fireEvent.change(screen.getByLabelText("メールアドレス"), {
      target: { value: "first-login@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "確認コードを送信" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(requestedDeviceId).not.toBe(initialDeviceId);
    expect(requestHeaderDeviceId).toBe(requestedDeviceId);
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(initialDeviceId);
  });

  test("keeps the signed-in account intact when secure device storage is unavailable", async () => {
    const previousDeviceId = "019d0000-0000-7000-8000-000000000231";
    window.localStorage.setItem("spott.web.device.v1", previousDeviceId);
    const currentSession: WebSession = {
      accessToken: "protected-current-token",
      accessTokenExpiresAt: new Date(Date.now() + 900_000).toISOString(),
      refreshGeneration: 0,
      sessionId: "019d0000-0000-7000-8000-000000000232",
      user: {
        id: "019d0000-0000-7000-8000-000000000233",
        publicHandle: "protected-current",
        phoneVerified: true,
        restrictions: [],
      },
    };
    saveSession(currentSession);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage denied", "SecurityError");
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderWithI18n(<LoginForm />, "zh-Hans");

    fireEvent.change(screen.getByLabelText("邮箱地址"), {
      target: { value: "blocked-switch@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发送邮箱验证码" }));

    expect(await screen.findByRole("status")).toHaveTextContent("无法安全切换账号，请检查浏览器存储设置后重试。");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readSession()).toEqual(currentSession);
    expect(window.localStorage.getItem("spott.web.device.v1")).toBe(previousDeviceId);
  });
});
