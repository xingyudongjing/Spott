import { screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { ReadOnlyCommunityNotice } from "../app/components/ReadOnlyCommunityNotice";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { SiteHeader } from "../app/components/SiteHeader";
import { renderWithI18n } from "./event-fixtures";

vi.mock("next/navigation", () => ({
  usePathname: () => "/groups",
}));

describe("read-only internal-test entry", () => {
  test("keeps complete Japanese guidance while exposing a real loopback link", () => {
    renderWithI18n(<ReadOnlyCommunityNotice />, "ja");

    expect(screen.getByRole("note")).toHaveTextContent(
      "このページでは公開情報のみ表示します。",
    );
    const entry = screen.getByRole("link", { name: "開く" });
    expect(entry).toHaveAttribute("href", "http://localhost:8080/groups");
    expect(entry).toHaveAttribute("target", "_blank");
    expect(entry).toHaveAttribute("rel", "noreferrer");
  });

  test("exposes one actionable internal-test entry from the global read-only banner", () => {
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <SiteHeader />
      </PreviewModeProvider>,
    );

    expect(screen.getByRole("status")).toHaveTextContent("公开只读预览");
    expect(screen.getByRole("status")).toContainElement(
      screen.getByRole("link", { name: "打开" }),
    );
    expect(screen.getByRole("link", { name: "打开" }))
      .toHaveAttribute("href", "http://localhost:8080/groups");
  });
});
