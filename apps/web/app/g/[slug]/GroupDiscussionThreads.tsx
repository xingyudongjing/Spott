"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import { useAppDialog } from "../../components/AppDialog";
import { useI18n } from "../../components/I18nProvider";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import type { Locale } from "../../i18n/messages";
import { apiRequest, errorMessage, readSession, type GroupView } from "../../lib/client-api";
import styles from "./GroupDiscussionThreads.module.css";

const BODY_LIMIT = 2000;
const PAGE_SIZE = 20;

export interface GroupDiscussionPost {
  id: string;
  groupId: string;
  author: { id: string; name: string };
  body: string;
  parentId: string | null;
  locale: Locale;
  likeCount: number;
  viewerLiked: boolean;
  replyCount: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface DiscussionPage {
  items: GroupDiscussionPost[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

type ThreadState = "loading" | "ready" | "error";
type ModerationStatus = "hidden" | "removed";

/**
 * The member-only discussion board of a group (`/groups/{id}/discussion`).
 *
 * Every route behind this component is authenticated and membership-bound, so
 * signed-out visitors, pending applicants and the public read-only preview get
 * a designed locked state instead of a request that is guaranteed to 403.
 */
export function GroupDiscussionThreads({
  group,
  onJoin,
  joinBusy = false,
}: {
  group: GroupView;
  onJoin?: () => void;
  joinBusy?: boolean;
}) {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const isReadOnly = usePreviewMode() === "read-only";
  const session = isReadOnly ? null : readSession();
  const viewerId = session?.user.id;

  const isMember = group.membershipStatus === "active" || group.membershipStatus === "muted";
  const canRead = !isReadOnly && Boolean(session) && isMember;
  const isManager = group.membershipRole === "owner" || group.membershipRole === "admin";
  const canModerate = canRead && isManager;
  const restricted = Boolean(session?.user.restrictions.includes("commentBlocked"));
  const needsPhone = canRead && group.membershipStatus === "active" && !session?.user.phoneVerified;
  const canPost = canRead && group.membershipStatus === "active" && !needsPhone && !restricted;

  const [state, setState] = useState<ThreadState>("loading");
  const [posts, setPosts] = useState<GroupDiscussionPost[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [replies, setReplies] = useState<Record<string, GroupDiscussionPost[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  const [busyPosts, setBusyPosts] = useState<Record<string, boolean>>({});
  const postKey = useRef<string | null>(null);
  const replyKeys = useRef(new Map<string, string>());

  useEffect(() => {
    if (!canRead) return;
    let active = true;
    void apiRequest<DiscussionPage>(`/groups/${group.id}/discussion?limit=${PAGE_SIZE}`, {
      authenticated: true,
    })
      .then((page) => {
        if (!active) return;
        setPosts(Array.isArray(page.items) ? page.items : []);
        setCursor(page.hasMore ? page.nextCursor ?? null : null);
        setState("ready");
      })
      .catch(() => {
        if (active) setState("error");
      });
    return () => {
      active = false;
    };
  }, [attempt, canRead, group.id]);

  const markBusy = useCallback((id: string, value: boolean) => {
    setBusyPosts((current) => ({ ...current, [id]: value }));
  }, []);

  const applyToPost = useCallback(
    (id: string, update: (post: GroupDiscussionPost) => GroupDiscussionPost) => {
      setPosts((current) => current.map((post) => (post.id === id ? update(post) : post)));
      setReplies((current) => {
        let changed = false;
        const next: Record<string, GroupDiscussionPost[]> = {};
        for (const [parentId, thread] of Object.entries(current)) {
          next[parentId] = thread.map((reply) => {
            if (reply.id !== id) return reply;
            changed = true;
            return update(reply);
          });
        }
        return changed ? next : current;
      });
    },
    [],
  );

  const dropPost = useCallback((post: GroupDiscussionPost) => {
    if (post.parentId) {
      const parentId = post.parentId;
      setReplies((current) => ({
        ...current,
        [parentId]: (current[parentId] ?? []).filter((reply) => reply.id !== post.id),
      }));
      setPosts((current) =>
        current.map((item) =>
          item.id === parentId ? { ...item, replyCount: Math.max(0, item.replyCount - 1) } : item,
        ),
      );
      return;
    }
    setPosts((current) => current.filter((item) => item.id !== post.id));
    setReplies((current) => {
      if (!(post.id in current)) return current;
      const next = { ...current };
      delete next[post.id];
      return next;
    });
  }, []);

  async function loadMore() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    setSubmitError("");
    try {
      const page = await apiRequest<DiscussionPage>(
        `/groups/${group.id}/discussion?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
        { authenticated: true },
      );
      setPosts((current) => {
        const known = new Set(current.map((post) => post.id));
        return [...current, ...page.items.filter((post) => !known.has(post.id))];
      });
      setCursor(page.hasMore ? page.nextCursor ?? null : null);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  }

  async function submitPost(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const body = draft.trim();
    if (!body || body.length > BODY_LIMIT || posting) return;
    setPosting(true);
    setSubmitError("");
    try {
      // One key per attempt so a retry after a network blip cannot double-post.
      const key = postKey.current ?? window.crypto.randomUUID();
      postKey.current = key;
      const created = await apiRequest<GroupDiscussionPost>(`/groups/${group.id}/discussion`, {
        method: "POST",
        authenticated: true,
        idempotencyKey: key,
        body: JSON.stringify({ body, locale }),
      });
      postKey.current = null;
      setPosts((current) => [created, ...current.filter((post) => post.id !== created.id)]);
      setDraft("");
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      setPosting(false);
    }
  }

  async function submitReply(formEvent: FormEvent<HTMLFormElement>, post: GroupDiscussionPost) {
    formEvent.preventDefault();
    const body = (replyDrafts[post.id] ?? "").trim();
    if (!body || body.length > BODY_LIMIT || busyPosts[post.id]) return;
    markBusy(post.id, true);
    setSubmitError("");
    try {
      const key = replyKeys.current.get(post.id) ?? window.crypto.randomUUID();
      replyKeys.current.set(post.id, key);
      const created = await apiRequest<GroupDiscussionPost>(
        `/groups/${group.id}/discussion/${post.id}/replies`,
        {
          method: "POST",
          authenticated: true,
          idempotencyKey: key,
          body: JSON.stringify({ body, locale }),
        },
      );
      replyKeys.current.delete(post.id);
      setReplies((current) => ({
        ...current,
        [post.id]: [...(current[post.id] ?? []).filter((reply) => reply.id !== created.id), created],
      }));
      setPosts((current) =>
        current.map((item) =>
          item.id === post.id ? { ...item, replyCount: item.replyCount + 1 } : item,
        ),
      );
      setReplyDrafts((current) => ({ ...current, [post.id]: "" }));
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      markBusy(post.id, false);
    }
  }

  async function toggleReplies(post: GroupDiscussionPost) {
    const open = !expanded[post.id];
    setExpanded((current) => ({ ...current, [post.id]: open }));
    if (!open || replies[post.id]) return;
    markBusy(post.id, true);
    try {
      const page = await apiRequest<DiscussionPage>(
        `/groups/${group.id}/discussion/${post.id}/replies`,
        { authenticated: true },
      );
      setReplies((current) => ({ ...current, [post.id]: page.items ?? [] }));
    } catch (error) {
      setSubmitError(errorMessage(error));
      setExpanded((current) => ({ ...current, [post.id]: false }));
    } finally {
      markBusy(post.id, false);
    }
  }

  async function toggleLike(post: GroupDiscussionPost) {
    if (!canRead || busyPosts[post.id]) return;
    const liked = !post.viewerLiked;
    markBusy(post.id, true);
    applyToPost(post.id, (current) => ({
      ...current,
      viewerLiked: liked,
      likeCount: Math.max(0, current.likeCount + (liked ? 1 : -1)),
    }));
    try {
      await apiRequest(`/groups/${group.id}/discussion/${post.id}/like`, {
        method: liked ? "PUT" : "DELETE",
        authenticated: true,
      });
    } catch (error) {
      applyToPost(post.id, (current) => ({
        ...current,
        viewerLiked: post.viewerLiked,
        likeCount: post.likeCount,
      }));
      setSubmitError(errorMessage(error));
    } finally {
      markBusy(post.id, false);
    }
  }

  async function moderate(post: GroupDiscussionPost, status: ModerationStatus) {
    if (!canModerate) return;
    if (status === "removed") {
      const confirmed = await appDialog.ask({
        title: t("group.discussionRemoveTitle"),
        message: t("group.discussionRemoveBody"),
        confirmLabel: t("group.discussionRemove"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    markBusy(post.id, true);
    setSubmitError("");
    try {
      await apiRequest(`/groups/${group.id}/discussion/${post.id}/moderation`, {
        method: "PATCH",
        authenticated: true,
        body: JSON.stringify({ status }),
      });
      dropPost(post);
    } catch (error) {
      setSubmitError(errorMessage(error));
    } finally {
      markBusy(post.id, false);
    }
  }

  const countLabel = useMemo(
    () => (posts.length ? t("group.discussionCount", { count: posts.length }) : ""),
    [posts.length, t],
  );

  return (
    <section className={styles.section} aria-label={t("group.discussionTitle")}>
      <p className={styles.eyebrow}>{t("group.discussionEyebrow")}</p>
      <div className={styles.heading}>
        <h2>{t("group.discussionTitle")}</h2>
        {canRead && state === "ready" && countLabel ? <span>{countLabel}</span> : null}
      </div>

      {canRead ? (
        <>
          <p className={styles.quietNote}>{t("group.discussionModerated")}</p>

          {group.membershipStatus === "muted" ? (
            <p className={styles.quietNote}>{t("group.discussionMuted")}</p>
          ) : null}
          {needsPhone ? (
            <p className={styles.quietNote}>
              {t("group.discussionPhoneGate")}{" "}
              <Link href={`/phone-verification?returnTo=${encodeURIComponent(`/g/${group.slug}`)}`}>
                {t("group.discussionPhoneGateAction")}
              </Link>
            </p>
          ) : null}
          {restricted && group.membershipStatus === "active" ? (
            <p className={styles.quietNote}>{t("group.discussionRestricted")}</p>
          ) : null}

          {canPost ? (
            <form className={styles.composer} onSubmit={(formEvent) => void submitPost(formEvent)}>
              <textarea
                value={draft}
                rows={3}
                maxLength={BODY_LIMIT}
                placeholder={t("group.discussionPlaceholder")}
                aria-label={t("group.discussionComposerLabel")}
                onChange={(changeEvent) => setDraft(changeEvent.target.value)}
              />
              <div className={styles.composerFooter}>
                <small className={draft.length > BODY_LIMIT ? styles.overLimit : undefined}>
                  {draft.length} / {BODY_LIMIT}
                </small>
                <button type="submit" disabled={posting || !draft.trim()}>
                  {posting ? t("group.discussionPosting") : t("group.discussionPost")}
                </button>
              </div>
            </form>
          ) : null}

          {state === "loading" ? (
            <>
              <div className={styles.skeleton} aria-hidden="true">
                <span />
                <span />
                <span />
              </div>
              <p className="sr-only" role="status">
                {t("group.discussionLoading")}
              </p>
            </>
          ) : null}

          {state === "error" ? (
            <div className={styles.errorNote} role="alert">
              <span>{t("group.discussionError")}</span>
              <button
                type="button"
                onClick={() => {
                  setState("loading");
                  setAttempt((value) => value + 1);
                }}
              >
                {t("common.retry")}
              </button>
            </div>
          ) : null}

          {state === "ready" && !posts.length ? (
            <div className={styles.locked}>
              <h3>{t("group.discussionEmptyTitle")}</h3>
              <p>{t("group.discussionEmptyBody")}</p>
            </div>
          ) : null}

          {posts.length ? (
            <ol className={styles.threadList}>
              {posts.map((post) => (
                <li key={post.id} className={styles.thread}>
                  <PostBody post={post} locale={locale} />
                  <div className={styles.actionRow}>
                    <button
                      type="button"
                      className={post.viewerLiked ? styles.liked : undefined}
                      aria-pressed={post.viewerLiked}
                      aria-label={t("group.discussionLike")}
                      disabled={Boolean(busyPosts[post.id])}
                      onClick={() => void toggleLike(post)}
                    >
                      {post.viewerLiked ? "♥" : "♡"} {post.likeCount}
                    </button>
                    <button
                      type="button"
                      aria-expanded={Boolean(expanded[post.id])}
                      onClick={() => void toggleReplies(post)}
                    >
                      {expanded[post.id]
                        ? t("group.discussionHideReplies")
                        : post.replyCount
                          ? t("group.discussionReplyCount", { count: post.replyCount })
                          : t("group.discussionReply")}
                    </button>
                    {canModerate ? (
                      <>
                        <span className={styles.spacer} />
                        <button
                          type="button"
                          className={styles.moderate}
                          disabled={Boolean(busyPosts[post.id])}
                          onClick={() => void moderate(post, "hidden")}
                        >
                          {t("group.discussionHide")}
                        </button>
                        <button
                          type="button"
                          className={styles.moderate}
                          disabled={Boolean(busyPosts[post.id])}
                          onClick={() => void moderate(post, "removed")}
                        >
                          {t("group.discussionRemove")}
                        </button>
                      </>
                    ) : null}
                  </div>

                  {expanded[post.id] ? (
                    <>
                      {replies[post.id]?.length ? (
                        <ol className={styles.replyList}>
                          {replies[post.id]!.map((reply) => (
                            <li key={reply.id}>
                              <PostBody post={reply} locale={locale} />
                              {canModerate ? (
                                <div className={styles.actionRow}>
                                  <span className={styles.spacer} />
                                  <button
                                    type="button"
                                    className={styles.moderate}
                                    disabled={Boolean(busyPosts[reply.id])}
                                    onClick={() => void moderate(reply, "hidden")}
                                  >
                                    {t("group.discussionHide")}
                                  </button>
                                  <button
                                    type="button"
                                    className={styles.moderate}
                                    disabled={Boolean(busyPosts[reply.id])}
                                    onClick={() => void moderate(reply, "removed")}
                                  >
                                    {t("group.discussionRemove")}
                                  </button>
                                </div>
                              ) : null}
                            </li>
                          ))}
                        </ol>
                      ) : (
                        <p className={styles.quietNote}>
                          {busyPosts[post.id] && !replies[post.id]
                            ? t("group.discussionLoading")
                            : t("group.discussionNoReplies")}
                        </p>
                      )}
                      {canPost ? (
                        <form
                          className={styles.replyComposer}
                          onSubmit={(formEvent) => void submitReply(formEvent, post)}
                        >
                          <textarea
                            value={replyDrafts[post.id] ?? ""}
                            rows={2}
                            maxLength={BODY_LIMIT}
                            placeholder={t("group.discussionReplyPlaceholder")}
                            aria-label={t("group.discussionReplyLabel", {
                              name: post.author.name,
                            })}
                            onChange={(changeEvent) =>
                              setReplyDrafts((current) => ({
                                ...current,
                                [post.id]: changeEvent.target.value,
                              }))
                            }
                          />
                          <button
                            type="submit"
                            disabled={
                              Boolean(busyPosts[post.id]) || !(replyDrafts[post.id] ?? "").trim()
                            }
                          >
                            {t("group.discussionSendReply")}
                          </button>
                        </form>
                      ) : null}
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}

          {cursor ? (
            <button
              type="button"
              className={styles.loadMore}
              disabled={loadingMore}
              aria-busy={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? t("common.loading") : t("group.discussionMore")}
            </button>
          ) : null}

          {submitError ? (
            <p className={styles.submitError} role="alert">
              {submitError}
            </p>
          ) : null}
        </>
      ) : (
        <LockedState
          group={group}
          isReadOnly={isReadOnly}
          signedIn={Boolean(viewerId)}
          onJoin={onJoin}
          joinBusy={joinBusy}
        />
      )}
    </section>
  );
}

function LockedState({
  group,
  isReadOnly,
  signedIn,
  onJoin,
  joinBusy,
}: {
  group: GroupView;
  isReadOnly: boolean;
  signedIn: boolean;
  onJoin?: () => void;
  joinBusy: boolean;
}) {
  const { t } = useI18n();

  if (isReadOnly) {
    return (
      <div className={styles.locked}>
        <h3>{t("group.discussionLockedTitle")}</h3>
        <p>{t("preview.communityReadOnly")}</p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div className={styles.locked}>
        <h3>{t("group.discussionSignInTitle")}</h3>
        <p>{t("group.discussionSignInBody")}</p>
        <Link href={`/login?returnTo=${encodeURIComponent(`/g/${group.slug}`)}`}>
          {t("group.discussionSignIn")}
        </Link>
      </div>
    );
  }

  if (group.membershipStatus === "pending") {
    return (
      <div className={styles.locked}>
        <h3>{t("group.discussionPendingTitle")}</h3>
        <p>{t("group.discussionPendingBody")}</p>
      </div>
    );
  }

  const joinable = group.availableActions.includes("joinGroup") && Boolean(onJoin);
  return (
    <div className={styles.locked}>
      <h3>{t("group.discussionLockedTitle")}</h3>
      <p>{t("group.discussionLockedBody")}</p>
      {joinable ? (
        <button type="button" disabled={joinBusy} aria-busy={joinBusy} onClick={onJoin}>
          {joinBusy ? t("common.loading") : t("group.join")}
        </button>
      ) : null}
    </div>
  );
}

function PostBody({ post, locale }: { post: GroupDiscussionPost; locale: Locale }) {
  return (
    <article className={styles.post}>
      <header>
        <strong>{post.author.name}</strong>
        <time dateTime={post.createdAt}>{postTime(post.createdAt, locale)}</time>
      </header>
      <p>{post.body}</p>
    </article>
  );
}

function postTime(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const intl = locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
  return new Intl.DateTimeFormat(intl, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(parsed);
}
