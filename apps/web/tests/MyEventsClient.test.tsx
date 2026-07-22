import { readFileSync } from "node:fs";
import { join } from "node:path";

import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { MyEventsClient } from "../app/me/events/MyEventsClient";
import { APIError, apiRequest } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

const sessionMocks = vi.hoisted(() => ({
  session: { user: { id: "user-a" } } as null | { user: { id: string } },
}));
vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return {
    ...actual,
    apiRequest: vi.fn(),
    errorMessage: (error: unknown) => error instanceof Error ? error.message : "request failed",
    readSession: () => sessionMocks.session,
  };
});
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
        offerExpiresAt: null as string | null,
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
        publicArea: "Shibuya" as string | null,
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
        offerExpiresAt: null as string | null,
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

function offeredItineraryPage({
  registrationVersion = 3,
  eventVersion = 8,
}: {
  registrationVersion?: number;
  eventVersion?: number;
} = {}) {
  const payload = structuredClone(itineraryPage);
  payload.items = [payload.items[0]!];
  payload.items[0]!.registration.status = "offered";
  payload.items[0]!.registration.offerExpiresAt = "2026-07-16T04:00:00.000Z";
  payload.items[0]!.registration.availableActions = ["cancelRegistration"];
  payload.items[0]!.registration.version = registrationVersion;
  payload.items[0]!.event!.version = eventVersion;
  return payload;
}

function confirmedItineraryPage() {
  const payload = offeredItineraryPage({ registrationVersion: 4, eventVersion: 9 });
  payload.items[0]!.registration.status = "confirmed";
  payload.items[0]!.registration.offerExpiresAt = null;
  payload.items[0]!.registration.availableActions = ["cancelRegistration", "viewTicket"];
  return payload;
}

