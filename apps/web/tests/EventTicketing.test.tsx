import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventGoingPreview } from "../app/e/[slug]/EventGoingPreview";
import { RegistrationConfirmation, RegistrationFlow } from "../app/register/[slug]/RegistrationFlow";
import { apiRequest } from "../app/lib/client-api";
import { makeDetail, renderWithI18n } from "./event-fixtures";

const mocks = vi.hoisted(() => ({
  session: null as null | { accessToken: string; user: { id: string; phoneVerified: boolean } },
  apiRequest: vi.fn(),
  trackProductEvent: vi.fn(),
}));

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: mocks.apiRequest, readSession: () => mocks.session };
});
vi.mock("../app/lib/analytics", () => ({ trackProductEvent: mocks.trackProductEvent }));

const apiRequestMock = vi.mocked(apiRequest);

const paidTicketTypes = {
  items: [
    {
      id: "019b0000-0000-7000-8600-000000000001",
      name: "早鸟票",
      description: "限量早鸟价",
      isFree: false,
      amountJPY: 2400,
      collectorName: "周末开局",
      method: "现场现金",
      paymentDeadlineText: "开始前",
      refundPolicy: "开始前 24 小时可全额退",
      quota: 8,
      soldCount: 2,
      remaining: 6,
      soldOut: false,
      active: true,
    },
    {
      id: "019b0000-0000-7000-8600-000000000002",
      name: "支持者票",
      description: null,
      isFree: false,
      amountJPY: 4800,
      collectorName: "周末开局",
      method: "现场现金",
      paymentDeadlineText: null,
      refundPolicy: null,
      quota: 2,
      soldCount: 2,
      remaining: 0,
      soldOut: true,
      active: true,
    },
  ],
};

const paidEvent = makeDetail({
  fee: {
    isFree: false,
    amountJPY: 2400,
    collectorName: "周末开局",
    method: "现场现金",
    paymentDeadlineText: "开始前",
    refundPolicy: "开始前 24 小时可全额退",
  },
});

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.session = { accessToken: "access", user: { id: "user-b", phoneVerified: true } };
  apiRequestMock.mockReset();
  mocks.trackProductEvent.mockReset();
});

function respondWith(ticketTypes: unknown, event = paidEvent) {
  apiRequestMock.mockImplementation(async (path) => {
    if (path === `/events/${event.id}`) return event;
    if (path === `/events/${event.id}/ticket-types`) return ticketTypes;
    if (path === "/quotes") {
      return {
        id: "019b0000-0000-7000-8500-000000000001",
        amount: 40,
        currency: "POINTS",
        expiresAt: "2099-07-16T03:15:00.000Z",
      };
    }
    return { id: "registration-1", eventId: event.id, status: "confirmed", partySize: 1 };
  });
}

describe("who's coming social proof", () => {
  test("shows the confirmed count with profile links for every disclosed attendee", async () => {
    apiRequestMock.mockResolvedValue({
      confirmedCount: 11,
      previews: [
        { userId: "019b0000-0000-7000-8000-000000000016", displayName: "未来酱", avatarURL: null },
        { userId: "019b0000-0000-7000-8000-000000000017", displayName: "樱花镜头", avatarURL: null },
      ],
      hasMore: true,
    });

    renderWithI18n(<EventGoingPreview eventId={makeDetail().id} locale="zh-Hans" />);

    expect(await screen.findByText("11 人已确认参加")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看 未来酱 的主页" })).toHaveAttribute(
      "href",
      "/u/019b0000-0000-7000-8000-000000000016",
    );
    expect(screen.getByText("+9")).toBeInTheDocument();
  });

  test("keeps the count honest when the organizer hides the guest list", async () => {
    apiRequestMock.mockResolvedValue({ confirmedCount: 6, previews: [], hasMore: true });

    renderWithI18n(<EventGoingPreview eventId={makeDetail().id} locale="zh-Hans" />);

    expect(await screen.findByText("6 人已确认参加")).toBeInTheDocument();
    expect(screen.getByText("主办方未公开参加者名单，这里只显示人数。")).toBeInTheDocument();
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });

  test("stays silent for an empty roster and for a failed request", async () => {
    apiRequestMock.mockResolvedValueOnce({ confirmedCount: 0, previews: [], hasMore: false });
    const empty = renderWithI18n(<EventGoingPreview eventId={makeDetail().id} locale="zh-Hans" />);
    await waitFor(() => expect(apiRequestMock).toHaveBeenCalled());
    expect(empty.container.textContent).toBe("");
    empty.unmount();

    apiRequestMock.mockRejectedValueOnce(new Error("offline"));
    const failed = renderWithI18n(<EventGoingPreview eventId={makeDetail().id} locale="zh-Hans" />);
    await waitFor(() => expect(failed.container.textContent).toBe(""));
  });
});

