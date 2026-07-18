"use client";

import { useCallback, useEffect, useState } from "react";
import { useAppDialog } from "../../components/AppDialog";
import { Footer } from "../../components/Footer";
import { useI18n } from "../../components/I18nProvider";
import { PreviewModeLink as Link } from "../../components/PreviewModeLink";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import { ReadOnlyCommunityNotice } from "../../components/ReadOnlyCommunityNotice";
import { APIError, apiRequest, errorMessage, readSession } from "../../lib/client-api";

interface PublicProfile {
  userId: string;
  publicHandle: string;
  nickname: string;
  bio: string;
  regionId: string | null;
  preferredLocale: string;
  contentLanguages: string[];
  avatarURL: string | null;
  followerCount: number;
  viewerFollowing: boolean;
}

interface BlockedUser {
  userId: string;
}

interface PublicProfileEvent {
  id: string;
  publicSlug: string;
  status: "published" | "registration_closed" | "in_progress" | "ended" | "archived";
  title: string;
  startsAt: string;
  endsAt: string;
  region: string;
  publicArea: string;
  priceLabel: string;
  coverURL?: string | null;
}

const profileFreeLabels = new Set(["免费", "無料", "free", "jpy 0", "¥0", "￥0", "0"]);

export function HostProfile({ handle }: { handle: string }) {
  const { locale, t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const appDialog = useAppDialog();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [events, setEvents] = useState<PublicProfileEvent[]>([]);
  const [blocked, setBlocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [loadFailure, setLoadFailure] = useState<"not-found" | "error" | null>(null);
  const copy = profileCopy(locale);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadFailure(null);
    try {
      const [profileValue, eventPayload] = await Promise.all([
        apiRequest<PublicProfile>(`/profiles/${encodeURIComponent(handle)}`),
        apiRequest<{
          items: PublicProfileEvent[];
        }>(`/profiles/${encodeURIComponent(handle)}/events?limit=60`),
      ]);
      setProfile(profileValue);
      setEvents(eventPayload.items);
      if (!isReadOnly && readSession()) {
        try {
          const blockPage = await apiRequest<{ items: BlockedUser[] }>("/me/blocks", {
            authenticated: true,
          });
          setBlocked(blockPage.items.some((item) => item.userId === profileValue.userId));
        } catch {
          setBlocked(false);
        }
      }
      setMessage("");
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        setLoadFailure("not-found");
        setMessage("");
      } else {
        setLoadFailure("error");
        setMessage(errorMessage(error));
      }
    } finally {
      setLoading(false);
    }
  }, [handle, isReadOnly]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function follow() {
    if (isReadOnly || !profile || blocked) return;
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/u/${handle}`)}`);
      return;
    }
    const previous = profile;
    const next = !profile.viewerFollowing;
    setProfile({
      ...profile,
      viewerFollowing: next,
      followerCount: Math.max(0, profile.followerCount + (next ? 1 : -1)),
    });
    setBusy(true);
    try {
      await apiRequest(`/profiles/${profile.userId}/follow`, {
        method: next ? "PUT" : "DELETE",
        authenticated: true,
      });
    } catch (error) {
      setProfile(previous);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleBlock() {
    if (isReadOnly || !profile) return;
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/u/${handle}`)}`);
      return;
    }
    const next = !blocked;
    await appDialog.run({
      title: next ? copy.block : copy.unblock,
      message: (next ? copy.blockConfirm : copy.unblockConfirm).replace("{name}", profile.nickname),
      confirmLabel: next ? copy.block : copy.unblock,
      destructive: next,
      onConfirm: async () => {
        setBusy(true);
        setMessage("");
        try {
          await apiRequest(`/users/${profile.userId}/block`, {
            method: next ? "PUT" : "DELETE",
            authenticated: true,
            ...(next
              ? {
                  body: JSON.stringify({ reason: "profile_safety_boundary" }),
                }
              : {}),
          });
          setBlocked(next);
          if (next) {
            setProfile((current) =>
              current
                ? {
                    ...current,
                    viewerFollowing: false,
                    followerCount: Math.max(0, current.followerCount - (current.viewerFollowing ? 1 : 0)),
                  }
                : current,
            );
          }
          setMessage(next ? copy.blocked : copy.unblocked);
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  if (loading)
    return (
      <main className="standard-shell">
        <div className="loading-state">
          <span />
          <p>{t("common.loading")}</p>
        </div>
      </main>
    );

  if (!profile)
    return (
      <main className="standard-shell">
        <div className="empty-state">
          <h1>{loadFailure === "not-found" ? copy.notFound : copy.loadError}</h1>
          <p>{loadFailure === "not-found" ? copy.notFoundBody : message || copy.loadErrorBody}</p>
          {loadFailure === "error" ? (
            <button className="secondary-action compact" type="button" onClick={() => void load()}>
              {t("common.retry")}
            </button>
          ) : null}
        </div>
      </main>
    );

  const completed = events.filter((event) => event.status === "ended").length;
  const ownProfile = !isReadOnly && readSession()?.user.id === profile.userId;

  return (
    <main>
      <div className="standard-shell">
        <section className={`profile-hero${blocked ? " profile-blocked" : ""}`}>
          {profile.avatarURL ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="profile-avatar profile-avatar-image" src={profile.avatarURL} alt="" />
          ) : (
            <div className="profile-avatar">{Array.from(profile.nickname).slice(0, 1)}</div>
          )}
          <div>
            <span className="eyebrow-text">HOST / {profile.regionId ?? "JAPAN"}</span>
            <h1>{profile.nickname}</h1>
            <p>{profile.bio || copy.noBio}</p>
            <div className="tag-row">
              <span>@{profile.publicHandle}</span>
              <span>
                {profile.followerCount} {copy.followers}
              </span>
              {completed > 0 && (
                <span>
                  {completed} {copy.completed}
                </span>
              )}
              {profile.contentLanguages.map((language) => (
                <span key={language}>{language}</span>
              ))}
            </div>
          </div>
          {!isReadOnly ? <div className="profile-actions">
            {!ownProfile && !blocked && (
              <button
                className={`secondary-action compact follow-profile${profile.viewerFollowing ? " active" : ""}`}
                type="button"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void follow()}
              >
                {profile.viewerFollowing ? copy.following : t("event.followHost")}
              </button>
            )}
            {!ownProfile && (
              <details className="profile-safety-menu">
                <summary aria-label={copy.more}>•••</summary>
                <div>
                  <Link href={`/reports/new?targetType=user&targetId=${profile.userId}`}>
                    {copy.report}
                  </Link>
                  <button type="button" disabled={busy} aria-busy={busy} onClick={() => void toggleBlock()}>
                    {blocked ? copy.unblock : copy.block}
                  </button>
                  <Link href="/safety">{copy.safetyCenter}</Link>
                </div>
              </details>
            )}
          </div> : null}
        </section>
        {isReadOnly ? <ReadOnlyCommunityNotice /> : null}

        {blocked && (
          <aside className="blocked-profile-note">
            <span aria-hidden="true">—</span>
            <div>
              <strong>{copy.blockedTitle}</strong>
              <p>{copy.blockedBody}</p>
            </div>
          </aside>
        )}
        {message && (
          <p className="form-message group-message" role="status">
            {message}
          </p>
        )}

        {!blocked && (
          <section className="event-section">
            <div className="section-heading">
              <div>
                <span className="section-number">HOSTING</span>
                <h2>{copy.hosted}</h2>
              </div>
            </div>
            {events.length ? (
              <div className="profile-event-grid">
                {events.map((event) => (
                  <ProfileEventCard key={event.id} event={event} locale={locale} isReadOnly={isReadOnly} />
                ))}
              </div>
            ) : (
              <div className="empty-state compact-empty">
                <h2>{copy.noEvents}</h2>
              </div>
            )}
          </section>
        )}
      </div>
      <Footer />
    </main>
  );
}

function ProfileEventCard({
  event,
  locale,
  isReadOnly,
}: {
  event: PublicProfileEvent;
  locale: "zh-Hans" | "ja" | "en";
  isReadOnly: boolean;
}) {
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = Boolean(event.coverURL) && !coverFailed;

  return (
    <article className="profile-event-card">
      <Link
        className="profile-event-card-link"
        href={`/e/${event.publicSlug}`}
        prefetch={isReadOnly ? false : undefined}
      >
        <div className="profile-event-cover">
          {showCover ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={event.coverURL ?? ""}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setCoverFailed(true)}
            />
          ) : (
            <div className="profile-event-cover-fallback" aria-hidden="true">
              <span>{event.region.toLocaleUpperCase()}</span>
              <strong>{Array.from(event.title).slice(0, 2).join("")}</strong>
            </div>
          )}
          <span className="profile-event-status">{profileEventStatus(event.status, locale)}</span>
        </div>
        <div className="profile-event-copy">
          <time dateTime={event.startsAt}>{profileEventDate(event, locale)}</time>
          <h3>{event.title}</h3>
          <div className="profile-event-meta">
            <span>{event.publicArea}</span>
            <strong>{profileEventPrice(event.priceLabel, locale)}</strong>
            <span className="profile-event-arrow" aria-hidden="true">↗</span>
          </div>
        </div>
      </Link>
    </article>
  );
}

