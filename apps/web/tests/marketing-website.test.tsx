import { render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { AppStoreDownload } from "../app/components/marketing/AppStoreDownload";
import { MarketingFooter } from "../app/components/marketing/MarketingFooter";
import { marketingMetadata } from "../app/components/marketing/MarketingMetadata";
import { MarketingMenu } from "../app/components/marketing/MarketingMenu.client";
import { marketingCopy } from "../app/components/marketing/marketing-copy";
import { resolveAppStoreAvailability } from "../app/lib/app-store";
import { marketingLocaleForPath, routeShellFromHeader } from "../app/lib/route-shell";

const menuProps = {
  currentLanguage: "简体中文",
  languageLabel: "选择语言",
  languages: [
    { current: true, href: "/", label: "简体中文", locale: "zh-Hans" },
    { current: false, href: "/ja", label: "日本語", locale: "ja" },
    { current: false, href: "/en", label: "English", locale: "en" },
  ],
  menuCloseLabel: "关闭 Spott 官网导航",
  menuOpenLabel: "打开 Spott 官网导航",
  navItems: [
    { href: "#before-you-go", label: "参加前须知" },
    { href: "#community", label: "社群" },
  ],
  navigationLabel: "Spott 官网导航",
} as const;

describe("product website security and navigation contracts", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });

  afterEach(() => {
    document.body.style.overflow = "";
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  test("fails closed unless state, numeric id, and exact Apple URL agree", () => {
    const available = resolveAppStoreAvailability({
      NEXT_PUBLIC_APP_STORE_STATE: "available",
      NEXT_PUBLIC_APP_STORE_ID: "1234567890",
      NEXT_PUBLIC_APP_STORE_URL: "https://apps.apple.com/jp/app/spott/id1234567890",
    });
    expect(available).toEqual({
      state: "available",
      id: "1234567890",
      url: "https://apps.apple.com/jp/app/spott/id1234567890",
    });

    for (const url of [
      "http://apps.apple.com/jp/app/spott/id1234567890",
      "https://apps.apple.com.evil.example/jp/app/spott/id1234567890",
      "https://user@apps.apple.com/jp/app/spott/id1234567890",
      "https://apps.apple.com:444/jp/app/spott/id1234567890",
      "https://apps.apple.com/jp/app/spott/id9999999999",
      "https://apps.apple.com/jp/app/spott/id1234567890#download",
    ]) {
      expect(resolveAppStoreAvailability({
        NEXT_PUBLIC_APP_STORE_STATE: "available",
        NEXT_PUBLIC_APP_STORE_ID: "1234567890",
        NEXT_PUBLIC_APP_STORE_URL: url,
      })).toEqual({ state: "unavailable", id: null, url: null });
    }
  });

  test("renders one official localized badge for a qualified available store link", () => {
    const copy = marketingCopy("zh-Hans");
    const availability = {
      state: "available",
      id: "1234567890",
      url: "https://apps.apple.com/jp/app/spott/id1234567890",
    } as const;

    const { rerender } = render(
      <AppStoreDownload availability={availability} copy={copy} placement="hero" />,
    );

    const storeLink = screen.getByRole("link", { name: copy.hero.appStoreDownload });
    expect(storeLink).toHaveAttribute("href", availability.url);
    expect(storeLink).not.toHaveAttribute("target");
    expect(storeLink.querySelector("img")).toHaveAttribute(
      "src",
      "https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/zh-cn",
    );
    expect(screen.getByRole("link", { name: copy.hero.webCta })).toHaveAttribute("href", "/discover");

    rerender(<AppStoreDownload availability={availability} copy={copy} placement="header" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.nav.download })).toHaveAttribute("href", "#download");

    rerender(<AppStoreDownload availability={availability} copy={copy} placement="final" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: copy.nav.download })).toHaveAttribute("href", "#download");
  });

  test("keeps unavailable and unverified preorder states free of Apple badges and store links", () => {
    const copy = marketingCopy("ja");

    for (const availability of [
      { state: "unavailable", id: null, url: null },
      {
        state: "preorder",
        id: "1234567890",
        url: "https://apps.apple.com/jp/app/spott/id1234567890",
      },
    ] as const) {
      const { unmount } = render(
        <AppStoreDownload availability={availability} copy={copy} placement="hero" />,
      );
      expect(screen.queryByRole("img")).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: copy.hero.appStorePreorder })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: copy.hero.appStoreDownload })).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: copy.hero.webCta })).toHaveAttribute("href", "/discover");
      expect(screen.getByText(copy.hero.appStoreSoon)).toBeInTheDocument();
      unmount();
    }
  });

  test("shows Apple's trademark credit only when official artwork is active", () => {
    const copy = marketingCopy("en");
    const FooterWithCredit = MarketingFooter as ComponentType<{
      readonly copy: typeof copy;
      readonly showAppleTrademarkCredit: boolean;
    }>;
    const { rerender } = render(
      <FooterWithCredit copy={copy} showAppleTrademarkCredit />,
    );

    expect(screen.getByText(/App Store is a service mark of Apple Inc\./u)).toBeInTheDocument();

    rerender(<FooterWithCredit copy={copy} showAppleTrademarkCredit={false} />);
    expect(screen.queryByText(/App Store is a service mark of Apple Inc\./u)).not.toBeInTheDocument();
  });

  test("marks query-shaped marketing metadata noindex and nofollow", () => {
    vi.stubEnv("SPOTT_WEB_CANONICAL_ORIGIN", "https://spott.jp");
    const metadataWithQuery = marketingMetadata("ja", { hasQuery: true });

    expect(metadataWithQuery.robots).toEqual({ index: false, follow: false });
    expect(marketingMetadata("ja").robots).toEqual({ index: true, follow: true });
  });

  test.each(["zh-Hans", "ja", "en"] as const)(
    "uses the matching %s discovery capture in social metadata",
    (locale) => {
      vi.stubEnv("SPOTT_WEB_CANONICAL_ORIGIN", "https://spott.jp");
      expect(JSON.stringify(marketingMetadata(locale))).toContain(
        `/marketing/product/web-discover-${locale}-desktop.png`,
      );
    },
  );

  test("classifies only the three fixed locale roots as marketing", () => {
    expect(marketingLocaleForPath("/")).toBe("zh-Hans");
    expect(marketingLocaleForPath("/ja/")).toBe("ja");
    expect(marketingLocaleForPath("/en")).toBe("en");
    expect(marketingLocaleForPath("/discover")).toBeNull();
    expect(marketingLocaleForPath("/ja/discover")).toBeNull();
    expect(routeShellFromHeader("marketing")).toBe("marketing");
    expect(routeShellFromHeader("product")).toBe("product");
    expect(routeShellFromHeader("attacker-controlled")).toBe("product");
    expect(routeShellFromHeader(null)).toBe("product");
  });

  test("traps focus, locks scrolling, closes on Escape, and restores the toggle", async () => {
    const user = userEvent.setup();
    render(<MarketingMenu {...menuProps} />);

    expect(screen.getByLabelText(menuProps.languageLabel))
      .toHaveAccessibleName(menuProps.languageLabel);
    const openButton = screen.getByRole("button", { name: menuProps.menuOpenLabel });
    await user.click(openButton);

    const dialog = screen.getByRole("dialog", { name: menuProps.navigationLabel });
    expect(dialog).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
    const closeButton = dialog.querySelector<HTMLButtonElement>(
      `button[aria-label="${menuProps.menuCloseLabel}"]`,
    );
    expect(closeButton).not.toBeNull();
    await waitFor(() => expect(closeButton).toHaveFocus());

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: menuProps.navigationLabel })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    await waitFor(() => expect(openButton).toHaveFocus());
    expect(openButton).toHaveAttribute("aria-expanded", "false");
  });
});
