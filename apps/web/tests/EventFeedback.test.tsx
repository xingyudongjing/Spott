import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { EventFeedback } from "../app/me/events/EventFeedback";
import { APIError, apiRequest } from "../app/lib/client-api";
import { renderWithI18n } from "./event-fixtures";

const session = vi.hoisted(() => ({ userId: "viewer-a" as string | null }));

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return {
    ...actual,
    apiRequest: vi.fn(),
    readSession: () => session.userId ? { user: { id: session.userId } } : null,
  };
});

const apiRequestMock = vi.mocked(apiRequest);
const registrationId = "019b0000-0000-7000-8200-000000000003";
const otherRegistrationId = "019b0000-0000-7000-8200-000000000004";

function state(overrides: Record<string, unknown> = {}) {
  return {
    registrationId,
    eventId: "019b0000-0000-7000-8100-000000000001",
    state: "edit_available",
    canSubmit: true,
    canEdit: true,
    windowClosesAt: "2026-08-14T00:00:00.000Z",
    feedback: {
      id: "019b0000-0000-7000-8300-000000000001",
      attendanceRating: 3,
      tags: ["friendly", "safe"],
      comment: "集合说明可以再清楚一些",
      visibility: "private",
      moderationState: "pending",
      editCount: 0,
      createdAt: "2026-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    },
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: "019b0000-0000-7000-8300-000000000001",
    eventId: "019b0000-0000-7000-8100-000000000001",
    status: "pending_moderation",
    editCount: 0,
    rewardPoints: 20,
    createdAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  apiRequestMock.mockReset();
  session.userId = "viewer-a";
});

describe("EventFeedback reliable current-user flow", () => {
  test("loads the exact authenticated private state, prefills it, and exposes one real edit", async () => {
    apiRequestMock.mockResolvedValue(state());
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="zh-Hans" />);

    const trigger = screen.getByRole("button", { name: "活动后反馈" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-controls");
    await user.click(trigger);

    expect(await screen.findByText("反馈已收到")).toBeInTheDocument();
    expect(apiRequestMock).toHaveBeenCalledWith(
      `/registrations/${registrationId}/feedback`,
      expect.objectContaining({ authenticated: true, method: "GET" }),
    );
    await user.click(screen.getByRole("button", { name: "修改反馈（仅此一次）" }));
    expect(screen.getByRole("radio", { name: "3" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "氛围友好" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "让人安心" })).toBeChecked();
    expect(screen.getByRole("textbox")).toHaveValue("集合说明可以再清楚一些");
    expect(screen.getByRole("combobox")).toHaveValue("private");
  });

  test("fails closed on a load error or contradictory response and offers localized retry", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new APIError(500, { message: "feedback.owner email leaked" }))
      .mockResolvedValueOnce(state({ registrationId: otherRegistrationId }));
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load your feedback. Try again.");
    expect(screen.queryByText(/owner email/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("We couldn't load your feedback. Try again.");
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
  });

  test("unknown or contradictory eligibility never enables submit or edit", async () => {
    apiRequestMock.mockResolvedValue(
      state({ state: "not_submitted", feedback: null, canSubmit: false, canEdit: true }),
    );
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await userEvent.click(screen.getByRole("button", { name: "Post-event feedback" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Feedback is not available right now.");
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  test("reuses one stable UUID after a lost response and never reveals a raw server diagnostic", async () => {
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockRejectedValueOnce(new APIError(503, { code: "INTERNAL", message: "postgres host 10.0.0.8" }))
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(state());
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="zh-Hans" />);

    await user.click(screen.getByRole("button", { name: "活动后反馈" }));
    await user.click(await screen.findByRole("button", { name: "提交反馈" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("反馈暂时没有提交成功，请检查网络后重试。");
    expect(screen.queryByText(/postgres host/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "提交反馈" }));
    await waitFor(() => expect(screen.getByText("反馈已收到")).toBeInTheDocument());

    const posts = apiRequestMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    const firstKey = posts[0]![1]?.idempotencyKey;
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(posts[1]![1]?.idempotencyKey).toBe(firstKey);
  });

  test("rotates the feedback key when a normalized transmitted field changes", async () => {
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockRejectedValueOnce(new APIError(503, { message: "lost" }))
      .mockResolvedValueOnce(receipt())
      .mockResolvedValueOnce(state());
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    await user.click(await screen.findByRole("button", { name: "Send feedback" }));
    await screen.findByRole("alert");
    await user.type(screen.getByRole("textbox"), " A clearer meeting point. ");
    await user.click(screen.getByRole("button", { name: "Send feedback" }));
    await screen.findByText("Feedback received");

    const posts = apiRequestMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts[1]![1]?.idempotencyKey).not.toBe(posts[0]![1]?.idempotencyKey);
  });

  test("invalidates old eligibility after POST success until an authoritative refresh succeeds", async () => {
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockResolvedValueOnce(receipt())
      .mockRejectedValueOnce(new APIError(503, { message: "replica unavailable" }))
      .mockResolvedValueOnce(state());
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    await user.click(await screen.findByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Feedback was saved, but we couldn't confirm its latest state. Try again.",
    );
    expect(screen.queryByRole("button", { name: "Send feedback" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Feedback received")).toBeInTheDocument();
  });

  test("synchronously blocks duplicate submit and collapse while a request is active", async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(state());
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    const submit = await screen.findByRole("button", { name: "Send feedback" });
    const form = submit.closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(screen.getByRole("button", { name: "Close feedback" })).toBeDisabled());
    expect(apiRequestMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    pending.resolve(receipt());
    await screen.findByText("Feedback received");
  });

  test("ignores a stale load after the registration changes", async () => {
    const oldLoad = deferred<ReturnType<typeof state>>();
    apiRequestMock
      .mockImplementationOnce(() => oldLoad.promise)
      .mockResolvedValueOnce(state({
        registrationId: otherRegistrationId,
        state: "not_submitted",
        feedback: null,
        canEdit: false,
      }));
    const view = renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await userEvent.click(screen.getByRole("button", { name: "Post-event feedback" }));
    view.rerender(<EventFeedback registrationId={otherRegistrationId} locale="en" />);
    await userEvent.click(screen.getByRole("button", { name: "Post-event feedback" }));
    expect(await screen.findByRole("button", { name: "Send feedback" })).toBeInTheDocument();
    oldLoad.resolve(state());

    await waitFor(() => expect(screen.getByRole("button", { name: "Send feedback" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });

  test("clears a private draft and ignores stale POST completion after the owner changes", async () => {
    const pending = deferred<ReturnType<typeof receipt>>();
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    await user.type(await screen.findByRole("textbox"), "Sensitive draft for the first account.");
    fireEvent.submit(screen.getByRole("button", { name: "Send feedback" }).closest("form")!);
    session.userId = "viewer-b";
    window.dispatchEvent(new CustomEvent("spott:session"));
    pending.resolve(receipt());

    await waitFor(() => expect(screen.getByRole("button", { name: "Post-event feedback" })).toHaveAttribute("aria-expanded", "false"));
    expect(screen.queryByText("Feedback received")).not.toBeInTheDocument();

    apiRequestMock.mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }));
    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    expect(await screen.findByRole("textbox")).toHaveValue("");
  });

  test("restores focus to the trigger after collapsing the loaded panel", async () => {
    apiRequestMock.mockResolvedValue(state());
    const user = userEvent.setup();
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await user.click(screen.getByRole("button", { name: "Post-event feedback" }));
    await screen.findByText("Feedback received");
    const close = screen.getByRole("button", { name: "Close feedback" });
    await user.click(close);

    await waitFor(() => expect(screen.getByRole("button", { name: "Post-event feedback" })).toHaveFocus());
  });

  test.each([
    ["zh-Hans", "暂时无法读取你的反馈，请重试。"],
    ["ja", "フィードバックを読み込めませんでした。もう一度お試しください。"],
    ["en", "We couldn't load your feedback. Try again."],
  ] as const)("keeps untrusted load diagnostics safe in %s", async (locale, safeMessage) => {
    apiRequestMock.mockRejectedValue(new APIError(500, { message: "secret diagnostic 192.0.2.1" }));
    renderWithI18n(<EventFeedback registrationId={registrationId} locale={locale} />, locale);

    await userEvent.click(screen.getByRole("button", { name: locale === "en" ? "Post-event feedback" : locale === "ja" ? "参加後のフィードバック" : "活动后反馈" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(safeMessage);
    expect(screen.queryByText(/secret diagnostic/)).not.toBeInTheDocument();
  });

  test("malformed POST receipts never produce false success", async () => {
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockResolvedValueOnce({ status: "pending_moderation", rewardPoints: 20 });
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await userEvent.click(screen.getByRole("button", { name: "Post-event feedback" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your feedback was not submitted. Check your connection and try again.");
    expect(screen.queryByText("Feedback received")).not.toBeInTheDocument();
  });

  test("non-RFC3339 feedback receipt timestamps never produce false success", async () => {
    apiRequestMock
      .mockResolvedValueOnce(state({ state: "not_submitted", feedback: null, canEdit: false }))
      .mockResolvedValueOnce(receipt({ createdAt: "0" }));
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await userEvent.click(screen.getByRole("button", { name: "Post-event feedback" }));
    await userEvent.click(await screen.findByRole("button", { name: "Send feedback" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Your feedback was not submitted. Check your connection and try again.");
    expect(screen.queryByText("Feedback received")).not.toBeInTheDocument();
  });

  test("does not offer another edit after the authoritative edit limit is reached", async () => {
    apiRequestMock.mockResolvedValue(state({
      state: "edit_limit_reached",
      canSubmit: false,
      canEdit: false,
      feedback: { ...state().feedback, editCount: 1 },
    }));
    renderWithI18n(<EventFeedback registrationId={registrationId} locale="en" />);

    await userEvent.click(screen.getByRole("button", { name: "Post-event feedback" }));
    const status = await screen.findByRole("status");
    expect(within(status).getByText("Feedback received")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /edit/i })).not.toBeInTheDocument();
  });
});
