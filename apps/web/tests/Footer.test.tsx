import { screen } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, test, vi } from "vitest";

import { Footer } from "../app/components/Footer";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { renderWithI18n } from "./event-fixtures";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    prefetch?: boolean;
  }) => <a {...props} data-next-navigation="true" data-prefetch={prefetch === false ? "false" : undefined} />,
}));

describe("mode-aware footer navigation", () => {
  test("uses document navigations throughout the public read-only footer", () => {
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <Footer />
      </PreviewModeProvider>,
    );

    expect(screen.getAllByRole("link")).not.toHaveLength(0);
    expect(screen.getAllByRole("link").every((link) => link.dataset.nextNavigation === undefined)).toBe(true);
  });

  test.each(["standard", "internal-test"] as const)(
    "keeps Next navigation in %s mode",
    (initialMode) => {
      renderWithI18n(
        <PreviewModeProvider initialMode={initialMode}>
          <Footer />
        </PreviewModeProvider>,
      );

      expect(screen.getAllByRole("link").every((link) => link.dataset.nextNavigation === "true")).toBe(true);
    },
  );
});
