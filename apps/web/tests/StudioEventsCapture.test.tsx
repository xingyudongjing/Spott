import { render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { I18nProvider } from "../app/components/I18nProvider";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { StudioEventsClient } from "../app/studio/events/StudioEventsClient";
import { normalizeEvent } from "../app/lib/api";
import { apiRequest } from "../app/lib/client-api";
import { makeEvent } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../app/lib/client-api")>()),
  apiRequest: vi.fn(),
}));

describe("host-studio marketing capture seam", () => {
  test("renders the real host-studio component from a frozen fixture without a live account request", () => {
    const items = [
      normalizeEvent(makeEvent({ confirmedCount: 11, status: "published" })),
      normalizeEvent(makeEvent({
        confirmedCount: 4,
        id: "019b0000-0000-7000-8100-000000000002",
        publicSlug: "yanaka-morning-sketch",
        status: "draft",
        title: "Yanaka Morning Sketch",
      })),
    ];

    render(
      <I18nProvider initialLocale="en">
        <PreviewModeProvider initialMode="standard">
          <AppDialogProvider>
            <StudioEventsClient initialItems={items} />
          </AppDialogProvider>
        </PreviewModeProvider>
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Event management" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: items[0]!.title })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Yanaka Morning Sketch" })).toBeInTheDocument();
    expect(vi.mocked(apiRequest)).not.toHaveBeenCalled();
  });

  test.each([
    ["zh-Hans", "1 已发布", "已确认", "0 待审核"],
    ["ja", "1件公開", "確定済み", "審査中 0件"],
    ["en", "1 published", "confirmed", "0 in review"],
  ] as const)(
    "keeps the %s host metrics in one language",
    (locale, published, confirmed, review) => {
      const items = [
        normalizeEvent(makeEvent({ confirmedCount: 11, status: "published" })),
        normalizeEvent(makeEvent({
          confirmedCount: 4,
          id: "019b0000-0000-7000-8100-000000000002",
          publicSlug: "yanaka-morning-sketch",
          status: "draft",
          title: "Yanaka Morning Sketch",
        })),
      ];

      render(
        <I18nProvider initialLocale={locale}>
          <PreviewModeProvider initialMode="standard">
            <AppDialogProvider>
              <StudioEventsClient initialItems={items} />
            </AppDialogProvider>
          </PreviewModeProvider>
        </I18nProvider>,
      );

      expect(screen.getByText(published)).toBeInTheDocument();
      expect(screen.getByText(confirmed)).toBeInTheDocument();
      expect(screen.getByText(review)).toBeInTheDocument();
    },
  );
});
