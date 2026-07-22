import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AnchorHTMLAttributes } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { GroupExperience } from "../app/g/[slug]/GroupExperience";
import { GroupsDirectory } from "../app/groups/GroupsDirectory";
import { HostProfile } from "../app/u/[handle]/HostProfile";
import {
  APIError,
  apiRequest,
  readSession,
  type GroupAnnouncement,
  type GroupComment,
  type GroupView,
  type WebSession,
} from "../app/lib/client-api";
import { makeEvent, renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn(), readSession: vi.fn() };
});

vi.mock("next/link", () => ({
  default: ({ prefetch, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    href: string;
    prefetch?: boolean;
  }) => <a {...props} data-next-navigation="true" data-prefetch={prefetch === false ? "false" : undefined} />,
}));

const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);

const session: WebSession = {
  accessToken: "viewer-access-token",
  accessTokenExpiresAt: "2026-07-18T00:00:00.000Z",
  refreshGeneration: 0,
  sessionId: "019b0000-0000-7000-8100-000000000091",
  user: {
    id: "viewer-user",
    publicHandle: "viewer",
    phoneVerified: true,
    restrictions: [],
  },
};

const group: GroupView = {
  id: "019b0000-0000-7000-8300-000000000001",
  name: "东京晨间散步",
  slug: "tokyo-morning-walk",
  description: "周末一起探索东京。",
  joinMode: "open",
  regionId: "tokyo",
  tags: ["city-walk", "摄影"],
  capacity: 120,
  memberCount: 32,
  status: "active",
  membershipStatus: null,
  membershipRole: "owner",
  viewerFollowing: false,
  availableActions: ["joinGroup", "manage"],
  version: 1,
};

const matchingGroupEvent = makeEvent({
  id: "019b0000-0000-7000-8100-000000000021",
  publicSlug: "tokyo-morning-group-walk",
  title: "群组限定晨间散步",
  groupId: group.id,
});

const unrelatedGroupEvent = makeEvent({
  id: "019b0000-0000-7000-8100-000000000022",
  publicSlug: "unrelated-community-event",
  title: "其他社区的活动",
  groupId: "019b0000-0000-7000-8300-000000000002",
});

const announcement: GroupAnnouncement = {
  id: "announcement-1",
  groupId: group.id,
  authorName: "主办方",
  title: "本周集合说明",
  body: "请提前十分钟到场。",
  visibility: "public",
  commentsEnabled: true,
  likeCount: 3,
  viewerLiked: false,
  commentCount: 1,
  version: 1,
  createdAt: "2026-07-17T00:00:00.000Z",
  pinnedAt: "2026-07-17T00:00:00.000Z",
};

const comment: GroupComment = {
  id: "comment-1",
  announcementId: announcement.id,
  author: { id: session.user.id, name: "测试用户" },
  body: "集合点说明很清楚。",
  locale: "zh-Hans",
  version: 1,
  createdAt: "2026-07-17T01:00:00.000Z",
  updatedAt: "2026-07-17T01:00:00.000Z",
};

function renderReadOnly(
  ui: React.ReactElement,
  locale: "zh-Hans" | "ja" | "en" = "zh-Hans",
) {
  return renderInMode(ui, "read-only", locale);
}

function renderInMode(
  ui: React.ReactElement,
  initialMode: "standard" | "read-only" | "internal-test",
  locale: "zh-Hans" | "ja" | "en" = "zh-Hans",
) {
  return renderWithI18n(
    <PreviewModeProvider initialMode={initialMode}>
      <AppDialogProvider>{ui}</AppDialogProvider>
    </PreviewModeProvider>,
    locale,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  readSessionMock.mockReset();
  readSessionMock.mockReturnValue(session);
});

