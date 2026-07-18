import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  createMediaUploadAttempt,
  uploadProcessedImage,
} from "../app/lib/media-upload";
import { apiRequest } from "../app/lib/client-api";

vi.mock("../app/lib/client-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/lib/client-api")>();
  return { ...actual, apiRequest: vi.fn() };
});

const apiRequestMock = vi.mocked(apiRequest);
const uuids = [
  "019b0000-0000-7000-9000-000000000001",
  "019b0000-0000-7000-9000-000000000002",
  "019b0000-0000-7000-9000-000000000003",
  "019b0000-0000-7000-9000-000000000004",
];

describe("recoverable browser media upload", () => {
  beforeEach(() => {
    apiRequestMock.mockReset();
    let index = 0;
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => uuids[index++]!);
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL("https://internal.spott.test/create"),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("hashes captured bytes before intent and retains distinct caller-owned keys", async () => {
    const bytes = new TextEncoder().encode("exact immutable image bytes");
    const file = new File([bytes], "cover.jpg", { type: "image/jpeg" });
    const attempt = createMediaUploadAttempt(file, "event_cover", "owner-a");
    const gatewayFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      attemptId: attempt.intentKey,
      assetId: "019b0000-0000-7000-8100-000000000001",
      state: "committed",
      leaseState: "committed",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", gatewayFetch);

    apiRequestMock.mockImplementation(async (path, init) => {
      if (path === "/media/upload-intents") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body.contentSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(init?.idempotencyKey).toBe(attempt.intentKey);
        return {
          attemptId: attempt.intentKey,
          assetId: "019b0000-0000-7000-8100-000000000001",
          state: "pending_upload",
          uploadUrl: "/v1/media/upload-attempts/019b0000-0000-7000-9000-000000000001/content",
          method: "PUT",
          requiredHeaders: {
            "Content-Type": "image/jpeg",
            "Content-Length": String(bytes.byteLength),
            "X-Content-SHA256": body.contentSha256,
            "X-Spott-Upload-Capability": "opaque-capability",
          },
        };
      }
      if (path === "/media/assets/019b0000-0000-7000-8100-000000000001/complete") {
        expect(init?.idempotencyKey).toBe(attempt.completionKey);
        expect(new Headers(init?.headers).get("X-Content-SHA256")).toMatch(/^[a-f0-9]{64}$/);
        return { assetId: "019b0000-0000-7000-8100-000000000001", state: "uploaded" };
      }
      if (path.includes("/attach/event/")) {
        expect(init?.idempotencyKey).toBe(attempt.attachmentKey);
        return { ok: true };
      }
      throw new Error(`Unexpected API request: ${path}`);
    });

    await expect(uploadProcessedImage({
      file,
      purpose: "event_cover",
      attempt,
      attachPath: (assetId) => `/media/${assetId}/attach/event/event-a`,
      attachBody: { kind: "cover", sortOrder: 0 },
    })).resolves.toEqual({ ok: true });

    expect(new Set([attempt.intentKey, attempt.completionKey, attempt.attachmentKey]).size).toBe(3);
    expect(apiRequestMock.mock.calls.some(([path]) =>
      path === "/media/019b0000-0000-7000-8100-000000000001/complete",
    )).toBe(false);
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    const [url, init] = gatewayFetch.mock.calls[0]!;
    expect(String(url)).toBe("https://internal.spott.test/v1/media/upload-attempts/019b0000-0000-7000-9000-000000000001/content");
    expect(init).toMatchObject({
      method: "PUT",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    expect(new Headers(init?.headers).has("Authorization")).toBe(false);
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    expect(Array.from(new Uint8Array(await (init?.body as Blob).arrayBuffer())))
      .toEqual(Array.from(bytes));
  });

  test("rejects a gateway URL that escapes the current Web origin before sending bytes", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    const attempt = createMediaUploadAttempt(file, "event_cover", "owner-a");
    const gatewayFetch = vi.fn();
    vi.stubGlobal("fetch", gatewayFetch);
    apiRequestMock.mockImplementation(async () => ({
      attemptId: attempt.intentKey,
      assetId: "019b0000-0000-7000-8100-000000000001",
      state: "pending_upload",
      uploadUrl: "https://provider.invalid/private/object",
      method: "PUT",
      requiredHeaders: {
        "Content-Type": "image/png",
        "Content-Length": "3",
        "X-Content-SHA256": "ab".repeat(32),
        "X-Spott-Upload-Capability": "opaque-capability",
      },
    }));

    await expect(uploadProcessedImage({
      file,
      purpose: "event_cover",
      attempt,
      attachPath: () => "/unused",
    })).rejects.toMatchObject({ code: "MEDIA_GATEWAY_ORIGIN_INVALID" });
    expect(gatewayFetch).not.toHaveBeenCalled();
  });
});
