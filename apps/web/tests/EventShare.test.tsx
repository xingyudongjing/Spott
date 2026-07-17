import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { EventActions } from "../app/e/[slug]/EventActions";
import { makeEvent, renderWithI18n } from "./event-fixtures";

const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");

afterEach(() => {
  restore(navigator, "share", originalShare);
  restore(navigator, "clipboard", originalClipboard);
  restore(window, "isSecureContext", originalSecureContext);
});

describe("event sharing capability fallback", () => {
  it("shows a selectable canonical URL on an insecure public IP", async () => {
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: false });
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <EventActions event={makeEvent()} session={null} />
      </PreviewModeProvider>,
      "en",
    );

    await userEvent.click(screen.getAllByRole("button", { name: "Share" })[0]!);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "http://localhost:3000/e/tokyo-afterglow-walk",
    );
  });

  it("uses the Clipboard API only in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <EventActions event={makeEvent()} session={null} />
      </PreviewModeProvider>,
      "en",
    );

    await userEvent.click(screen.getAllByRole("button", { name: "Share" })[0]!);
    expect(writeText).toHaveBeenCalledWith("http://localhost:3000/e/tokyo-afterglow-walk");
    expect(screen.getByRole("alert")).toHaveTextContent("Link copied.");
  });
});

function restore(target: object, key: PropertyKey, descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}
