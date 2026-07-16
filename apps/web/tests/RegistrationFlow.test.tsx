import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { RegistrationConfirmation, RegistrationFlow } from "../app/register/[slug]/RegistrationFlow";
import { APIError, apiRequest } from "../app/lib/client-api";
import { fetchEvent } from "../app/lib/events-api";
import { REGISTRATION_DRAFT_SCHEMA_VERSION, saveRegistrationDraft } from "../app/lib/registration-draft";
import { makeDetail, renderWithI18n } from "./event-fixtures";

const mocks = vi.hoisted(() => ({
  session: null as null | {
    accessToken: string;
    user: { id: string; phoneVerified: boolean };
  },
  apiRequest: vi.fn(),
  fetchEvent: vi.fn(),
}));

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: mocks.apiRequest, readSession: () => mocks.session };
});
vi.mock("../app/lib/events-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/events-api")>();
  return { ...actual, fetchEvent: mocks.fetchEvent };
});

const apiRequestMock = vi.mocked(apiRequest);
const fetchEventMock = vi.mocked(fetchEvent);

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.session = { accessToken: "access", user: { id: "user-b", phoneVerified: true } };
  apiRequestMock.mockReset();
  fetchEventMock.mockReset();
  apiRequestMock.mockImplementation(async (path) => {
    if (path === "/quotes") {
      return { id: "019b0000-0000-7000-8500-000000000001", amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" };
    }
    return { id: "019b0000-0000-7000-8200-000000000001", eventId: makeDetail().id, status: "confirmed", partySize: 1 };
  });
});

