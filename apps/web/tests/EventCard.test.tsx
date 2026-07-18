import { screen, within } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import { describe, expect, test, vi } from "vitest";

import { EventResultCard } from "../app/components/discovery/EventResultCard";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { eventFixture, renderWithI18n } from "./event-fixtures";

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    prefetch?: boolean;
  }) => <a {...props} data-next-navigation="true" data-prefetch={prefetch === false ? "false" : undefined} />,
}));

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

  test("gives the first real event an editorial treatment with description and at most three localized tags", () => {
    renderWithI18n(
      <EventResultCard
        event={{
          ...eventFixture,
          category: "walk",
          tags: ["walk", "music", "outdoor", "games", "learning"],
        }}
        featured
      />,
    );

    const card = screen.getByRole("article", { name: eventFixture.title });
    expect(card).toHaveAttribute("data-featured", "true");
    expect(card).toHaveTextContent(eventFixture.description);
    const tags = within(card).getByRole("list", { name: "活动标签" });
    expect(within(tags).getAllByRole("listitem")).toHaveLength(3);
    expect(tags).toHaveTextContent("城市探索");
    expect(tags).toHaveTextContent("音乐");
    expect(tags).toHaveTextContent("户外");
    expect(tags).not.toHaveTextContent("桌游");
  });

  test.each([
    ["ja", "イベントタグ", "まち歩き"],
    ["en", "Event tags", "City walks"],
  ] as const)("localizes discovery tags for %s without exposing implementation keys", (locale, listName, label) => {
    renderWithI18n(
      <EventResultCard event={{ ...eventFixture, category: "city-walk", tags: [] }} />,
      locale,
    );

    const tags = screen.getByRole("list", { name: listName });
    expect(tags).toHaveTextContent(label);
    expect(tags).not.toHaveTextContent("city-walk");
  });

  test.each([
    ["zh-Hans", "活动标签", "摄影"],
    ["ja", "イベントタグ", "写真"],
    ["en", "Event tags", "Photography"],
  ] as const)("preserves photography as a truthful localized tag in %s", (locale, listName, label) => {
    renderWithI18n(
      <EventResultCard event={{ ...eventFixture, category: "custom", tags: ["photography"] }} />,
      locale,
    );

    const tags = screen.getByRole("list", { name: listName });
    expect(tags).toHaveTextContent(label);
    expect(tags).not.toHaveTextContent(locale === "en" ? "City walks" : locale === "ja" ? "まち歩き" : "城市探索");
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

  test("describes a first-time organizer without presenting zero as a trust metric", () => {
    renderWithI18n(
      <EventResultCard
        event={{
          ...eventFixture,
          organizer: {
            ...eventFixture.organizer,
            trust: { ...eventFixture.organizer.trust, completedEventCount: 0 },
          },
        }}
      />,
    );

    const card = screen.getByRole("article", { name: eventFixture.title });
    expect(card).toHaveTextContent("Spott 新主办方");
    expect(card).not.toHaveTextContent("已完成 0 场活动");
    expect(card).not.toHaveTextContent("历史到场率");
  });

  test("uses a document navigation for event cards on the public read-only surface", () => {
    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <EventResultCard event={eventFixture} />
      </PreviewModeProvider>,
    );

    const link = within(screen.getByRole("article", { name: eventFixture.title })).getByRole("link");
    expect(link).not.toHaveAttribute("data-next-navigation");
    expect(link).toHaveAttribute("href", `/e/${eventFixture.publicSlug}`);
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
