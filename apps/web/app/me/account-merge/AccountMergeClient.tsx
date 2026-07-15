"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useI18n } from "../../components/I18nProvider";
import type { Locale } from "../../i18n/messages";
import {
  apiRequest,
  deviceId,
  errorMessage,
  saveSession,
  type WebSession,
} from "../../lib/client-api";

interface EmailChallenge {
  challengeId: string;
  expiresAt: string;
  developmentCode?: string;
}

interface MergePreview {
  jobId: string;
  mergeToken: string;
  expiresAt: string;
  sourceUserId: string;
  targetUserId: string;
  impact: {
    ownedEvents: number;
    ownedGroups: number;
    sourceWallet: { paid: number; free: number };
    targetWallet: { paid: number; free: number };
  };
  conflicts: Array<Record<string, unknown>>;
  canCommit: boolean;
}

export function AccountMergeClient() {
  const { locale } = useI18n();
  const copy = mergeCopy(locale);
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<EmailChallenge | null>(null);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    try {
      if (!challenge) {
        const created = await apiRequest<EmailChallenge>("/auth/email/challenges", {
          method: "POST",
          body: JSON.stringify({ email, deviceId: deviceId() }),
        });
        setChallenge(created);
        if (created.developmentCode) setCode(created.developmentCode);
        setMessage(copy.codeSent);
        return;
      }
      const result = await apiRequest<MergePreview>("/accounts/merge/preview", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({
          credential: { provider: "email", challengeId: challenge.challengeId, code },
        }),
      });
      setPreview(result);
      setConfirmed(false);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || !confirmed || !preview.canCommit) return;
    setBusy(true);
    setMessage("");
    try {
      const session = await apiRequest<WebSession>("/accounts/merge/commit", {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({
          jobId: preview.jobId,
          mergeToken: preview.mergeToken,
          deviceId: deviceId(),
          platform: "web",
        }),
      });
      saveSession(session);
      window.location.assign("/me/settings?accountMerge=complete");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flow-page account-merge-page">
      <section className="flow-card account-merge-card">
        <Link className="back-link" href="/me/settings">
          ← {copy.back}
        </Link>
        <span className="section-number">IDENTITY / VERIFIED MERGE</span>
        <h1>{copy.title}</h1>
        <p className="flow-lead">{copy.lead}</p>

        {!preview ? (
          <form className="merge-verify-form" onSubmit={verify}>
            <div className="merge-safety-note">
              <strong>{copy.reverify}</strong>
              <p>{copy.reverifyBody}</p>
            </div>
            <label className="form-field">
              {copy.email}
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                disabled={Boolean(challenge)}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="another@example.jp"
              />
            </label>
            {challenge && (
              <label className="form-field">
                {copy.code}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                />
              </label>
            )}
            <button className="primary-action" disabled={busy}>
              {busy ? copy.wait : challenge ? copy.preview : copy.send}
            </button>
            {challenge && (
              <button
                className="text-button"
                type="button"
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                  setMessage("");
                }}
              >
                {copy.change}
              </button>
            )}
          </form>
        ) : (
          <div className="merge-preview">
            <div className="merge-verified-mark">
              <span aria-hidden="true">✓</span>
              <div>
                <strong>{copy.verified}</strong>
                <p>
                  {copy.expires}{" "}
                  {new Intl.DateTimeFormat(intlLocale(locale), {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(preview.expiresAt))}
                </p>
              </div>
            </div>
            <div className="merge-impact-grid">
              <div><span>{copy.events}</span><strong>{preview.impact.ownedEvents}</strong></div>
              <div><span>{copy.groups}</span><strong>{preview.impact.ownedGroups}</strong></div>
              <div>
                <span>{copy.points}</span>
                <strong>
                  {preview.impact.sourceWallet.paid + preview.impact.sourceWallet.free} +{" "}
                  {preview.impact.targetWallet.paid + preview.impact.targetWallet.free}
                </strong>
              </div>
            </div>
            {preview.conflicts.length ? (
              <div className="merge-conflicts" role="alert">
                <strong>{copy.conflicts}</strong>
                <ul>
                  {preview.conflicts.map((conflict, index) => (
                    <li key={`${String(conflict.type ?? "conflict")}-${index}`}>
                      {String(conflict.message ?? conflict.type ?? copy.conflictFallback)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="merge-clear">✓ {copy.noConflicts}</p>
            )}
            <label className="merge-confirmation">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span><strong>{copy.confirm}</strong><small>{copy.confirmBody}</small></span>
            </label>
            <div className="merge-actions">
              <button
                className="primary-action"
                disabled={busy || !confirmed || !preview.canCommit}
                onClick={() => void commit()}
              >
                {busy ? copy.merging : copy.commit}
              </button>
              <button className="text-button" onClick={() => setPreview(null)}>
                {copy.reverifyOther}
              </button>
            </div>
          </div>
        )}
        {message && <p className="form-message" role="status">{message}</p>}
      </section>
    </main>
  );
}

function mergeCopy(locale: Locale) {
  if (locale === "ja") return {
    back: "設定", title: "アカウントを安全に統合", lead: "別の既存アカウントを再認証し、移行されるイベント、コミュニティ、ポイントと競合を確認してから確定します。", reverify: "2つ目のアカウントを認証", reverifyBody: "現在のログイン状態だけでは統合できません。もう一つのアカウントのメールコードを入力してください。", email: "もう一つのアカウントのメールアドレス", code: "6桁の確認コード", codeSent: "確認コードを送信しました。", wait: "確認中…", preview: "認証して影響を確認", send: "確認コードを送信", change: "別のメールを使う", verified: "2つ目のアカウントを認証しました", expires: "認証の有効期限:", events: "主催イベント", groups: "所有コミュニティ", points: "統合後のポイント", conflicts: "先に解決が必要な競合", conflictFallback: "アカウントの競合", noConflicts: "電話番号、申込、コミュニティ、運営権限の競合はありません。", confirm: "この2つのアカウントを統合する", confirmBody: "公開プロフィール、イベント、コミュニティ、ポイント、安全記録を一つのトランザクションで移行し、元アカウントのセッションを無効にします。自分では取り消せません。", merging: "統合中…", commit: "統合を確定", reverifyOther: "別のアカウントを再認証",
  };
  if (locale === "en") return {
    back: "Settings", title: "Merge accounts securely", lead: "Reverify another existing account, review the events, communities, points, and conflicts that will move, then give final confirmation.", reverify: "Verify the second account", reverifyBody: "Your current session alone cannot authorize a merge. Enter the email code for the other account.", email: "Email for the other account", code: "6-digit verification code", codeSent: "Verification code sent.", wait: "Verifying…", preview: "Verify and review impact", send: "Send verification code", change: "Use another email", verified: "Second account verified", expires: "Verification expires:", events: "Hosted events", groups: "Owned communities", points: "Combined points", conflicts: "Conflicts to resolve first", conflictFallback: "Account conflict", noConflicts: "No phone, registration, community, or operator-role conflicts were found.", confirm: "Merge these two accounts", confirmBody: "This moves public profiles, events, communities, points, and safety records in one transaction and revokes sessions for the source account. You cannot undo it yourself.", merging: "Merging…", commit: "Confirm merge", reverifyOther: "Reverify another account",
  };
  return {
    back: "返回设置", title: "安全合并账号", lead: "重新验证另一个现有账号，先核对将迁移的活动、社群、积分与冲突，再最终确认。", reverify: "验证第二个账号", reverifyBody: "仅凭当前登录状态不能发起合并，请输入另一个账号收到的邮箱验证码。", email: "另一个账号的邮箱", code: "6 位验证码", codeSent: "验证码已发送。", wait: "正在验证…", preview: "验证并查看影响", send: "发送验证码", change: "更换邮箱", verified: "第二个账号已验证", expires: "验证证明失效时间：", events: "主办活动", groups: "拥有社群", points: "合并后积分", conflicts: "需要先解决的冲突", conflictFallback: "账号冲突", noConflicts: "没有发现手机号、报名、社群或运营身份冲突。", confirm: "确认合并这两个账号", confirmBody: "系统会在一个事务中迁移公开资料、活动、社群、积分与安全记录，并撤销来源账号会话。此操作不能自行撤销。", merging: "正在合并…", commit: "确认合并", reverifyOther: "重新验证其他账号",
  };
}

function intlLocale(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}
