import { screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SiteHeader } from "../app/components/SiteHeader";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { renderWithI18n } from "./event-fixtures";

const navigation = vi.hoisted(() => ({ pathname: "/discover" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

beforeEach(() => {
  navigation.pathname = "/discover";
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      clear: vi.fn(),
      getItem: vi.fn(() => null),
      key: vi.fn(() => null),
      length: 0,
      removeItem: vi.fn(),
      setItem: vi.fn(),
    } satisfies Storage,
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "localStorage");
  vi.unstubAllGlobals();
});

describe("responsive site navigation", () => {
  test("marks the active route and keeps region plus notifications in the mobile header", () => {
    renderWithI18n(<SiteHeader />);

    const discoverLinks = screen.getAllByRole("link", { name: "发现" });
    expect(discoverLinks).toHaveLength(2);
    expect(discoverLinks.every((link) => link.getAttribute("aria-current") === "page")).toBe(true);
    expect(screen.getByRole("link", { name: "地区：日本" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "通知" })).toHaveAttribute("data-unread", "false");
    expect(screen.getByRole("navigation", { name: "移动导航" })).toBeInTheDocument();
  });

  test("shows the notification dot only after the signed-in API reports unread items", async () => {
    const session = {
      accessToken: "access-token",
      accessTokenExpiresAt: "2099-01-01T00:00:00.000Z",
      refreshToken: "refresh-token",
      sessionId: "019b0000-0000-7000-8100-000000000091",
      user: {
        id: "019b0000-0000-7000-8100-000000000092",
        publicHandle: "viewer",
        phoneVerified: true,
        restrictions: [],
      },
    };
    vi.mocked(window.localStorage.getItem).mockImplementation((key) =>
      key === "spott.web.session.v1" ? JSON.stringify(session) : null,
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      items: [{
        id: "notification-1",
        type: "registration.confirmed",
        variables: {},
        resourceType: "event",
        resourcePublicId: "event-1",
        createdAt: "2026-07-17T00:00:00.000Z",
        readAt: null,
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    renderWithI18n(<SiteHeader />);

    await waitFor(() => expect(screen.getByRole("link", { name: "通知" })).toHaveAttribute("data-unread", "true"));
  });

  test("removes the global mobile dock when event detail owns the safe-area action", () => {
    navigation.pathname = "/e/tokyo-afterglow-walk";
    renderWithI18n(<SiteHeader />);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "移动导航" })).not.toBeInTheDocument();
  });

  test("keeps registration immersive without global chrome", () => {
    navigation.pathname = "/register/tokyo-afterglow-walk";
    renderWithI18n(<SiteHeader />);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "移动导航" })).not.toBeInTheDocument();
  });

  test("turns the public HTTP surface into an explicit read-only experience", () => {
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <SiteHeader />
      </PreviewModeProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("公开只读预览");
    expect(screen.getByRole("navigation", { name: "移动导航" })).toHaveClass("mobile-dock--readonly");
    expect(screen.queryByRole("link", { name: "创建活动" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "登录" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "通知" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "我的活动" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "主办方工作台" })).not.toBeInTheDocument();
  });
});