describe("resumable registration flow", () => {
  test.each([
    [null, "/login?returnTo="],
    [{ accessToken: "access", user: { id: "user-b", phoneVerified: false } }, "/phone-verification?returnTo="],
  ])("preserves the full draft through a gate", async (session, expectedPrefix) => {
    mocks.session = session;
    const event = makeDetail();
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: event.id,
      eventVersion: event.version,
      ownerUserId: session?.user.id ?? null,
      partySize: 3,
      answers: { "019b0000-0000-7000-8300-000000000001": "Vegetarian" },
      attendeeNote: "Near the lift",
      acceptedTerms: true,
      step: "review",
      idempotencyKey: "019b0000-0000-7000-8400-000000000001",
      updatedAt: "2026-07-16T03:00:00.000Z",
    });
    const navigate = vi.fn();

    renderWithI18n(<RegistrationFlow event={event} navigate={navigate} />);

    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(navigate.mock.calls[0]![0]).toMatch(new RegExp(`^${expectedPrefix.replace(/[?]/g, "\\?")}`));
    expect(window.sessionStorage.length).toBe(1);
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toContain("Near the lift");
  });

  test("restores every field once after returning from a gate", async () => {
    const questionId = "019b0000-0000-7000-8300-000000000001";
    const event = makeDetail({
      registrationQuestions: [{ id: questionId, prompt: "Dietary needs", kind: "text", required: true, options: [] }],
    });
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION, eventId: event.id, eventVersion: event.version, ownerUserId: "user-b",
      partySize: 3, answers: { [questionId]: "Vegetarian" }, attendeeNote: "Near the lift",
      acceptedTerms: true, step: "details", idempotencyKey: "019b0000-0000-7000-8400-000000000001",
      updatedAt: "2026-07-16T03:00:00.000Z",
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    expect(await screen.findByLabelText(/参加人数/)).toHaveValue(3);
    expect(screen.getByLabelText(/Dietary needs/)).toHaveValue("Vegetarian");
    expect(screen.getByLabelText("想对主办方补充什么？")).toHaveValue("Near the lift");
  });

  test("restores a review draft for the same owner and immediately refreshes its quote", async () => {
    const event = makeDetail();
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: event.id,
      eventVersion: event.version,
      ownerUserId: "user-b",
      partySize: 2,
      answers: {},
      attendeeNote: "Still attending",
      acceptedTerms: true,
      step: "review",
      idempotencyKey: "019b0000-0000-7000-8400-000000000001",
      updatedAt: "2026-07-16T03:00:00.000Z",
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    expect(await screen.findByText("40 积分")).toBeInTheDocument();
    expect(apiRequestMock.mock.calls.filter(([path]) => path === "/quotes")).toHaveLength(1);
  });

  test("never restores private answers after the tab changes account", async () => {
    const event = makeDetail();
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: event.id,
      eventVersion: event.version,
      ownerUserId: "user-a",
      partySize: 4,
      answers: {},
      attendeeNote: "User A private note",
      acceptedTerms: true,
      step: "details",
      idempotencyKey: "019b0000-0000-7000-8400-000000000001",
      updatedAt: "2026-07-16T03:00:00.000Z",
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    expect(await screen.findByLabelText(/参加人数/)).toHaveValue(1);
    expect(screen.getByLabelText("想对主办方补充什么？")).toHaveValue("");
    expect(screen.queryByDisplayValue("User A private note")).not.toBeInTheDocument();
  });

  test("clamps a restored party size to current available capacity", async () => {
    const event = makeDetail({ capacity: 12, availableCapacity: 2 });
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: event.id,
      eventVersion: event.version,
      ownerUserId: "user-b",
      partySize: 9,
      answers: {},
      attendeeNote: "",
      acceptedTerms: true,
      step: "details",
      idempotencyKey: "019b0000-0000-7000-8400-000000000001",
      updatedAt: "2026-07-16T03:00:00.000Z",
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    expect(await screen.findByLabelText(/参加人数/)).toHaveValue(2);
  });

  test.each([
    makeDetail({ status: "cancelled", availableActions: [] }),
    makeDetail({ status: "registration_closed", availableActions: [] }),
  ])("blocks a direct registration URL before showing fields when strict CTA is unavailable", async (event) => {
    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "报名暂不可用" })).toBeInTheDocument();
    expect(screen.queryByLabelText(/参加人数/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "继续核对" })).not.toBeInTheDocument();
  });

  test("focuses the first invalid field and connects its local error", async () => {
    const user = userEvent.setup();
    const questionId = "019b0000-0000-7000-8300-000000000001";
    const event = makeDetail({
      registrationQuestions: [{ id: questionId, prompt: "Dietary needs", kind: "text", required: true, options: [] }],
    });
    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    const question = await screen.findByLabelText(/Dietary needs/);
    await user.click(screen.getByRole("button", { name: "继续核对" }));

    expect(question).toHaveFocus();
    expect(question).toHaveAccessibleDescription("请填写此项。");
    expect(screen.getByRole("alert")).toHaveTextContent("请检查标出的内容");
  });

  test("reuses one idempotency key for an offline retry and never shows false success", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let registrationAttempt = 0;
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === "/quotes") return { id: "019b0000-0000-7000-8500-000000000001", amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" };
      if (!init) throw new Error("registration request options are required");
      keys.push(String(init.idempotencyKey));
      registrationAttempt += 1;
      if (registrationAttempt === 1) throw new TypeError("offline");
      return { id: "019b0000-0000-7000-8200-000000000001", eventId: makeDetail().id, status: "confirmed", partySize: 1 };
    });
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await screen.findByText("40 积分");
    await user.click(screen.getByRole("button", { name: "确认并报名" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");
    expect(screen.queryByText("报名已确认")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "确认并报名" }));
    expect(await screen.findByText("报名已确认")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });

  test("explicit restart clears the draft and creates a new logical idempotency key", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let attempt = 0;
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === "/quotes") return { id: `quote-${attempt}`, amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" };
      if (!init) throw new Error("registration request options are required");
      keys.push(String(init.idempotencyKey));
      attempt += 1;
      if (attempt === 1) throw new TypeError("offline");
      return { id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 };
    });
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);

    await user.type(await screen.findByLabelText("想对主办方补充什么？"), "discard me");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("offline");

    await user.click(screen.getByRole("button", { name: "清空并重新开始" }));
    expect(await screen.findByLabelText("想对主办方补充什么？")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    const submit = await screen.findByRole("button", { name: "确认并报名" });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);

    expect(await screen.findByText("报名已确认")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  test("refreshes an expired quote immediately before the registration commit", async () => {
    const user = userEvent.setup();
    const quoteIds: string[] = [];
    let quoteCalls = 0;
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === "/quotes") {
        quoteCalls += 1;
        return {
          id: `quote-${quoteCalls}`,
          amount: quoteCalls === 1 ? 10 : 20,
          currency: "POINTS",
          expiresAt: quoteCalls === 1 ? "2000-01-01T00:00:00.000Z" : "2099-01-01T00:00:00.000Z",
        };
      }
      if (!init) throw new Error("registration request options are required");
      quoteIds.push(String(JSON.parse(String(init.body)).quoteId));
      return { id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 };
    });
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    expect(await screen.findByText("10 积分")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "确认并报名" }));

    expect(await screen.findByText("报名已确认")).toBeInTheDocument();
    expect(quoteCalls).toBe(2);
    expect(quoteIds).toEqual(["quote-2"]);
  });

  test("offers an explicit quote retry without changing the draft or logical key", async () => {
    const user = userEvent.setup();
    let quoteCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path !== "/quotes") return { id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 };
      quoteCalls += 1;
      if (quoteCalls === 1) throw new TypeError("quote offline");
      return { id: "quote-2", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
    });
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);

    await user.type(await screen.findByLabelText("想对主办方补充什么？"), "Keep this note");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("quote offline");
    const before = await storedDraft();

    await user.click(screen.getByRole("button", { name: "重新获取报价" }));
    expect(await screen.findByText("40 积分")).toBeInTheDocument();
    const after = await storedDraft();

    expect(quoteCalls).toBe(2);
    expect(after.idempotencyKey).toBe(before.idempotencyKey);
    expect(after.attendeeNote).toBe("Keep this note");
  });

  test("maps API field errors back to the stable field and preserves the draft", async () => {
    const user = userEvent.setup();
    const questionId = "019b0000-0000-7000-8300-000000000001";
    const event = makeDetail({
      registrationQuestions: [{ id: questionId, prompt: "Dietary needs", kind: "text", required: true, options: [] }],
    });
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/quotes") return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      throw new APIError(422, { fieldErrors: [{ field: `answers.${questionId}`, message: "Please use a supported answer." }] });
    });
    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);

    await user.type(await screen.findByLabelText(/Dietary needs/), "Private answer");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    const field = await screen.findByLabelText(/Dietary needs/);
    expect(field).toHaveFocus();
    expect(field).toHaveAccessibleDescription("Please use a supported answer.");
    expect(field).toHaveValue("Private answer");
    expect(window.sessionStorage.getItem(window.sessionStorage.key(0)!)).toContain("Private answer");
  });

  test("blocks double submit while the logical request is in flight", async () => {
    const user = userEvent.setup();
    let release!: () => void;
    const pending = new Promise((resolve) => { release = () => resolve({ id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 }); });
    apiRequestMock.mockImplementation(async (path) => path === "/quotes"
      ? { id: "019b0000-0000-7000-8500-000000000001", amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" }
      : pending);
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    const submit = await screen.findByRole("button", { name: "确认并报名" });
    await waitFor(() => expect(submit).toBeEnabled());

    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(apiRequestMock.mock.calls.filter(([path]) => String(path).includes("/registrations"))).toHaveLength(1));
    release();
  });

  test("refreshes event and quote after 409, preserves answers, and requires reconfirmation", async () => {
    const user = userEvent.setup();
    const event = makeDetail();
    let quoteCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/quotes") {
        quoteCalls += 1;
        return { id: `019b0000-0000-7000-8500-00000000000${quoteCalls}`, amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" };
      }
      throw new APIError(409, { code: "REGISTRATION_CAPACITY_FULL", message: "full" });
    });
    fetchEventMock.mockResolvedValue(makeDetail({
      version: event.version + 1,
      confirmedCount: event.capacity,
      availableCapacity: 0,
      availableActions: ["joinWaitlist"],
    }));
    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);
    const partySize = await screen.findByLabelText(/参加人数/);
    await user.clear(partySize);
    await user.type(partySize, "3");
    const note = await screen.findByLabelText("想对主办方补充什么？");
    await user.type(note, "Window seat");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("活动信息刚刚更新");
    expect(screen.getByText("Window seat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByDisplayValue("Window seat")).toBeInTheDocument();
    expect(screen.getByLabelText(/参加人数/)).toHaveValue(1);
    expect(screen.queryByText("报名已确认")).not.toBeInTheDocument();
    expect(fetchEventMock).toHaveBeenCalledWith(event.id, { accessToken: "access" });
    await waitFor(() => expect(quoteCalls).toBe(2));
  });
});