function profileEventDate(event: PublicProfileEvent, locale: "zh-Hans" | "ja" | "en") {
  const language = locale === "zh-Hans" ? "zh-CN" : locale === "ja" ? "ja-JP" : "en-US";
  const start = new Date(event.startsAt);
  const end = new Date(event.endsAt);
  const day = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Tokyo",
  }).format(start);
  const time = new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Tokyo",
  });
  const dayKey = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo",
  });
  if (dayKey.format(start) === dayKey.format(end)) {
    return `${day} · ${time.format(start)}–${time.format(end)}`;
  }
  const endDay = new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    weekday: "short",
    timeZone: "Asia/Tokyo",
  }).format(end);
  return `${day} · ${time.format(start)}–${endDay} · ${time.format(end)}`;
}

function profileEventStatus(
  status: PublicProfileEvent["status"],
  locale: "zh-Hans" | "ja" | "en",
) {
  const labels = {
    published: { "zh-Hans": "开放报名", ja: "受付中", en: "Open" },
    registration_closed: { "zh-Hans": "报名结束", ja: "受付終了", en: "Closed" },
    in_progress: { "zh-Hans": "进行中", ja: "開催中", en: "Live" },
    ended: { "zh-Hans": "已结束", ja: "終了", en: "Ended" },
    archived: { "zh-Hans": "已归档", ja: "アーカイブ", en: "Archived" },
  } as const;
  return labels[status][locale];
}