beforeEach(() => {
  window.history.replaceState({}, "", "/me/events");
  sessionMocks.session = { user: { id: "user-a" } };
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

  test.each(["storage", "spott:session"])(
    "fails closed and reloads the itinerary for a new owner after %s",
    async (eventType) => {
      const nextOwnerPage = structuredClone(itineraryPage);
      nextOwnerPage.items[0]!.event!.title = "New owner itinerary";
      apiRequestMock
        .mockResolvedValueOnce(structuredClone(itineraryPage))
        .mockResolvedValueOnce(nextOwnerPage);
      renderWithI18n(<MyEventsClient />);
      expect(await screen.findByText("Evening walk")).toBeInTheDocument();

      sessionMocks.session = { user: { id: "user-b" } };
      if (eventType === "storage") {
        window.dispatchEvent(new StorageEvent("storage", { key: "spott.web.session-metadata.v1" }));
      } else {
        window.dispatchEvent(new CustomEvent("spott:session"));
      }

      expect(await screen.findByText("New owner itinerary")).toBeInTheDocument();
      expect(screen.queryByText("Evening walk")).not.toBeInTheDocument();
      expect(apiRequestMock).toHaveBeenCalledTimes(2);
    },
  );

  test("supports arrow, Home, and End navigation across the itinerary tabs", async () => {
    const user = userEvent.setup();
    renderWithI18n(<MyEventsClient />);

    const upcoming = await screen.findByRole("tab", { name: /即将开始/ });
    const waitlist = screen.getByRole("tab", { name: /候补/ });
    const past = screen.getByRole("tab", { name: /过去/ });
    upcoming.focus();

    await user.keyboard("{ArrowRight}");
    expect(waitlist).toHaveFocus();
    expect(waitlist).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{End}");
    expect(past).toHaveFocus();
    expect(past).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{Home}");
    expect(upcoming).toHaveFocus();
    expect(upcoming).toHaveAttribute("aria-selected", "true");
  });

  test("selects, scrolls to, and focuses the accessible card named by registration", async () => {
    const registrationId = itineraryPage.items[1]!.registration.id;
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    window.history.replaceState({}, "", `/me/events?registration=${registrationId}`);

    renderWithI18n(<MyEventsClient />);

    const pending = await screen.findByRole("tab", { name: /待确认 1/ });
    await waitFor(() => expect(pending).toHaveAttribute("aria-selected", "true"));
    const card = screen.getByText("活动暂不可见").closest("article")!;
    await waitFor(() => expect(card).toHaveFocus());
    expect(card).toHaveAttribute("tabindex", "-1");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
  });

  test.each([
    ["online", "线上活动"],
    ["in_person", "区域待确认"],
  ])("renders the truthful fallback location for %s events", async (format, expectedLocation) => {
    const payload = structuredClone(itineraryPage);
    payload.items = [payload.items[0]!];
    payload.items[0]!.event!.format = format;
    payload.items[0]!.event!.publicArea = null;
    apiRequestMock.mockResolvedValue(payload);
    renderWithI18n(<MyEventsClient />);

    expect(await screen.findByText(expectedLocation)).toBeInTheDocument();
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

  test("reviews a fresh waitlist quote with event, party, points, expiry, and fee boundary before accepting", async () => {
    const user = userEvent.setup();
    const payload = offeredItineraryPage();
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") return structuredClone(payload);
      if (path === "/quotes") {
        return {
          id: "019b0000-0000-7000-8500-000000000001",
          amount: 40,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:15:00.000Z",
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));

    const dialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    const cancel = within(dialog).getByRole("button", { name: "暂不接受" });
    const close = within(dialog).getByRole("button", { name: "关闭" });
    const confirm = within(dialog).getByRole("button", { name: "确认并使用 40 积分" });
    expect(dialog.className).not.toBe("");
    expect(dialog.parentElement?.className).not.toBe("");
    expect(cancel).toHaveFocus();
    expect(document.body.style.overflow).toBe("hidden");
    expect(within(dialog).getByText("Evening walk")).toBeInTheDocument();
    expect(within(dialog).getByText("2 人参加")).toBeInTheDocument();
    expect(within(dialog).getByText("40 积分")).toBeInTheDocument();
    expect(within(dialog).getByText(/报价有效至/)).toBeInTheDocument();
    expect(within(dialog).getByText(/不会产生隐藏扣费/)).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith("/quotes", {
      method: "POST",
      authenticated: true,
      body: JSON.stringify({
        purpose: "registration",
        resourceId: payload.items[0]!.event!.id,
      }),
    });

    close.focus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    const backgroundRefresh = screen.getByRole("button", { name: "更新行程" });
    backgroundRefresh.focus();
    await user.tab();
    expect(close).toHaveFocus();
    backgroundRefresh.focus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();

    await user.click(cancel);
    expect(screen.queryByRole("dialog", { name: "确认接受候补名额" })).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe("");
    expect(screen.getByRole("button", { name: "接受名额" })).toHaveFocus();
    expect(apiRequestMock.mock.calls.some(([path]) => String(path).includes("waitlist-acceptance"))).toBe(false);
  });

  test("restores focus to the actual accept trigger after a deferred quote resolves", async () => {
    const user = userEvent.setup();
    const payload = offeredItineraryPage();
    let resolveQuote: ((value: unknown) => void) | undefined;
    const deferredQuote = new Promise<unknown>((resolve) => {
      resolveQuote = resolve;
    });
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") return structuredClone(payload);
      if (path === "/quotes") return deferredQuote;
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    const trigger = screen.getByRole("button", { name: "接受名额" });
    await user.click(trigger);
    screen.getByRole("button", { name: "更新行程" }).focus();
    resolveQuote?.({
      id: "019b0000-0000-7000-8500-000000000009",
      amount: 35,
      currency: "POINTS",
      expiresAt: "2026-07-16T03:20:00.000Z",
    });

    const dialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    await user.click(within(dialog).getByRole("button", { name: "暂不接受" }));
    expect(trigger).toHaveFocus();
  });

  test("submits an immutable reviewed snapshot and reuses one idempotency key when a response is lost", async () => {
    const user = userEvent.setup();
    const payload = offeredItineraryPage();
    let itineraryCalls = 0;
    let acceptanceCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") {
        itineraryCalls += 1;
        return structuredClone(payload);
      }
      if (path === "/quotes") {
        return {
          id: "019b0000-0000-7000-8500-000000000002",
          amount: 55,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        acceptanceCalls += 1;
        if (acceptanceCalls === 1) throw new TypeError("response lost");
        return { status: "confirmed" };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));
    const dialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    const confirm = within(dialog).getByRole("button", { name: "确认并使用 55 积分" });
    const reviewedExpiry = within(dialog).getByText(/报价有效至/).textContent;
    await user.click(confirm);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "暂时无法确认名额，请稍后重试；当前复核内容已保留。",
    );
    expect(within(dialog).queryByText("response lost")).not.toBeInTheDocument();
    expect(confirm).toHaveFocus();

    payload.items[0]!.registration.version = 44;
    payload.items[0]!.registration.partySize = 5;
    payload.items[0]!.event!.version = 88;
    payload.items[0]!.event!.title = "Changed event";
    payload.items[0]!.event!.displayTimeZone = "America/Los_Angeles";
    screen.getByRole("button", { name: "更新行程" }).click();
    expect(await screen.findByText("Changed event")).toBeInTheDocument();
    expect(within(dialog).getByText("Evening walk")).toBeInTheDocument();
    expect(within(dialog).getByText("2 人参加")).toBeInTheDocument();
    expect(within(dialog).queryByText("5 人参加")).not.toBeInTheDocument();
    expect(within(dialog).getByText(/报价有效至/)).toHaveTextContent(reviewedExpiry ?? "");

    await user.click(confirm);

    await waitFor(() => {
      expect(acceptanceCalls).toBe(2);
      expect(itineraryCalls).toBe(3);
    });
    const acceptanceRequests = apiRequestMock.mock.calls.filter(([path]) => String(path).endsWith("/waitlist-acceptance"));
    expect(acceptanceRequests).toHaveLength(2);
    expect(acceptanceRequests[0]![1]?.idempotencyKey).toBeTruthy();
    expect(acceptanceRequests[1]![1]?.idempotencyKey).toBe(acceptanceRequests[0]![1]?.idempotencyKey);
    expect(acceptanceRequests[0]![1]).toMatchObject({
      method: "POST",
      authenticated: true,
      idempotencyKey: acceptanceRequests[0]![1]?.idempotencyKey,
      body: JSON.stringify({
        quoteId: "019b0000-0000-7000-8500-000000000002",
        expectedRegistrationVersion: 3,
        expectedEventVersion: 8,
      }),
    });
    expect(acceptanceRequests[1]![1]?.body).toBe(acceptanceRequests[0]![1]?.body);
  });

  test("replaces quote transport diagnostics with localized safe guidance", async () => {
    const user = userEvent.setup();
    const payload = offeredItineraryPage();
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") return structuredClone(payload);
      if (path === "/quotes") throw new TypeError("socket internals");
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "无法验证最新报价，请稍后重试。",
    );
    expect(screen.queryByText("socket internals")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认接受候补名额" })).not.toBeInTheDocument();
  });

  test("keeps a saved acceptance fail-closed while its authoritative itinerary refresh is pending", async () => {
    const user = userEvent.setup();
    const original = offeredItineraryPage();
    const updated = confirmedItineraryPage();
    let resolveRefresh: ((value: unknown) => void) | undefined;
    const deferredRefresh = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    });
    let itineraryCalls = 0;
    let quoteCalls = 0;
    let acceptanceCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") {
        itineraryCalls += 1;
        if (itineraryCalls === 1) return structuredClone(original);
        return deferredRefresh;
      }
      if (path === "/quotes") {
        quoteCalls += 1;
        return {
          id: "019b0000-0000-7000-8500-000000000010",
          amount: 45,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        acceptanceCalls += 1;
        return { status: "confirmed" };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));
    await user.click(await screen.findByRole("button", { name: "确认并使用 45 积分" }));

    await waitFor(() => expect(itineraryCalls).toBe(2));
    expect(screen.queryByRole("dialog", { name: "确认接受候补名额" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "接受名额" })).not.toBeInTheDocument();
    const syncing = screen.getByRole("button", { name: "名额已保存，正在刷新报名状态…" });
    expect(syncing).toHaveAttribute("aria-disabled", "true");
    expect(screen.queryByText("更多操作")).not.toBeInTheDocument();
    await user.click(syncing);
    expect(quoteCalls).toBe(1);
    expect(acceptanceCalls).toBe(1);

    resolveRefresh?.(structuredClone(updated));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("名额已确认，报名状态已刷新。");
    await waitFor(() => expect(status).toHaveFocus());
    expect(quoteCalls).toBe(1);
    expect(acceptanceCalls).toBe(1);
  });

  test("offers only an authoritative GET retry when a saved acceptance cannot refresh", async () => {
    const user = userEvent.setup();
    const original = offeredItineraryPage();
    const updated = confirmedItineraryPage();
    let itineraryCalls = 0;
    let quoteCalls = 0;
    let acceptanceCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") {
        itineraryCalls += 1;
        if (itineraryCalls === 1) return structuredClone(original);
        if (itineraryCalls === 2) throw new TypeError("raw post-success refresh diagnostic");
        return structuredClone(updated);
      }
      if (path === "/quotes") {
        quoteCalls += 1;
        return {
          id: "019b0000-0000-7000-8500-000000000011",
          amount: 50,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        acceptanceCalls += 1;
        return { status: "confirmed" };
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));
    await user.click(await screen.findByRole("button", { name: "确认并使用 50 积分" }));

    const failedStatus = await screen.findByRole("status");
    expect(failedStatus).toHaveTextContent(
      "名额接受结果已保存，但暂时无法刷新最新报名状态。请重试更新；不要再次接受名额。",
    );
    expect(screen.queryByText("raw post-success refresh diagnostic")).not.toBeInTheDocument();
    await waitFor(() => expect(failedStatus).toHaveFocus());
    expect(screen.queryByRole("button", { name: "接受名额" })).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "重试刷新报名状态" });
    expect(screen.queryByText("更多操作")).not.toBeInTheDocument();
    await user.click(retry);

    const refreshedStatus = await screen.findByRole("status");
    expect(refreshedStatus).toHaveTextContent("名额已确认，报名状态已刷新。");
    await waitFor(() => expect(refreshedStatus).toHaveFocus());
    expect(itineraryCalls).toBe(3);
    expect(quoteCalls).toBe(1);
    expect(acceptanceCalls).toBe(1);
  });

  test("keeps confirm focus during a slow acceptance and restores it after a retryable rejection", async () => {
    const user = userEvent.setup();
    const payload = offeredItineraryPage();
    let rejectAcceptance: ((reason?: unknown) => void) | undefined;
    const deferredAcceptance = new Promise<unknown>((_resolve, reject) => {
      rejectAcceptance = reject;
    });
    let acceptanceCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") return structuredClone(payload);
      if (path === "/quotes") {
        return {
          id: "019b0000-0000-7000-8500-000000000012",
          amount: 30,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        acceptanceCalls += 1;
        return deferredAcceptance;
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));
    const dialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    const confirm = within(dialog).getByRole("button", { name: "确认并使用 30 积分" });
    await user.click(confirm);

    await waitFor(() => expect(acceptanceCalls).toBe(1));
    expect(confirm).toHaveFocus();
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    expect(confirm).not.toBeDisabled();
    await user.click(confirm);
    expect(acceptanceCalls).toBe(1);
    confirm.blur();
    expect(confirm).not.toHaveFocus();
    rejectAcceptance?.(new TypeError("transport detail"));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "暂时无法确认名额，请稍后重试；当前复核内容已保留。",
    );
    await waitFor(() => expect(confirm).toHaveFocus());
    expect(acceptanceCalls).toBe(1);
  });

  test.each([
    ["accepted", "名额接受结果已保存，但暂时无法刷新最新报名状态。请重试更新；不要再次接受名额。"],
    ["conflict", "无法更新最新名额与报价。为避免重复确认，接受操作已暂停；请重试更新。"],
  ] as const)(
    "does not publish an old-owner %s refresh result after an owner switch",
    async (mode, forbiddenMessage) => {
      const user = userEvent.setup();
      const original = offeredItineraryPage();
      const nextOwner = offeredItineraryPage();
      nextOwner.items[0]!.event!.title = "New owner itinerary";
      nextOwner.items[0]!.registration.userId = "019b0000-0000-7000-8000-000000000002";
      let resolveOldRefresh: ((value: unknown) => void) | undefined;
      const oldRefresh = new Promise<unknown>((resolve) => {
        resolveOldRefresh = resolve;
      });
      let itineraryCalls = 0;
      let quoteCalls = 0;
      let acceptanceCalls = 0;
      apiRequestMock.mockImplementation(async (path) => {
        if (path === "/me/registrations?limit=100") {
          itineraryCalls += 1;
          if (itineraryCalls === 1) return structuredClone(original);
          if (itineraryCalls === 2) return oldRefresh;
          if (itineraryCalls === 3) return structuredClone(nextOwner);
        }
        if (path === "/quotes") {
          quoteCalls += 1;
          return {
            id: "019b0000-0000-7000-8500-000000000014",
            amount: 25,
            currency: "POINTS",
            expiresAt: "2026-07-16T03:20:00.000Z",
          };
        }
        if (String(path).endsWith("/waitlist-acceptance")) {
          acceptanceCalls += 1;
          if (mode === "conflict") {
            throw new APIError(409, { code: "QUOTE_EXPIRED", message: "expired" });
          }
          return { status: "confirmed" };
        }
        throw new Error(`unexpected ${path}`);
      });
      renderWithI18n(<MyEventsClient />);

      await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
      await user.click(screen.getByRole("button", { name: "接受名额" }));
      await user.click(await screen.findByRole("button", { name: "确认并使用 25 积分" }));
      await waitFor(() => expect(itineraryCalls).toBe(2));

      sessionMocks.session = { user: { id: "user-b" } };
      window.dispatchEvent(new CustomEvent("spott:session"));
      expect(await screen.findByText("New owner itinerary")).toBeInTheDocument();

      await act(async () => {
        resolveOldRefresh?.(structuredClone(original));
        await oldRefresh;
        await Promise.resolve();
      });

      expect(screen.getByText("New owner itinerary")).toBeInTheDocument();
      expect(screen.queryByText(forbiddenMessage)).not.toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(itineraryCalls).toBe(3);
      expect(quoteCalls).toBe(1);
      expect(acceptanceCalls).toBe(1);
    },
  );

  test.each(["accepted", "conflict"] as const)(
    "does not let a header refresh supersede an in-flight %s critical refresh",
    async (mode) => {
      const user = userEvent.setup();
      const original = offeredItineraryPage();
      const updated = mode === "accepted"
        ? confirmedItineraryPage()
        : offeredItineraryPage({ registrationVersion: 4, eventVersion: 9 });
      let resolveCriticalRefresh: ((value: unknown) => void) | undefined;
      const criticalRefresh = new Promise<unknown>((resolve) => {
        resolveCriticalRefresh = resolve;
      });
      let itineraryCalls = 0;
      let quoteCalls = 0;
      let acceptanceCalls = 0;
      apiRequestMock.mockImplementation(async (path) => {
        if (path === "/me/registrations?limit=100") {
          itineraryCalls += 1;
          if (itineraryCalls === 1) return structuredClone(original);
          return criticalRefresh;
        }
        if (path === "/quotes") {
          quoteCalls += 1;
          return {
            id: "019b0000-0000-7000-8500-000000000015",
            amount: 25,
            currency: "POINTS",
            expiresAt: "2026-07-16T03:20:00.000Z",
          };
        }
        if (String(path).endsWith("/waitlist-acceptance")) {
          acceptanceCalls += 1;
          if (mode === "conflict") {
            throw new APIError(409, { code: "QUOTE_EXPIRED", message: "expired" });
          }
          return { status: "confirmed" };
        }
        throw new Error(`unexpected ${path}`);
      });
      renderWithI18n(<MyEventsClient />);

      await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
      await user.click(screen.getByRole("button", { name: "接受名额" }));
      await user.click(await screen.findByRole("button", { name: "确认并使用 25 积分" }));
      await waitFor(() => expect(itineraryCalls).toBe(2));

      const headerRefresh = screen.getByRole("button", { name: "正在更新…" });
      expect(headerRefresh).toBeDisabled();
      await user.click(headerRefresh);
      expect(itineraryCalls).toBe(2);

      await act(async () => {
        resolveCriticalRefresh?.(structuredClone(updated));
        await criticalRefresh;
      });

      const status = await screen.findByRole("status");
      expect(status).toHaveTextContent(mode === "accepted"
        ? "名额已确认，报名状态已刷新。"
        : "报价或活动状态已更新，请重新查看并确认。");
      await waitFor(() => expect(status).toHaveFocus());
      expect(screen.queryByText(/无法更新|无法刷新/)).not.toBeInTheDocument();
      expect(itineraryCalls).toBe(2);
      expect(quoteCalls).toBe(1);
      expect(acceptanceCalls).toBe(1);
    },
  );

  test("keeps review open while replacing raw API diagnostics with localized guidance", async () => {
    const user = userEvent.setup();
    const payload = offeredItineraryPage();
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") return structuredClone(payload);
      if (path === "/quotes") {
        return {
          id: "019b0000-0000-7000-8500-000000000003",
          amount: 20,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        throw new APIError(500, { code: "INTERNAL_QUERY_FAILURE", message: "raw database diagnostic" });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));
    const dialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    await user.click(within(dialog).getByRole("button", { name: "确认并使用 20 积分" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "暂时无法确认名额，请稍后重试；当前复核内容已保留。",
    );
    expect(within(dialog).queryByText("raw database diagnostic")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "确认接受候补名额" })).toBeInTheDocument();
  });

  test("ships a non-clipping light-only mobile waitlist sheet with contrast and reduced-motion support", () => {
    const css = readFileSync(
      join(process.cwd(), "app/me/events/MyEvents.module.css"),
      "utf8",
    );

    expect(css).toMatch(/\.waitlistBackdrop\s*\{/);
    expect(css).toMatch(/\.waitlistDialog\s*\{/);
    expect(css).toContain("safe-area-inset-bottom");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("@media (max-width: 640px)");
    expect(css).not.toContain("@media (prefers-color-scheme: dark)");
    expect(css).not.toContain("color-scheme: dark");
    expect(css).toContain("@media (prefers-contrast: more)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@media (forced-colors: active)");
    expect(css).toMatch(/\[aria-disabled=["']true["']\]/);
    expect(css).toMatch(/cursor:\s*not-allowed/);
    expect(css).toMatch(/opacity:\s*(?:0)?\.[0-9]+/);
  });

  test("refreshes after a quote or version conflict and requires a new quote review", async () => {
    const user = userEvent.setup();
    const original = offeredItineraryPage();
    const updated = offeredItineraryPage({ registrationVersion: 4, eventVersion: 9 });
    let itineraryCalls = 0;
    let quoteCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") {
        itineraryCalls += 1;
        return structuredClone(itineraryCalls === 1 ? original : updated);
      }
      if (path === "/quotes") {
        quoteCalls += 1;
        return {
          id: `019b0000-0000-7000-8500-00000000000${quoteCalls}`,
          amount: quoteCalls === 1 ? 40 : 65,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        throw new APIError(409, { code: "QUOTE_EXPIRED", message: "expired" });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    await user.click(screen.getByRole("button", { name: "接受名额" }));
    await user.click(await screen.findByRole("button", { name: "确认并使用 40 积分" }));

    await waitFor(() => expect(itineraryCalls).toBe(2));
    expect(screen.queryByRole("dialog", { name: "确认接受候补名额" })).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("报价或活动状态已更新，请重新查看并确认。");

    await user.click(screen.getByRole("button", { name: "接受名额" }));
    const refreshedDialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    expect(within(refreshedDialog).getByText("65 积分")).toBeInTheDocument();
    expect(quoteCalls).toBe(2);
    expect(apiRequestMock.mock.calls.filter(([path]) => String(path).endsWith("/waitlist-acceptance"))).toHaveLength(1);
  });

  test("does not focus a disabled stale trigger and focuses status after a deferred conflict refresh succeeds", async () => {
    const user = userEvent.setup();
    const original = offeredItineraryPage();
    const updated = offeredItineraryPage({ registrationVersion: 4, eventVersion: 9 });
    let rejectAcceptance: ((reason?: unknown) => void) | undefined;
    const deferredAcceptance = new Promise<unknown>((_resolve, reject) => {
      rejectAcceptance = reject;
    });
    let resolveRefresh: ((value: unknown) => void) | undefined;
    const deferredRefresh = new Promise<unknown>((resolve) => {
      resolveRefresh = resolve;
    });
    let itineraryCalls = 0;
    let quoteCalls = 0;
    let acceptanceCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") {
        itineraryCalls += 1;
        if (itineraryCalls === 1) return structuredClone(original);
        return deferredRefresh;
      }
      if (path === "/quotes") {
        quoteCalls += 1;
        return {
          id: "019b0000-0000-7000-8500-000000000013",
          amount: 40,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        acceptanceCalls += 1;
        return deferredAcceptance;
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    const trigger = screen.getByRole("button", { name: "接受名额" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "确认接受候补名额" });
    const triggerFocus = vi.spyOn(trigger, "focus");
    await user.click(within(dialog).getByRole("button", { name: "确认并使用 40 积分" }));
    rejectAcceptance?.(new APIError(409, { code: "QUOTE_EXPIRED", message: "expired" }));

    await waitFor(() => expect(itineraryCalls).toBe(2));
    expect(screen.queryByRole("dialog", { name: "确认接受候补名额" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在更新名额…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(triggerFocus).not.toHaveBeenCalled();

    resolveRefresh?.(structuredClone(updated));
    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("报价或活动状态已更新，请重新查看并确认。");
    await waitFor(() => expect(status).toHaveFocus());
    expect(quoteCalls).toBe(1);
    expect(acceptanceCalls).toBe(1);
  });

  test("fails closed after a conflict refresh failure until authoritative facts reload", async () => {
    const user = userEvent.setup();
    const original = offeredItineraryPage();
    const updated = offeredItineraryPage({ registrationVersion: 4, eventVersion: 9 });
    let itineraryCalls = 0;
    let quoteCalls = 0;
    let acceptanceCalls = 0;
    let rejectRefresh: ((reason?: unknown) => void) | undefined;
    const deferredRefresh = new Promise<unknown>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/me/registrations?limit=100") {
        itineraryCalls += 1;
        if (itineraryCalls === 2) return deferredRefresh;
        return structuredClone(itineraryCalls === 1 ? original : updated);
      }
      if (path === "/quotes") {
        quoteCalls += 1;
        return {
          id: "019b0000-0000-7000-8500-000000000008",
          amount: 40,
          currency: "POINTS",
          expiresAt: "2026-07-16T03:20:00.000Z",
        };
      }
      if (String(path).endsWith("/waitlist-acceptance")) {
        acceptanceCalls += 1;
        throw new APIError(409, { code: "QUOTE_EXPIRED", message: "expired" });
      }
      throw new Error(`unexpected ${path}`);
    });
    renderWithI18n(<MyEventsClient />);

    await user.click(await screen.findByRole("tab", { name: /候补 1/ }));
    const trigger = screen.getByRole("button", { name: "接受名额" });
    await user.click(trigger);
    const triggerFocus = vi.spyOn(trigger, "focus");
    await user.click(await screen.findByRole("button", { name: "确认并使用 40 积分" }));
    await waitFor(() => expect(itineraryCalls).toBe(2));
    rejectRefresh?.(new APIError(503, {
      code: "UPSTREAM_UNAVAILABLE",
      message: "raw refresh diagnostic",
    }));

    const failedStatus = await screen.findByRole("status");
    expect(failedStatus).toHaveTextContent(
      "无法更新最新名额与报价。为避免重复确认，接受操作已暂停；请重试更新。",
    );
    await waitFor(() => expect(failedStatus).toHaveFocus());
    expect(triggerFocus).not.toHaveBeenCalled();
    expect(screen.queryByText("raw refresh diagnostic")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "确认接受候补名额" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "接受名额" })).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "重试更新名额" });
    expect(retry).toBeEnabled();
    expect(screen.queryByText("更多操作")).not.toBeInTheDocument();
    expect(quoteCalls).toBe(1);
    expect(acceptanceCalls).toBe(1);

    await user.click(retry);
    expect(await screen.findByRole("button", { name: "接受名额" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "报价或活动状态已更新，请重新查看并确认。",
    );
    expect(itineraryCalls).toBe(3);
    expect(quoteCalls).toBe(1);
    expect(acceptanceCalls).toBe(1);
  });
});