describe("complete registration confirmation", () => {
  test.each([
    ["confirmed", "报名已确认"],
    ["pending", "正在等待主办方确认"],
    ["waitlisted", "已加入候补"],
  ])("covers %s with the complete next-step set", (status, title) => {
    renderWithI18n(
      <RegistrationConfirmation
        event={makeDetail()}
        registration={{ id: "019b0000-0000-7000-8200-000000000001", eventId: makeDetail().id, status, partySize: 2 }}
      />,
    );

    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText("东京余光 · 隅田川蓝调散步")).toBeInTheDocument();
    expect(screen.getByText(/2 人/)).toBeInTheDocument();
    expect(screen.getByText("清澄白河站附近")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "加入日历" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "分享" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看我的活动" })).toHaveAttribute("href", "/me/events");
  });

  test.each([
    ["online", "线上活动"],
    ["in_person", "区域待确认"],
  ] as const)("renders a truthful location fallback for %s events", (format, location) => {
    renderWithI18n(
      <RegistrationConfirmation
        event={makeDetail({ format, publicArea: null })}
        registration={{ id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 }}
      />,
    );

    expect(screen.getByText(location)).toBeInTheDocument();
  });

  test("turns clipboard failure into accessible feedback and treats native share cancellation as silent", async () => {
    const user = userEvent.setup();
    const shareDescriptor = Object.getOwnPropertyDescriptor(navigator, "share");
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    try {
      Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")) },
      });
      const view = renderWithI18n(
        <RegistrationConfirmation
          event={makeDetail()}
          registration={{ id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 }}
        />,
      );

      await user.click(screen.getByRole("button", { name: "分享" }));
      expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法分享");

      view.unmount();
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: vi.fn().mockRejectedValue(new DOMException("cancelled", "AbortError")),
      });
      renderWithI18n(
        <RegistrationConfirmation
          event={makeDetail()}
          registration={{ id: "registration", eventId: makeDetail().id, status: "confirmed", partySize: 1 }}
        />,
      );
      await user.click(screen.getByRole("button", { name: "分享" }));
      await waitFor(() => expect(navigator.share).toHaveBeenCalledOnce());
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      restoreNavigatorProperty("share", shareDescriptor);
      restoreNavigatorProperty("clipboard", clipboardDescriptor);
    }
  });
});

async function storedDraft() {
  let draft: Record<string, unknown> | null = null;
  await waitFor(() => {
    const key = window.sessionStorage.key(0);
    expect(key).not.toBeNull();
    draft = JSON.parse(window.sessionStorage.getItem(key!)!) as Record<string, unknown>;
    expect(draft.attendeeNote).toBe("Keep this note");
  });
  return draft!;
}

function restoreNavigatorProperty(name: "share" | "clipboard", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(navigator, name, descriptor);
  else delete (navigator as unknown as Record<string, unknown>)[name];
}
