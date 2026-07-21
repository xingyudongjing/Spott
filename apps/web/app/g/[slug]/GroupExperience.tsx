"use client";

import { useCallback, useEffect, useState } from "react";

import { EventCard } from "../../components/EventCard";
import { Footer } from "../../components/Footer";
import { useI18n } from "../../components/I18nProvider";
import { PreviewModeLink as Link } from "../../components/PreviewModeLink";
import { usePreviewMode } from "../../components/PreviewModeProvider";
import { ReadOnlyCommunityNotice } from "../../components/ReadOnlyCommunityNotice";
import { normalizeEvent } from "../../lib/api";
import {
  APIError,
  apiRequest,
  errorMessage,
  readSession,
  type GroupAnnouncement,
  type GroupView,
} from "../../lib/client-api";
import type { EventView } from "../../lib/demo-data";
import { eventDate, eventTime } from "../../lib/format";
import { localizedPublicTags } from "../../lib/public-taxonomy";
import styles from "./GroupDetail.module.css";
import { GroupDetailArtwork } from "./GroupDetailArtwork";
import { GroupDiscussion } from "./GroupDiscussion";

export function GroupExperience({ slug }: { slug: string }) {
  const { locale, t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const [group, setGroup] = useState<GroupView | null>(null);
  const [events, setEvents] = useState<EventView[]>([]);
  const [announcements, setAnnouncements] = useState<GroupAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const value = await apiRequest<GroupView>(`/groups/${encodeURIComponent(slug)}`);
      setGroup(value);
      const [eventResult, announcementResult] = await Promise.allSettled([
        apiRequest<{
          items: Array<Partial<EventView> & Pick<EventView, "id" | "publicSlug" | "title">>;
        }>("/events/search?limit=100"),
        apiRequest<{ items: GroupAnnouncement[] }>(`/groups/${value.id}/announcements?limit=30`),
      ]);

      if (eventResult.status === "fulfilled") {
        setEvents(
          eventResult.value.items
            .map(normalizeEvent)
            .filter((event) => event.groupId === value.id)
            .sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt)),
        );
      }
      if (announcementResult.status === "fulfilled") {
        setAnnouncements(announcementResult.value.items);
      } else if (!(
        announcementResult.reason instanceof APIError && announcementResult.reason.status === 404
      )) {
        setMessage(errorMessage(announcementResult.reason));
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function join() {
    if (isReadOnly || !group) return;
    const session = readSession();
    if (!session) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/g/${slug}`)}`);
      return;
    }
    if (!session.user.phoneVerified) {
      window.location.assign(`/phone-verification?returnTo=${encodeURIComponent(`/g/${slug}`)}`);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const inviteCode = new URLSearchParams(window.location.search).get("invite");
      const result = await apiRequest<{ status: string }>(`/groups/${group.id}/join`, {
        method: "POST",
        authenticated: true,
        idempotent: true,
        body: JSON.stringify(inviteCode ? { inviteCode } : {}),
      });
      setGroup({
        ...group,
        membershipStatus: result.status as GroupView["membershipStatus"],
        memberCount: result.status === "active" ? group.memberCount + 1 : group.memberCount,
        availableActions: group.availableActions.filter((action) => action !== "joinGroup"),
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function follow() {
    if (isReadOnly || !group) return;
    if (!readSession()) {
      window.location.assign(`/login?returnTo=${encodeURIComponent(`/g/${slug}`)}`);
      return;
    }
    const next = !group.viewerFollowing;
    setGroup({ ...group, viewerFollowing: next });
    setBusy(true);
    setMessage("");
    try {
      await apiRequest(`/groups/${group.id}/follow`, {
        method: next ? "PUT" : "DELETE",
        authenticated: true,
      });
    } catch (error) {
      setGroup(group);
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <main className="standard-shell">
        <div className="loading-state">
          <span />
          <p>{t("common.loading")}</p>
        </div>
      </main>
    );
  }

  if (!group) {
    return (
      <main className="standard-shell">
        <div className="empty-state">
          <h1>
            {locale === "ja" ? "グループが見つかりません" : locale === "en" ? "Group not found" : "群组不存在"}
          </h1>
          <p>{message}</p>
          <Link className="primary-action compact" href="/groups" prefetch={isReadOnly ? false : undefined}>
            {t("group.directory")}
          </Link>
        </div>
      </main>
    );
  }

  const joined = group.membershipStatus === "active" || !group.availableActions.includes("joinGroup");
  const nextEvent = events[0];
  const highlightedAnnouncement = announcements.find((item) => item.pinnedAt) ?? announcements[0];
  const tags = localizedPublicTags(group.tags ?? [], locale);

  return (
    <main>
      <div className={styles.shell}>
        <section className={styles.hero} aria-labelledby="group-title">
          <GroupDetailArtwork group={group} />
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>
              {t("group.detailEyebrow", { region: t(regionMessageKey(group.regionId)) })}
            </p>
            <h1 id="group-title">{group.name}</h1>
            {group.owner ? (
              <p className={styles.ownerLine}>
                <span>{t("group.hostLabel")}</span>
                <Link href={`/u/${group.owner.handle}`} prefetch={isReadOnly ? false : undefined}>
                  {group.owner.name}
                </Link>
              </p>
            ) : null}
            <ul className={styles.facts} aria-label={t("group.detailEyebrow", { region: t(regionMessageKey(group.regionId)) })}>
              <li>{t("group.members", { count: group.memberCount })}</li>
              <li>{t("group.capacity", { count: group.capacity })}</li>
              <li>{joinModeLabel(group.joinMode, locale)}</li>
              {tags.map((tag) => <li key={tag}>{tag}</li>)}
            </ul>

            {!isReadOnly ? (
              <div className="group-hero-actions">
                {joined ? (
                  <span className="joined-badge">
                    ✓ {group.membershipStatus === "pending" ? t("group.pending") : t("group.joined")}
                  </span>
                ) : (
                  <button
                    className="primary-action compact"
                    type="button"
                    onClick={() => void join()}
                    disabled={busy}
                    aria-busy={busy}
                  >
                    {busy ? t("common.loading") : t("group.join")}
                  </button>
                )}
                <button
                  className={`secondary-action compact${group.viewerFollowing ? " active" : ""}`}
                  type="button"
                  onClick={() => void follow()}
                  disabled={busy}
                  aria-busy={busy}
                >
                  {followLabel(Boolean(group.viewerFollowing), locale)}
                </button>
              </div>
            ) : null}

            {nextEvent ? (
              <Link className={styles.highlight} href={`/e/${nextEvent.publicSlug}`} prefetch={isReadOnly ? false : undefined}>
                <span>
                  <span>{t("group.nextGathering")}</span>
                  <strong>{nextEvent.title}</strong>
                  <small>
                    {eventDate(nextEvent.startsAt, locale, nextEvent.displayTimeZone)} · {eventTime(nextEvent.startsAt, nextEvent.endsAt, locale, nextEvent.displayTimeZone)}
                  </small>
                </span>
                <span className={styles.highlightArrow} aria-hidden="true">↗</span>
              </Link>
            ) : highlightedAnnouncement ? (
              <a className={styles.highlight} href="#discussion">
                <span>
                  <span>{highlightedAnnouncement.pinnedAt ? t("group.pinnedUpdate") : t("group.latestUpdate")}</span>
                  <strong>{highlightedAnnouncement.title}</strong>
                  <small>{highlightedAnnouncement.authorName ?? group.owner?.name}</small>
                </span>
                <span className={styles.highlightArrow} aria-hidden="true">↓</span>
              </a>
            ) : null}
          </div>
        </section>

        <nav className={styles.sectionNav} aria-label={t("group.sectionNavigation")}>
          <a href="#about">{t("group.navAbout")}</a>
          <a href="#events">{t("group.navEvents")}</a>
          <a href="#discussion">{t("group.navDiscussion")}</a>
        </nav>

        {isReadOnly ? <ReadOnlyCommunityNotice /> : null}
        {message ? <p className="form-message group-message" role="alert">{message}</p> : null}

        <div className={styles.contentGrid}>
          <div className={styles.mainColumn}>
            <section className={styles.section} id="events" aria-labelledby="group-events-title">
              <div className={styles.sectionHeading}>
                <div>
                  <span>{t("group.upNext")}</span>
                  <h2 id="group-events-title">{t("group.events")}</h2>
                </div>
              </div>
              {events.length ? (
                <div className={styles.eventList}>
                  {events.map((event) => <EventCard key={event.id} event={event} />)}
                </div>
              ) : (
                <div className={styles.emptyCard}>
                  <h3>{t("group.noUpcomingTitle")}</h3>
                  <p>{t("group.noUpcomingBody")}</p>
                </div>
              )}
            </section>
            <GroupDiscussion group={group} initialItems={announcements} />
          </div>

          <aside className={styles.aboutPanel}>
            <section id="about" aria-labelledby="group-about-title">
              <h2 id="group-about-title">{t("group.aboutTitle")}</h2>
              <p>{group.description?.trim() ? group.description : t("group.noDescription")}</p>
            </section>
            {group.owner ? (
              <section aria-labelledby="group-host-title">
                <h3 id="group-host-title">{t("group.hostLabel")}</h3>
                <Link className={styles.hostCard} href={`/u/${group.owner.handle}`} prefetch={isReadOnly ? false : undefined}>
                  <span className={styles.hostMark} aria-hidden="true">
                    {Array.from(group.owner.name).filter((value) => value.trim()).slice(0, 1).join("")}
                  </span>
                  <span>
                    <small>{t("group.hostedBy", { name: group.owner.name })}</small>
                    <strong>{group.owner.name}</strong>
                  </span>
                </Link>
              </section>
            ) : null}
            <section aria-labelledby="group-rules-title">
              <h3 id="group-rules-title">{t("group.rulesTitle")}</h3>
              <p>{group.rules?.trim() || t("group.noRules")}</p>
            </section>
          </aside>
        </div>
      </div>
      <Footer />
    </main>
  );
}

function followLabel(following: boolean, locale: "zh-Hans" | "ja" | "en") {
  if (following) return locale === "ja" ? "フォロー中" : locale === "en" ? "Following" : "已关注";
  return locale === "ja" ? "グループをフォロー" : locale === "en" ? "Follow group" : "关注群组";
}

function joinModeLabel(mode: GroupView["joinMode"], locale: "zh-Hans" | "ja" | "en") {
  if (mode === "approval") return locale === "ja" ? "承認制" : locale === "en" ? "Approval required" : "审核加入";
  if (mode === "invite_only") return locale === "ja" ? "招待のみ" : locale === "en" ? "Invite only" : "仅限邀请";
  return locale === "ja" ? "誰でも参加" : locale === "en" ? "Open to join" : "公开加入";
}

function regionMessageKey(regionId: string | null | undefined) {
  switch (regionId) {
    case "tokyo": return "region.tokyo" as const;
    case "kanagawa": return "region.kanagawa" as const;
    case "saitama": return "region.saitama" as const;
    case "chiba": return "region.chiba" as const;
    case "osaka": return "region.osaka" as const;
    case "kyoto": return "region.kyoto" as const;
    default: return "region.all" as const;
  }
}