describe("public read-only community surfaces", () => {
  test("labels a standard signed-out directory as public instead of claiming public groups are mine", async () => {
    readSessionMock.mockReturnValue(null);
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [group] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderInMode(<GroupsDirectory />, "standard");

    expect(await screen.findByRole("heading", { name: group.name })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "兴趣群组", level: 2 })).toBeInTheDocument();
    expect(screen.getByText("公开社区")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "我的群组" })).not.toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalledWith("/me/groups", expect.anything());
  });

  test("describes an empty signed-out directory as public inventory instead of personal membership", async () => {
    readSessionMock.mockReturnValue(null);
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupsDirectory />, "en");

    expect(await screen.findByRole("heading", { name: "No public communities nearby yet" })).toBeInTheDocument();
    expect(screen.getByText("Browse events for now. New public communities will appear here as they open.")).toBeInTheDocument();
    expect(screen.queryByText("You haven’t joined a group yet")).not.toBeInTheDocument();
    expect(readSessionMock).not.toHaveBeenCalled();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  test("separates joined groups from public discovery for an authenticated viewer", async () => {
    const publicGroup = {
      ...group,
      id: "019b0000-0000-7000-8300-000000000002",
      name: "东京公共读书会",
      slug: "tokyo-public-reading",
    };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [group, publicGroup] };
      if (path === "/me/groups") return { items: [group] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderInMode(<GroupsDirectory />, "standard");

    const mineHeading = await screen.findByRole("heading", { name: "我的群组" });
    const mineSection = mineHeading.closest("section");
    expect(mineSection).not.toBeNull();
    expect(within(mineSection as HTMLElement).getByRole("heading", { name: group.name })).toBeInTheDocument();
    expect(within(mineSection as HTMLElement).getByText("已加入")).toBeInTheDocument();
    expect(within(mineSection as HTMLElement).queryByRole("heading", { name: publicGroup.name })).not.toBeInTheDocument();

    const publicHeading = screen.getByRole("heading", { name: "兴趣群组", level: 2 });
    const publicSection = publicHeading.closest("section");
    expect(publicSection).not.toBeNull();
    expect(within(publicSection as HTMLElement).getByRole("heading", { name: publicGroup.name })).toBeInTheDocument();
    expect(within(publicSection as HTMLElement).queryByRole("heading", { name: group.name })).not.toBeInTheDocument();
  });

  test("renders every creator-supported group region without collapsing it to Japan", async () => {
    const groups = [
      { ...group, id: "saitama-group", name: "埼玉群组", slug: "saitama-group", regionId: "saitama" },
      { ...group, id: "chiba-group", name: "千叶群组", slug: "chiba-group", regionId: "chiba" },
      { ...group, id: "nationwide-group", name: "全国群组", slug: "nationwide-group", regionId: "nationwide" },
    ];
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: groups };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupsDirectory />);

    await screen.findByRole("heading", { name: "埼玉群组" });
    expect(screen.getAllByText("埼玉").length).toBeGreaterThan(0);
    expect(screen.getAllByText("千叶").length).toBeGreaterThan(0);
    expect(screen.getAllByText("日本全国").length).toBeGreaterThan(0);
  });

  test("keeps community write controls available through the internal-test entry", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return group;
      if (path === "/events/search?limit=100") {
        return { items: [matchingGroupEvent, unrelatedGroupEvent] };
      }
      if (path === `/groups/${group.id}/announcements?limit=30`) return { items: [announcement] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderInMode(<GroupExperience slug={group.slug} />, "internal-test");

    expect(await screen.findByRole("button", { name: "加入群组" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关注群组" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /发布公告/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /♡ 3/ })).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  test("lists public groups without reading membership or showing create controls", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [group] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupsDirectory />);

    expect(await screen.findByRole("heading", { name: group.name })).toBeInTheDocument();
    expect(screen.getByText("东京 · 兴趣社区")).toBeInTheDocument();
    expect(screen.getByText("公开社区")).toBeInTheDocument();
    expect(screen.getByText("公开加入")).toBeInTheDocument();
    const groupLink = screen.getByRole("link", { name: new RegExp(group.name) });
    expect(groupLink).toHaveClass("group-tile-link");
    expect(within(groupLink).getByText("城市探索")).toBeInTheDocument();
    expect(within(groupLink).getByText("摄影")).toBeInTheDocument();
    expect(groupLink.querySelector(".group-artwork")).not.toBeNull();
    expect(screen.queryByText("COMMUNITIES / SYNCED")).not.toBeInTheDocument();
    expect(screen.queryByText("PUBLIC NETWORK")).not.toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /创建群组/ })).not.toBeInTheDocument();
    expect(groupLink).not.toHaveAttribute("data-next-navigation");
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).not.toHaveBeenCalledWith("/me/groups", expect.anything());
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  test("surfaces live community context and filters the directory without another request", async () => {
    const user = userEvent.setup();
    const walkingGroup: GroupView = {
      ...group,
      categoryId: "city-walk",
      owner: { id: "host-walk", name: "余光散步工作室", handle: "afterglow-walks" },
      announcementSummary: [{
        id: "announcement-directory-1",
        groupId: group.id,
        title: "本周路线与天气提醒",
        body: "集合点将在活动页更新。",
        visibility: "public",
        commentsEnabled: true,
        likeCount: 8,
        viewerLiked: false,
        commentCount: 3,
        version: 1,
        createdAt: "2026-07-18T00:00:00.000Z",
        pinnedAt: "2026-07-18T00:00:00.000Z",
      }],
    };
    const musicGroup: GroupView = {
      ...group,
      id: "music-group",
      name: "下北泽一枚聆听会",
      slug: "shimokita-one-record",
      description: "每次认真听完一张唱片。",
      categoryId: "music",
      tags: ["音乐", "唱片"],
      memberCount: 18,
      owner: { id: "host-music", name: "Listening Table", handle: "listening-table" },
    };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [walkingGroup, musicGroup] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupsDirectory />);

    const search = await screen.findByRole("searchbox", { name: "搜索兴趣社群" });
    expect(screen.getByText("公开社群")).toBeInTheDocument();
    expect(screen.getByText("社群成员席位")).toBeInTheDocument();
    expect(screen.getByText("近期动态")).toBeInTheDocument();
    expect(screen.getByText("本周路线与天气提醒")).toBeInTheDocument();
    expect(screen.getByText("由 余光散步工作室 发起")).toBeInTheDocument();

    await user.type(search, "唱片");
    expect(screen.getByRole("heading", { name: musicGroup.name })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: walkingGroup.name })).not.toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);

    await user.clear(search);
    await user.click(screen.getByRole("button", { name: "城市探索" }));
    expect(screen.getByRole("heading", { name: walkingGroup.name })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: musicGroup.name })).not.toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["ja", "興味のグループを検索", "まち歩き", "公開グループ", "主催者 が主催"],
    ["en", "Search interest communities", "City walks", "Public communities", "Hosted by 主催者"],
  ] as const)("localizes directory discovery controls in %s", async (locale, searchLabel, categoryLabel, communityLabel, hostLabel) => {
    const localizedGroup: GroupView = {
      ...group,
      categoryId: "city-walk",
      owner: { id: "localized-host", name: "主催者", handle: "localized-host" },
    };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [localizedGroup] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupsDirectory />, locale);

    expect(await screen.findByRole("searchbox", { name: searchLabel })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: categoryLabel })).toBeInTheDocument();
    expect(screen.getAllByText(communityLabel).length).toBeGreaterThan(0);
    expect(screen.getByText(hostLabel)).toBeInTheDocument();
  });

  test.each([
    ["zh-Hans", "摄影"],
    ["ja", "写真"],
    ["en", "Photography"],
  ] as const)("keeps the formal photography taxonomy visible and searchable in %s", async (locale, photographyLabel) => {
    const photographyGroup: GroupView = {
      ...group,
      id: `photography-group-${locale}`,
      categoryId: "photography",
      tags: [],
    };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [photographyGroup] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupsDirectory />, locale);

    const categoryButton = await screen.findByRole("button", { name: photographyLabel });
    expect(categoryButton).toBeInTheDocument();
    await userEvent.click(categoryButton);
    expect(screen.getByRole("heading", { name: photographyGroup.name })).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
  });

  test("loads group covers lazily and replaces a failed image with deterministic artwork", async () => {
    const coveredGroup = {
      ...group,
      coverURL: "https://media.spott.jp/groups/tokyo-morning-walk.jpg",
    };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/groups?limit=60") return { items: [coveredGroup] };
      throw new Error(`Unexpected request: ${path}`);
    });

    const { container } = renderReadOnly(<GroupsDirectory />);

    await screen.findByRole("heading", { name: coveredGroup.name });
    const artwork = container.querySelector(".group-artwork");
    const image = artwork?.querySelector("img");
    expect(image).toHaveAttribute("loading", "lazy");
    expect(image).toHaveAttribute("decoding", "async");
    expect(artwork?.querySelector(".group-artwork-fallback")).toBeNull();

    fireEvent.error(image as HTMLImageElement);

    expect(artwork?.querySelector("img")).toBeNull();
    const fallback = artwork?.querySelector(".group-artwork-fallback");
    expect(fallback).not.toBeNull();
    expect(fallback?.querySelector("small")).toHaveTextContent("东京");
    expect(fallback?.querySelector("strong")).toHaveTextContent("东京");
  });

  test("renders group loading cards with separate artwork and copy regions", () => {
    apiRequestMock.mockImplementation(() => new Promise(() => undefined));

    const { container } = renderReadOnly(<GroupsDirectory />);

    const skeletons = container.querySelectorAll(".group-skeleton-card");
    expect(skeletons).toHaveLength(6);
    for (const skeleton of skeletons) {
      expect(skeleton.querySelector(".group-skeleton-artwork")).not.toBeNull();
      expect(skeleton.querySelector(".group-skeleton-copy")).not.toBeNull();
    }
  });

  test("keeps group announcements readable while every group mutation stays unreachable", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return group;
      if (path === "/events/search?limit=100") {
        return { items: [matchingGroupEvent, unrelatedGroupEvent] };
      }
      if (path === `/groups/${group.id}/announcements?limit=30`) return { items: [announcement] };
      if (path === `/groups/${group.id}/announcements/${announcement.id}/comments`) {
        return { items: [comment] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<GroupExperience slug={group.slug} />);

    expect(await screen.findByRole("heading", { name: group.name })).toBeInTheDocument();
    expect(screen.getByText("兴趣社区 · 东京")).toBeInTheDocument();
    expect(screen.getByText("即将开始")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: matchingGroupEvent.title })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: unrelatedGroupEvent.title })).not.toBeInTheDocument();
    expect(screen.getByText(/置顶 ·/)).toBeInTheDocument();
    expect(screen.queryByText(/COMMUNITY \/|UP NEXT|^COMMUNITY$|PINNED/)).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("创建、加入、关注、点赞、评论、举报和拉黑");
    expect(screen.queryByRole("button", { name: "加入群组" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关注群组" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /发布公告/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /♡/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /1 评论/ }));
    expect(await screen.findByText(comment.body)).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("写下评论")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除" })).not.toBeInTheDocument();
    expect(apiRequestMock.mock.calls.some(([, init]) => Boolean(init?.method && init.method !== "GET"))).toBe(false);
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  test("shows a public profile without follow, report, or block controls and skips private block state", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/profiles/weekend-kai") {
        return {
          userId: "host-user",
          publicHandle: "weekend-kai",
          nickname: "周末开局",
          bio: "认真组织周末见面。",
          regionId: "tokyo",
          preferredLocale: "zh-Hans",
          contentLanguages: ["zh-Hans", "ja", "en"],
          avatarURL: null,
          followerCount: 80,
          viewerFollowing: false,
        };
      }
      if (path === "/profiles/weekend-kai/events?limit=60") return { items: [] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<HostProfile handle="weekend-kai" />);

    expect(await screen.findByRole("heading", { name: "周末开局" })).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("此页面仅展示公开内容");
    expect(screen.queryByRole("button", { name: "关注主办方" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "私密举报" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "拉黑该用户" })).not.toBeInTheDocument();
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalledTimes(2));
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/me/blocks")).toBe(false);
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  test.each([
    ["zh-Hans", "免费", "7月25日周六 · 23:00–7月26日周日 · 02:00"],
    ["ja", "無料", "7月25日(土) · 23:00–7月26日(日) · 02:00"],
    ["en", "Free", "Sat, Jul 25 · 23:00–Sun, Jul 26 · 02:00"],
  ] as const)("renders the lightweight public profile event contract in %s without fabricating a full event summary", async (locale, price, date) => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/profiles/spott_preview_studio") {
        return {
          userId: "019f1000-0000-7000-8000-000000000001",
          publicHandle: "spott_preview_studio",
          nickname: "东京余光散步会",
          bio: "每月选一条适合慢走的东京路线。",
          regionId: "tokyo",
          preferredLocale: "zh-Hans",
          contentLanguages: ["zh-Hans", "ja", "en"],
          avatarURL: null,
          followerCount: 0,
          viewerFollowing: false,
        };
      }
      if (path === "/profiles/spott_preview_studio/events?limit=60") {
        return {
          items: [
            {
              id: "019f1000-0000-7000-8100-000000000001",
              publicSlug: "tokyo-afterglow-preview",
              status: "published",
              title: "东京余光 · 隅田川蓝调散步",
              startsAt: "2026-07-25T14:00:00.000Z",
              endsAt: "2026-07-25T17:00:00.000Z",
              region: "tokyo",
              publicArea: "清澄白河站附近",
              priceLabel: "免费",
              coverURL: null,
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<HostProfile handle="spott_preview_studio" />, locale);

    const eventLink = await screen.findByRole("link", { name: /东京余光 · 隅田川蓝调散步/ });
    expect(eventLink).toHaveAttribute("href", "/e/tokyo-afterglow-preview");
    expect(within(eventLink).getByText(date)).toBeInTheDocument();
    expect(within(eventLink).getByText("清澄白河站附近")).toBeInTheDocument();
    expect(within(eventLink).getByText(price)).toBeInTheDocument();
    expect(screen.queryByText(/Invalid EventSummary/)).not.toBeInTheDocument();
  });

  test("distinguishes an absent profile from a recoverable network failure", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/profiles/missing-host") {
        throw new APIError(404, { code: "PROFILE_NOT_FOUND" });
      }
      if (path === "/profiles/missing-host/events?limit=60") return { items: [] };
      throw new Error(`Unexpected request: ${path}`);
    });

    const { unmount } = renderReadOnly(<HostProfile handle="missing-host" />);
    expect(await screen.findByRole("heading", { name: "用户主页不存在" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "重试" })).not.toBeInTheDocument();
    unmount();

    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/profiles/offline-host") throw new Error("network unavailable");
      if (path === "/profiles/offline-host/events?limit=60") return { items: [] };
      throw new Error(`Unexpected request: ${path}`);
    });

    renderReadOnly(<HostProfile handle="offline-host" />);
    expect(await screen.findByRole("heading", { name: "暂时无法加载主页" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
