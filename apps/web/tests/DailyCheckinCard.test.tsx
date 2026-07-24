import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { DailyCheckinCard } from "../app/me/wallet/DailyCheckinCard";
import { apiRequest, type WalletView } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);

const wallet: WalletView = {
  paidBalance: 120,
  freeBalance: 96,
  totalBalance: 216,
  version: 4,
  nextFreeExpiry: null,
};

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe("daily check-in touchpoint", () => {
  test("posts the check-in and shows the streak plus every server-issued reward", async () => {
    const user = userEvent.setup();
    const onWalletUpdate = vi.fn();
    apiRequestMock.mockResolvedValue({
      alreadyCheckedIn: false,
      streak: 7,
      civilDay: "2026-07-23",
      rewards: [
        { type: "daily_checkin_reward", points: 10 },
        { type: "streak_7_reward", points: 50 },
      ],
      wallet,
    });

    renderWithI18n(<DailyCheckinCard locale="zh-Hans" onWalletUpdate={onWalletUpdate} />);

    await user.click(screen.getByRole("button", { name: "立即签到" }));

    expect(await screen.findByText("已连续签到 7 天")).toBeInTheDocument();
    expect(screen.getByText("每日签到奖励")).toBeInTheDocument();
    expect(screen.getByText("+10")).toBeInTheDocument();
    expect(screen.getByText("连续 7 天奖励")).toBeInTheDocument();
    expect(screen.getByText("+50")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "已领取积分" })).toBeDisabled();
    expect(apiRequestMock).toHaveBeenCalledWith("/points/checkin", {
      method: "POST",
      authenticated: true,
    });
    expect(onWalletUpdate).toHaveBeenCalledWith(wallet);
  });

  test("shows the disabled already-checked-in state without inventing rewards", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockResolvedValue({
      alreadyCheckedIn: true,
      streak: 12,
      civilDay: "2026-07-23",
      rewards: [],
      wallet,
    });

    renderWithI18n(<DailyCheckinCard locale="zh-Hans" />);

    await user.click(screen.getByRole("button", { name: "立即签到" }));

    expect(await screen.findByRole("button", { name: "今日已签到" })).toBeDisabled();
    expect(screen.getByText("已连续签到 12 天")).toBeInTheDocument();
    expect(screen.getByText("今天已经签到过了，明天（日本时间）再来吧。")).toBeInTheDocument();
    expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument();
  });

  test("keeps the button available and surfaces the failure message on error", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockRejectedValue(new Error("网络不可用"));

    renderWithI18n(<DailyCheckinCard locale="zh-Hans" />);

    await user.click(screen.getByRole("button", { name: "立即签到" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("网络不可用");
    expect(screen.getByRole("button", { name: "立即签到" })).toBeEnabled();
  });
});
