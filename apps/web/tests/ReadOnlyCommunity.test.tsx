import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
import { renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn(), readSession: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);

const session: WebSession = {
  accessToken: "viewer-access-token",
  accessTokenExpiresAt: "2026-07-18T00:00:00.000Z",
  refreshToken: "viewer-refresh-token",
  sessionId: "019b0000-0000-7000-8100-000000000091",
  user: {
    id: "viewer-user",
    publicHandle: "viewer",
    phoneVerified: true,
    restrictions: [],
  },
};

const group: GroupView = {
  id: "group-1",
  name: "东京晨间散步",
  slug: "tokyo-morning-walk",
  description: "周末一起探索东京。",
  joinMode: "open",
  regionId: "tokyo",
  capacity: 120,
  memberCount: 32,
  status: "active",
  membershipStatus: null,
  membershipRole: "owner",
  viewerFollowing: false,
  availableActions: ["joinGroup", "manage"],
  version: 1,
};

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

function renderReadOnly(ui: React.ReactElement) {
  return renderInMode(ui, "read-only");
}

function renderInMode(ui: React.ReactElement, initialMode: "standard" | "read-only" | "internal-test") {
  return renderWithI18n(
    <PreviewModeProvider initialMode={initialMode}>
      <AppDialogProvider>{ui}</AppDialogProvider>
    </PreviewModeProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  readSessionMock.mockReset();
  readSessionMock.mockReturnValue(session);
});

describe("public read-only community surfaces", () => {
  test("keeps community write controls available through the internal-test entry", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return group;
      if (path === "/events/search?limit=100") return { items: [] };
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
    expect(screen.queryByText("COMMUNITIES / SYNCED")).not.toBeInTheDocument();
    expect(screen.queryByText("PUBLIC NETWORK")).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("此页面仅展示公开内容");
    expect(screen.queryByRole("link", { name: /创建群组/ })).not.toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).not.toHaveBeenCalledWith("/me/groups", expect.anything());
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  test("keeps group announcements readable while every group mutation stays unreachable", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${group.slug}`) return group;
      if (path === "/events/search?limit=100") return { items: [] };
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
