import { screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { EventPrimaryAction } from "../app/e/[slug]/EventActions";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import type { EventCTA } from "../app/lib/event-cta";
import { makeEvent, renderWithI18n } from "./event-fixtures";

const registrationId = "019b0000-0000-7000-8200-000000000001";

const states: Array<[string, EventCTA]> = [
  ["unavailable", { kind: "event_unavailable", intent: "none", disabled: true }],
  ["offer", { kind: "accept_waitlist", intent: "accept_waitlist", disabled: false, registrationId, offerExpiresAt: "2026-07-16T04:00:00.000Z" }],
  ["itinerary", { kind: "view_itinerary", intent: "itinerary", disabled: false, registrationId }],
  ["pending", { kind: "view_pending", intent: "itinerary", disabled: false, registrationId }],
  ["waitlist", { kind: "view_waitlist", intent: "itinerary", disabled: false, registrationId }],
  ["login", { kind: "continue_login", intent: "login", disabled: false }],
  ["phone", { kind: "continue_phone_verification", intent: "phone_verification", disabled: false }],
  ["closed", { kind: "registration_closed", intent: "none", disabled: true }],
  ["join waitlist", { kind: "join_waitlist", intent: "register", disabled: false }],
  ["full", { kind: "full_closed", intent: "none", disabled: true }],
  ["apply", { kind: "apply", intent: "register", disabled: false }],
  ["register", { kind: "register", intent: "register", disabled: false }],
];

describe("rendered strict CTA states", () => {
  test.each(states)("%s renders exactly one primary action", (_name, cta) => {
    const { container } = renderWithI18n(
      <EventPrimaryAction
        cta={cta}
        event={makeEvent()}
        busy={false}
        onAccept={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("[data-event-primary]")).toHaveLength(1);
  });

  test("uses the real offer registration id and prevents unavailable navigation", () => {
    const onAccept = vi.fn();
    const { rerender } = renderWithI18n(
      <EventPrimaryAction
        cta={{ kind: "accept_waitlist", intent: "accept_waitlist", disabled: false, registrationId, offerExpiresAt: "2026-07-16T04:00:00.000Z" }}
        event={makeEvent()}
        busy={false}
        onAccept={onAccept}
      />,
    );
    screen.getByRole("button", { name: "接受候补名额" }).click();
    expect(onAccept).toHaveBeenCalledWith(registrationId);

    rerender(
      <EventPrimaryAction
        cta={{ kind: "event_unavailable", intent: "none", disabled: true }}
        event={makeEvent()}
        busy={false}
        onAccept={onAccept}
      />,
    );
    expect(screen.getByRole("button", { name: "活动暂不可参加" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "活动暂不可参加" })).not.toBeInTheDocument();
  });

  test("keeps the public HTTP preview from entering a write flow", () => {
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <EventPrimaryAction
          cta={{ kind: "register", intent: "register", disabled: false }}
          event={makeEvent()}
          busy={false}
          onAccept={vi.fn()}
        />
      </PreviewModeProvider>,
    );

    expect(screen.getByRole("button", { name: "内部测试入口可报名" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "报名参加" })).not.toBeInTheDocument();
  });
});
