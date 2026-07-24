import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventComments, type EventCommentView } from "../app/e/[slug]/EventComments";
import { PreviewModeProvider } from "../app/components/PreviewModeProvider";
import { apiRequest, type WebSession } from "../app/lib/client-api";
import { makeDetail, renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);

const viewerSession: WebSession = {
  accessToken: "viewer-access-token",
  accessTokenExpiresAt: "2026-07-24T01:00:00.000Z",
  refreshToken: "viewer-refresh-token",
  sessionId: "019b0000-0000-7000-8100-000000000091",
  user: {
    id: "019b0000-0000-7000-8100-000000000092",
    publicHandle: "viewer",
    phoneVerified: true,
    restrictions: [],
  },
};

function makeComment(overrides: Partial<EventCommentView> = {}): EventCommentView {
  return {
    id: "019b0000-0000-7000-8300-000000000001",
    body: "自带水杯就可以了。",
    parentId: null,
    locale: "zh-Hans",
    createdAt: "2026-07-16T09:00:00.000Z",
    author: { id: "019b0000-0000-7000-8100-000000000010", name: "周末开局" },
    ...overrides,
  };
}

function mockThread(
  items: EventCommentView[],
  commentPermission: "disabled" | "participants" | "group_members" = "participants",
) {
  apiRequestMock.mockImplementation(async (path: string) => {
    if (path.endsWith("/comments")) return { eventId: "x", commentPermission, items };
    throw new Error(`unexpected request ${path}`);
  });
}

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe("controlled event comments", () => {
  test("lists comments with author, time, and one nested reply level", async () => {
    mockThread([
      makeComment(),
      makeComment({
        id: "019b0000-0000-7000-8300-000000000002",
        parentId: "019b0000-0000-7000-8300-000000000001",
        body: "收到，谢谢！",
        author: { id: "019b0000-0000-7000-8100-000000000092", name: "小林" },
      }),
    ]);

    renderWithI18n(
      <EventComments event={makeDetail()} session={null} locale="zh-Hans" />,
    );

    expect(await screen.findByText("自带水杯就可以了。")).toBeInTheDocument();
    expect(screen.getByText("周末开局")).toBeInTheDocument();
    const thread = screen.getByText("自带水杯就可以了。").closest("li")!;
    expect(within(thread).getByText("收到，谢谢！")).toBeInTheDocument();
    expect(within(thread).getByText("小林")).toBeInTheDocument();
    expect(screen.getByText("2 条")).toBeInTheDocument();
  });

  test("keeps the composer away from anonymous viewers with the participant gate copy", async () => {
    mockThread([makeComment()]);

    renderWithI18n(
      <EventComments event={makeDetail()} session={null} locale="zh-Hans" />,
    );

    expect(await screen.findByTestId("comment-gate")).toHaveTextContent("仅参与者可评论");
    expect(screen.queryByRole("textbox", { name: "写评论" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "回复" })).not.toBeInTheDocument();
  });

  test("shows the closed state when the organizer disabled comments", async () => {
    mockThread([], "disabled");

    renderWithI18n(
      <EventComments event={makeDetail()} session={viewerSession} locale="zh-Hans" />,
    );

    expect(await screen.findByText("该活动已关闭评论。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "写评论" })).not.toBeInTheDocument();
  });

  test("lets a confirmed attendee post with a stable idempotency key and renders the result", async () => {
    const user = userEvent.setup();
    const created = makeComment({
      id: "019b0000-0000-7000-8300-000000000009",
      body: "请问几点集合？",
      author: { id: viewerSession.user.id, name: "小林" },
    });
    apiRequestMock.mockImplementation(async (path, init) => {
      if (init?.method === "POST") return created;
      if (path.endsWith("/comments")) {
        return { commentPermission: "participants", items: [makeComment()] };
      }
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <EventComments
        event={makeDetail({
          viewerRegistration: {
            id: "019b0000-0000-7000-8200-000000000001",
            status: "confirmed",
            partySize: 1,
            offerExpiresAt: null,
          },
        })}
        session={viewerSession}
        locale="zh-Hans"
      />,
    );

    const composer = await screen.findByRole("textbox", { name: "写评论" });
    await user.type(composer, "请问几点集合？");
    await user.click(screen.getByRole("button", { name: "发表评论" }));

    expect(await screen.findByText("请问几点集合？")).toBeInTheDocument();
    const post = apiRequestMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(post?.[0]).toBe(`/events/${makeDetail().id}/comments`);
    const init = post?.[1] as { idempotencyKey?: string; body?: string; authenticated?: boolean };
    expect(init.authenticated).toBe(true);
    expect(init.idempotencyKey).toBeTruthy();
    expect(JSON.parse(init.body ?? "{}")).toEqual({ body: "请问几点集合？", locale: "zh-Hans" });
    expect(composer).toHaveValue("");
  });

  test("posts a one-level reply with the parent id", async () => {
    const user = userEvent.setup();
    const parent = makeComment();
    apiRequestMock.mockImplementation(async (path, init) => {
      if (init?.method === "POST") {
        const payload = JSON.parse(String(init.body ?? "{}")) as { body: string; parentId?: string };
        return makeComment({
          id: "019b0000-0000-7000-8300-000000000012",
          body: payload.body,
          parentId: payload.parentId ?? null,
          author: { id: viewerSession.user.id, name: "小林" },
        });
      }
      if (path.endsWith("/comments")) return { commentPermission: "participants", items: [parent] };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <EventComments
        event={makeDetail({
          viewerRegistration: {
            id: "019b0000-0000-7000-8200-000000000001",
            status: "checked_in",
            partySize: 1,
            offerExpiresAt: null,
          },
        })}
        session={viewerSession}
        locale="zh-Hans"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "回复" }));
    expect(screen.getByText("回复 周末开局")).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "写评论" }), "我也想知道");
    await user.click(screen.getByRole("button", { name: "发表评论" }));

    await waitFor(() => {
      const thread = screen.getByText(parent.body).closest("li")!;
      expect(within(thread).getByText("我也想知道")).toBeInTheDocument();
    });
    const post = apiRequestMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse((post?.[1] as { body?: string }).body ?? "{}")).toEqual({
      body: "我也想知道",
      parentId: parent.id,
      locale: "zh-Hans",
    });
  });

  test("asks for phone verification before showing the composer", async () => {
    mockThread([]);

    renderWithI18n(
      <EventComments
        event={makeDetail({
          viewerRegistration: {
            id: "019b0000-0000-7000-8200-000000000001",
            status: "confirmed",
            partySize: 1,
            offerExpiresAt: null,
          },
        })}
        session={{ ...viewerSession, user: { ...viewerSession.user, phoneVerified: false } }}
        locale="zh-Hans"
      />,
    );

    expect(await screen.findByRole("link", { name: "去验证手机号" })).toHaveAttribute(
      "href",
      `/phone-verification?returnTo=${encodeURIComponent(`/e/${makeDetail().publicSlug}`)}`,
    );
    expect(screen.queryByRole("textbox", { name: "写评论" })).not.toBeInTheDocument();
  });

  test("checks linked-group membership before opening the group-members composer", async () => {
    const groupId = "019b0000-0000-7000-8400-000000000001";
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path.endsWith("/comments")) return { commentPermission: "group_members", items: [] };
      if (path === `/groups/${groupId}`) return { membershipStatus: "active" };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <EventComments
        event={makeDetail({ groupId })}
        session={viewerSession}
        locale="zh-Hans"
      />,
    );

    expect(await screen.findByRole("textbox", { name: "写评论" })).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(`/groups/${groupId}`, { authenticated: true });
  });

  test("stays read-only in the public preview even for an eligible viewer", async () => {
    mockThread([makeComment()]);

    renderWithI18n(
      <PreviewModeProvider initialMode="read-only">
        <EventComments
          event={makeDetail({
            viewerRegistration: {
              id: "019b0000-0000-7000-8200-000000000001",
              status: "confirmed",
              partySize: 1,
              offerExpiresAt: null,
            },
          })}
          session={viewerSession}
          locale="zh-Hans"
        />
      </PreviewModeProvider>,
    );

    expect(await screen.findByText("自带水杯就可以了。")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "写评论" })).not.toBeInTheDocument();
  });
});
