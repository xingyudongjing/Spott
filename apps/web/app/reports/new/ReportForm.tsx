"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import { apiRequest, readSession, subscribeSessionChanges } from "../../lib/client-api";
import { isRFC3339DateTime } from "../../lib/rfc3339";
import { StableRequestAttempt } from "../../lib/stable-request-attempt";

const allowedTypes = ["event", "group", "user", "comment", "announcement"] as const;
const allowedReasons = ["fraud", "personal_safety", "harassment_or_hate", "minor_safety", "other"] as const;
const evidenceMimes = ["image/jpeg", "image/png", "image/webp", "image/heic"];
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ReportTargetType = (typeof allowedTypes)[number];

interface EvidenceSelection {
  id: string;
  file: File;
}

interface UploadIntent {
  assetId: string;
  uploadUrl: string;
  method: string;
  requiredHeaders: Record<string, string>;
}

interface ReportReceipt {
  reference: string;
  status: "open";
  submittedAt: string;
}

export function ReportForm({
  initialTargetType,
  initialTargetId,
}: {
  initialTargetType?: string;
  initialTargetId?: string;
}) {
  const { locale } = useI18n();
  const copy = reportCopy(locale);
  const targetType = isTargetType(initialTargetType) ? initialTargetType : null;
  const targetId = initialTargetId ?? "";
  const scope = `${targetType ?? "invalid"}\u0000${targetId}`;
  const scopeRef = useRef(scope);
  useLayoutEffect(() => {
    scopeRef.current = scope;
  }, [scope]);
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [files, setFiles] = useState<EvidenceSelection[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState("");
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const ownerRef = useRef(currentOwnerId());
  const uploadedRef = useRef(new Map<string, string>());
  const fileIdsRef = useRef(new WeakMap<File, string>());
  const attemptRef = useRef(new StableRequestAttempt());
  const successHeadingRef = useRef<HTMLHeadingElement>(null);

  const operationIsCurrent = useCallback((generation: number, ownerId: string, expectedScope: string) => (
    generationRef.current === generation
    && currentOwnerId() === ownerId
    && scopeRef.current === expectedScope
  ), []);

  const clearPrivateState = useCallback(() => {
    generationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setReason("");
    setDetails("");
    setFiles([]);
    setProgress("");
    setMessage("");
    setReference("");
    uploadedRef.current.clear();
    fileIdsRef.current = new WeakMap<File, string>();
    attemptRef.current.clear();
  }, []);

  useEffect(() => {
    if (!readSession()) {
      window.location.replace(
        `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
    }
    return subscribeSessionChanges(() => {
      const nextOwner = currentOwnerId();
      if (nextOwner === ownerRef.current) return;
      ownerRef.current = nextOwner;
      clearPrivateState();
    });
  }, [clearPrivateState]);

  const previousScopeRef = useRef(scope);
  useEffect(() => {
    if (previousScopeRef.current === scope) return;
    previousScopeRef.current = scope;
    clearPrivateState();
  }, [clearPrivateState, scope]);

  useEffect(() => () => {
    generationRef.current += 1;
    uploadedRef.current.clear();
    attemptRef.current.clear();
  }, []);

  useEffect(() => {
    if (reference) successHeadingRef.current?.focus();
  }, [reference]);

  function selectionId(file: File): string {
    const existing = fileIdsRef.current.get(file);
    if (existing) return existing;
    const id = crypto.randomUUID();
    fileIdsRef.current.set(file, id);
    return id;
  }

  function addEvidence(selected: FileList | null) {
    if (!selected || busyRef.current) return;
    const incoming = Array.from(selected);
    const invalid = incoming.find(
      (file) => !evidenceMimes.includes(file.type) || file.size > 20 * 1024 * 1024,
    );
    if (invalid) {
      setMessage(copy.invalidEvidence.replace("{name}", invalid.name));
      return;
    }
    setFiles((current) => {
      const known = new Set(current.map((item) => item.file));
      const additions = incoming
        .filter((file) => !known.has(file))
        .map((file) => ({ id: selectionId(file), file }));
      return [...current, ...additions].slice(0, 10);
    });
    setMessage("");
  }

  async function uploadEvidence(
    selectedFiles: EvidenceSelection[],
    generation: number,
    ownerId: string,
    expectedScope: string,
  ): Promise<string[]> {
    for (const [index, selection] of selectedFiles.entries()) {
      if (!operationIsCurrent(generation, ownerId, expectedScope)) throw new StaleReportOperation();
      if (uploadedRef.current.has(selection.id)) continue;
      const { file } = selection;
      setProgress(copy.uploading.replace("{current}", String(index + 1)).replace("{total}", String(selectedFiles.length)));
      const rawIntent = await apiRequest<unknown>("/media/upload-intents", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({
          purpose: "report_evidence",
          filename: file.name,
          mimeType: file.type,
          byteSize: file.size,
          focalX: 0.5,
          focalY: 0.5,
        }),
      });
      if (!operationIsCurrent(generation, ownerId, expectedScope)) throw new StaleReportOperation();
      const intent = parseUploadIntent(rawIntent);
      const response = await fetch(intent.uploadUrl, {
        method: intent.method,
        headers: intent.requiredHeaders,
        body: file,
      });
      if (!operationIsCurrent(generation, ownerId, expectedScope)) throw new StaleReportOperation();
      if (!response.ok) throw new SafeReportError(copy.uploadFailed.replace("{name}", file.name));
      const contentSha256 = await sha256(file);
      if (!operationIsCurrent(generation, ownerId, expectedScope)) throw new StaleReportOperation();
      await apiRequest(`/media/assets/${intent.assetId}/complete`, {
        method: "POST",
        authenticated: true,
        headers: { "X-Content-SHA256": contentSha256 },
      });
      if (!operationIsCurrent(generation, ownerId, expectedScope)) throw new StaleReportOperation();
      uploadedRef.current.set(selection.id, intent.assetId);
    }
    return selectedFiles.map((selection) => {
      const assetId = uploadedRef.current.get(selection.id);
      if (!assetId) throw new TypeError("Evidence upload did not complete.");
      return assetId;
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    if (!targetType || !uuidPattern.test(targetId)) {
      setMessage(copy.invalidTarget);
      return;
    }
    const normalizedDetails = details.trim();
    if (!allowedReasons.includes(reason as (typeof allowedReasons)[number]) || normalizedDetails.length < 3) return;
    const ownerId = currentOwnerId();
    if (!ownerId) return;
    const generation = ++generationRef.current;
    const expectedScope = scope;
    const selectedFiles = [...files];
    busyRef.current = true;
    setBusy(true);
    setMessage("");
    setProgress(selectedFiles.length ? copy.preparingEvidence : copy.submitting);
    try {
      const evidenceAssetIds = selectedFiles.length
        ? await uploadEvidence(selectedFiles, generation, ownerId, expectedScope)
        : [];
      if (!operationIsCurrent(generation, ownerId, expectedScope)) return;
      setProgress(copy.submitting);
      const body = { targetType, targetId, reason, details: normalizedDetails, evidenceAssetIds };
      const idempotencyKey = attemptRef.current.keyFor({ method: "POST", path: "/reports", body });
      const rawReceipt = await apiRequest<unknown>("/reports", {
        method: "POST",
        authenticated: true,
        idempotencyKey,
        body: JSON.stringify(body),
      });
      if (!operationIsCurrent(generation, ownerId, expectedScope)) return;
      const receipt = parseReportReceipt(rawReceipt);
      attemptRef.current.clear();
      uploadedRef.current.clear();
      fileIdsRef.current = new WeakMap<File, string>();
      setFiles([]);
      setReason("");
      setDetails("");
      setReference(receipt.reference);
    } catch (error) {
      if (!operationIsCurrent(generation, ownerId, expectedScope)) return;
      setMessage(error instanceof SafeReportError ? error.message : copy.submitError);
    } finally {
      if (operationIsCurrent(generation, ownerId, expectedScope)) {
        busyRef.current = false;
        setBusy(false);
        setProgress("");
      }
    }
  }

  if (reference) {
    return (
      <main className="flow-page">
        <div className="flow-shell narrow">
          <section className="flow-card success-card">
            <span className="success-mark">✓</span>
            <h1 ref={successHeadingRef} tabIndex={-1}>{copy.received}</h1>
            <p className="lead">{copy.receivedBody}</p>
            <div className="points-confirm">
              <span>{copy.reference}</span>
              <strong>{reference}</strong>
            </div>
            <Link className="primary-action" href="/safety">
              {copy.safetyCenter}
            </Link>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="flow-page">
      <div className="flow-shell narrow">
        <form className="flow-card report-form" onSubmit={(submitEvent) => void submit(submitEvent)}>
          <span className="section-number">{copy.eyebrow}</span>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
          <aside className="report-privacy-note">
            <span aria-hidden="true">◎</span>
            <p>{copy.privacy}</p>
          </aside>
          <label className="form-field">
            {copy.reason}
            <select required value={reason} onChange={(changeEvent) => setReason(changeEvent.target.value)} disabled={busy}>
              <option value="">—</option>
              <option value="fraud">{copy.fraud}</option>
              <option value="personal_safety">{copy.personalSafety}</option>
              <option value="harassment_or_hate">{copy.harassment}</option>
              <option value="minor_safety">{copy.minorSafety}</option>
              <option value="other">{copy.other}</option>
            </select>
          </label>
          <label className="form-field">
            {copy.details}
            <textarea
              required
              minLength={3}
              maxLength={5000}
              rows={7}
              value={details}
              onChange={(changeEvent) => setDetails(changeEvent.target.value)}
              placeholder={copy.detailsPlaceholder}
              disabled={busy}
            />
          </label>
          <div className="evidence-field">
            <div>
              <strong>{copy.evidence}</strong>
              <small>{copy.evidenceBody}</small>
            </div>
            <label className="evidence-picker">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic"
                multiple
                onChange={(changeEvent) => {
                  addEvidence(changeEvent.target.files);
                  changeEvent.target.value = "";
                }}
                disabled={busy || files.length >= 10}
              />
              <span>{copy.addEvidence}</span>
            </label>
            {files.length > 0 && (
              <div className="evidence-list">
                {files.map((selection) => (
                  <div key={selection.id}>
                    <span aria-hidden="true">▧</span>
                    <div>
                      <strong>{selection.file.name}</strong>
                      <small>{formatBytes(selection.file.size)}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFiles((current) => current.filter((item) => item.id !== selection.id))}
                      disabled={busy}
                      aria-label={copy.remove.replace("{name}", selection.file.name)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {message && <p className="form-message" role="alert">{message}</p>}
          {progress && <p className="report-progress" role="status"><i /> {progress}</p>}
          <button className="danger-action" disabled={busy}>
            {busy ? copy.working : copy.submit}
          </button>
        </form>
      </div>
    </main>
  );
}

class SafeReportError extends Error {}
class StaleReportOperation extends Error {}

function currentOwnerId(): string | null {
  return readSession()?.user?.id ?? null;
}

function isTargetType(value: string | undefined): value is ReportTargetType {
  return allowedTypes.includes(value as ReportTargetType);
}

function parseUploadIntent(value: unknown): UploadIntent {
  const record = objectRecord(value);
  if (
    !uuidPattern.test(String(record.assetId ?? ""))
    || typeof record.uploadUrl !== "string"
    || !isSafeUploadURL(record.uploadUrl)
    || (record.method !== "PUT" && record.method !== "POST")
    || !isStringRecord(record.requiredHeaders)
  ) throw new TypeError("Invalid upload intent.");
  return record as unknown as UploadIntent;
}

function parseReportReceipt(value: unknown): ReportReceipt {
  const record = objectRecord(value);
  if (
    typeof record.reference !== "string"
    || !/^SPT-[0-9]{4}-[A-F0-9]{12}$/.test(record.reference)
    || record.status !== "open"
    || !isRFC3339DateTime(record.submittedAt)
  ) throw new TypeError("Invalid report receipt.");
  return record as unknown as ReportReceipt;
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Expected an object.");
  return value as Record<string, unknown>;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === "string"));
}

function isSafeUploadURL(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function sha256(file: File): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(value / 1024))} KB`;
}

function reportCopy(locale: "zh-Hans" | "ja" | "en") {
  if (locale === "ja") {
    return {
      eyebrow: "安全サポート・非公開",
      reference: "受付番号",
      title: "報告と安全サポート",
      lead: "あなたの身元は対象者に表示されません。緊急時は警察・救急へ連絡してください。",
      privacy: "詳細と証拠は暗号化された制限領域で扱われ、案件担当者だけが確認します。",
      reason: "理由", fraud: "詐欺・虚偽", personalSafety: "身体の安全", harassment: "嫌がらせ・ヘイト", minorSafety: "未成年者の安全", other: "その他",
      details: "詳細", detailsPlaceholder: "いつ、どこで、何が起きたかを、覚えている範囲で記入してください。",
      evidence: "非公開の画像証拠（任意）", evidenceBody: "JPEG / PNG / WebP / HEIC、1枚20MBまで、最大10枚", addEvidence: "画像を追加", remove: "{name} を削除",
      invalidEvidence: "{name} は対応形式ではないか、20MBを超えています。", invalidTarget: "報告対象が正しくありません。元のページからもう一度お試しください。",
      preparingEvidence: "証拠を安全に準備しています…", uploading: "証拠をアップロード中 {current}/{total}", uploadFailed: "{name} をアップロードできませんでした。通信を確認して再試行してください。",
      submitting: "非公開レポートを送信しています…", working: "安全に送信中…", submit: "非公開レポートを送信", submitError: "報告を送信できませんでした。通信を確認して再試行してください。",
      received: "報告を受け付けました", receivedBody: "内容は非公開で確認され、対象者にあなたの身元は表示されません。", safetyCenter: "安全センターで進捗を確認",
    };
  }
  if (locale === "en") {
    return {
      eyebrow: "SAFETY · PRIVATE",
      reference: "REFERENCE",
      title: "Report & safety support",
      lead: "Your identity is not shown to the reported party. For immediate danger, contact local emergency services first.",
      privacy: "Details and evidence are stored in an encrypted restricted area visible only to assigned case reviewers.",
      reason: "Reason", fraud: "Fraud or false information", personalSafety: "Personal safety", harassment: "Harassment or hate", minorSafety: "Minor safety", other: "Other",
      details: "Details", detailsPlaceholder: "Describe what happened, when, and where, using only what you remember.",
      evidence: "Private image evidence (optional)", evidenceBody: "JPEG, PNG, WebP, or HEIC · up to 20 MB each · maximum 10", addEvidence: "Add images", remove: "Remove {name}",
      invalidEvidence: "{name} is unsupported or larger than 20 MB.", invalidTarget: "The report target is invalid. Start again from the original page.",
      preparingEvidence: "Preparing evidence securely…", uploading: "Uploading evidence {current}/{total}", uploadFailed: "Could not upload {name}. Check your connection and try again.",
      submitting: "Submitting private report…", working: "Submitting securely…", submit: "Submit private report", submitError: "Your report was not submitted. Check your connection and try again.",
      received: "Report received", receivedBody: "The report is reviewed privately. Your identity is not shown to the reported party.", safetyCenter: "Review progress in Safety Center",
    };
  }
  return {
    eyebrow: "安全举报 · 私密",
    reference: "举报编号",
    title: "举报与安全求助",
    lead: "你的身份不会向被举报方展示。遇到紧急人身危险，请先联系当地警察或急救服务。",
    privacy: "详细说明和证据会进入加密的受限区域，仅案件处理人员可查看。",
    reason: "举报原因", fraud: "诈骗或虚假信息", personalSafety: "人身安全", harassment: "骚扰或仇恨", minorSafety: "未成年人风险", other: "其他",
    details: "详细说明", detailsPlaceholder: "请根据记忆描述发生了什么、时间和地点。",
    evidence: "私密图片证据（选填）", evidenceBody: "支持 JPEG、PNG、WebP、HEIC；每张不超过 20 MB；最多 10 张", addEvidence: "添加图片", remove: "移除 {name}",
    invalidEvidence: "{name} 格式不支持或超过 20 MB。", invalidTarget: "举报对象无效，请从原页面重新进入。",
    preparingEvidence: "正在安全准备证据…", uploading: "正在上传证据 {current}/{total}", uploadFailed: "{name} 上传失败，请检查网络后重试。",
    submitting: "正在提交私密举报…", working: "正在安全提交…", submit: "提交私密举报", submitError: "举报暂时没有提交成功，请检查网络后重试。",
    received: "举报已提交", receivedBody: "内容会被私密处理，你的身份不会向被举报方展示。", safetyCenter: "在安全中心查看进度",
  };
}
