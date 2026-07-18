"use client";

import { APIError, apiRequest } from "./client-api";

export type ImagePurpose =
  | "event_cover"
  | "profile_avatar"
  | "group_cover"
  | "report_evidence";

export type MediaUploadStage =
  | "selected"
  | "hashed"
  | "intent-created"
  | "uploaded"
  | "completed"
  | "attached";

export interface MediaUploadAttempt {
  readonly selectionId: string;
  readonly ownerGeneration: string;
  readonly intentKey: string;
  readonly completionKey: string;
  readonly attachmentKey: string;
  readonly file: File;
  readonly purpose: ImagePurpose;
  contentSha256: string | null;
  assetId: string | null;
  stage: MediaUploadStage;
}

interface UploadCapability {
  attemptId: string;
  assetId: string;
  state: "pending_upload";
  uploadUrl: string;
  method: "PUT";
  requiredHeaders: Record<string, string>;
}

interface UploadState {
  attemptId: string;
  assetId: string;
  state: string;
  leaseState: string;
  receipt?: { assetId: string; state: string; leaseState: string; committedAt: string };
}

type IntentOrState = UploadCapability | UploadState;

const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const gatewayHeaderNames = new Set([
  "content-type",
  "content-length",
  "x-content-sha256",
  "x-spott-upload-capability",
]);

export class MediaUploadClientError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "MediaUploadClientError";
  }
}

export function createMediaUploadAttempt(
  file: File,
  purpose: ImagePurpose,
  ownerGeneration = "current-session",
): MediaUploadAttempt {
  return {
    selectionId: crypto.randomUUID(),
    ownerGeneration,
    intentKey: crypto.randomUUID(),
    completionKey: crypto.randomUUID(),
    attachmentKey: crypto.randomUUID(),
    file,
    purpose,
    contentSha256: null,
    assetId: null,
    stage: "selected",
  };
}

export async function uploadProcessedImage<T>(options: {
  file: File;
  purpose: ImagePurpose;
  attachPath: (assetId: string) => string;
  attachBody?: unknown;
  attempt?: MediaUploadAttempt;
  ownerGeneration?: string;
}): Promise<T> {
  const { file, purpose, attachPath, attachBody } = options;
  validateFile(file);
  const attempt = options.attempt
    ?? createMediaUploadAttempt(file, purpose, options.ownerGeneration);
  assertAttempt(attempt, file, purpose, options.ownerGeneration);

  // Capture once. The bytes sent to the gateway are the same immutable bytes that
  // were hashed; a mutable file handle is never re-read after the intent exists.
  const capturedBytes = new Uint8Array(await file.arrayBuffer());
  assertAttempt(attempt, file, purpose, options.ownerGeneration);
  const contentSha256 = await sha256Bytes(capturedBytes);
  assertAttempt(attempt, file, purpose, options.ownerGeneration);
  attempt.contentSha256 = contentSha256;
  attempt.stage = "hashed";

  let intent = await createOrRecoverIntent(attempt, file, contentSha256);
  attempt.assetId = intent.assetId;
  attempt.stage = "intent-created";

  if (!isCommitted(intent)) {
    intent = await uploadOrRecover(attempt, intent, capturedBytes, contentSha256);
  }
  attempt.stage = "uploaded";

  await apiRequest(`/media/assets/${attempt.assetId}/complete`, {
    method: "POST",
    authenticated: true,
    idempotencyKey: attempt.completionKey,
    headers: { "X-Content-SHA256": contentSha256 },
  });
  assertAttempt(attempt, file, purpose, options.ownerGeneration);
  attempt.stage = "completed";

  let lastError: unknown;
  for (let retry = 0; retry < 12; retry += 1) {
    try {
      const result = await apiRequest<T>(attachPath(attempt.assetId), {
        method: "POST",
        authenticated: true,
        idempotencyKey: attempt.attachmentKey,
        body: attachBody === undefined ? undefined : JSON.stringify(attachBody),
      });
      assertAttempt(attempt, file, purpose, options.ownerGeneration);
      attempt.stage = "attached";
      return result;
    } catch (error) {
      lastError = error;
      if (!(error instanceof APIError) || error.body.code !== "MEDIA_NOT_READY") throw error;
      if (retry < 11) await delay(750);
    }
  }
  throw lastError;
}

async function createOrRecoverIntent(
  attempt: MediaUploadAttempt,
  file: File,
  contentSha256: string,
): Promise<IntentOrState> {
  try {
    return await apiRequest<IntentOrState>("/media/upload-intents", {
      method: "POST",
      authenticated: true,
      idempotencyKey: attempt.intentKey,
      body: JSON.stringify({
        purpose: attempt.purpose,
        filename: file.name.normalize("NFC"),
        mimeType: file.type,
        byteSize: file.size,
        focalX: 0.5,
        focalY: 0.5,
        contentSha256,
      }),
    });
  } catch (intentError) {
    try {
      return await apiRequest<IntentOrState>(`/media/upload-attempts/${attempt.intentKey}`, {
        authenticated: true,
        cache: "no-store",
      });
    } catch {
      throw intentError;
    }
  }
}

