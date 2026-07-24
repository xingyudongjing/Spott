import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AchievementsClient } from "../app/me/achievements/AchievementsClient";
import { apiRequest } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return {
    ...actual,
    apiRequest: vi.fn(),
    errorMessage: (error: unknown) => (error instanceof Error ? error.message : "request failed"),
    readSession: () => ({ user: { id: "user-a" } }),
  };
});

const apiRequestMock = vi.mocked(apiRequest);

const award = {
  id: "019b0000-0000-7000-8300-000000000001",
  code: "first_checkin",
  audience: "participant",
  ruleVersion: 1,
  visibility: "public",
  awardedAt: "2026-07-01T02:00:00.000Z",
  revokedAt: null as string | null,
  revocationReason: null as string | null,
  hidden: false,
};

function respond(items: Array<typeof award>, awarded: string[] = []) {
  apiRequestMock.mockImplementation(async (path: string) => {
    if (path === "/me/achievements/evaluate") return { awarded, revoked: [] } as never;
    if (path === "/me/achievements") return { items } as never;
    return undefined as never;
  });
}

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe("AchievementsClient", () => {
  test("evaluates on open and shows earned achievements with real names", async () => {
    respond([award], ["first_checkin"]);
    renderWithI18n(<AchievementsClient />);

    expect(await screen.findByText("初次见面")).toBeInTheDocument();
    expect(screen.getByText("首次完成活动签到。")).toBeInTheDocument();
    expect(screen.getByText("刚刚获得：初次见面")).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      "/me/achievements/evaluate",
      expect.objectContaining({ method: "POST" }),
    );
    // No invented progress: nothing unearned is rendered as a partial bar.
    expect(screen.queryByText("城市探索者")).not.toBeInTheDocument();
  });

  test("keeps the screen usable when evaluation fails", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/me/achievements/evaluate") throw new Error("evaluate offline");
      if (path === "/me/achievements") return { items: [award] } as never;
      return undefined as never;
    });
    renderWithI18n(<AchievementsClient />);

    expect(await screen.findByText("初次见面")).toBeInTheDocument();
  });

  test("hides a single award and restores it when the request fails", async () => {
    respond([award]);
    renderWithI18n(<AchievementsClient />);
    await screen.findByText("初次见面");

    apiRequestMock.mockRejectedValueOnce(new Error("network down"));
    await userEvent.click(screen.getByRole("button", { name: "不公开" }));

    await waitFor(() => expect(screen.getByText("network down")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "不公开" })).toBeInTheDocument();
  });

  test("blocks sharing a hidden award, which the API rejects with 422", async () => {
    respond([{ ...award, hidden: true }]);
    renderWithI18n(<AchievementsClient />);
    await screen.findByText("初次见面");

    expect(screen.getByRole("button", { name: "分享成就卡" })).toBeDisabled();
    expect(screen.getByText("未公开")).toBeInTheDocument();
  });

  test("explains a revoked award instead of dropping it silently", async () => {
    respond([
      {
        ...award,
        revokedAt: "2026-07-10T02:00:00.000Z",
        revocationReason: "condition_no_longer_met",
      },
    ]);
    renderWithI18n(<AchievementsClient />);

    expect(await screen.findByText("已撤回")).toBeInTheDocument();
    expect(screen.getByText("条件不再满足")).toBeInTheDocument();
  });

  test("shows a designed empty state with no achievements", async () => {
    respond([]);
    renderWithI18n(<AchievementsClient />);

    expect(await screen.findByText("成就从真实见面开始")).toBeInTheDocument();
  });

  test("shows a retryable error state when the list cannot load", async () => {
    apiRequestMock.mockImplementation(async (path: string) => {
      if (path === "/me/achievements/evaluate") return { awarded: [], revoked: [] } as never;
      throw new Error("achievements offline");
    });
    renderWithI18n(<AchievementsClient />);

    expect(await screen.findByText("暂时无法加载成就")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
