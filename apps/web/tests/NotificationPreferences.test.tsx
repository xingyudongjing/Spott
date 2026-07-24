import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { NotificationPreferences } from "../app/me/settings/NotificationPreferences";
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

function preferences(items: unknown[]) {
  apiRequestMock.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path === "/notifications/preferences" && !init?.method) return { items } as never;
    return undefined as never;
  });
}

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe("NotificationPreferences", () => {
  test("restores stored channels and the quiet window from the API", async () => {
    preferences([
      {
        type: "event.reminder",
        inApp: true,
        push: false,
        email: false,
        quietHours: '["2026-07-24 22:00:00+09","2026-07-25 08:00:00+09")',
        locale: "zh-Hans",
      },
    ]);
    renderWithI18n(<NotificationPreferences preferredLocale="zh-Hans" />);

    const push = await screen.findByRole("checkbox", { name: "活动提醒 · 推送" });
    expect(push).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "活动提醒 · 站内" })).toBeChecked();
    expect(screen.getByDisplayValue("22:00")).toBeInTheDocument();
    expect(screen.getByDisplayValue("08:00")).toBeInTheDocument();
    expect(screen.getByText("22:00 到次日 08:00")).toBeInTheDocument();
  });

  test("writes only the toggled type and carries the quiet window", async () => {
    preferences([
      {
        type: "event.reminder",
        inApp: true,
        push: true,
        email: false,
        quietHours: '["2026-07-24 22:00:00+09","2026-07-25 08:00:00+09")',
        locale: "zh-Hans",
      },
    ]);
    renderWithI18n(<NotificationPreferences preferredLocale="ja" />);

    await userEvent.click(await screen.findByRole("checkbox", { name: "推荐提醒 · 邮件" }));

    await waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(([path]) => path === "/notifications/preferences/recommendation"),
      ).toBe(true),
    );
    const call = apiRequestMock.mock.calls.find(
      ([path]) => path === "/notifications/preferences/recommendation",
    );
    expect(call?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      inApp: true,
      push: true,
      email: true,
      quietStart: "22:00",
      quietEnd: "08:00",
      locale: "ja",
    });
  });

  test("clears the quiet window for every type when quiet hours are turned off", async () => {
    preferences([
      {
        type: "event.reminder",
        inApp: true,
        push: true,
        email: false,
        quietHours: '["2026-07-24 22:00:00+09","2026-07-25 08:00:00+09")',
        locale: "zh-Hans",
      },
    ]);
    renderWithI18n(<NotificationPreferences preferredLocale="zh-Hans" />);

    await userEvent.click(await screen.findByRole("checkbox", { name: /免打扰/ }));

    await waitFor(() => {
      const writes = apiRequestMock.mock.calls.filter(([path]) =>
        String(path).startsWith("/notifications/preferences/"),
      );
      expect(writes).toHaveLength(5);
      for (const write of writes) {
        expect(JSON.parse(String(write[1]?.body))).not.toHaveProperty("quietStart");
      }
    });
  });

  test("keeps a designed error state when preferences cannot be read", async () => {
    apiRequestMock.mockRejectedValue(new Error("preferences offline"));
    renderWithI18n(<NotificationPreferences preferredLocale="zh-Hans" />);

    expect(await screen.findByText("通知偏好暂时无法读取，请重试。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument();
  });
});
