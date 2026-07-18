import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { ReportForm } from "../app/reports/new/ReportForm";
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
const targetId = "019b0000-0000-7000-8100-000000000001";
const assetA = "019b0000-0000-7000-8500-000000000001";
const assetB = "019b0000-0000-7000-8500-000000000002";

function reportReceipt(overrides: Record<string, unknown> = {}) {
  return {
    reference: "SPT-2026-ABCDEF123456",
    status: "open",
    submittedAt: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

function uploadIntent(assetId: string) {
  return { assetId, uploadUrl: `https://upload.test/${assetId}`, method: "PUT", requiredHeaders: {} };
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

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByLabelText("Reason"), "fraud");
  await user.type(screen.getByLabelText("Details"), "The listing requested an unexpected transfer.");
}

function reportPosts() {
  return apiRequestMock.mock.calls.filter(([path]) => path === "/reports");
}

beforeEach(() => {
  apiRequestMock.mockReset();
  session.userId = "viewer-a";
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
});

describe("ReportForm reliable safety submission", () => {
  test("reuses a stable key after response loss and localizes server failures", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new APIError(503, { code: "INTERNAL", message: "safety.report row lock leaked" }))
      .mockResolvedValueOnce(reportReceipt());
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);

    await user.click(screen.getByRole("button", { name: "Submit private report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your report was not submitted. Check your connection and try again.",
    );
    expect(screen.queryByText(/row lock leaked/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await waitFor(() => expect(screen.getByText("Report received")).toBeInTheDocument());

    const posts = reportPosts();
    expect(posts).toHaveLength(2);
    const firstKey = posts[0]![1]?.idempotencyKey;
    expect(firstKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(posts[1]![1]?.idempotencyKey).toBe(firstKey);
  });

  test("rotates the report key when a normalized field or target scope changes", async () => {
    apiRequestMock
      .mockRejectedValueOnce(new APIError(503, { message: "lost" }))
      .mockResolvedValueOnce(reportReceipt());
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);

    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByRole("alert");
    await user.type(screen.getByLabelText("Details"), " More context.");
    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByText("Report received");

    const posts = reportPosts();
    expect(posts[1]![1]?.idempotencyKey).not.toBe(posts[0]![1]?.idempotencyKey);
  });

  test("clears private input and rotates the attempt when the report target scope changes", async () => {
    const secondTargetId = "019b0000-0000-7000-8100-000000000002";
    apiRequestMock
      .mockRejectedValueOnce(new APIError(503, { message: "lost" }))
      .mockResolvedValueOnce(reportReceipt());
    const user = userEvent.setup();
    const view = renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByRole("alert");

    view.rerender(<ReportForm initialTargetType="group" initialTargetId={secondTargetId} />);
    await waitFor(() => expect(screen.getByLabelText("Details")).toHaveValue(""));
    await fillRequired(user);
    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByText("Report received");

    const posts = reportPosts();
    expect(posts).toHaveLength(2);
    expect(posts[1]![1]?.idempotencyKey).not.toBe(posts[0]![1]?.idempotencyKey);
    expect(JSON.parse(String(posts[1]![1]?.body))).toMatchObject({ targetType: "group", targetId: secondTargetId });
  });

  test("reuses known uploaded assets in current visible order after report response loss", async () => {
    let intentIndex = 0;
    let reportIndex = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/media/upload-intents") return uploadIntent([assetB, assetA][intentIndex++]!);
      if (path === `/media/assets/${assetA}/complete` || path === `/media/assets/${assetB}/complete`) {
        return undefined;
      }
      if (path === "/reports") {
        reportIndex += 1;
        if (reportIndex === 1) throw new APIError(503, { message: "report transaction diagnostic" });
        return reportReceipt();
      }
      throw new Error(`unexpected ${path}`);
    });
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    const second = new File(["second"], "second.png", { type: "image/png", lastModified: 2 });
    const first = new File(["first"], "first.png", { type: "image/png", lastModified: 1 });
    await user.upload(screen.getByLabelText("Add images"), [second, first]);

    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByRole("alert");
    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByText("Report received");

    expect(apiRequestMock.mock.calls.filter(([path]) => path === "/media/upload-intents")).toHaveLength(2);
    expect(apiRequestMock.mock.calls
      .map(([path]) => path)
      .filter((path) => path.endsWith("/complete")))
      .toEqual([`/media/assets/${assetB}/complete`, `/media/assets/${assetA}/complete`]);
    expect(apiRequestMock.mock.calls.some(([path]) =>
      path === `/media/${assetA}/complete` || path === `/media/${assetB}/complete`,
    )).toBe(false);
    const posts = reportPosts();
    expect(JSON.parse(String(posts[0]![1]?.body)).evidenceAssetIds).toEqual([assetB, assetA]);
    expect(JSON.parse(String(posts[1]![1]?.body)).evidenceAssetIds).toEqual([assetB, assetA]);
    expect(posts[1]![1]?.idempotencyKey).toBe(posts[0]![1]?.idempotencyKey);
  });

  test("does not repeat an earlier completed upload when a later upload fails", async () => {
    const attempts = new Map<string, number>();
    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === "/media/upload-intents") {
        const filename = JSON.parse(String(init?.body)).filename as string;
        const count = (attempts.get(filename) ?? 0) + 1;
        attempts.set(filename, count);
        if (filename === "later.png" && count === 1) throw new APIError(503, { message: "storage host leaked" });
        return uploadIntent(filename === "first.png" ? assetA : assetB);
      }
      if (path.includes("/complete")) return undefined;
      if (path === "/reports") return reportReceipt();
      throw new Error(`unexpected ${path}`);
    });
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    await user.upload(screen.getByLabelText("Add images"), [
      new File(["first"], "first.png", { type: "image/png" }),
      new File(["later"], "later.png", { type: "image/png" }),
    ]);

    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    expect(await screen.findByRole("alert")).not.toHaveTextContent(/storage host/);
    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByText("Report received");

    expect(attempts.get("first.png")).toBe(1);
    expect(attempts.get("later.png")).toBe(2);
  });

  test("accepts the API's loopback HTTP upload origin for local development", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/media/upload-intents") {
        return { ...uploadIntent(assetA), uploadUrl: `http://127.0.0.1:9100/spott-media/${assetA}` };
      }
      if (path.includes("/complete")) return undefined;
      if (path === "/reports") return reportReceipt();
      throw new Error(`unexpected ${path}`);
    });
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    await user.upload(screen.getByLabelText("Add images"), new File(["local"], "local.png", { type: "image/png" }));

    await user.click(screen.getByRole("button", { name: "Submit private report" }));

    expect(await screen.findByText("Report received")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^http:\/\/127\.0\.0\.1:9100\//),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  test("never aliases distinct files with identical name, size, and lastModified", async () => {
    let intentIndex = 0;
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/media/upload-intents") return uploadIntent([assetA, assetB][intentIndex++]!);
      if (path.includes("/complete")) return undefined;
      if (path === "/reports") return reportReceipt();
      throw new Error(`unexpected ${path}`);
    });
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    const first = new File(["aa"], "same.png", { type: "image/png", lastModified: 100 });
    const second = new File(["bb"], "same.png", { type: "image/png", lastModified: 100 });
    await user.upload(screen.getByLabelText("Add images"), [first, second]);

    expect(screen.getAllByText("same.png")).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "Submit private report" }));
    await screen.findByText("Report received");

    expect(apiRequestMock.mock.calls.filter(([path]) => path === "/media/upload-intents")).toHaveLength(2);
  });

  test("synchronously prevents duplicate report submission", async () => {
    const pending = deferred<ReturnType<typeof reportReceipt>>();
    apiRequestMock.mockImplementation(() => pending.promise);
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    const form = screen.getByRole("button", { name: "Submit private report" }).closest("form")!;

    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => expect(reportPosts()).toHaveLength(1));
    pending.resolve(reportReceipt());
    await screen.findByText("Report received");
  });

  test("owner change clears private fields and ignores a stale successful completion", async () => {
    const pending = deferred<ReturnType<typeof reportReceipt>>();
    apiRequestMock.mockImplementation(() => pending.promise);
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);
    await user.upload(
      screen.getByLabelText("Add images"),
      new File(["private"], "private.png", { type: "image/png" }),
    );
    fireEvent.submit(screen.getByRole("button", { name: "Submit private report" }).closest("form")!);

    session.userId = "viewer-b";
    window.dispatchEvent(new CustomEvent("spott:session"));
    pending.resolve(reportReceipt());

    await waitFor(() => expect(screen.getByLabelText("Details")).toHaveValue(""));
    expect(screen.queryByText("private.png")).not.toBeInTheDocument();
    expect(screen.queryByText("Report received")).not.toBeInTheDocument();
  });

  test("never completes an old owner's evidence after the owner changes during hashing", async () => {
    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/media/upload-intents") return uploadIntent(assetA);
      if (path.includes("/complete")) return undefined;
      if (path === "/reports") return reportReceipt();
      throw new Error(`unexpected ${path}`);
    });
    const digest = deferred<ArrayBuffer>();
    const digestSpy = vi.spyOn(crypto.subtle, "digest").mockImplementation(() => digest.promise);
    const user = userEvent.setup();

    try {
      renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
      await fillRequired(user);
      await user.upload(
        screen.getByLabelText("Add images"),
        new File(["private"], "private.png", { type: "image/png" }),
      );
      fireEvent.submit(screen.getByRole("button", { name: "Submit private report" }).closest("form")!);
      await waitFor(() => expect(digestSpy).toHaveBeenCalledOnce());

      session.userId = "viewer-b";
      window.dispatchEvent(new CustomEvent("spott:session"));
      digest.resolve(new Uint8Array(32).buffer);
      await digest.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(apiRequestMock.mock.calls.filter(([path]) => path.includes("/complete"))).toHaveLength(0);
      expect(reportPosts()).toHaveLength(0);
      await waitFor(() => expect(screen.getByLabelText("Details")).toHaveValue(""));
      expect(screen.queryByText("private.png")).not.toBeInTheDocument();
    } finally {
      digestSpy.mockRestore();
    }
  });

  test("invalid supplied report type fails closed instead of silently retargeting to an event", async () => {
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="not-a-target" initialTargetId={targetId} />, "en");
    await fillRequired(user);

    await user.click(screen.getByRole("button", { name: "Submit private report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The report target is invalid. Start again from the original page.",
    );
    expect(apiRequestMock).not.toHaveBeenCalled();
  });

  test.each([
    ["zh-Hans", "举报原因", "详细说明", "提交私密举报", "举报暂时没有提交成功，请检查网络后重试。"],
    ["ja", "理由", "詳細", "非公開レポートを送信", "報告を送信できませんでした。通信を確認して再試行してください。"],
    ["en", "Reason", "Details", "Submit private report", "Your report was not submitted. Check your connection and try again."],
  ] as const)("keeps untrusted submission diagnostics safe in %s", async (locale, reasonLabel, detailsLabel, submitLabel, safeMessage) => {
    apiRequestMock.mockRejectedValue(new APIError(500, { message: "private moderation database diagnostic" }));
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, locale);
    await user.selectOptions(screen.getByLabelText(reasonLabel), "fraud");
    await user.type(screen.getByLabelText(detailsLabel), "Enough details for a private safety report.");

    await user.click(screen.getByRole("button", { name: submitLabel }));

    expect(await screen.findByRole("alert")).toHaveTextContent(safeMessage);
    expect(screen.queryByText(/database diagnostic/)).not.toBeInTheDocument();
  });

  test.each([
    ["zh-Hans", "举报原因", "详细说明", "添加图片", "提交私密举报", "举报暂时没有提交成功，请检查网络后重试。"],
    ["ja", "理由", "詳細", "画像を追加", "非公開レポートを送信", "報告を送信できませんでした。通信を確認して再試行してください。"],
    ["en", "Reason", "Details", "Add images", "Submit private report", "Your report was not submitted. Check your connection and try again."],
  ] as const)("keeps upload-intent diagnostics safe in %s", async (locale, reasonLabel, detailsLabel, addLabel, submitLabel, safeMessage) => {
    apiRequestMock.mockRejectedValue(new APIError(500, { message: "private object storage diagnostic" }));
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, locale);
    await user.selectOptions(screen.getByLabelText(reasonLabel), "fraud");
    await user.type(screen.getByLabelText(detailsLabel), "Enough details for a private safety report.");
    await user.upload(screen.getByLabelText(addLabel), new File(["safe"], "safe.png", { type: "image/png" }));

    await user.click(screen.getByRole("button", { name: submitLabel }));

    expect(await screen.findByRole("alert")).toHaveTextContent(safeMessage);
    expect(screen.queryByText(/object storage diagnostic/)).not.toBeInTheDocument();
  });

  test("non-RFC3339 report receipt timestamps never produce false success", async () => {
    apiRequestMock.mockResolvedValue(reportReceipt({ submittedAt: "0" }));
    const user = userEvent.setup();
    renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "en");
    await fillRequired(user);

    await user.click(screen.getByRole("button", { name: "Submit private report" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your report was not submitted. Check your connection and try again.",
    );
    expect(screen.queryByText("Report received")).not.toBeInTheDocument();
  });

  test("validates the receipt, focuses success, clears evidence, and localizes fixed labels", async () => {
    apiRequestMock.mockResolvedValueOnce({ reference: "internal-row-1", status: "open" });
    const user = userEvent.setup();
    const view = renderWithI18n(<ReportForm initialTargetType="event" initialTargetId={targetId} />, "zh-Hans");
    await user.selectOptions(screen.getByLabelText("举报原因"), "fraud");
    await user.type(screen.getByLabelText("详细说明"), "这是一段足够长的私密举报说明。");
    await user.click(screen.getByRole("button", { name: "提交私密举报" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("举报暂时没有提交成功，请检查网络后重试。");
    expect(screen.queryByText("举报已提交")).not.toBeInTheDocument();

    apiRequestMock.mockImplementation(async (path) => {
      if (path === "/media/upload-intents") return uploadIntent(assetA);
      if (path.includes("/complete")) return undefined;
      if (path === "/reports") return reportReceipt();
      throw new Error(`unexpected ${path}`);
    });
    await user.upload(screen.getByLabelText("添加图片"), new File(["private"], "private.png", { type: "image/png" }));
    await user.click(screen.getByRole("button", { name: "提交私密举报" }));
    const heading = await screen.findByRole("heading", { name: "举报已提交" });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByText("private.png")).not.toBeInTheDocument();
    expect(screen.getByText("举报编号")).toBeInTheDocument();
    expect(screen.queryByText("REFERENCE")).not.toBeInTheDocument();
    expect(screen.queryByText("SAFETY / PRIVATE")).not.toBeInTheDocument();

    view.unmount();
  });
});