async function uploadOrRecover(
  attempt: MediaUploadAttempt,
  initial: IntentOrState,
  capturedBytes: Uint8Array,
  contentSha256: string,
): Promise<UploadState> {
  let current = initial;
  for (let recovery = 0; recovery < 16; recovery += 1) {
    if (isCommitted(current)) return current as UploadState;
    if (isCapability(current)) {
      try {
        return await putCapturedBytes(current, capturedBytes, contentSha256);
      } catch (uploadError) {
        if (
          uploadError instanceof MediaUploadClientError
          && uploadError.code !== "MEDIA_GATEWAY_UPLOAD_FAILED"
        ) throw uploadError;
        current = await recoverAfterGatewayLoss(attempt, uploadError);
        continue;
      }
    }
    if (["receiving", "provider_writing", "in_progress"].includes(current.leaseState)) {
      await delay(500);
      current = await apiRequest<IntentOrState>(`/media/upload-attempts/${attempt.intentKey}`, {
        authenticated: true,
        cache: "no-store",
      });
      continue;
    }
    throw new MediaUploadClientError(
      "MEDIA_UPLOAD_NOT_RECOVERABLE",
      "图片上传未完成，请重新选择图片后重试。",
    );
  }
  throw new MediaUploadClientError(
    "MEDIA_UPLOAD_STILL_PROCESSING",
    "图片仍在安全处理中，请稍后重试。",
  );
}

async function recoverAfterGatewayLoss(
  attempt: MediaUploadAttempt,
  uploadError: unknown,
): Promise<IntentOrState> {
  try {
    return await apiRequest<IntentOrState>(`/media/upload-attempts/${attempt.intentKey}`, {
      authenticated: true,
      cache: "no-store",
    });
  } catch {
    throw uploadError;
  }
}

async function putCapturedBytes(
  intent: UploadCapability,
  capturedBytes: Uint8Array,
  contentSha256: string,
): Promise<UploadState> {
  if (intent.method !== "PUT") {
    throw new MediaUploadClientError("MEDIA_GATEWAY_METHOD_INVALID", "图片上传配置无效。");
  }
  const uploadURL = new URL(intent.uploadUrl, window.location.origin);
  if (uploadURL.origin !== window.location.origin) {
    throw new MediaUploadClientError(
      "MEDIA_GATEWAY_ORIGIN_INVALID",
      "图片上传地址未通过安全校验。",
    );
  }
  const headers = validatedGatewayHeaders(intent.requiredHeaders, capturedBytes.byteLength, contentSha256);
  const immutableBody = new Blob([capturedBytes.slice().buffer], {
    type: headers.get("Content-Type") ?? "application/octet-stream",
  });
  const response = await fetch(uploadURL, {
    method: "PUT",
    headers,
    body: immutableBody,
    credentials: "omit",
    cache: "no-store",
    redirect: "error",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    throw new MediaUploadClientError(
      "MEDIA_GATEWAY_UPLOAD_FAILED",
      "图片上传失败，请检查网络后重试。",
    );
  }
  return response.json() as Promise<UploadState>;
}

function validatedGatewayHeaders(
  source: Record<string, string>,
  byteSize: number,
  contentSha256: string,
): Headers {
  const headers = new Headers(source);
  for (const name of headers.keys()) {
    if (!gatewayHeaderNames.has(name.toLowerCase())) {
      throw new MediaUploadClientError("MEDIA_GATEWAY_HEADERS_INVALID", "图片上传配置无效。");
    }
  }
  if (
    headers.get("Content-Length") !== String(byteSize)
    || headers.get("X-Content-SHA256")?.toLowerCase() !== contentSha256
    || !allowedMimes.has(headers.get("Content-Type") ?? "")
    || !headers.get("X-Spott-Upload-Capability")
  ) {
    throw new MediaUploadClientError("MEDIA_GATEWAY_BINDING_INVALID", "图片上传配置已失效。");
  }
  headers.delete("Authorization");
  headers.delete("Cookie");
  return headers;
}

function isCapability(value: IntentOrState): value is UploadCapability {
  return "uploadUrl" in value && value.state === "pending_upload";
}

function isCommitted(value: IntentOrState): boolean {
  return !isCapability(value) && value.leaseState === "committed";
}

function validateFile(file: File): void {
  if (!allowedMimes.has(file.type)) {
    throw new MediaUploadClientError(
      "MEDIA_MIME_UNSUPPORTED",
      "请选择 JPEG、PNG、WebP 或 HEIC 图片。",
    );
  }
  if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
    throw new MediaUploadClientError("MEDIA_SIZE_INVALID", "图片大小必须在 20MB 以内。");
  }
}

function assertAttempt(
  attempt: MediaUploadAttempt,
  file: File,
  purpose: ImagePurpose,
  ownerGeneration?: string,
): void {
  if (
    attempt.file !== file
    || attempt.purpose !== purpose
    || (ownerGeneration !== undefined && attempt.ownerGeneration !== ownerGeneration)
  ) {
    throw new MediaUploadClientError(
      "MEDIA_SELECTION_CHANGED",
      "账号或所选图片已经变化，请重新开始上传。",
    );
  }
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const snapshot = bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", snapshot);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
