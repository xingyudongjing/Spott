"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppDialog } from "../components/AppDialog";
import { PreviewModeLink as Link } from "../components/PreviewModeLink";
import type { Locale } from "../i18n/messages";
import { apiRequest, errorMessage, readSession } from "../lib/client-api";

interface SafetyCase {
  reference: string;
  relationship: "submitted" | "subject";
  targetType: "event" | "group" | "user" | "comment" | "announcement";
  targetId: string;
  reason: string;
  severity: "p0" | "p1" | "p2";
  status: string;
  caseStatus: string | null;
  decision: string | null;
  slaDueAt: string | null;
  createdAt: string;
  updatedAt: string;
  appeal: { id: string; status: string; createdAt: string | null; decidedAt: string | null } | null;
}

interface BlockedUser {
  userId: string;
  publicHandle: string;
  nickname: string | null;
  reason: string | null;
  blockedAt: string;
}

export function SafetyCaseTracker({ locale }: { locale: Locale }) {
  const appDialog = useAppDialog();
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [cases, setCases] = useState<SafetyCase[]>([]);
  const [blocks, setBlocks] = useState<BlockedUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [appealReference, setAppealReference] = useState("");
  const [statement, setStatement] = useState("");
  const [message, setMessage] = useState("");
  const copy = trackerCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [casePage, blockPage] = await Promise.all([
        apiRequest<{ items: SafetyCase[] }>("/me/safety-cases", { authenticated: true }),
        apiRequest<{ items: BlockedUser[] }>("/me/blocks", { authenticated: true }),
      ]);
      setCases(casePage.items);
      setBlocks(blockPage.items);
      setMessage("");
    } catch (error) {
      if (!readSession()) {
        setAuthenticated(false);
        setMessage("");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const signedIn = Boolean(readSession());
      setAuthenticated(signedIn);
      if (signedIn) void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function submitAppeal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!appealReference || statement.trim().length < 10) return;
    setBusyId(appealReference);
    setMessage("");
    try {
      await apiRequest("/appeals", {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({ caseReference: appealReference, statement: statement.trim() }),
      });
      setAppealReference("");
      setStatement("");
      setMessage(copy.appealSent);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusyId("");
    }
  }

  async function unblock(user: BlockedUser) {
    await appDialog.run({
      title: copy.unblock,
      message: copy.unblockConfirm.replace("{name}", user.nickname || `@${user.publicHandle}`),
      confirmLabel: copy.unblock,
      onConfirm: async () => {
        setBusyId(user.userId);
        setMessage("");
        try {
          await apiRequest(`/users/${user.userId}/block`, {
            method: "DELETE",
            authenticated: true,
          });
          setBlocks((current) => current.filter((item) => item.userId !== user.userId));
          setMessage(copy.unblocked);
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusyId("");
        }
      },
    });
  }

  return (
    <section className="safety-account" aria-labelledby="safety-account-title">
      <div className="section-heading compact-heading">
        <div>
          <span className="section-number">PRIVATE CASE PORTAL</span>
          <h2 id="safety-account-title">{copy.title}</h2>
        </div>
        <p>{copy.body}</p>
      </div>

      {authenticated === null ? (
        <div className="loading-state compact-loading">
          <span />
          <p>{copy.checking}</p>
        </div>
      ) : !authenticated ? (
        <div className="safety-signin-panel">
          <div>
            <span aria-hidden="true">◎</span>
            <div>
              <strong>{copy.signInTitle}</strong>
              <p>{copy.signInBody}</p>
            </div>
          </div>
          <Link className="primary-action compact" href="/login?returnTo=%2Fsafety">
            {copy.signIn}
          </Link>
        </div>
      ) : loading ? (
        <div className="loading-state compact-loading">
          <span />
          <p>{copy.loading}</p>
        </div>
      ) : (
        <>
          {message && (
            <p className="form-message" role="status">
              {message}
            </p>
          )}
          <div className="safety-account-grid">
            <section className="case-list-section">
              <div className="safety-subheading">
                <div>
                  <span>{copy.casesEyebrow}</span>
                  <h3>{copy.cases}</h3>
                </div>
                <strong>{cases.length}</strong>
              </div>
              {cases.length ? (
                <div className="safety-case-list">
                  {cases.map((item) => {
                    const canAppeal =
                      !item.appeal && ["decided", "closed"].includes(item.caseStatus ?? "");
                    return (
                      <article key={item.reference}>
                        <div className="case-topline">
                          <span className={`severity-badge severity-${item.severity}`}>
                            {item.severity.toUpperCase()}
                          </span>
                          <code>{item.reference}</code>
                          <span>{relationshipLabel(item.relationship, locale)}</span>
                        </div>
                        <h4>{reasonLabel(item.reason, locale)}</h4>
                        <p>
                          {targetLabel(item.targetType, locale)} · {statusLabel(item.caseStatus ?? item.status, locale)}
                        </p>
                        <dl>
                          <div>
                            <dt>{copy.updated}</dt>
                            <dd>{formatDate(item.updatedAt, locale)}</dd>
                          </div>
                          {item.decision && (
                            <div>
                              <dt>{copy.decision}</dt>
                              <dd>{statusLabel(item.decision, locale)}</dd>
                            </div>
                          )}
                          {item.slaDueAt && !["decided", "closed"].includes(item.caseStatus ?? "") && (
                            <div>
                              <dt>{copy.targetResponse}</dt>
                              <dd>{formatDate(item.slaDueAt, locale)}</dd>
                            </div>
                          )}
                        </dl>
                        {item.appeal ? (
                          <div className="appeal-state">
                            <span>{copy.appeal}</span>
                            <strong>{statusLabel(item.appeal.status, locale)}</strong>
                          </div>
                        ) : canAppeal ? (
                          <button
                            className="secondary-action compact"
                            type="button"
                            onClick={() => {
                              setAppealReference(item.reference);
                              setStatement("");
                            }}
                          >
                            {copy.startAppeal}
                          </button>
                        ) : null}
                        {appealReference === item.reference && (
                          <form className="appeal-form" onSubmit={(event) => void submitAppeal(event)}>
                            <label className="form-field">
                              {copy.statement}
                              <textarea
                                value={statement}
                                onChange={(event) => setStatement(event.target.value)}
                                minLength={10}
                                maxLength={5000}
                                required
                                placeholder={copy.statementPlaceholder}
                              />
                            </label>
                            <div className="inline-actions">
                              <button
                                type="button"
                                onClick={() => {
                                  setAppealReference("");
                                  setStatement("");
                                }}
                              >
                                {copy.cancel}
                              </button>
                              <button disabled={busyId === item.reference || statement.trim().length < 10}>
                                {busyId === item.reference ? copy.sending : copy.submitAppeal}
                              </button>
                            </div>
                          </form>
                        )}
                      </article>
                    );
                  })}
                </div>
              ) : (
                <div className="safety-empty">
                  <strong>{copy.noCases}</strong>
                  <p>{copy.noCasesBody}</p>
                </div>
              )}
            </section>

            <section className="block-list-section">
              <div className="safety-subheading">
                <div>
                  <span>{copy.blocksEyebrow}</span>
                  <h3>{copy.blocks}</h3>
                </div>
                <strong>{blocks.length}</strong>
              </div>
              <p className="block-explainer">{copy.blocksBody}</p>
              {blocks.length ? (
                <div className="blocked-user-list">
                  {blocks.map((user) => (
                    <article key={user.userId}>
                      <div className="blocked-avatar">
                        {(user.nickname || user.publicHandle).slice(0, 1).toUpperCase()}
                      </div>
                      <div>
                        <strong>{user.nickname || `@${user.publicHandle}`}</strong>
                        <span>@{user.publicHandle}</span>
                        <small>{copy.blockedAt.replace("{date}", formatDate(user.blockedAt, locale))}</small>
                      </div>
                      <button disabled={busyId === user.userId} onClick={() => void unblock(user)}>
                        {copy.unblock}
                      </button>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="safety-empty">
                  <strong>{copy.noBlocks}</strong>
                  <p>{copy.noBlocksBody}</p>
                </div>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function relationshipLabel(value: SafetyCase["relationship"], locale: Locale): string {
  if (value === "submitted")
    return locale === "ja" ? "あなたが報告" : locale === "en" ? "Reported by you" : "由你举报";
  return locale === "ja" ? "あなたが対象" : locale === "en" ? "You are the subject" : "涉及你的案件";
}

function targetLabel(value: SafetyCase["targetType"], locale: Locale): string {
  const labels: Record<SafetyCase["targetType"], [string, string, string]> = {
    event: ["活动", "イベント", "Event"],
    group: ["群组", "グループ", "Group"],
    user: ["用户", "ユーザー", "User"],
    comment: ["评论", "コメント", "Comment"],
    announcement: ["公告", "お知らせ", "Announcement"],
  };
  return labels[value][locale === "ja" ? 1 : locale === "en" ? 2 : 0];
}

function reasonLabel(value: string, locale: Locale): string {
  const known: Record<string, [string, string, string]> = {
    harassment: ["骚扰或不当接触", "嫌がらせ・不適切な接触", "Harassment or unwanted contact"],
    unsafe: ["安全风险", "安全上の懸念", "Safety concern"],
    fraud: ["诈骗或虚假信息", "詐欺・虚偽情報", "Fraud or misleading information"],
    hate: ["仇恨或歧视", "ヘイト・差別", "Hate or discrimination"],
    spam: ["垃圾信息", "スパム", "Spam"],
  };
  return known[value]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? value;
}

function statusLabel(value: string, locale: Locale): string {
  const labels: Record<string, [string, string, string]> = {
    open: ["已受理", "受付済み", "Open"],
    triage: ["评估中", "確認中", "In triage"],
    investigating: ["调查中", "調査中", "Investigating"],
    decided: ["已作出决定", "判断済み", "Decided"],
    closed: ["已结案", "終了", "Closed"],
    appealed: ["申诉处理中", "異議申立て中", "Under appeal"],
    pending: ["待处理", "処理待ち", "Pending"],
    upheld: ["维持原决定", "原判断を維持", "Upheld"],
    overturned: ["已变更决定", "判断を変更", "Overturned"],
    approved: ["已通过", "承認済み", "Approved"],
    rejected: ["未通过", "却下", "Rejected"],
  };
  return labels[value]?.[locale === "ja" ? 1 : locale === "en" ? 2 : 0] ?? value;
}

function formatDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function trackerCopy(locale: Locale) {
  if (locale === "ja")
    return {
      title: "あなたの安全記録",
      body: "報告、判断、異議申立て、ブロックは非公開で、iOS と Web に同期されます。",
      checking: "ログイン状態を確認中…",
      signInTitle: "非公開ポータルにログイン",
      signInBody: "本人に関係する案件とブロックだけが表示されます。証拠や相手の非公開情報は表示されません。",
      signIn: "ログインして確認",
      loading: "安全記録を同期中…",
      casesEyebrow: "REPORTS & DECISIONS",
      cases: "案件の進捗",
      blocksEyebrow: "BOUNDARIES",
      blocks: "ブロック中のユーザー",
      blocksBody: "ブロックすると相互フォローが解除され、相手からの直接の交流が制限されます。",
      updated: "更新",
      decision: "判断",
      targetResponse: "対応目標",
      appeal: "異議申立て",
      startAppeal: "判断に異議を申し立てる",
      statement: "異議申立ての説明",
      statementPlaceholder: "見直しが必要な理由と、新しい情報を具体的に記入してください（10文字以上）",
      cancel: "キャンセル",
      sending: "送信中…",
      submitAppeal: "異議申立てを送信",
      appealSent: "異議申立てを受け付けました。進捗はこのページに同期されます。",
      noCases: "表示できる案件はありません",
      noCasesBody: "報告すると参照番号と進捗がここに表示されます。",
      noBlocks: "ブロック中のユーザーはいません",
      noBlocksBody: "ユーザープロフィールからいつでもブロックできます。",
      blockedAt: "{date} にブロック",
      unblock: "解除",
      unblockConfirm: "{name} のブロックを解除しますか？",
      unblocked: "ブロックを解除しました。",
    };
  if (locale === "en")
    return {
      title: "Your safety records",
      body: "Reports, decisions, appeals, and blocks stay private and sync across iOS and Web.",
      checking: "Checking sign-in…",
      signInTitle: "Sign in to the private portal",
      signInBody: "You only see cases and blocks involving you. Evidence and the other party’s private information are never exposed.",
      signIn: "Sign in to review",
      loading: "Syncing safety records…",
      casesEyebrow: "REPORTS & DECISIONS",
      cases: "Case progress",
      blocksEyebrow: "BOUNDARIES",
      blocks: "Blocked people",
      blocksBody: "Blocking severs mutual follows and limits direct interaction from that person.",
      updated: "Updated",
      decision: "Decision",
      targetResponse: "Target response",
      appeal: "Appeal",
      startAppeal: "Appeal this decision",
      statement: "Appeal statement",
      statementPlaceholder: "Explain why the decision should be reviewed and include any new information (at least 10 characters)",
      cancel: "Cancel",
      sending: "Sending…",
      submitAppeal: "Submit appeal",
      appealSent: "Appeal received. Its progress will stay synced on this page.",
      noCases: "No cases to show",
      noCasesBody: "A report reference and progress will appear here after you submit a report.",
      noBlocks: "No blocked people",
      noBlocksBody: "You can block someone at any time from their profile.",
      blockedAt: "Blocked {date}",
      unblock: "Unblock",
      unblockConfirm: "Unblock {name}?",
      unblocked: "User unblocked.",
    };
  return {
    title: "你的安全记录",
    body: "举报、处理决定、申诉与拉黑记录保持私密，并在 iOS 和 Web 同步。",
    checking: "正在确认登录状态…",
    signInTitle: "登录后进入私密安全门户",
    signInBody: "这里只展示与你有关的案件和拉黑记录，不会暴露证据或对方的私密信息。",
    signIn: "登录查看",
    loading: "正在同步安全记录…",
    casesEyebrow: "REPORTS & DECISIONS",
    cases: "案件进度",
    blocksEyebrow: "BOUNDARIES",
    blocks: "已拉黑的人",
    blocksBody: "拉黑会解除双方关注关系，并限制对方与你直接互动。",
    updated: "更新时间",
    decision: "处理决定",
    targetResponse: "目标响应时间",
    appeal: "申诉",
    startAppeal: "对决定提出申诉",
    statement: "申诉说明",
    statementPlaceholder: "请具体说明需要复核的原因和新增信息（至少 10 个字）",
    cancel: "取消",
    sending: "正在提交…",
    submitAppeal: "提交申诉",
    appealSent: "申诉已提交，处理进度会同步显示在这里。",
    noCases: "暂无可显示的案件",
    noCasesBody: "提交举报后，案件编号和处理进度会出现在这里。",
    noBlocks: "没有拉黑任何人",
    noBlocksBody: "你可以随时从用户主页拉黑对方。",
    blockedAt: "拉黑于 {date}",
    unblock: "解除拉黑",
    unblockConfirm: "确定解除对 {name} 的拉黑吗？",
    unblocked: "已解除拉黑。",
  };
}
