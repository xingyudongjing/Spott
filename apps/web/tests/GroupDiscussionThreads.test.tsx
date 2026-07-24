import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import {
  GroupDiscussionThreads,
  type GroupDiscussionPost,
} from "../app/g/[slug]/GroupDiscussionThreads";
import { apiRequest, readSession, type GroupView, type WebSession } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn(), readSession: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);
const readSessionMock = vi.mocked(readSession);

const session: WebSession = {
  accessToken: "member-access-token",
  accessTokenExpiresAt: "2026-07-25T00:00:00.000Z",
  refreshToken: "member-refresh-token",
  sessionId: "019b0000-0000-7000-8100-0000000000a1",
  user: { id: "member-user", publicHandle: "member", phoneVerified: true, restrictions: [] },
};

const baseGroup: GroupView = {
  id: "019b0000-0000-7000-8100-0000000000b1",
  name: "东京晨间散步",
  slug: "tokyo-morning-walk",
  description: "周末一起探索东京。",
  joinMode: "open",
  capacity: 120,
  memberCount: 32,
  status: "active",
  membershipStatus: "active",
  membershipRole: "member",
  availableActions: [],
  version: 1,
};

const post: GroupDiscussionPost = {
  id: "post-1",
  groupId: baseGroup.id,
  author: { id: "other-user", name: "周末开局" },
  body: "这周六去代代木公园怎么样？",
  parentId: null,
  locale: "zh-Hans",
  likeCount: 2,
  viewerLiked: false,
  replyCount: 1,
  version: 1,
  createdAt: "2026-07-20T01:00:00.000Z",
  updatedAt: "2026-07-20T01:00:00.000Z",
};

const reply: GroupDiscussionPost = {
  ...post,
  id: "reply-1",
  author: { id: "member-user", name: "测试用户" },
  body: "我可以带热水。",
  parentId: post.id,
  likeCount: 0,
  replyCount: 0,
  createdAt: "2026-07-20T02:00:00.000Z",
  updatedAt: "2026-07-20T02:00:00.000Z",
};

function renderThreads(group: GroupView, mode: "standard" | "read-only" = "standard") {
  return renderWithI18n(
    <PreviewModeProvider initialMode={mode}>
      <AppDialogProvider>
        <GroupDiscussionThreads group={group} onJoin={() => undefined} />
      </AppDialogProvider>
    </PreviewModeProvider>,
  );
}

beforeEach(() => {
  apiRequestMock.mockReset();
  readSessionMock.mockReset();
  readSessionMock.mockReturnValue(session);
});

describe("group discussion threads", () => {
  test("asks a signed-out visitor to sign in instead of firing a request that must 403", () => {
    readSessionMock.mockReturnValue(null);
    renderThreads({ ...baseGroup, membershipStatus: null, membershipRole: null });

    expect(screen.getByRole("heading", { name: "登录后查看群内讨论" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "登录" })).toHaveAttribute(
      "href",
      "/login?returnTo=%2Fg%2Ftokyo-morning-walk",
    );
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  test("locks a signed-in non-member out and offers the join action", () => {
    renderThreads({
      ...baseGroup,
      membershipStatus: null,
      membershipRole: null,
      availableActions: ["joinGroup"],
    });

    expect(screen.getByRole("heading", { name: "讨论区仅群成员可见" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加入群组" })).toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  test("tells a pending applicant the space unlocks after approval", () => {
    renderThreads({ ...baseGroup, membershipStatus: "pending", membershipRole: null });

    expect(screen.getByRole("heading", { name: "加入申请正在审核" })).toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  test("keeps the public read-only preview free of session reads and requests", () => {
    renderThreads({ ...baseGroup, membershipStatus: "active" }, "read-only");

    expect(screen.getByRole("heading", { name: "讨论区仅群成员可见" })).toBeInTheDocument();
    expect(apiRequestMock).not.toHaveBeenCalled();
    expect(readSessionMock).not.toHaveBeenCalled();
  });

  test("lets a member post, expand replies, and reply inside the thread", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/groups/${baseGroup.id}/discussion?limit=20`) {
        return { items: [post], hasMore: false, nextCursor: null };
      }
      if (path === `/groups/${baseGroup.id}/discussion` && init?.method === "POST") {
        return { ...post, id: "post-2", body: "带上垃圾袋。", replyCount: 0, likeCount: 0 };
      }
      if (path === `/groups/${baseGroup.id}/discussion/${post.id}/replies` && !init?.method) {
        return { items: [reply] };
      }
      if (path === `/groups/${baseGroup.id}/discussion/${post.id}/replies`) {
        return { ...reply, id: "reply-2", body: "我也去。" };
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });

    renderThreads(baseGroup);

    expect(await screen.findByText(post.body)).toBeInTheDocument();

    await user.type(screen.getByLabelText("发一条讨论"), "带上垃圾袋。");
    await user.click(screen.getByRole("button", { name: "发布" }));
    expect(await screen.findByText("带上垃圾袋。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "1 条回复" }));
    expect(await screen.findByText(reply.body)).toBeInTheDocument();

    await user.type(screen.getByLabelText("回复 周末开局"), "我也去。");
    await user.click(screen.getByRole("button", { name: "发送回复" }));
    expect(await screen.findByText("我也去。")).toBeInTheDocument();

    const postCall = apiRequestMock.mock.calls.find(
      ([path, init]) => path === `/groups/${baseGroup.id}/discussion` && init?.method === "POST",
    );
    expect(postCall?.[1]?.idempotencyKey).toBeTruthy();
  });

  test("hides moderation from ordinary members and gives managers hide and remove", async () => {
    apiRequestMock.mockResolvedValue({ items: [post], hasMore: false, nextCursor: null });

    const { unmount } = renderThreads(baseGroup);
    expect(await screen.findByText(post.body)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "隐藏" })).not.toBeInTheDocument();
    unmount();

    renderThreads({ ...baseGroup, membershipRole: "admin" });
    expect(await screen.findAllByText(post.body)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "隐藏" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "移除" })).toBeInTheDocument();
  });

  test("shows a designed error state with a retry instead of a raw fetch failure", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockRejectedValueOnce(new Error("fetch failed"));
    apiRequestMock.mockResolvedValue({ items: [post], hasMore: false, nextCursor: null });

    renderThreads(baseGroup);

    expect(await screen.findByText("讨论没有加载成功。")).toBeInTheDocument();
    expect(screen.queryByText("fetch failed")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重试" }));
    await waitFor(() => expect(screen.getByText(post.body)).toBeInTheDocument());
  });

  test("pages older posts through the cursor the API returns", async () => {
    const user = userEvent.setup();
    const older: GroupDiscussionPost = { ...post, id: "post-0", body: "上周走了皇居。" };
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/groups/${baseGroup.id}/discussion?limit=20`) {
        return { items: [post], hasMore: true, nextCursor: "cursor-1" };
      }
      if (path === `/groups/${baseGroup.id}/discussion?limit=20&cursor=cursor-1`) {
        return { items: [older], hasMore: false, nextCursor: null };
      }
      throw new Error(`Unexpected request: ${String(path)}`);
    });

    renderThreads(baseGroup);

    await user.click(await screen.findByRole("button", { name: "加载更早的讨论" }));
    expect(await screen.findByText(older.body)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "加载更早的讨论" })).not.toBeInTheDocument();
  });
});