describe("ticket tier selection", () => {
  test("requires a tier, disables a sold-out tier, and submits the chosen ticketTypeId", async () => {
    const user = userEvent.setup();
    respondWith(paidTicketTypes);
    renderWithI18n(<RegistrationFlow event={paidEvent} navigate={vi.fn()} />);

    const earlyBird = await screen.findByRole("radio", { name: /早鸟票/ });
    expect(screen.getByRole("radio", { name: /支持者票/ })).toBeDisabled();
    expect(screen.getByText("已售罄")).toBeInTheDocument();
    expect(screen.getByText("仅剩 6 个名额")).toBeInTheDocument();
    expect(
      screen.getByText("票款由主办方在 Spott 外收取；Spott 不代收、不退款。"),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /我已阅读线下费用与退款边界/ }));
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    expect(await screen.findByText("请先选择一个票种。")).toBeInTheDocument();

    await user.click(earlyBird);
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await screen.findByText("最后核对一次");
    expect(screen.getByText(/早鸟票/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认并报名" }));
    await waitFor(() => {
      const submission = apiRequestMock.mock.calls.find(([path]) => String(path).endsWith("/registrations"));
      expect(submission).toBeTruthy();
      expect(JSON.parse(String(submission![1]?.body)).ticketTypeId).toBe(
        "019b0000-0000-7000-8600-000000000001",
      );
    });
  });

  test("leaves the single-fee flow untouched when the organizer published no tiers", async () => {
    const user = userEvent.setup();
    respondWith({ items: [] });
    renderWithI18n(<RegistrationFlow event={paidEvent} navigate={vi.fn()} />);

    await screen.findByRole("button", { name: "继续核对" });
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();

    await user.click(screen.getByRole("checkbox", { name: /我已阅读线下费用与退款边界/ }));
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await screen.findByText("最后核对一次");
    await user.click(screen.getByRole("button", { name: "确认并报名" }));

    await waitFor(() => {
      const submission = apiRequestMock.mock.calls.find(([path]) => String(path).endsWith("/registrations"));
      expect(submission).toBeTruthy();
      expect(JSON.parse(String(submission![1]?.body)).ticketTypeId).toBeUndefined();
    });
  });

  test("offers a retry instead of a raw error when tiers cannot be loaded", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${paidEvent.id}`) return paidEvent;
      if (path === `/events/${paidEvent.id}/ticket-types`) throw new Error("offline");
      return {};
    });
    renderWithI18n(<RegistrationFlow event={paidEvent} navigate={vi.fn()} />);

    expect(await screen.findByText("暂时无法加载票种，请稍后重试。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新加载票种" })).toBeInTheDocument();
  });
});

describe("offline payment self-report", () => {
  test("reports once and then shows the awaiting-confirmation state", async () => {
    const user = userEvent.setup();
    apiRequestMock.mockResolvedValue({ registrationId: "registration-1", paymentStatus: "self_reported" });
    renderWithI18n(
      <RegistrationConfirmation
        event={paidEvent}
        registration={{ id: "registration-1", eventId: paidEvent.id, status: "confirmed", partySize: 1 }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "我已线下支付" }));

    expect(await screen.findByText("已告知主办方 · 待确认")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "我已线下支付" })).not.toBeInTheDocument();
    expect(
      apiRequestMock.mock.calls.filter(([path]) => String(path).endsWith("/payment-report")),
    ).toHaveLength(1);
  });

  test("never offers a payment report on a free event or a pending registration", () => {
    const free = renderWithI18n(
      <RegistrationConfirmation
        event={makeDetail()}
        registration={{ id: "registration-1", eventId: makeDetail().id, status: "confirmed", partySize: 1 }}
      />,
    );
    expect(screen.queryByRole("button", { name: "我已线下支付" })).not.toBeInTheDocument();
    free.unmount();

    renderWithI18n(
      <RegistrationConfirmation
        event={paidEvent}
        registration={{ id: "registration-1", eventId: paidEvent.id, status: "pending", partySize: 1 }}
      />,
    );
    expect(screen.queryByRole("button", { name: "我已线下支付" })).not.toBeInTheDocument();
  });
});
