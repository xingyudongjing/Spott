import { screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { EventResultCard } from "../app/components/discovery/EventResultCard";
import { eventFixture, renderWithI18n } from "./event-fixtures";

describe("premium event result", () => {
  test("uses one whole-item link and renders only structured event facts", () => {
    renderWithI18n(<EventResultCard event={eventFixture} priority />);

    const card = screen.getByRole("article", { name: eventFixture.title });
    expect(within(card).getAllByRole("link")).toHaveLength(1);
    expect(within(card).getByRole("link")).toHaveAttribute(
      "href",
      `/e/${eventFixture.publicSlug}`,
    );
    expect(card).toHaveTextContent("清澄白河站附近");
    expect(card).toHaveTextContent("免费");
    expect(card).toHaveTextContent("线下");
    expect(card).toHaveTextContent("日语");
    expect(card).toHaveTextContent("语言已确认");
    expect(card).toHaveTextContent("周末开局");
    expect(card).toHaveTextContent("手机已验证");
    expect(card).toHaveTextContent("已完成 18 场活动");
    expect(card).toHaveTextContent("余 13");

    expect(card).not.toHaveTextContent(/TOKYO \/ BLUE HOUR|SPOTT \/ TOKYO|评分|推荐给你/);
    expect(within(card).getByTestId("event-cover-fallback")).toBeInTheDocument();
  });

  test("marks commercially promoted results and never invents the badge otherwise", () => {
    const { unmount } = renderWithI18n(
      <EventResultCard event={{ ...eventFixture, promoted: true }} />,
    );
    expect(screen.getByRole("article", { name: eventFixture.title })).toHaveTextContent("推广");
    unmount();

    renderWithI18n(<EventResultCard event={eventFixture} />);
    expect(screen.getByRole("article", { name: eventFixture.title })).not.toHaveTextContent("推广");
  });

  test("treats zero capacity as unlimited instead of manufacturing a waitlist", () => {
    renderWithI18n(
      <EventResultCard
        event={{
          ...eventFixture,
          capacity: 0,
          availableCapacity: 0,
          waitlistEnabled: true,
          availableActions: ["register"],
        }}
      />,
    );

    const card = screen.getByRole("article", { name: eventFixture.title });
    expect(card).toHaveTextContent("不限量");
    expect(card).not.toHaveTextContent("可候补");
  });

  test("shows waitlist only when a full event exposes the joinWaitlist action", () => {
    renderWithI18n(
      <EventResultCard
        event={{
          ...eventFixture,
          capacity: 12,
          availableCapacity: 0,
          waitlistEnabled: true,
          availableActions: ["joinWaitlist"],
        }}
      />,
    );

    expect(screen.getByRole("article", { name: eventFixture.title })).toHaveTextContent("可候补");
  });

  test("shows full when no waitlist action is available", () => {
    renderWithI18n(
      <EventResultCard
        event={{
          ...eventFixture,
          capacity: 12,
          availableCapacity: 0,
          waitlistEnabled: false,
          availableActions: [],
        }}
      />,
    );

    const card = screen.getByRole("article", { name: eventFixture.title });
    expect(card).toHaveTextContent("已满");
    expect(card).not.toHaveTextContent("可候补");
  });

  test.each([
    ["pending", "报名待确认"],
    ["confirmed", "已报名"],
    ["waitlisted", "候补中"],
    ["offered", "候补名额已释放"],
    ["checked_in", "已签到"],
  ] as const)("prioritizes the viewer registration state %s over generic capacity", (status, label) => {
    renderWithI18n(
      <EventResultCard
        event={{
          ...eventFixture,
          registrationStatus: status,
          viewerRegistration: {
            id: "019b0000-0000-7000-8100-000000000090",
            status,
            partySize: 1,
            offerExpiresAt: status === "offered" ? "2026-07-17T00:00:00.000Z" : null,
          },
        }}
      />,
    );

    const card = screen.getByRole("article", { name: eventFixture.title });
    expect(card).toHaveTextContent(label);
    expect(card).not.toHaveTextContent("余 13");
  });
});