function profileEventPrice(priceLabel: string, locale: "zh-Hans" | "ja" | "en") {
  const normalized = priceLabel.trim().toLocaleLowerCase("en-US");
  if (!profileFreeLabels.has(normalized)) return priceLabel;
  if (locale === "ja") return "無料";
  if (locale === "en") return "Free";
  return "免费";
}

function profileCopy(locale: "zh-Hans" | "ja" | "en") {
  if (locale === "ja")
    return {
      notFound: "プロフィールが見つかりません",
      notFoundBody: "URLを確認するか、イベント一覧から主催者を探してください。",
      loadError: "プロフィールを読み込めませんでした",
      loadErrorBody: "通信を確認して、もう一度お試しください。",
      noBio: "自己紹介はまだありません。",
      followers: "フォロワー",
      completed: "回完了",
      following: "フォロー中",
      more: "安全とその他の操作",
      report: "非公開で報告",
      block: "このユーザーをブロック",
      unblock: "ブロックを解除",
      safetyCenter: "安全センター",
      blockConfirm: "{name} をブロックしますか？相互フォローが解除され、直接の交流が制限されます。",
      unblockConfirm: "{name} のブロックを解除しますか？",
      blocked: "ユーザーをブロックしました。",
      unblocked: "ブロックを解除しました。",
      blockedTitle: "このユーザーをブロック中です",
      blockedBody: "主催イベントや直接の交流を非表示にしています。安全メニューからいつでも解除できます。",
      hosted: "主催イベント",
      noEvents: "公開中のイベントはありません",
    };
  if (locale === "en")
    return {
      notFound: "Profile not found",
      notFoundBody: "Check the URL, or find the host again from an event.",
      loadError: "We could not load this profile",
      loadErrorBody: "Check your connection and try again.",
      noBio: "No bio yet.",
      followers: "followers",
      completed: "completed",
      following: "Following",
      more: "Safety and more actions",
      report: "Report privately",
      block: "Block this person",
      unblock: "Unblock",
      safetyCenter: "Safety center",
      blockConfirm: "Block {name}? Mutual follows will be removed and direct interaction will be limited.",
      unblockConfirm: "Unblock {name}?",
      blocked: "User blocked.",
      unblocked: "User unblocked.",
      blockedTitle: "You blocked this person",
      blockedBody: "Their hosted events and direct interactions are hidden. You can unblock them from the safety menu at any time.",
      hosted: "Hosted events",
      noEvents: "No live events",
    };
  return {
    notFound: "用户主页不存在",
    notFoundBody: "请检查链接，或从活动页重新查找主办方。",
    loadError: "暂时无法加载主页",
    loadErrorBody: "请检查网络后重试。",
    noBio: "还没有填写个人简介。",
    followers: "位关注者",
    completed: "场已完成",
    following: "已关注",
    more: "安全与更多操作",
    report: "私密举报",
    block: "拉黑该用户",
    unblock: "解除拉黑",
    safetyCenter: "安全中心",
    blockConfirm: "确定拉黑 {name} 吗？双方关注关系会解除，并限制直接互动。",
    unblockConfirm: "确定解除对 {name} 的拉黑吗？",
    blocked: "已拉黑该用户。",
    unblocked: "已解除拉黑。",
    blockedTitle: "你已拉黑该用户",
    blockedBody: "对方主办的活动与直接互动已隐藏。你可以随时从安全菜单解除拉黑。",
    hosted: "正在发起",
    noEvents: "暂时没有公开活动",
  };
}
