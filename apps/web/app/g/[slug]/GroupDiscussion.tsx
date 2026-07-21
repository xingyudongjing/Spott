"use client";

import { useState } from "react";
import type { FormEvent } from "react";

import { useAppDialog } from "../../components/AppDialog";
import { useI18n } from "../../components/I18nProvider";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import {
  apiRequest,
  errorMessage,
  readSession,
  type GroupAnnouncement,
  type GroupComment,
  type GroupView,
} from "../../lib/client-api";
import styles from "./GroupDetail.module.css";

type CommentLoadState = {
  status: "idle" | "loading" | "loaded" | "error";
  items: GroupComment[];
};

const idleComments: CommentLoadState = { status: "idle", items: [] };

export function GroupDiscussion({
  group,
  initialItems,
}: {
  group: GroupView;
  initialItems: GroupAnnouncement[];
}) {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const [items, setItems] = useState(initialItems);
  const [openId, setOpenId] = useState("");
  const [commentStates, setCommentStates] = useState<Record<string, CommentLoadState>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showComposer, setShowComposer] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [membersOnly, setMembersOnly] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const isReadOnly = usePreviewMode() === "read-only";
  const canComment = !isReadOnly && group.membershipStatus === "active";
  const canManage = !isReadOnly && (
    group.membershipRole === "owner"
    || group.membershipRole === "admin"
    || group.availableActions.includes("manage")
  );
  const dateFormatter = new Intl.DateTimeFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
    { dateStyle: "medium" },
  );
  const dateTimeFormatter = new Intl.DateTimeFormat(
    locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN",
    { dateStyle: "medium", timeStyle: "short" },
  );

  async function reloadAnnouncements() {
    const payload = await apiRequest<{ items: GroupAnnouncement[] }>(
      `/groups/${group.id}/announcements?limit=50`,
    );
    setItems(payload.items);
  }

  async function loadComments(item: GroupAnnouncement) {
    setCommentStates((current) => ({
      ...current,
      [item.id]: { status: "loading", items: current[item.id]?.items ?? [] },
    }));
    try {
      const payload = await apiRequest<{ items: GroupComment[] }>(
        `/groups/${group.id}/announcements/${item.id}/comments`,
      );
      setCommentStates((current) => ({
        ...current,
        [item.id]: { status: "loaded", items: payload.items },
      }));
    } catch {
      setCommentStates((current) => ({
        ...current,
        [item.id]: { status: "error", items: current[item.id]?.items ?? [] },
      }));
    }
  }

  function openComments(item: GroupAnnouncement) {
    if (openId === item.id) {
      setOpenId("");
      return;
    }
    setOpenId(item.id);
    const state = commentStates[item.id] ?? idleComments;
    if (state.status === "idle") void loadComments(item);
  }

  async function toggleLike(item: GroupAnnouncement) {
    if (isReadOnly) return;
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/g/${group.slug}`)}`);
      return;
    }
    const next = !item.viewerLiked;
    setItems((current) => current.map((value) => value.id === item.id
      ? { ...value, viewerLiked: next, likeCount: Math.max(0, value.likeCount + (next ? 1 : -1)) }
      : value));
    try {
      await apiRequest(`/groups/${group.id}/announcements/${item.id}/like`, {
        method: next ? "PUT" : "DELETE",
        authenticated: true,
      });
    } catch (error) {
      setMessage(errorMessage(error));
      await reloadAnnouncements();
    }
  }

  async function postComment(event: FormEvent, item: GroupAnnouncement) {
    event.preventDefault();
    if (isReadOnly) return;
    const value = drafts[item.id]?.trim();
    if (!value) return;
    setBusy(true);
    setMessage("");
    try {
      const created = await apiRequest<GroupComment>(
        `/groups/${group.id}/announcements/${item.id}/comments`,
        {
          method: "POST",
          authenticated: true,
          idempotent: true,
          body: JSON.stringify({ body: value, locale }),
        },
      );
      setCommentStates((current) => ({
        ...current,
        [item.id]: {
          status: "loaded",
          items: [...(current[item.id]?.items ?? []), created],
        },
      }));
      setDrafts((current) => ({ ...current, [item.id]: "" }));
      setItems((current) => current.map((announcement) => announcement.id === item.id
        ? { ...announcement, commentCount: (announcement.commentCount ?? 0) + 1 }
        : announcement));
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function editComment(comment: GroupComment) {
    if (isReadOnly) return;
    const label = locale === "ja" ? "コメントを編集" : locale === "en" ? "Edit comment" : "编辑评论";
    await appDialog.run({
      title: label,
      confirmLabel: label,
      input: { label, defaultValue: comment.body, required: true, multiline: true, maxLength: 2000 },
      onConfirm: async (value) => {
        if (value === comment.body) return;
        try {
          const updated = await apiRequest<GroupComment>(`/comments/${comment.id}`, {
            method: "PATCH",
            authenticated: true,
            ifMatch: comment.version,
            body: JSON.stringify({ body: value }),
          });
          setCommentStates((current) => ({
            ...current,
            [comment.announcementId]: {
              status: "loaded",
              items: (current[comment.announcementId]?.items ?? []).map((item) => item.id === updated.id ? updated : item),
            },
          }));
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  async function deleteComment(comment: GroupComment) {
    if (isReadOnly) return;
    const label = locale === "ja" ? "コメントを削除" : locale === "en" ? "Delete comment" : "删除评论";
    await appDialog.run({
      title: label,
      message: locale === "ja" ? "コメントを削除しますか？" : locale === "en" ? "Delete this comment?" : "确定删除这条评论吗？",
      confirmLabel: label,
      destructive: true,
      onConfirm: async () => {
        try {
          await apiRequest(`/comments/${comment.id}`, { method: "DELETE", authenticated: true });
          setCommentStates((current) => ({
            ...current,
            [comment.announcementId]: {
              status: "loaded",
              items: (current[comment.announcementId]?.items ?? []).filter((item) => item.id !== comment.id),
            },
          }));
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  async function createAnnouncement(event: FormEvent) {
    event.preventDefault();
    if (isReadOnly) return;
    setBusy(true);
    setMessage("");
    try {
      await apiRequest(`/groups/${group.id}/announcements`, {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify({
          title: title.trim(),
          body: body.trim(),
          visibility: membersOnly ? "members" : "public",
          commentsEnabled: true,
        }),
      });
      setTitle("");
      setBody("");
      setShowComposer(false);
      await reloadAnnouncements();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function editAnnouncement(item: GroupAnnouncement) {
    if (isReadOnly) return;
    const titleLabel = locale === "ja" ? "お知らせのタイトル" : locale === "en" ? "Announcement title" : "公告标题";
    const editLabel = locale === "ja" ? "編集" : locale === "en" ? "Edit" : "编辑";
    const nextTitle = await appDialog.askForText({
      title: titleLabel,
      confirmLabel: editLabel,
      input: { label: titleLabel, defaultValue: item.title, required: true, maxLength: 120 },
    });
    if (!nextTitle) return;
    const bodyLabel = locale === "ja" ? "本文" : locale === "en" ? "Announcement body" : "公告正文";
    await appDialog.run({
      title: bodyLabel,
      confirmLabel: editLabel,
      input: { label: bodyLabel, defaultValue: item.body, required: true, multiline: true, maxLength: 4000 },
      onConfirm: async (nextBody) => {
        try {
          await apiRequest(`/groups/${group.id}/announcements/${item.id}`, {
            method: "PATCH",
            authenticated: true,
            ifMatch: item.version,
            body: JSON.stringify({ title: nextTitle, body: nextBody }),
          });
          await reloadAnnouncements();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  async function deleteAnnouncement(item: GroupAnnouncement) {
    if (isReadOnly) return;
    const label = locale === "ja" ? "お知らせを削除" : locale === "en" ? "Delete announcement" : "删除公告";
    await appDialog.run({
      title: label,
      message: locale === "ja" ? "お知らせを削除しますか？" : locale === "en" ? "Delete this announcement?" : "确定删除这条公告吗？",
      confirmLabel: label,
      destructive: true,
      onConfirm: async () => {
        try {
          await apiRequest(`/groups/${group.id}/announcements/${item.id}`, {
            method: "DELETE",
            authenticated: true,
          });
          setItems((current) => current.filter((value) => value.id !== item.id));
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        }
      },
    });
  }

  const sessionUserId = isReadOnly ? undefined : readSession()?.user.id;

  return (
    <section
      className={`${styles.section} ${styles.discussion}`}
      id="discussion"
      aria-labelledby="group-discussion-title"
    >
      <div className={styles.sectionHeading}>
        <div>
          <span>{t("group.communitySection")}</span>
          <h2 id="group-discussion-title">{t("group.announcements")}</h2>
        </div>
        {canManage ? (
          <button className="secondary-action compact" type="button" onClick={() => setShowComposer((value) => !value)}>
            ＋ {locale === "ja" ? "お知らせ" : locale === "en" ? "Announcement" : "发布公告"}
          </button>
        ) : null}
      </div>

      {message ? <p className={`form-message ${styles.discussionMessage}`} role="alert">{message}</p> : null}

      {showComposer ? (
        <form className={styles.composer} onSubmit={createAnnouncement}>
          <label className="form-field">
            {locale === "ja" ? "タイトル" : locale === "en" ? "Title" : "标题"}
            <input required minLength={2} maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="form-field">
            {locale === "ja" ? "本文" : locale === "en" ? "Message" : "正文"}
            <textarea required maxLength={4000} rows={5} value={body} onChange={(event) => setBody(event.target.value)} />
          </label>
          <label className="check-row">
            <input type="checkbox" checked={membersOnly} onChange={(event) => setMembersOnly(event.target.checked)} />
            <span>{locale === "ja" ? "メンバー限定" : locale === "en" ? "Members only" : "仅群成员可见"}</span>
          </label>
          <button className="primary-action compact" disabled={busy} aria-busy={busy}>
            {busy ? t("common.loading") : locale === "ja" ? "公開" : locale === "en" ? "Publish" : "发布"}
          </button>
        </form>
      ) : null}

      {items.length ? (
        <div className={styles.announcementList}>
          {items.map((item) => {
            const panelId = `group-comments-${item.id}`;
            const expanded = openId === item.id;
            const commentState = commentStates[item.id] ?? idleComments;
            return (
              <article className={styles.thread} key={item.id}>
                <div className={styles.threadCopy}>
                  <div className={styles.threadMeta}>
                    {item.pinnedAt ? (
                      <span className={styles.pinnedBadge}>{t("group.pinned")} ·</span>
                    ) : null}
                    <time dateTime={item.createdAt}>{dateFormatter.format(new Date(item.createdAt))}</time>
                    {item.authorName ? <span>· {item.authorName}</span> : null}
                  </div>
                  <h3>{item.title}</h3>
                  <p className={styles.threadBody}>{item.body}</p>
                  <div className={styles.threadActions}>
                    {!isReadOnly ? (
                      <button
                        className={`${styles.threadAction}${item.viewerLiked ? ` ${styles.liked}` : ""}`}
                        type="button"
                        onClick={() => void toggleLike(item)}
                      >
                        ♡ {item.likeCount}
                      </button>
                    ) : null}
                    {item.commentsEnabled ? (
                      <button
                        className={styles.discussionToggle}
                        type="button"
                        aria-label={locale === "zh-Hans" ? `${item.commentCount ?? 0} 评论` : undefined}
                        aria-expanded={expanded}
                        aria-controls={panelId}
                        onClick={() => openComments(item)}
                      >
                        <span aria-hidden="true">↳</span>
                        {t("group.commentCount", { count: item.commentCount ?? 0 })}
                      </button>
                    ) : null}
                    {canManage ? (
                      <>
                        <button className={styles.threadAction} type="button" onClick={() => void editAnnouncement(item)}>
                          {locale === "ja" ? "編集" : locale === "en" ? "Edit" : "编辑"}
                        </button>
                        <button className={`${styles.threadAction} ${styles.danger}`} type="button" onClick={() => void deleteAnnouncement(item)}>
                          {locale === "ja" ? "削除" : locale === "en" ? "Delete" : "删除"}
                        </button>
                      </>
                    ) : null}
                  </div>
                </div>

                {expanded ? (
                  <div className={styles.commentPanel} id={panelId}>
                    {commentState.status === "loading" ? (
                      <div className={styles.commentState} role="status">
                        <span className={styles.commentSpinner} aria-hidden="true" />
                        <span>{t("group.commentsLoading")}</span>
                      </div>
                    ) : null}
                    {commentState.status === "error" ? (
                      <div className={styles.commentState}>
                        <p className={styles.commentError} role="alert">{t("group.commentsError")}</p>
                        <button className={styles.commentRetry} type="button" onClick={() => void loadComments(item)}>
                          {t("group.commentsRetry")}
                        </button>
                      </div>
                    ) : null}
                    {commentState.status === "loaded" && commentState.items.length === 0 ? (
                      <p className={styles.commentState}>{t("group.commentsEmpty")}</p>
                    ) : null}
                    {commentState.status === "loaded" && commentState.items.length > 0 ? (
                      <ul className={styles.commentList}>
                        {commentState.items.map((comment) => (
                          <li className={styles.comment} key={comment.id}>
                            <div>
                              <div className={styles.commentHeader}>
                                <strong>{comment.author.name}</strong>
                                <time dateTime={comment.createdAt}>{dateTimeFormatter.format(new Date(comment.createdAt))}</time>
                              </div>
                              <p>{comment.body}</p>
                            </div>
                            {sessionUserId === comment.author.id ? (
                              <div className={styles.commentControls}>
                                <button className={styles.threadAction} type="button" onClick={() => void editComment(comment)}>
                                  {locale === "ja" ? "編集" : locale === "en" ? "Edit" : "编辑"}
                                </button>
                                <button className={`${styles.threadAction} ${styles.danger}`} type="button" onClick={() => void deleteComment(comment)}>
                                  {locale === "ja" ? "削除" : locale === "en" ? "Delete" : "删除"}
                                </button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {canComment && item.commentsEnabled ? (
                      <form className={styles.commentComposer} onSubmit={(event) => void postComment(event, item)}>
                        <textarea
                          required
                          maxLength={2000}
                          value={drafts[item.id] ?? ""}
                          onChange={(event) => setDrafts((current) => ({ ...current, [item.id]: event.target.value }))}
                          placeholder={locale === "ja" ? "コメントを書く" : locale === "en" ? "Write a comment" : "写下评论"}
                        />
                        <button disabled={busy} aria-busy={busy}>
                          {locale === "ja" ? "送信" : locale === "en" ? "Post" : "发送"}
                        </button>
                      </form>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className={styles.emptyCard}>
          <h3>{t("group.noAnnouncements")}</h3>
        </div>
      )}
    </section>
  );
}
