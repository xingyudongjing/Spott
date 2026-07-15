"use client";

import { APIError, apiRequest } from "./client-api";

export type ImagePurpose =
  | "event_cover"
  | "profile_avatar"
  | "group_cover"
  | "report_evidence";

interface UploadIntent {
  assetId: string;
  uploadUrl: string;
  method: string;
  requiredHeaders: Record<string, string>;
}

const allowedMimes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);

export async function uploadProcessedImage<T>(options: {
  file: File;
  purpose: ImagePurpose;
  attachPath: (assetId: string) => string;
  attachBody?: unknown;
}): Promise<T> {
  const { file, purpose, attachPath, attachBody } = options;
  if (!allowedMimes.has(file.type)) {
    throw new Error("请选择 JPEG、PNG、WebP 或 HEIC 图片。");
  }
  if (file.size <= 0 || file.size > 20 * 1024 * 1024) {
    throw new Error("图片大小必须在 20MB 以内。");
  }

  const intent = await apiRequest<UploadIntent>("/media/upload-intents", {
    method: "POST",
    authenticated: true,
    body: JSON.stringify({
      purpose,
      filename: file.name,
      mimeType: file.type,
      byteSize: file.size,
      focalX: 0.5,
      focalY: 0.5,
    }),
  });
  const uploaded = await fetch(intent.uploadUrl, {
    method: intent.method,
    headers: intent.requiredHeaders,
    body: file,
  });
  if (!uploaded.ok) throw new Error("图片上传失败，请检查网络后重试。");

  await apiRequest(`/media/${intent.assetId}/complete`, {
    method: "POST",
    authenticated: true,
    headers: { "X-Content-SHA256": await sha256(file) },
  });

  let lastError: unknown;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      return await apiRequest<T>(attachPath(intent.assetId), {
        method: "POST",
        authenticated: true,
        body: attachBody === undefined ? undefined : JSON.stringify(attachBody),
      });
    } catch (error) {
      lastError = error;
      if (!(error instanceof APIError) || error.body.code !== "MEDIA_NOT_READY") throw error;
      if (attempt < 11) await delay(750);
    }
  }
  throw lastError;
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
