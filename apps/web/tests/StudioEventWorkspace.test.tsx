import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { AppDialogProvider } from "../app/components/AppDialog";
import { AnnouncementComposer } from "../app/studio/events/[id]/announcements/AnnouncementComposer";
import { AttendeeManager } from "../app/studio/events/[id]/attendees/AttendeeManager";
import { PromotionManager } from "../app/studio/events/[id]/promotion/PromotionManager";
import { TicketTypeManager } from "../app/studio/events/[id]/tickets/TicketTypeManager";
import { apiRequest } from "../app/lib/client-api";
import type { EventView } from "../app/lib/demo-data";
import { eventFixture, makeDetail, renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);
const eventId = eventFixture.id;

function organizerEvent(overrides: Partial<EventView> = {}): EventView {
  return {
    ...makeDetail(),
    categoryLabel: "城市探索",
    priceLabel: "免费",
    organizer: { ...eventFixture.organizer, reliability: "high" },
    availableActions: ["edit", "cancelEvent"],
    ...overrides,
  } as unknown as EventView;
}

beforeEach(() => {
  apiRequestMock.mockReset();
});

describe("studio ticket types", () => {
  test("creates a free tier without ever sending fee fields", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/ticket-types` && !init?.method) return { items: [] };
      if (path === `/events/${eventId}/ticket-types` && init?.method === "POST") return {};
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <TicketTypeManager eventId={eventId} />
      </AppDialogProvider>,
    );

    await screen.findByRole("heading", { name: "还没有票种" });
    await user.click(screen.getByRole("button", { name: "＋ 新增票种" }));
    await user.type(screen.getByLabelText("票种名称"), "早鸟票");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() =>
      expect(
        apiRequestMock.mock.calls.some(
          ([path, init]) =>
            path === `/events/${eventId}/ticket-types` && init?.method === "POST",
        ),
      ).toBe(true),
    );
    const create = apiRequestMock.mock.calls.find(
      ([path, init]) => path === `/events/${eventId}/ticket-types` && init?.method === "POST",
    );
    expect(JSON.parse(String(create?.[1]?.body))).toEqual({ name: "早鸟票", isFree: true });
  });

  test("blocks an incomplete paid tier before it can reach the API", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/ticket-types` && !init?.method) return { items: [] };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <TicketTypeManager eventId={eventId} />
      </AppDialogProvider>,
    );

    await screen.findByRole("heading", { name: "还没有票种" });
    await user.click(screen.getByRole("button", { name: "＋ 新增票种" }));
    await user.type(screen.getByLabelText("票种名称"), "支持票");
    await user.click(screen.getByRole("radio", { name: /付费/ }));
    await user.type(screen.getByLabelText("金额（日元）"), "2000");
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "付费票需要填写正整数金额、收款主体、收款方式与退款规则。",
    );
    expect(
      apiRequestMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });

  test("keeps a paid tier from being switched to free", async () => {
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/ticket-types` && !init?.method) {
        return {
          items: [
            {
              id: "ticket-1",
              eventId,
              name: "支持票",
              description: null,
              isFree: false,
              amountJPY: 2000,
              collectorName: "周末开局",
              method: "现场现金",
              paymentDeadlineText: null,
              refundPolicy: "开始前 24 小时可退",
              quota: 10,
              soldCount: 3,
              remaining: 7,
              soldOut: false,
              active: true,
              sortOrder: 0,
            },
          ],
        };
      }
      throw new Error(`unexpected request ${path}`);
    });

    const user = userEvent.setup();
    renderWithI18n(
      <AppDialogProvider>
        <TicketTypeManager eventId={eventId} />
      </AppDialogProvider>,
    );

    await user.click(await screen.findByRole("button", { name: "编辑" }));
    expect(screen.getByRole("radio", { name: /免费/ })).toBeDisabled();
    expect(screen.getByText("付费票不能改为免费。请停用后新建一个免费票种。")).toBeInTheDocument();
  });
});

describe("studio attendee announcements", () => {
  test("surfaces the remaining daily allowance and sends with an idempotency key", async () => {
    const user = userEvent.setup();
    let remaining = 2;
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/announcements` && !init?.method) {
        return { items: [], dailyLimit: 5, remainingToday: remaining };
      }
      if (path === `/events/${eventId}/announcements` && init?.method === "POST") {
        remaining -= 1;
        return {
          announcementId: "a-1",
          recipientCount: 9,
          dailyLimit: 5,
          remainingToday: remaining,
        };
      }
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <AnnouncementComposer eventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText("今天还可发送 2 条 · 每天上限 5 条")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/标题/), "集合点有调整");
    await user.type(screen.getByLabelText(/内容/), "改到东口检票口集合。");
    await user.click(screen.getByRole("button", { name: "发送通知" }));

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("已发送，9 人收到。"),
    );
    const sent = apiRequestMock.mock.calls.find(
      ([path, init]) => path === `/events/${eventId}/announcements` && init?.method === "POST",
    );
    expect(sent?.[1]?.idempotent).toBe(true);
    expect(JSON.parse(String(sent?.[1]?.body))).toEqual({
      title: "集合点有调整",
      body: "改到东口检票口集合。",
    });
  });

  test("stops sending once the daily cap is used up", async () => {
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/announcements` && !init?.method) {
        return { items: [], dailyLimit: 5, remainingToday: 0 };
      }
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <AnnouncementComposer eventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText("今天的发送次数已用完，明天会恢复。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "发送通知" })).toBeDisabled();
  });
});

describe("studio promotion", () => {
  test("explains why a draft event cannot be boosted and asks for no quote", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${eventId}`) return organizerEvent({ status: "draft" });
      if (path === `/events/${eventId}/promotion`) return null;
      if (path === "/wallet") {
        return {
          paidBalance: 100,
          freeBalance: 0,
          totalBalance: 100,
          version: 1,
          nextFreeExpiry: null,
        };
      }
      if (path === "/quotes") return { id: "quote-1", amount: 300, expiresAt: futureISO() };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <PromotionManager eventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByRole("heading", { name: "现在不能购买置顶" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /置顶$/ })).not.toBeInTheDocument();
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/quotes")).toBe(false);
  });

  test("shows the running boost instead of another purchase", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/promotion`) {
        return {
          id: "promotion-1",
          eventId,
          tier: "boost_72h",
          amount: 700,
          durationHours: 72,
          state: "active",
          startsAt: "2026-07-24T00:00:00.000Z",
          expiresAt: "2026-07-27T00:00:00.000Z",
        };
      }
      if (path === "/wallet") {
        return {
          paidBalance: 900,
          freeBalance: 0,
          totalBalance: 900,
          version: 1,
          nextFreeExpiry: null,
        };
      }
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <PromotionManager eventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByRole("heading", { name: "置顶进行中" })).toBeInTheDocument();
    expect(screen.getByText(/本次使用 700 积分/)).toBeInTheDocument();
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/quotes")).toBe(false);
  });

  test("refuses a tier the wallet cannot cover", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (path === `/events/${eventId}/promotion`) return null;
      if (path === "/wallet") {
        return {
          paidBalance: 10,
          freeBalance: 0,
          totalBalance: 10,
          version: 1,
          nextFreeExpiry: null,
        };
      }
      if (path === "/quotes") return { id: "quote-1", amount: 300, expiresAt: futureISO() };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <PromotionManager eventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText("积分不足，无法购买这个档位。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "使用 300 积分置顶" })).toBeDisabled();
  });
});

describe("studio attendee list", () => {
  test("records an offline payment only for a paid ticket holder", async () => {
    const user = userEvent.setup();
    const registration = {
      id: "019b0000-0000-7000-8100-0000000000d1",
      eventId,
      status: "pending",
      partySize: 1,
      ticketTypeId: "ticket-1",
      answers: {},
      attendee: { id: "attendee-1", nickname: "小林", publicHandle: "kobayashi" },
    };
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (String(path).startsWith(`/events/${eventId}/attendees`)) {
        return { items: [registration], hasMore: false, nextCursor: null };
      }
      if (String(path).startsWith(`/events/${eventId}/checkin-corrections`)) return { items: [] };
      if (path === `/events/${eventId}/ticket-types`) {
        return { items: [{ id: "ticket-1", name: "支持票", isFree: false }] };
      }
      if (
        path === `/registrations/${registration.id}/payment-confirmation`
        && init?.method === "POST"
      ) {
        return { registrationId: registration.id, paymentStatus: "confirmed" };
      }
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <AttendeeManager eventId={eventId} />
      </AppDialogProvider>,
    );

    expect(await screen.findByText(/票种: 支持票/)).toBeInTheDocument();
    const triggers = await screen.findAllByRole("button", { name: "记录已收款" });
    await user.click(triggers[0]!);
    const dialogButtons = await screen.findAllByRole("button", { name: "记录已收款" });
    await user.click(dialogButtons[dialogButtons.length - 1]!);

    expect(await screen.findByText("✓ 已记录收款")).toBeInTheDocument();
    expect(
      apiRequestMock.mock.calls.some(
        ([path, init]) =>
          path === `/registrations/${registration.id}/payment-confirmation`
          && init?.method === "POST",
      ),
    ).toBe(true);
  });

  test("hides the payment record action on a free event", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${eventId}`) return organizerEvent();
      if (String(path).startsWith(`/events/${eventId}/attendees`)) {
        return {
          items: [
            {
              id: "019b0000-0000-7000-8100-0000000000d2",
              eventId,
              status: "pending",
              partySize: 2,
              ticketTypeId: null,
              answers: {},
              attendee: { id: "attendee-2", nickname: "阿海", publicHandle: "umi" },
            },
          ],
          hasMore: false,
          nextCursor: null,
        };
      }
      if (String(path).startsWith(`/events/${eventId}/checkin-corrections`)) return { items: [] };
      if (path === `/events/${eventId}/ticket-types`) return { items: [] };
      throw new Error(`unexpected request ${path}`);
    });

    renderWithI18n(
      <AppDialogProvider>
        <AttendeeManager eventId={eventId} />
      </AppDialogProvider>,
    );

    await screen.findByRole("heading", { name: "阿海" });
    expect(screen.queryByRole("button", { name: "记录已收款" })).not.toBeInTheDocument();
  });
});

function futureISO(): string {
  return new Date(Date.now() + 15 * 60 * 1000).toISOString();
}
