import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  RegistrationConfirmation,
  RegistrationFlow,
  registrationPartyLimit,
} from "../app/register/[slug]/RegistrationFlow";
import { APIError, apiRequest } from "../app/lib/client-api";
import { REGISTRATION_DRAFT_SCHEMA_VERSION, saveRegistrationDraft } from "../app/lib/registration-draft";
import { makeDetail, renderWithI18n } from "./event-fixtures";

const mocks = vi.hoisted(() => ({
  session: null as null | {
    accessToken: string;
    user: { id: string; phoneVerified: boolean };
  },
  apiRequest: vi.fn(),
  trackProductEvent: vi.fn(),
}));

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: mocks.apiRequest, readSession: () => mocks.session };
});
vi.mock("../app/lib/analytics", () => ({
  trackProductEvent: mocks.trackProductEvent,
}));

const apiRequestMock = vi.mocked(apiRequest);
let defaultViewerEvent = makeDetail();

beforeEach(() => {
  window.sessionStorage.clear();
  mocks.session = { accessToken: "access", user: { id: "user-b", phoneVerified: true } };
  apiRequestMock.mockReset();
  mocks.trackProductEvent.mockReset();
  defaultViewerEvent = makeDetail();
  apiRequestMock.mockImplementation(async (path) => {
    if (path === `/events/${defaultViewerEvent.id}`) return defaultViewerEvent;
    if (path === "/quotes") {
      return { id: "019b0000-0000-7000-8500-000000000001", amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" };
    }
    return { id: "019b0000-0000-7000-8200-000000000001", eventId: makeDetail().id, status: "confirmed", partySize: 1 };
  });
});

describe("resumable registration flow", () => {
  test("keeps the language control available throughout the immersive registration route", async () => {
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);

    expect(screen.getByRole("combobox", { name: "语言" })).toBeInTheDocument();
    await screen.findByRole("button", { name: "继续核对" });
    expect(screen.getByRole("combobox", { name: "语言" })).toBeInTheDocument();
  });

  test("announces the current registration step with localized context", async () => {
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />, "en");

    await screen.findByRole("button", { name: "Review details" });
    const progress = screen.getByRole("list", { name: "Registration progress" });
    const currentStep = progress.querySelector('[aria-current="step"]');
    expect(currentStep).toHaveTextContent("Registration details · Step 1 of 2");
  });

  test("keeps the paid-fee checkbox independent from keyboard-accessible legal links", async () => {
    const user = userEvent.setup();
    const paidEvent = makeDetail({
      fee: {
        isFree: false,
        amountJPY: 2400,
        collectorName: "Weekend Kai",
        method: "Cash at the venue",
        paymentDeadlineText: "Before check-in",
        refundPolicy: "Full refund until 24 hours before start",
      },
    });
    defaultViewerEvent = paidEvent;

    renderWithI18n(<RegistrationFlow event={paidEvent} navigate={vi.fn()} />);

    const checkbox = await screen.findByRole("checkbox", {
      name: /我已阅读线下费用与退款边界/,
    });
    const termsLink = screen.getByRole("link", { name: /服务条款/ });
    const privacyLink = screen.getByRole("link", { name: /隐私政策/ });

    expect(termsLink).toHaveAttribute("href", "/terms");
    expect(privacyLink).toHaveAttribute("href", "/privacy");
    expect(termsLink).toHaveAttribute("target", "_blank");
    expect(privacyLink).toHaveAttribute("target", "_blank");
    expect(checkbox.closest("label")).not.toContainElement(termsLink);
    expect(checkbox.closest("label")).not.toContainElement(privacyLink);

    termsLink.focus();
    expect(termsLink).toHaveFocus();
    termsLink.addEventListener("click", (event) => event.preventDefault(), { once: true });
    await user.keyboard("{Enter}");
    expect(checkbox).not.toBeChecked();

    await user.click(checkbox);
    expect(checkbox).toBeChecked();
  });

  test.each([
    ["ja", "利用規約", "プライバシーポリシー"],
    ["en", "Terms of Service", "Privacy Policy"],
  ] as const)("renders localized legal destinations in %s", async (locale, terms, privacy) => {
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />, locale);

    expect(await screen.findByRole("link", { name: new RegExp(terms) })).toHaveAttribute("href", "/terms");
    expect(screen.getByRole("link", { name: new RegExp(privacy) })).toHaveAttribute("href", "/privacy");
  });

  test("always replaces a registration-ready server event with the viewer-authorized event", async () => {
    const serverEvent = makeDetail({
      title: "Public registration snapshot",
      availableActions: ["register"],
    });
    const authorizedEvent = makeDetail({
      title: "Viewer-authorized registration snapshot",
      availableActions: ["register"],
    });
    apiRequestMock.mockImplementation(async (path) => path === `/events/${serverEvent.id}`
      ? authorizedEvent
      : { id: "registration", eventId: serverEvent.id, status: "confirmed", partySize: 1 });

    renderWithI18n(<RegistrationFlow event={serverEvent} navigate={vi.fn()} />);

    expect(await screen.findByText("Viewer-authorized registration snapshot")).toBeInTheDocument();
    expect(screen.queryByText("Public registration snapshot")).not.toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/events/${serverEvent.id}`,
      { authenticated: true },
    );
  });

  test("remounts every private registration fact when the dynamic route changes from A to B", async () => {
    const user = userEvent.setup();
    const routeA = makeDetail({
      title: "Route A registration",
      organizerContact: null,
    });
    const authorizedA = makeDetail({
      title: "Route A registration",
      organizerContact: {
        kind: "email",
        label: "Route A private desk",
        value: "route-a-private@example.jp",
      },
    });
    const routeB = makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "route-b-registration",
      title: "Route B registration",
      organizerContact: null,
    });
    let routeAReads = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${routeA.id}`) {
        routeAReads += 1;
        return routeAReads === 1 ? routeA : authorizedA;
      }
      if (path === `/events/${routeB.id}`) return routeB;
      if (path === "/quotes") {
        return {
          id: "019b0000-0000-7000-8500-000000000001",
          amount: 40,
          currency: "POINTS",
          expiresAt: "2099-07-16T03:15:00.000Z",
        };
      }
      if (path === `/events/${routeA.id}/registrations`) {
        return {
          id: "019b0000-0000-7000-8200-000000000001",
          eventId: routeA.id,
          status: "confirmed",
          partySize: 1,
        };
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    const view = renderWithI18n(<RegistrationFlow event={routeA} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));
    expect(await screen.findByText("Route A private desk")).toBeInTheDocument();

    view.rerender(<RegistrationFlow event={routeB} navigate={vi.fn()} />);

    expect(screen.queryByText("Route A registration")).not.toBeInTheDocument();
    expect(screen.queryByText("Route A private desk")).not.toBeInTheDocument();
    expect(screen.queryByText("route-a-private@example.jp")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "报名已确认" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /返回活动/ })).toHaveAttribute(
      "href",
      `/e/${routeB.publicSlug}`,
    );
    expect(await screen.findByRole("button", { name: "继续核对" })).toBeInTheDocument();
    expect(screen.getByText("Route B registration")).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(`/events/${routeB.id}`, { authenticated: true });
    expect(apiRequestMock).not.toHaveBeenCalledWith(
      `/events/${routeB.id}/registrations`,
      expect.anything(),
    );
  });

  test("fails closed when the first authorized read returns a different event", async () => {
    const serverEvent = makeDetail({ title: "Expected registration event" });
    const wrongEvent = makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-registration-event",
      title: "Wrong registration event",
      organizerContact: {
        kind: "email",
        label: "Wrong private desk",
        value: "wrong-private@example.jp",
      },
    });
    apiRequestMock.mockImplementation(async (path) => path === `/events/${serverEvent.id}`
      ? wrongEvent
      : { id: "unexpected" });

    renderWithI18n(<RegistrationFlow event={serverEvent} navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "无法确认报名资格" })).toBeInTheDocument();
    expect(screen.queryByText("Wrong registration event")).not.toBeInTheDocument();
    expect(screen.queryByText("Wrong private desk")).not.toBeInTheDocument();
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/quotes")).toBe(false);
  });

  test("keeps retry fail-closed when a later authorized read returns a different event", async () => {
    const user = userEvent.setup();
    const serverEvent = makeDetail({ title: "Expected retry event" });
    const wrongEvent = makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-retry-event",
      title: "Wrong retry event",
    });
    let reads = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path !== `/events/${serverEvent.id}`) return { id: "unexpected" };
      reads += 1;
      if (reads === 1) throw new TypeError("offline");
      return wrongEvent;
    });

    renderWithI18n(<RegistrationFlow event={serverEvent} navigate={vi.fn()} />);
    await screen.findByRole("heading", { name: "无法确认报名资格" });
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("heading", { name: "无法确认报名资格" })).toBeInTheDocument();
    expect(reads).toBe(2);
    expect(screen.queryByText("Wrong retry event")).not.toBeInTheDocument();
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/quotes")).toBe(false);
  });

  test("prunes draft answers that are absent from the initial viewer-authorized event", async () => {
    const user = userEvent.setup();
    const removedQuestionId = "019b0000-0000-7000-8300-000000000008";
    const serverEvent = makeDetail({
      registrationQuestions: [{
        id: removedQuestionId,
        prompt: "Old server question",
        kind: "text",
        required: false,
        options: [],
      }],
    });
    const authorizedEvent = makeDetail({ registrationQuestions: [] });
    saveRegistrationDraft(window.sessionStorage, {
      schemaVersion: REGISTRATION_DRAFT_SCHEMA_VERSION,
      eventId: serverEvent.id,
      eventVersion: serverEvent.version,
      ownerUserId: "user-b",
      partySize: 1,
      answers: { [removedQuestionId]: "stale private answer" },
      attendeeNote: "",
      acceptedTerms: true,
      step: "details",
      idempotencyKey: "019b0000-0000-7000-8400-000000000008",
      updatedAt: "2026-07-16T03:00:00.000Z",
    });
    let submittedBody: Record<string, unknown> | null = null;
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${serverEvent.id}`) return authorizedEvent;
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      submittedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return { id: "registration", eventId: serverEvent.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={serverEvent} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    expect(await screen.findByText("报名已确认")).toBeInTheDocument();
    expect(submittedBody).not.toBeNull();
    expect(submittedBody!.answers).toEqual({});
  });

  test("hydrates the anonymous server event with the authenticated viewer action set", async () => {
    const anonymousEvent = makeDetail({ availableActions: [] });
    const authorizedEvent = makeDetail({ availableActions: ["register"] });
    apiRequestMock.mockImplementation(async (path) => path === `/events/${anonymousEvent.id}`
      ? authorizedEvent
      : { id: "registration", eventId: anonymousEvent.id, status: "confirmed", partySize: 1 });

    renderWithI18n(<RegistrationFlow event={anonymousEvent} navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "确认参加信息" })).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/events/${anonymousEvent.id}`,
      { authenticated: true },
    );
    expect(screen.queryByRole("heading", { name: "报名暂不可用" })).not.toBeInTheDocument();
  });

  test("hydrates registration eligibility through apiRequest instead of a raw access-token fetch", async () => {
    const anonymousEvent = makeDetail({ availableActions: [] });
    const authorizedEvent = makeDetail({ availableActions: ["register"] });
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${anonymousEvent.id}`) return authorizedEvent;
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return { id: "registration", eventId: anonymousEvent.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={anonymousEvent} navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "确认参加信息" })).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/events/${anonymousEvent.id}`,
      { authenticated: true },
    );
  });

  test("invalidates an old details form on a cross-tab owner change before requesting a quote", async () => {
    const user = userEvent.setup();
    mocks.session = { accessToken: "access-a", user: { id: "user-a", phoneVerified: true } };
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);

    const note = await screen.findByLabelText("想对主办方补充什么？");
    await user.type(note, "User A private answer");
    const oldForm = screen.getByRole("button", { name: "继续核对" }).closest("form")!;
    apiRequestMock.mockClear();

    mocks.session = { accessToken: "access-b", user: { id: "user-b", phoneVerified: true } };
    window.dispatchEvent(new StorageEvent("storage", { key: "spott.web.session-metadata.v1" }));
    fireEvent.submit(oldForm);

    await waitFor(() => {
      expect(apiRequestMock.mock.calls.filter(([path]) => path === "/quotes")).toHaveLength(0);
    });
    expect(screen.queryByDisplayValue("User A private answer")).not.toBeInTheDocument();
  });

  test("invalidates an old review form on an in-tab session event before registration submit", async () => {
    const user = userEvent.setup();
    mocks.session = { accessToken: "access-a", user: { id: "user-a", phoneVerified: true } };
    renderWithI18n(<RegistrationFlow event={makeDetail()} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    const oldForm = (await screen.findByRole("button", { name: "确认并报名" })).closest("form")!;
    apiRequestMock.mockClear();

    mocks.session = { accessToken: "access-b", user: { id: "user-b", phoneVerified: true } };
    window.dispatchEvent(new CustomEvent("spott:session"));
    fireEvent.submit(oldForm);

    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(apiRequestMock.mock.calls.some(([path]) => path === "/quotes")).toBe(false);
    expect(apiRequestMock.mock.calls.some(([path]) => String(path).endsWith("/registrations"))).toBe(false);
    expect(mocks.trackProductEvent).not.toHaveBeenCalledWith(
      "registration_completed",
      expect.anything(),
    );
  });

  test("offers a retry when authenticated event hydration fails without discarding the draft", async () => {
    const user = userEvent.setup();
    const anonymousEvent = makeDetail({ availableActions: [] });
    const authorizedEvent = makeDetail({ availableActions: ["register"] });
    let eventCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${anonymousEvent.id}`) {
        eventCalls += 1;
        if (eventCalls === 1) throw new TypeError("offline");
        return authorizedEvent;
      }
      return { id: "registration", eventId: anonymousEvent.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={anonymousEvent} navigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "无法确认报名资格" })).toBeInTheDocument();
    const beforeRetry = await storedDraft("");
    await user.click(screen.getByRole("button", { name: "重试" }));

    expect(await screen.findByRole("heading", { name: "确认参加信息" })).toBeInTheDocument();
    const afterRetry = await storedDraft("");
    expect(eventCalls).toBe(2);
    expect(afterRetry.idempotencyKey).toBe(beforeRetry.idempotencyKey);
  });

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
    defaultViewerEvent = event;
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
    defaultViewerEvent = event;
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
    defaultViewerEvent = event;
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
    defaultViewerEvent = event;
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
      if (path === `/events/${makeDetail().id}`) return makeDetail();
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
    expect(mocks.trackProductEvent).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "确认并报名" }));
    expect(await screen.findByText("报名已确认")).toBeInTheDocument();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(mocks.trackProductEvent).toHaveBeenCalledWith("registration_completed", {
      eventId: makeDetail().id,
      registrationStatus: "confirmed",
      partySize: 1,
    });
  });

  test("rejects a registration success response for a different event", async () => {
    const user = userEvent.setup();
    const event = makeDetail();
    const wrongEventId = "019b0000-0000-7000-8100-000000000099";
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${event.id}`) return event;
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return { id: "wrong-registration", eventId: wrongEventId, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.queryByText("报名已确认")).not.toBeInTheDocument();
    expect(mocks.trackProductEvent).not.toHaveBeenCalledWith(
      "registration_completed",
      expect.anything(),
    );
  });

  test("rejects a different event returned by the 409 refresh before requesting another quote", async () => {
    const user = userEvent.setup();
    const event = makeDetail({ title: "Expected conflict event" });
    const wrongEvent = makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-conflict-event",
      title: "Wrong conflict event",
    });
    let detailReads = 0;
    const quoteResources: string[] = [];
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${event.id}`) {
        detailReads += 1;
        return detailReads === 1 ? event : wrongEvent;
      }
      if (path === "/quotes") {
        quoteResources.push(String((JSON.parse(String(init?.body)) as { resourceId?: string }).resourceId));
        return { id: `quote-${quoteResources.length}`, amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      throw new APIError(409, { code: "EVENT_VERSION_CONFLICT", message: "changed" });
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    await waitFor(() => expect(detailReads).toBe(2));
    expect(screen.queryByText("Wrong conflict event")).not.toBeInTheDocument();
    expect(quoteResources).toEqual([event.id]);
    expect(screen.queryByText("报名已确认")).not.toBeInTheDocument();
  });

  test("explicit restart clears the draft and creates a new logical idempotency key", async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let attempt = 0;
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${makeDetail().id}`) return makeDetail();
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
      if (path === `/events/${makeDetail().id}`) return makeDetail();
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
      if (path === `/events/${makeDetail().id}`) return makeDetail();
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
      if (path === `/events/${event.id}`) return event;
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
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${makeDetail().id}`) return makeDetail();
      return path === "/quotes"
        ? { id: "019b0000-0000-7000-8500-000000000001", amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" }
        : pending;
    });
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
    const refreshedEvent = makeDetail({
      version: event.version + 1,
      confirmedCount: event.capacity,
      availableCapacity: 0,
      availableActions: ["joinWaitlist"],
    });
    let eventCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/quotes") {
        quoteCalls += 1;
        return { id: `019b0000-0000-7000-8500-00000000000${quoteCalls}`, amount: 40, currency: "POINTS", expiresAt: "2099-07-16T03:15:00.000Z" };
      }
      if (path === `/events/${event.id}`) {
        eventCalls += 1;
        return eventCalls === 1 ? event : refreshedEvent;
      }
      throw new APIError(409, { code: "REGISTRATION_CAPACITY_FULL", message: "full" });
    });
    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);
    const partySize = await screen.findByLabelText(/参加人数/);
    fireEvent.change(partySize, { target: { value: "3" } });
    const note = await screen.findByLabelText("想对主办方补充什么？");
    await user.type(note, "Window seat");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("活动信息刚刚更新");
    expect(screen.getByText("Window seat")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "返回修改" }));
    expect(screen.getByDisplayValue("Window seat")).toBeInTheDocument();
    expect(screen.getByLabelText(/参加人数/)).toHaveValue(3);
    expect(screen.queryByText("报名已确认")).not.toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/events/${event.id}`,
      { authenticated: true },
    );
    await waitFor(() => expect(quoteCalls).toBe(2));
  });

  test("returns to live required questions and revokes changed paid terms after a 409", async () => {
    const user = userEvent.setup();
    const questionId = "019b0000-0000-7000-8300-000000000009";
    const event = makeDetail({
      fee: {
        isFree: false,
        amountJPY: 1_000,
        collectorName: "Original host",
        method: "Cash",
        paymentDeadlineText: "At check-in",
        refundPolicy: "Refund until 24 hours before",
      },
    });
    const refreshedEvent = makeDetail({
      version: event.version + 1,
      fee: {
        ...event.fee!,
        collectorName: "New venue desk",
      },
      registrationQuestions: [{
        id: questionId,
        prompt: "Emergency contact",
        kind: "text",
        required: true,
        options: [],
      }],
    });
    let eventCalls = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${event.id}`) {
        eventCalls += 1;
        return eventCalls === 1 ? event : refreshedEvent;
      }
      if (path === "/quotes") {
        return { id: `quote-${eventCalls}`, amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      throw new APIError(409, { code: "EVENT_VERSION_CONFLICT", message: "changed" });
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);
    const terms = await screen.findByRole("checkbox", { name: /我已阅读线下费用与退款边界/ });
    await user.click(terms);
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    const requiredQuestion = await screen.findByLabelText(/Emergency contact/);
    expect(requiredQuestion).toHaveFocus();
    expect(requiredQuestion).toHaveAccessibleDescription("请填写此项。");
    expect(screen.getByRole("checkbox", { name: /我已阅读线下费用与退款边界/ })).not.toBeChecked();
    expect(screen.getByText(/New venue desk/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "核对并确认" })).not.toBeInTheDocument();
  });

  test("drops removed question answers before retrying a registration after 409", async () => {
    const user = userEvent.setup();
    const removedQuestionId = "019b0000-0000-7000-8300-000000000007";
    const event = makeDetail({
      registrationQuestions: [{
        id: removedQuestionId,
        prompt: "Question removed during submit",
        kind: "text",
        required: true,
        options: [],
      }],
    });
    const refreshedEvent = makeDetail({
      version: event.version + 1,
      registrationQuestions: [],
    });
    let eventCalls = 0;
    const submittedBodies: Array<Record<string, unknown>> = [];
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === `/events/${event.id}`) {
        eventCalls += 1;
        return eventCalls === 1 ? event : refreshedEvent;
      }
      if (path === "/quotes") {
        return { id: `quote-${eventCalls}`, amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      submittedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (submittedBodies.length === 1) {
        throw new APIError(409, { code: "EVENT_VERSION_CONFLICT", message: "changed" });
      }
      return { id: "registration", eventId: event.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={event} navigate={vi.fn()} />);
    await user.type(await screen.findByLabelText(/Question removed during submit/), "remove me");
    await user.click(screen.getByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));
    const reconfirm = await screen.findByRole("checkbox", { name: /我已核对更新后的名额、费用与活动信息/ });
    await user.click(reconfirm);
    await user.click(screen.getByRole("button", { name: "确认并报名" }));

    expect(await screen.findByText("报名已确认")).toBeInTheDocument();
    expect(submittedBodies).toHaveLength(2);
    expect(submittedBodies[0]).toMatchObject({
      expectedEventVersion: event.version,
      answers: { [removedQuestionId]: "remove me" },
    });
    expect(submittedBodies[1]).toMatchObject({
      expectedEventVersion: refreshedEvent.version,
      answers: {},
    });
  });
});

describe("registration party limits", () => {
  test.each([
    [makeDetail({ capacity: 24, availableCapacity: 13 }), 10],
    [makeDetail({ capacity: 24, availableCapacity: 2 }), 2],
    [makeDetail({ capacity: 24, availableCapacity: 0, availableActions: ["joinWaitlist"] }), 10],
    [makeDetail({ capacity: 6, availableCapacity: 0, availableActions: ["joinWaitlist"] }), 6],
  ])("keeps the API maximum and the live waitlist capacity for %#", (event, expected) => {
    expect(registrationPartyLimit(event)).toBe(expected);
  });
});

describe("complete registration confirmation", () => {
  test("shows committed success before contact refresh settles, then retries a real failure to success", async () => {
    const user = userEvent.setup();
    const publicDetail = makeDetail({ organizerContact: null });
    const confirmedDetail = makeDetail({
      organizerContact: { kind: "line", label: "活动 LINE", value: "spott_host" },
    });
    let rejectRefresh!: (error: Error) => void;
    const pendingRefresh = new Promise<never>((_resolve, reject) => {
      rejectRefresh = reject;
    });
    let detailReads = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${publicDetail.id}`) {
        detailReads += 1;
        if (detailReads === 1) return publicDetail;
        if (detailReads === 2) return pendingRefresh;
        return confirmedDetail;
      }
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return { id: "registration", eventId: publicDetail.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={publicDetail} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    expect(await screen.findByRole("heading", { name: "报名已确认" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "查看我的活动" })).toBeInTheDocument();

    rejectRefresh(new Error("contact offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法加载主办方联系方式");
    await user.click(screen.getByRole("button", { name: "重新加载联系方式" }));

    expect(await screen.findByRole("heading", { name: "联系主办方" })).toBeInTheDocument();
    const lineLink = screen.getByRole("link", { name: /通过 LINE 联系/ });
    expect(lineLink).toHaveAttribute(
      "href",
      "https://line.me/R/ti/p/~spott_host",
    );
    expect(lineLink).toHaveAttribute("target", "_blank");
    expect(lineLink).toHaveAttribute("rel", "noopener noreferrer");
    expect(detailReads).toBe(3);
  });

  test("ignores a stale contact refresh after the signed-in owner changes", async () => {
    const user = userEvent.setup();
    const publicDetail = makeDetail({ organizerContact: null });
    const oldOwnerDetail = makeDetail({
      organizerContact: { kind: "email", label: "Old owner only", value: "old-owner@example.jp" },
    });
    let resolveRefresh!: (event: typeof oldOwnerDetail) => void;
    const pendingRefresh = new Promise<typeof oldOwnerDetail>((resolve) => {
      resolveRefresh = resolve;
    });
    let detailReads = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${publicDetail.id}`) {
        detailReads += 1;
        if (detailReads === 1) return publicDetail;
        if (detailReads === 2) return pendingRefresh;
        return publicDetail;
      }
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return { id: "registration", eventId: publicDetail.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={publicDetail} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));
    expect(await screen.findByRole("heading", { name: "报名已确认" })).toBeInTheDocument();

    mocks.session = { accessToken: "next-owner", user: { id: "user-c", phoneVerified: true } };
    window.dispatchEvent(new CustomEvent("spott:session"));
    expect(await screen.findByRole("button", { name: "继续核对" })).toBeInTheDocument();

    resolveRefresh(oldOwnerDetail);
    await waitFor(() => expect(detailReads).toBeGreaterThanOrEqual(3));
    expect(screen.queryByText("Old owner only")).not.toBeInTheDocument();
    expect(screen.queryByText("old-owner@example.jp")).not.toBeInTheDocument();
  });

  test("rejects a wrong-event contact detail on both the initial refresh and retry", async () => {
    const user = userEvent.setup();
    const publicDetail = makeDetail({ organizerContact: null });
    const wrongEventDetail = makeDetail({
      id: "019b0000-0000-7000-8100-000000000099",
      publicSlug: "wrong-cached-event",
      organizerContact: {
        kind: "email",
        label: "Wrong event private desk",
        value: "wrong-event@example.jp",
      },
    });
    let detailReads = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${publicDetail.id}`) {
        detailReads += 1;
        return detailReads === 1 ? publicDetail : wrongEventDetail;
      }
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return { id: "registration", eventId: publicDetail.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={publicDetail} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    expect(await screen.findByRole("heading", { name: "报名已确认" })).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法加载主办方联系方式");
    expect(screen.queryByText("Wrong event private desk")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-event@example.jp")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "重新加载联系方式" }));
    await waitFor(() => expect(detailReads).toBe(3));
    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法加载主办方联系方式");
    expect(screen.queryByText("Wrong event private desk")).not.toBeInTheDocument();
    expect(screen.queryByText("wrong-event@example.jp")).not.toBeInTheDocument();
  });

  test("refetches the confirmed detail and renders the newly authorized contact", async () => {
    const user = userEvent.setup();
    const publicDetail = makeDetail({ organizerContact: null });
    const confirmedDetail = makeDetail({
      organizerContact: { kind: "email", label: "活动联络邮箱", value: "host@example.jp" },
    });
    let detailReads = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === `/events/${publicDetail.id}`) {
        detailReads += 1;
        return detailReads === 1 ? publicDetail : confirmedDetail;
      }
      if (path === "/quotes") {
        return { id: "quote", amount: 40, currency: "POINTS", expiresAt: "2099-01-01T00:00:00.000Z" };
      }
      return { id: "registration", eventId: publicDetail.id, status: "confirmed", partySize: 1 };
    });

    renderWithI18n(<RegistrationFlow event={publicDetail} navigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "继续核对" }));
    await user.click(await screen.findByRole("button", { name: "确认并报名" }));

    expect(await screen.findByRole("heading", { name: "联系主办方" })).toBeInTheDocument();
    const emailLink = screen.getByRole("link", { name: "发送邮件" });
    expect(emailLink).toHaveAttribute("href", "mailto:host@example.jp");
    expect(emailLink).not.toHaveAttribute("target");
    expect(detailReads).toBe(2);
  });

  test("offers an accessible retry when the confirmed-contact refresh fails", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    const event = makeDetail({ organizerContact: null });
    renderWithI18n(
      <RegistrationConfirmation
        event={event}
        registration={{ id: "registration", eventId: event.id, status: "confirmed", partySize: 1 }}
        contactRefreshFailed
        onRetryContact={retry}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("暂时无法加载主办方联系方式");
    await user.click(screen.getByRole("button", { name: "重新加载联系方式" }));
    expect(retry).toHaveBeenCalledOnce();
  });

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

  test("shows the protected host contact only after confirmation with a report escape hatch", () => {
    const event = makeDetail({
      organizerContact: { kind: "email", label: "活动联络邮箱", value: "host@example.jp" },
    });
    const confirmed = renderWithI18n(
      <RegistrationConfirmation
        event={event}
        registration={{ id: "registration", eventId: event.id, status: "confirmed", partySize: 1 }}
      />,
    );

    expect(screen.getByRole("heading", { name: "联系主办方" })).toBeInTheDocument();
    expect(screen.getByText("活动联络邮箱")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "发送邮件" })).toHaveAttribute("href", "mailto:host@example.jp");
    expect(screen.getByRole("link", { name: "举报问题" })).toHaveAttribute(
      "href",
      `/reports/new?targetType=event&targetId=${event.id}`,
    );

    confirmed.unmount();
    renderWithI18n(
      <RegistrationConfirmation
        event={event}
        registration={{ id: "registration", eventId: event.id, status: "pending", partySize: 1 }}
      />,
    );
    expect(screen.queryByRole("heading", { name: "联系主办方" })).not.toBeInTheDocument();
    expect(screen.queryByText("host@example.jp")).not.toBeInTheDocument();
  });

  test.each(["confirmed", "checked_in"])(
    "shows protected host contact for the authorized %s lifecycle state",
    (status) => {
      const event = makeDetail({
        organizerContact: { kind: "email", label: "Authorized desk", value: "host@example.jp" },
      });
      renderWithI18n(
        <RegistrationConfirmation
          event={event}
          registration={{ id: "registration", eventId: event.id, status, partySize: 1 }}
        />,
      );

      expect(screen.getByRole("heading", { name: "联系主办方" })).toBeInTheDocument();
      expect(screen.getByText("Authorized desk")).toBeInTheDocument();
    },
  );

  test("never shows contact when the registration belongs to a different event", () => {
    const event = makeDetail({
      organizerContact: {
        kind: "email",
        label: "Route-mismatched private desk",
        value: "route-mismatch@example.jp",
      },
    });

    renderWithI18n(
      <RegistrationConfirmation
        event={event}
        registration={{
          id: "registration",
          eventId: "019b0000-0000-7000-8100-000000000099",
          status: "confirmed",
          partySize: 1,
        }}
      />,
    );

    expect(screen.queryByText("Route-mismatched private desk")).not.toBeInTheDocument();
    expect(screen.queryByText("route-mismatch@example.jp")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "联系主办方" })).not.toBeInTheDocument();
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

async function storedDraft(expectedAttendeeNote = "Keep this note") {
  let draft: Record<string, unknown> | null = null;
  await waitFor(() => {
    const key = window.sessionStorage.key(0);
    expect(key).not.toBeNull();
    draft = JSON.parse(window.sessionStorage.getItem(key!)!) as Record<string, unknown>;
    expect(draft.attendeeNote).toBe(expectedAttendeeNote);
  });
  return draft!;
}

function restoreNavigatorProperty(name: "share" | "clipboard", descriptor: PropertyDescriptor | undefined) {
  if (descriptor) Object.defineProperty(navigator, name, descriptor);
  else delete (navigator as unknown as Record<string, unknown>)[name];
}
