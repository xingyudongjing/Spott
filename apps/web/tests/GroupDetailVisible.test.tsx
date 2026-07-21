import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes, ReactElement } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { I18nProvider } from "../app/components/I18nProvider";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { GroupDiscussion } from "../app/g/[slug]/GroupDiscussion";
import { GroupExperience } from "../app/g/[slug]/GroupExperience";
import {
  apiRequest,
  readSession,
  type GroupAnnouncement,
  type GroupComment,
  type GroupView,
} from "../app/lib/client-api";
import type { Locale } from "../app/i18n/messages";
import { makeEvent } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn(), readSession: vi.fn() };
});

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    prefetch?: boolean;
  }) => {
    void prefetch;
    return <a {...props} />;
  },
}));

const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);

const group: GroupView = {
  id: "019f1000-0000-7000-8200-000000000002",
  ownerId: "019f1000-0000-7000-8000-000000000002",
  owner: {
    id: "019f1000-0000-7000-8000-000000000002",
    name: "Shimokita Listening Table",
    handle: "spott_preview_weekend",
  },
  name: "下北沢一枚聴く会",
  slug: "shimokita-one-record",
  description: "一度に数曲だけを、最後までゆっくり聴く会です。",
  joinMode: "approval",
  regionId: "tokyo",
  categoryId: "music",
  tags: ["音楽", "レコード", "少人数"],
  rules: "音楽の知識は問いません。録音・配信・営業目的の参加はご遠慮ください。",
  capacity: 100,
  memberCount: 2,
  status: "active",
  membershipStatus: null,
  membershipRole: null,
  viewerFollowing: false,
  availableActions: ["joinGroup"],
  version: 1,
};

const announcement: GroupAnnouncement = {
  id: "019f1000-0000-7000-8220-000000000002",
  groupId: group.id,
  authorId: group.ownerId,
  authorName: group.owner?.name,
  title: "今月のテーマ：一曲目",
  body: "アルバムの一曲目だけを持ち寄る回です。好きな理由を一言話せれば十分です。",
  visibility: "public",
  commentsEnabled: true,
  pinnedAt: "2026-07-18T09:08:16.226Z",
  likeCount: 0,
  viewerLiked: false,
  commentCount: 1,
  version: 1,
  createdAt: "2026-07-18T09:08:16.226Z",
};

const comment: GroupComment = {
  id: "comment-1",
  announcementId: announcement.id,
  author: { id: "member-1", name: "Mika" },
  body: "手ぶらでも参加できるのが嬉しいです。",
  locale: "ja",
  version: 1,
  createdAt: "2026-07-18T10:00:00.000Z",
  updatedAt: "2026-07-18T10:00:00.000Z",
};

const event = makeEvent({
  id: "019f1000-0000-7000-8100-000000000002",
  publicSlug: "shimokita-vinyl-preview",
  title: "下北沢 Listening Table · 一枚を聴く夜",
  groupId: group.id,
});

function renderInReadOnly(ui: ReactElement, locale: Locale = "zh-Hans") {
  return render(
    <I18nProvider initialLocale={locale}>
      <PreviewModeProvider initialMode="read-only">
        <AppDialogProvider>{ui}</AppDialogProvider>
      </PreviewModeProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  readSessionMock.mockReset();
});

