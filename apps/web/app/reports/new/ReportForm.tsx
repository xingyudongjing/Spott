"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import { apiRequest, errorMessage, readSession } from "../../lib/client-api";

const allowedTypes = ["event", "group", "user", "comment", "announcement"] as const;
const evidenceMimes = ["image/jpeg", "image/png", "image/webp", "image/heic"];

interface UploadedEvidence {
  key: string;
  assetId: string;
}

interface UploadIntent {
  assetId: string;
  uploadUrl: string;
  method: string;
  requiredHeaders: Record<string, string>;
}

export function ReportForm({
  initialTargetType,
  initialTargetId,
}: {
  initialTargetType?: string;
  initialTargetId?: string;
}) {
  const { locale } = useI18n();
  const targetType = allowedTypes.includes(initialTargetType as (typeof allowedTypes)[number])
    ? initialTargetType!
    : "event";
  const targetId = initialTargetId ?? "";
  const [reason, setReason] = useState("");
  const [details, setDetails] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [uploadedEvidence, setUploadedEvidence] = useState<UploadedEvidence[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");
  const [reference, setReference] = useState("");
  const copy = reportCopy(locale);

  useEffect(() => {
    if (!readSession())
      window.location.replace(
        `/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`,
      );
  }, []);

  function addEvidence(selected: FileList | null) {
    if (!selected) return;
    const incoming = Array.from(selected);
    const invalid = incoming.find(
      (file) => !evidenceMimes.includes(file.type) || file.size > 20 * 1024 * 1024,
    );
    if (invalid) {
      setMessage(copy.invalidEvidence.replace("{name}", invalid.name));
      return;
    }
    setFiles((current) => {
      const known = new Set(current.map(fileKey));
      const additions = incoming.filter((file) => !known.has(fileKey(file)));
      return [...current, ...additions].slice(0, 10);
    });
    setMessage("");
  }

  async function uploadEvidence(): Promise<string[]> {
    const uploaded = [...uploadedEvidence];
    for (const [index, file] of files.entries()) {
      const key = fileKey(file);
      const existing = uploaded.find((item) => item.key === key);
      if (existing) continue;
      setProgress(copy.uploading.replace("{current}", String(index + 1)).replace("{total}", String(files.length)));
      const intent = await apiRequest<UploadIntent>("/media/upload-intents", {
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
      const response = await fetch(intent.uploadUrl, {
        method: intent.method,
        headers: intent.requiredHeaders,
        body: file,
      });
      if (!response.ok) throw new Error(copy.uploadFailed.replace("{name}", file.name));
      await apiRequest(`/media/${intent.assetId}/complete`, {
        method: "POST",
        authenticated: true,
        headers: { "X-Content-SHA256": await sha256(file) },
      });
      uploaded.push({ key, assetId: intent.assetId });
      setUploadedEvidence([...uploaded]);
    }
    const selected = new Set(files.map(fileKey));
    return uploaded.filter((item) => selected.has(item.key)).map((item) => item.assetId);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!/^[0-9a-f-]{36}$/i.test(targetId)) {
      setMessage(copy.invalidTarget);
      return;
    }
    setBusy(true);
    setMessage("");
    setProgress(files.length ? copy.preparingEvidence : copy.submitting);
    try {
      const evidenceAssetIds = files.length ? await uploadEvidence() : [];
      setProgress(copy.submitting);
      const result = await apiRequest<{ reference: string }>("/reports", {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({ targetType, targetId, reason, details, evidenceAssetIds }),
      });
      setReference(result.reference);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  if (reference)
    return (
      <main className="flow-page">
        <div className="flow-shell narrow">
          <section className="flow-card success-card">
            <span className="success-mark">✓</span>
            <h1>{copy.received}</h1>
            <p className="lead">{copy.receivedBody}</p>
            <div className="points-confirm">
              <span>REFERENCE</span>
              <strong>{reference}</strong>
            </div>
            <Link className="primary-action" href="/safety">
              {copy.safetyCenter}
            </Link>
          </section>
        </div>
      </main>
    );

  return (
    <main className="flow-page">
      <div className="flow-shell narrow">
        <form className="flow-card report-form" onSubmit={(event) => void submit(event)}>
          <span className="section-number">SAFETY / PRIVATE</span>
          <h1>{copy.title}</h1>
          <p className="lead">{copy.lead}</p>
          <aside className="report-privacy-note">
            <span aria-hidden="true">◎</span>
            <p>{copy.privacy}</p>
          </aside>
          <label className="form-field">
            {copy.reason}
            <select required value={reason} onChange={(event) => setReason(event.target.value)}>
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
              onChange={(event) => setDetails(event.target.value)}
              placeholder={copy.detailsPlaceholder}
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
                onChange={(event) => {
                  addEvidence(event.target.files);
                  event.target.value = "";
                }}
                disabled={busy || files.length >= 10}
              />
              <span>{copy.addEvidence}</span>
            </label>
            {files.length > 0 && (
              <div className="evidence-list">
                {files.map((file) => (
                  <div key={fileKey(file)}>
                    <span aria-hidden="true">▧</span>
                    <div>
                      <strong>{file.name}</strong>
                      <small>{formatBytes(file.size)}</small>
                    </div>
                    <button
                      type="button"
                      onClick={() => setFiles((current) => current.filter((item) => fileKey(item) !== fileKey(file)))}
                      disabled={busy}
                      aria-label={copy.remove.replace("{name}", file.name)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          {message && (
            <p className="form-message" role="alert">
              {message}
            </p>
          )}
          {progress && (
            <p className="report-progress" role="status">
              <i /> {progress}
            </p>
          )}
          <button className="danger-action" disabled={busy}>
            {busy ? copy.working : copy.submit}
          </button>
        </form>
      </div>
    </main>
  );
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
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
  if (locale === "ja")
    return {
      title: "報告と安全サポート",
      lead: "あなたの身元は対象者に表示されません。緊急時は警察・救急へ連絡してください。",
      privacy: "詳細と証拠は暗号化された制限領域で扱われ、案件担当者だけが確認します。",
      reason: "理由",
      fraud: "詐欺・虚偽",
      personalSafety: "身体の安全",
      harassment: "嫌がらせ・ヘイト",
      minorSafety: "未成年者の安全",
      other: "その他",
      details: "詳細",
      detailsPlaceholder: "いつ、どこで、何が起きたかを、覚えている範囲で記入してください。",
      evidence: "非公開の画像証拠（任意）",
      evidenceBody: "JPEG / PNG / WebP / HEIC、1枚20MBまで、最大10枚",
      addEvidence: "画像を追加",
      remove: "{name} を削除",
      invalidEvidence: "{name} は対応形式ではないか、20MBを超えています。",
      invalidTarget: "報告対象が正しくありません。元のページからもう一度お試しください。",
      preparingEvidence: "証拠を安全に準備しています…",
      uploading: "証拠をアップロード中 {current}/{total}",
      uploadFailed: "{name} をアップロードできませんでした。通信を確認して再試行してください。",
      submitting: "非公開レポートを送信しています…",
      working: "安全に送信中…",
      submit: "非公開レポートを送信",
      received: "報告を受け付けました",
      receivedBody: "内容は非公開で確認され、対象者にあなたの身元は表示されません。",
      safetyCenter: "安全センターで進捗を確認",
    };
  if (locale === "en")
    return {
      title: "Report & safety support",
      lead: "Your identity is not shown to the reported party. For immediate danger, contact local emergency services first.",
      privacy: "Details and evidence are stored in an encrypted restricted area visible only to assigned case reviewers.",
      reason: "Reason",
      fraud: "Fraud or false information",
      personalSafety: "Personal safety",
      harassment: "Harassment or hate",
      minorSafety: "Minor safety",
      other: "Other",
      details: "Details",
      detailsPlaceholder: "Describe what happened, when, and where, using only what you remember.",
      evidence: "Private image evidence (optional)",
      evidenceBody: "JPEG, PNG, WebP, or HEIC · up to 20 MB each · maximum 10",
      addEvidence: "Add images",
      remove: "Remove {name}",
      invalidEvidence: "{name} is unsupported or larger than 20 MB.",
      invalidTarget: "The report target is invalid. Start again from the original page.",
      preparingEvidence: "Preparing evidence securely…",
      uploading: "Uploading evidence {current}/{total}",
      uploadFailed: "Could not upload {name}. Check your connection and try again.",
      submitting: "Submitting private report…",
      working: "Submitting securely…",
      submit: "Submit private report",
      received: "Report received",
      receivedBody: "The report is reviewed privately. Your identity is not shown to the reported party.",
      safetyCenter: "Review progress in Safety Center",
    };
  return {
    title: "举报与安全求助",
    lead: "你的身份不会向被举报方展示。遇到紧急人身危险，请先联系当地警察或急救服务。",
    privacy: "详细说明和证据会进入加密的受限区域，仅案件处理人员可查看。",
    reason: "举报原因",
    fraud: "诈骗或虚假信息",
    personalSafety: "人身安全",
    harassment: "骚扰或仇恨",
    minorSafety: "未成年人风险",
    other: "其他",
    details: "详细说明",
    detailsPlaceholder: "请根据记忆描述发生了什么、时间和地点。",
    evidence: "私密图片证据（选填）",
    evidenceBody: "支持 JPEG、PNG、WebP、HEIC；每张不超过 20 MB；最多 10 张",
    addEvidence: "添加图片",
    remove: "移除 {name}",
    invalidEvidence: "{name} 格式不支持或超过 20 MB。",
    invalidTarget: "举报对象无效，请从原页面重新进入。",
    preparingEvidence: "正在安全准备证据…",
    uploading: "正在上传证据 {current}/{total}",
    uploadFailed: "{name} 上传失败，请检查网络后重试。",
    submitting: "正在提交私密举报…",
    working: "正在安全提交…",
    submit: "提交私密举报",
    received: "举报已提交",
    receivedBody: "内容会被私密处理，你的身份不会向被举报方展示。",
    safetyCenter: "在安全中心查看进度",
  };
}
