import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { MyEventsClient } from "../app/me/events/MyEventsClient";
import { apiRequest } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

vi.mock("../app/lib/client-api", () => ({
  apiRequest: vi.fn(),
  errorMessage: (error: unknown) => error instanceof Error ? error.message : "request failed",
}));
const { appDialogRunMock } = vi.hoisted(() => ({ appDialogRunMock: vi.fn() }));
vi.mock("../app/components/AppDialog", () => ({
  useAppDialog: () => ({ run: appDialogRunMock }),
}));

const apiRequestMock = vi.mocked(apiRequest);

const itineraryPage = {
  items: [
    {
      registration: {
        id: "019b0000-0000-7000-8200-000000000003",
        eventId: "019b0000-0000-7000-8100-000000000001",
        userId: "019b0000-0000-7000-8000-000000000001",
        status: "confirmed",
        partySize: 2,
        attendeeNote: null,
        offerExpiresAt: null,
        availableActions: ["cancelRegistration", "viewTicket", "checkIn"],
        version: 4,
        updatedAt: "2026-07-16T02:00:00.000Z",
      },
      event: {
        id: "019b0000-0000-7000-8100-000000000001",
        publicSlug: "evening-walk",
        status: "published",
        title: "Evening walk",
        startsAt: "2026-07-20T09:00:00.000Z",
        endsAt: "2026-07-20T11:00:00.000Z",
        displayTimeZone: "Asia/Tokyo",
        region: "tokyo",
        publicArea: "Shibuya",
        coverURL: null,
        format: "in_person",
        primaryLocale: "ja",
        localeConfirmed: true,
        version: 7,
        updatedAt: "2026-07-15T02:00:00.000Z",
      },
    },
    {
      registration: {
        id: "019b0000-0000-7000-8200-000000000004",
        eventId: "019b0000-0000-7000-8100-000000000002",
        userId: "019b0000-0000-7000-8000-000000000001",
        status: "pending",
        partySize: 1,
        attendeeNote: null,
        offerExpiresAt: null,
        availableActions: ["cancelRegistration"],
        version: 1,
        updatedAt: "2026-07-16T02:10:00.000Z",
      },
      event: null,
    },
  ],
  nextCursor: null,
  hasMore: false,
  serverTime: "2026-07-16T03:00:00.000Z",
};

beforeEach(() => {
  apiRequestMock.mockReset();
  appDialogRunMock.mockReset();
  apiRequestMock.mockResolvedValue(structuredClone(itineraryPage));
});

describe("single-request itinerary", () => {
  test("strictly consumes Task4A registration+event items without detail N+1 requests", async () => {
    renderWithI18n(<MyEventsClient />);

    expect(await screen.findByText("Evening walk")).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledTimes(1);
    expect(apiRequestMock).toHaveBeenCalledWith(
      "/me/registrations?limit=100",
      { authenticated: true },
    );
    expect(apiRequestMock.mock.calls.some(([path]) => String(path).startsWith("/events/"))).toBe(false);

    await userEvent.click(screen.getByRole("tab", { name: /待确认/ }));
    expect(screen.getByText("活动暂不可见")).toBeInTheDocument();
    expect(screen.getByText(/等待主办方确认/)).toBeInTheDocument();
  });

  test("retains the last itinerary and announces a refresh failure", async () => {
    const user = userEvent.setup();
    apiRequestMock
      .mockResolvedValueOnce(structuredClone(itineraryPage))
      .mockRejectedValueOnce(new Error("offline"));
    renderWithI18n(<MyEventsClient />);

    expect(await screen.findByText("Evening walk")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更新行程" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("offline"));
    expect(screen.getByText("Evening walk")).toBeInTheDocument();
  });

  test("renders one eligible primary action and keeps cancellation in an accessible menu", async () => {
    const user = userEvent.setup();
    const payload = structuredClone(itineraryPage);
    payload.items[0]!.event!.startsAt = "2026-07-16T03:30:00.000Z";
    payload.items[0]!.event!.endsAt = "2026-07-16T05:00:00.000Z";
    apiRequestMock.mockResolvedValue(payload);
    renderWithI18n(<MyEventsClient />);

    const row = (await screen.findByText("Evening walk")).closest("article")!;
    expect(within(row).getAllByTestId("itinerary-primary-action")).toHaveLength(1);
    expect(within(row).getByRole("button", { name: "现场签到" })).toBeInTheDocument();
    expect(within(row).getByText("更多操作")).toBeInTheDocument();

    await user.click(within(row).getByRole("menuitem", { name: "取消报名" }));
    expect(appDialogRunMock).toHaveBeenCalledOnce();
  });

  test.each([
    ["no_show", "申请补签"],
    ["attendance_disputed", "申请补签"],
    ["checked_in", "活动后反馈"],
  ])("renders the post-event next best action for %s", async (status, actionLabel) => {
    const payload = structuredClone(itineraryPage);
    payload.items = [payload.items[0]!];
    payload.items[0]!.registration.status = status;
    payload.items[0]!.registration.availableActions = [];
    payload.items[0]!.event!.status = "ended";
    payload.items[0]!.event!.startsAt = "2026-07-15T23:00:00.000Z";
    payload.items[0]!.event!.endsAt = "2026-07-16T02:30:00.000Z";
    apiRequestMock.mockResolvedValue(payload);
    renderWithI18n(<MyEventsClient />);

    await screen.findByRole("tab", { name: /过去 1/ });
    await userEvent.click(screen.getByRole("tab", { name: /过去 1/ }));
    const row = screen.getByText("Evening walk").closest("article")!;
    expect(within(row).getAllByTestId("itinerary-primary-action")).toHaveLength(1);
    expect(within(row).getByRole("button", { name: actionLabel })).toBeInTheDocument();
  });
});