describe("visible group detail experience", () => {
  test("puts identity, real owner, membership facts, rules and a next event in one navigable public detail", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return group;
      if (path === "/events/search?limit=100") return { items: [event] };
      if (path === `/groups/${group.id}/announcements?limit=30`) return { items: [announcement] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderInReadOnly(<GroupExperience slug={group.slug} />, "en");

    expect(await screen.findByRole("heading", { level: 1, name: group.name })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: group.owner?.name })).toHaveAttribute(
      "href",
      `/u/${group.owner?.handle}`,
    );
    expect(screen.getByText("2 members")).toBeInTheDocument();
    expect(screen.getByText("Capacity 100")).toBeInTheDocument();
    expect(screen.getByText("Approval required")).toBeInTheDocument();
    expect(screen.getByText(group.rules!)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: event.title })).toBeInTheDocument();

    const navigation = screen.getByRole("navigation", { name: "Community sections" });
    expect(within(navigation).getByRole("link", { name: "About" })).toHaveAttribute("href", "#about");
    expect(within(navigation).getByRole("link", { name: "Events" })).toHaveAttribute("href", "#events");
    expect(within(navigation).getByRole("link", { name: "Discussion" })).toHaveAttribute("href", "#discussion");
    expect(screen.queryByRole("button", { name: /join group/i })).not.toBeInTheDocument();
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  test("keeps UGC in its source language while localizing the surrounding chrome", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return group;
      if (path === "/events/search?limit=100") return { items: [] };
      if (path === `/groups/${group.id}/announcements?limit=30`) return { items: [announcement] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderInReadOnly(<GroupExperience slug={group.slug} />, "en");

    expect((await screen.findAllByText(announcement.title)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(announcement.body)).toBeInTheDocument();
    expect(screen.getByText("Pinned update")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "About this community" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Community guidelines" })).toBeInTheDocument();
  });

  test("uses a dedicated localized description fallback without relabeling it as community rules", async () => {
    const groupWithoutDescription = { ...group, description: "   " };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return groupWithoutDescription;
      if (path === "/events/search?limit=100") return { items: [] };
      if (path === `/groups/${group.id}/announcements?limit=30`) return { items: [] };
      throw new Error(`Unexpected request: ${path}`);
    });
    const cases: Array<[Locale, string, string, string, string]> = [
      ["zh-Hans", "关于这个社群", "社群约定", "主办方暂未补充社群介绍。", "主办方暂未补充社群约定。"],
      ["ja", "このコミュニティについて", "コミュニティの約束", "コミュニティの紹介はまだありません。", "コミュニティの約束はまだありません。"],
      ["en", "About this community", "Community guidelines", "The host has not added a community description yet.", "The host has not added community guidelines yet."],
    ];

    for (const [locale, aboutLabel, rulesLabel, descriptionFallback, rulesFallback] of cases) {
      const view = renderInReadOnly(<GroupExperience slug={group.slug} />, locale);
      await screen.findByRole("heading", { level: 1, name: group.name });
      const about = screen.getByRole("region", { name: aboutLabel });
      const rules = screen.getByRole("region", { name: rulesLabel });
      expect(within(about).getByText(descriptionFallback)).toBeInTheDocument();
      expect(within(about).queryByText(group.rules!)).not.toBeInTheDocument();
      expect(within(rules).getByText(group.rules!)).toBeInTheDocument();
      expect(screen.queryByText(rulesFallback)).not.toBeInTheDocument();
      expect(screen.getAllByText(group.rules!)).toHaveLength(1);
      view.unmount();
    }
  });

  test("the detail stylesheet specifies responsive layout, touch targets and inclusive fallbacks", () => {
    const cssPath = resolve(process.cwd(), "app/g/[slug]/GroupDetail.module.css");
    const css = readFileSync(cssPath, "utf8");
    const discussionControlRule = css.match(
      /\.threadAction,\s*\.discussionToggle,\s*\.commentRetry\s*\{([^}]*)\}/,
    )?.[1];

    expect(css).toMatch(/\.sectionNav a\s*\{[\s\S]*?min-height:\s*44px;/);
    expect(discussionControlRule).toBeDefined();
    expect(discussionControlRule).toMatch(/min-height:\s*44px;/);
    expect(css).toMatch(/@media\s*\(max-width:\s*780px\)[\s\S]*?grid-template-areas:\s*"about"\s*"main";/);
    expect(css).toMatch(/@media\s*\(forced-colors:\s*active\)/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

describe("public discussion comments", () => {
  test("announces loading, wires expanded state to the panel, and then renders comments", async () => {
    const user = userEvent.setup();
    let resolveComments!: (value: { items: GroupComment[] }) => void;
    apiRequestMock.mockImplementation(() => new Promise((resolve) => {
      resolveComments = resolve;
    }));

    renderInReadOnly(<GroupDiscussion group={group} initialItems={[announcement]} />);

    const toggle = screen.getByRole("button", { name: /1 评论/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panelId = toggle.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();
    expect(screen.getByRole("status")).toHaveTextContent("正在加载评论");

    resolveComments({ items: [comment] });
    expect(await screen.findByText(comment.body)).toBeInTheDocument();
    expect(document.getElementById(panelId!)).toContainElement(screen.getByText(comment.body));
  });

  test("shows a localized empty state when an announcement has no comments", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockResolvedValue({ items: [] });

    renderInReadOnly(
      <GroupDiscussion group={group} initialItems={[{ ...announcement, commentCount: 0 }]} />,
      "ja",
    );
    await user.click(screen.getByRole("button", { name: /コメント 0件/ }));

    expect(await screen.findByText("最初のコメントはまだありません。")).toBeInTheDocument();
  });

  test("keeps a failed comment panel open and retries without exposing a write action", async () => {
    const user = userEvent.setup();
    apiRequestMock
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce({ items: [comment] });

    renderInReadOnly(<GroupDiscussion group={group} initialItems={[announcement]} />, "en");
    await user.click(screen.getByRole("button", { name: /1 comment/ }));

    expect(await screen.findByText("Comments could not be loaded.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry comments" }));

    expect(await screen.findByText(comment.body)).toBeInTheDocument();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));
    expect(screen.queryByPlaceholderText("Write a comment")).not.toBeInTheDocument();
    expect(readSessionMock).not.toHaveBeenCalled();
  });
});
