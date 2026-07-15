import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SiteHeader } from "../app/components/SiteHeader";
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
});

describe("responsive site navigation", () => {
  test("marks the active route and keeps region plus notifications in the mobile header", () => {
    renderWithI18n(<SiteHeader />);

    const discoverLinks = screen.getAllByRole("link", { name: "发现" });
    expect(discoverLinks).toHaveLength(2);
    expect(discoverLinks.every((link) => link.getAttribute("aria-current") === "page")).toBe(true);
    expect(screen.getByRole("link", { name: "地区：日本" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "通知" })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "移动导航" })).toBeInTheDocument();
  });
});
