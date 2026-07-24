"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePreviewMode } from "../../components/PreviewModeProvider";
import type { Locale } from "../../i18n/messages";
import { apiRequest, errorMessage, type WebSession } from "../../lib/client-api";
import type { EventDetail } from "../../lib/event-contract";
import styles from "./EventComments.module.css";

type CommentPermission = "disabled" | "participants" | "group_members";

export interface EventCommentView {
  id: string;
  body: string;
  parentId: string | null;
  locale?: string;
  createdAt: string;
  author: { id: string; name: string };
}

interface EventCommentsPayload {
  eventId?: string;
  commentPermission?: CommentPermission;
  items: EventCommentView[];
}

type ThreadState = "loading" | "ready" | "error";

export function EventComments({
  event,
  session,
  locale,
}: {
  event: EventDetail;
  session: WebSession | null;
  locale: Locale;
}) {
  const isReadOnly = usePreviewMode() === "read-only";
  const copy = commentsCopy(locale);
  const [state, setState] = useState<ThreadState>("loading");
  const [items, setItems] = useState<EventCommentView[]>([]);
  const [permission, setPermission] = useState<CommentPermission | null>(
    event.commentPermission ?? null,
  );
  const [membership, setMembership] = useState<{ groupId: string; active: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<EventCommentView | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const idempotencyKey = useRef<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let active = true;
    void apiRequest<EventCommentsPayload>(`/events/${event.id}/comments`)
      .then((payload) => {
        if (!active) return;
        setItems(Array.isArray(payload.items) ? payload.items : []);
        if (payload.commentPermission) setPermission(payload.commentPermission);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [event.id, loadAttempt]);

  const isOrganizer = Boolean(session && session.user.id === event.organizerId);
  const isConfirmedAttendee = ["confirmed", "checked_in"].includes(
    event.viewerRegistration?.status ?? "",
  );

  // group_members events need the viewer's membership, which the event payload
  // does not carry; the public group endpoint returns it for the signed-in viewer.
  useEffect(() => {
    if (isReadOnly || !session || isOrganizer) return;
    if (permission !== "group_members" || !event.groupId) return;
    const groupId = event.groupId;
    let active = true;
    void apiRequest<{ membershipStatus?: string | null }>(`/groups/${groupId}`, {
      authenticated: true,
    })
      .then((group) => {
        if (active) setMembership({ groupId, active: group.membershipStatus === "active" });
      })
      .catch(() => {
        if (active) setMembership({ groupId, active: false });
      });
    return () => {
      active = false;
    };
  }, [event.groupId, isOrganizer, isReadOnly, permission, session]);
  const membershipActive = Boolean(membership && membership.groupId === event.groupId && membership.active);

  const viewerMayComment = Boolean(
    session
      && permission
      && permission !== "disabled"
      && (isOrganizer
        || (permission === "participants" && isConfirmedAttendee)
        || (permission === "group_members" && membershipActive)),
  );
  const needsPhoneVerification = viewerMayComment && !session?.user.phoneVerified;
  const composerVisible = !isReadOnly && viewerMayComment && !needsPhoneVerification;

  const gateNotice = useMemo(() => {
    if (permission === "disabled") return copy.disabled;
    if (composerVisible || needsPhoneVerification) return null;
    if (permission === "participants") return copy.participantsOnly;
    if (permission === "group_members") return copy.groupMembersOnly;
    return permission === null && state === "ready" ? copy.disabled : null;
  }, [composerVisible, copy, needsPhoneVerification, permission, state]);

  const threads = useMemo(() => buildThreads(items), [items]);

  const beginReply = useCallback((comment: EventCommentView) => {
    setReplyTo(comment);
    composerRef.current?.focus();
  }, []);

  async function submit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const body = draft.trim();
    if (!body || busy) return;
    setBusy(true);
    setSubmitError("");
    try {
      const key = idempotencyKey.current ?? window.crypto.randomUUID();
      idempotencyKey.current = key;
      const created = await apiRequest<EventCommentView>(`/events/${event.id}/comments`, {
        method: "POST",
        authenticated: true,
        idempotencyKey: key,
        body: JSON.stringify({
          body,
          ...(replyTo ? { parentId: replyTo.id } : {}),
          locale,
        }),
      });
      idempotencyKey.current = null;
      setItems((current) => [...current, created]);
      setDraft("");
      setReplyTo(null);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.section} aria-label={copy.title}>
      <p className={styles.eyebrow}>{copy.eyebrow}</p>
      <div className={styles.heading}>
        <h2>{copy.title}</h2>
        {state === "ready" && items.length ? (
          <span>{copy.count.replaceAll("{count}", String(items.length))}</span>
        ) : null}
      </div>

      {state === "loading" ? <p className={styles.quietNote}>{copy.loading}</p> : null}
      {state === "error" ? (
        <div className={styles.errorNote} role="alert">
          <span>{copy.loadError}</span>
          <button
            type="button"
            onClick={() => {
              setState("loading");
              setLoadAttempt((attempt) => attempt + 1);
            }}
          >
            {copy.retry}
          </button>
        </div>
      ) : null}

      {state === "ready" && !items.length ? (
        <p className={styles.quietNote}>
          {permission === "disabled" ? copy.disabled : copy.empty}
        </p>
      ) : null}

      {threads.length ? (
        <ol className={styles.threadList}>
          {threads.map(({ comment, replies }) => (
            <li key={comment.id} className={styles.thread}>
              <CommentBody comment={comment} locale={locale} />
              {composerVisible ? (
                <button
                  type="button"
                  className={styles.replyButton}
                  onClick={() => beginReply(comment)}
                >
                  {copy.reply}
                </button>
              ) : null}
              {replies.length ? (
                <ol className={styles.replyList}>
                  {replies.map((reply) => (
                    <li key={reply.id}>
                      <CommentBody comment={reply} locale={locale} />
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {gateNotice && !(state === "ready" && !items.length && permission === "disabled") ? (
        <p className={styles.quietNote} data-testid="comment-gate">{gateNotice}</p>
      ) : null}

      {!isReadOnly && needsPhoneVerification ? (
        <p className={styles.quietNote}>
          {copy.phoneGate}{" "}
          <Link href={`/phone-verification?returnTo=${encodeURIComponent(`/e/${event.publicSlug}`)}`}>
            {copy.phoneGateAction}
          </Link>
        </p>
      ) : null}

      {composerVisible ? (
        <form className={styles.composer} onSubmit={(formEvent) => void submit(formEvent)}>
          {replyTo ? (
            <p className={styles.replyContext}>
              <span>{copy.replyingTo.replaceAll("{name}", replyTo.author.name)}</span>
              <button type="button" onClick={() => setReplyTo(null)}>{copy.cancelReply}</button>
            </p>
          ) : null}
          <textarea
            ref={composerRef}
            value={draft}
            maxLength={2000}
            rows={3}
            placeholder={replyTo ? copy.replyPlaceholder : copy.placeholder}
            aria-label={copy.composerLabel}
            onChange={(changeEvent) => setDraft(changeEvent.target.value)}
          />
          <div className={styles.composerFooter}>
            <small>{copy.moderated}</small>
            <button type="submit" disabled={busy || !draft.trim()}>
              {busy ? copy.sending : copy.send}
            </button>
          </div>
          {submitError ? <p className={styles.submitError} role="alert">{submitError}</p> : null}
        </form>
      ) : null}
    </section>
  );
}

function CommentBody({ comment, locale }: { comment: EventCommentView; locale: Locale }) {
  return (
    <article className={styles.comment}>
      <header>
        <strong>{comment.author.name}</strong>
        <time dateTime={comment.createdAt}>{commentTime(comment.createdAt, locale)}</time>
      </header>
      <p>{comment.body}</p>
    </article>
  );
}

function buildThreads(items: EventCommentView[]) {
  const topLevel = items.filter((item) => !item.parentId);
  const known = new Set(topLevel.map((item) => item.id));
  const replies = new Map<string, EventCommentView[]>();
  const orphans: EventCommentView[] = [];
  for (const item of items) {
    if (!item.parentId) continue;
    if (known.has(item.parentId)) {
      const bucket = replies.get(item.parentId) ?? [];
      bucket.push(item);
      replies.set(item.parentId, bucket);
    } else {
      // A reply whose parent is no longer visible still deserves a place.
      orphans.push(item);
    }
  }
  return [
    ...topLevel.map((comment) => ({ comment, replies: replies.get(comment.id) ?? [] })),
    ...orphans.map((comment) => ({ comment, replies: [] as EventCommentView[] })),
  ];
}

function commentTime(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const intl = locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
  return new Intl.DateTimeFormat(intl, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(parsed);
}

function commentsCopy(locale: Locale) {
  if (locale === "ja") {
    return {
      eyebrow: "参加者コミュニティ",
      title: "コメント",
      count: "{count}件",
      loading: "コメントを読み込み中…",
      loadError: "コメントを読み込めませんでした。",
      retry: "もう一度",
      empty: "まだコメントはありません。最初の一言をどうぞ。",
      disabled: "このイベントはコメントを受け付けていません。",
      participantsOnly: "参加が確定した人のみコメントできます。",
      groupMembersOnly: "関連グループのメンバーのみコメントできます。",
      phoneGate: "コメントするには電話番号の確認が必要です。",
      phoneGateAction: "電話番号を確認する",
      composerLabel: "コメントを書く",
      placeholder: "参加者への質問や補足をどうぞ（2000文字まで）",
      replyPlaceholder: "返信を書く…",
      reply: "返信",
      replyingTo: "{name} さんへ返信",
      cancelReply: "取り消す",
      moderated: "コメントは参加者向けの管理された掲示板です。",
      send: "コメントを送信",
      sending: "送信中…",
    };
  }
  if (locale === "en") {
    return {
      eyebrow: "ATTENDEE COMMUNITY",
      title: "Comments",
      count: "{count} comments",
      loading: "Loading comments…",
      loadError: "Comments could not be loaded.",
      retry: "Try again",
      empty: "No comments yet. Start the conversation.",
      disabled: "Comments are closed for this event.",
      participantsOnly: "Only confirmed attendees can comment.",
      groupMembersOnly: "Only members of the linked group can comment.",
      phoneGate: "Verify your phone number to comment.",
      phoneGateAction: "Verify phone",
      composerLabel: "Write a comment",
      placeholder: "Ask a question or share a note (up to 2000 characters)",
      replyPlaceholder: "Write a reply…",
      reply: "Reply",
      replyingTo: "Replying to {name}",
      cancelReply: "Cancel",
      moderated: "Comments are a moderated space for this event’s participants.",
      send: "Post comment",
      sending: "Posting…",
    };
  }
  return {
    eyebrow: "参与者社区",
    title: "评论",
    count: "{count} 条",
    loading: "正在加载评论…",
    loadError: "评论没有加载成功。",
    retry: "重试",
    empty: "还没有评论，来说点什么吧。",
    disabled: "该活动已关闭评论。",
    participantsOnly: "仅参与者可评论。",
    groupMembersOnly: "仅关联群组成员可评论。",
    phoneGate: "验证手机号后即可评论。",
    phoneGateAction: "去验证手机号",
    composerLabel: "写评论",
    placeholder: "向参与者提问或补充信息（最多 2000 字）",
    replyPlaceholder: "写下你的回复…",
    reply: "回复",
    replyingTo: "回复 {name}",
    cancelReply: "取消",
    moderated: "评论是面向本活动参与者的受控空间。",
    send: "发表评论",
    sending: "正在发表…",
  };
}
