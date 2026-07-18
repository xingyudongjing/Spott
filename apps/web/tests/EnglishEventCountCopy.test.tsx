import { screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { DiscoveryShell } from "../app/components/discovery/DiscoveryShell";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { formatMessage, type Locale } from "../app/i18n/messages";
import { eventFixture, makePage, renderWithI18n } from "./event-fixtures";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
    href: string;
    prefetch?: boolean;
  }) => <a {...props} data-prefetch={prefetch === false ? "false" : undefined} />,
}));

describe("visible event-count copy", () => {
  test("uses singular English on a one-result discovery page and its event card", () => {
    const oneEvent = {
      ...eventFixture,
      organizer: {
        ...eventFixture.organizer,
        trust: {
          ...eventFixture.organizer.trust,
          completedEventCount: 1,
        },
      },
    };

    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <DiscoveryShell
          initialQuery={{ category: "music" }}
          initialPage={makePage([oneEvent])}
        />
      </PreviewModeProvider>,
      "en",
    );

    expect(screen.getByText("1 event · Japan time")).toBeInTheDocument();
    expect(screen.getByText("1 event completed")).toBeInTheDocument();
    expect(screen.queryByText("1 events · Japan time")).not.toBeInTheDocument();
    expect(screen.queryByText("1 events completed")).not.toBeInTheDocument();
  });

  test("keeps English plural copy for non-singular counts", () => {
    expect(formatMessage("en", "discover.resultCount", { count: 2 }))
      .toBe("2 events · Japan time");
    expect(formatMessage("en", "event.completedEvents", { count: 2 }))
      .toBe("2 events completed");
  });

  test.each([
    ["zh-Hans", "1 个活动 · 按日本时间", "已完成 1 场活动"],
    ["ja", "1件 · 日本時間", "開催実績 1件"],
  ] as const)("preserves %s count semantics", (locale, resultCount, completedCount) => {
    expect(formatMessage(locale as Locale, "discover.resultCount", { count: 1 }))
      .toBe(resultCount);
    expect(formatMessage(locale as Locale, "event.completedEvents", { count: 1 }))
      .toBe(completedCount);
  });
});
