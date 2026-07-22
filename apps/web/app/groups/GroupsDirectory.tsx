"use client";
/* eslint-disable @next/next/no-img-element */

import { useCallback, useEffect, useMemo, useState } from "react";
import { APIError, apiRequest, errorMessage, readSession, type GroupView } from "../lib/client-api";
import { useI18n } from "../components/I18nProvider";
import { ArrowIcon, UsersIcon } from "../components/icons";
import { PreviewModeLink as Link } from "../components/PreviewModeLink";
import { usePreviewMode } from "../components/PreviewModeProvider";
import type { MessageKey } from "../i18n/messages";
import { localizedPublicTags } from "../lib/public-taxonomy";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

const CATEGORY_MESSAGE_KEYS = {
  "city-walk": "filter.categoryWalk",
  photography: "filter.categoryPhotography",
  music: "filter.categoryMusic",
  food: "filter.categoryFood",
  outdoor: "filter.categoryOutdoor",
  art: "filter.categoryArt",
  "language-exchange": "filter.categoryLanguage",
  sports: "filter.categorySports",
  games: "filter.categoryGames",
  learning: "filter.categoryLearning",
  wellness: "filter.categoryWellness",
  networking: "filter.categoryNetworking",
} as const satisfies Record<string, MessageKey>;

type GroupsDirectoryProps = {
  /** Frozen, public-only records used by deterministic product-evidence capture. */
  readonly initialItems?: readonly GroupView[];
};

export function GroupsDirectory({ initialItems }: GroupsDirectoryProps = {}) {
  const { locale, t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const [publicItems, setPublicItems] = useState<GroupView[]>(() => initialItems ? [...initialItems] : []);
  const [myItems, setMyItems] = useState<GroupView[]>([]);
  const [signedIn, setSignedIn] = useState(false);
  const [loading, setLoading] = useState(initialItems === undefined);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");

  const load = useCallback(async () => {
    setLoading(true); setMessage("");
    try {
      const session = isReadOnly ? null : readSession();
      setSignedIn(Boolean(session));
      const [publicResult, mineResult] = await Promise.allSettled([
        apiRequest<{ items: GroupView[] }>("/groups?limit=60"),
        session ? apiRequest<{ items: GroupView[] }>("/me/groups", { authenticated: true }) : Promise.resolve({ items: [] }),
      ]);
      const nextPublicItems = publicResult.status === "fulfilled" ? publicResult.value.items : [];
      const nextMyItems = mineResult.status === "fulfilled" ? mineResult.value.items : [];
      const myIDs = new Set(nextMyItems.map((group) => group.id));
      setMyItems(nextMyItems);
      setPublicItems(nextPublicItems.filter((group) => !myIDs.has(group.id)));
      if (!nextMyItems.length && !nextPublicItems.length && publicResult.status === "rejected" && !(publicResult.reason instanceof APIError && publicResult.reason.status === 404)) setMessage(errorMessage(publicResult.reason));
    } finally { setLoading(false); }
  }, [isReadOnly]);

  useEffect(() => {
    if (initialItems !== undefined) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [initialItems, load]);

  const allItems = useMemo(() => [...myItems, ...publicItems], [myItems, publicItems]);
  const categories = useMemo(
    () => Array.from(new Set(allItems.map((group) => group.categoryId).filter((value): value is string => Boolean(value)))),
    [allItems],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filterGroups = useCallback((groups: GroupView[]) => groups.filter((group) => {
    if (category !== "all" && group.categoryId !== category) return false;
    if (!normalizedQuery) return true;
    const searchable = [
      group.name,
      group.description,
      group.owner?.name,
      localizedCategoryName(group.categoryId, t),
      ...(group.tags ?? []),
    ].filter(Boolean).join(" ").toLocaleLowerCase();
    return searchable.includes(normalizedQuery);
  }), [category, normalizedQuery, t]);
  const visibleMine = useMemo(() => filterGroups(myItems), [filterGroups, myItems]);
  const visiblePublic = useMemo(() => filterGroups(publicItems), [filterGroups, publicItems]);
  const memberCount = allItems.reduce((total, group) => total + group.memberCount, 0);
  const updateCount = allItems.reduce((total, group) => total + (group.announcementSummary?.length ?? 0), 0);

  return (
    <div className="standard-shell groups-directory">
      <section className="directory-hero">
        <div className="directory-hero-copy">
          <span className="eyebrow-text">{t("group.directoryEyebrow")}</span>
          <h1>{t("group.directory")}</h1>
          <p>{t("group.directoryBody")}</p>
        </div>
        <div className="directory-hero-aside">
          {!loading && allItems.length ? (
            <div className="directory-signal-board" aria-label={t("group.networkSnapshot")}>
              <span><strong>{allItems.length}</strong><small>{t("group.communityCount", { count: allItems.length })}</small></span>
              <span><strong>{memberCount}</strong><small>{t("group.memberNetwork", { count: memberCount })}</small></span>
              <span><strong>{updateCount}</strong><small>{t("group.liveUpdates", { count: updateCount })}</small></span>
            </div>
          ) : null}
          {!isReadOnly ? (
            <Link className="primary-action compact" href="/groups/create">
              ＋ {t("group.create")}
            </Link>
          ) : null}
        </div>
      </section>
      {message && (
        <div className="inline-error" role="alert">
          <p>{message}</p>
          <button onClick={() => void load()}>{t("common.retry")}</button>
        </div>
      )}
      {loading ? (
        <div className="group-skeleton-grid" role="status" aria-live="polite" aria-busy="true">
          <span className="sr-only">{t("common.loading")}</span>
          {Array.from({ length: 6 }, (_, index) => (
            <span className="group-skeleton-card" key={index} aria-hidden="true">
              <span className="group-skeleton-artwork" />
              <span className="group-skeleton-copy" />
            </span>
          ))}
        </div>
      ) : allItems.length ? (
        <>
          <section className="group-discovery-controls" aria-label={t("group.exploreControls")}>
            <label className="group-search-field">
              <span className="sr-only">{t("group.searchLabel")}</span>
              <svg aria-hidden="true" viewBox="0 0 24 24" fill="none">
                <circle cx="10.5" cy="10.5" r="6.25" stroke="currentColor" strokeWidth="1.7" />
                <path d="m15.25 15.25 4.1 4.1" stroke="currentColor" strokeLinecap="round" strokeWidth="1.7" />
              </svg>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("group.searchPlaceholder")}
                aria-label={t("group.searchLabel")}
              />
            </label>
            <div className="group-category-rail" role="group" aria-label={t("group.interestFilter")}>
              {["all", ...categories].map((value) => (
                <button
                  key={value}
                  type="button"
                  className={category === value ? "active" : ""}
                  aria-pressed={category === value}
                  onClick={() => setCategory(value)}
                >
                  {value === "all" ? t("discover.all") : localizedCategoryName(value, t)}
                </button>
              ))}
            </div>
          </section>
          {visibleMine.length || visiblePublic.length ? (
            <>
              {signedIn && visibleMine.length ? groupSection("mine", visibleMine) : null}
              {visiblePublic.length ? groupSection("public", visiblePublic) : null}
            </>
          ) : (
            <div className="empty-state compact-empty group-filter-empty" role="status">
              <span className="spotlight-empty" />
              <h2>{t("group.noMatch")}</h2>
              <p>{t("group.noMatchBody")}</p>
              <button className="secondary-action compact" type="button" onClick={() => { setQuery(""); setCategory("all"); }}>
                {t("common.clear")}
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="empty-state compact-empty">
          <span className="spotlight-empty" />
          <h2>{t(isReadOnly || !signedIn ? "group.publicEmpty" : "group.empty")}</h2>
          <p>{t(isReadOnly || !signedIn ? "group.publicEmptyBody" : "group.emptyBody")}</p>
          <Link className="primary-action compact" href="/discover" prefetch={isReadOnly ? false : undefined}>
            {t("nav.discover")}
          </Link>
        </div>
      )}
    </div>
  );

  function groupSection(kind: "mine" | "public", groups: GroupView[]) {
    const headingID = `group-section-${kind}`;
    return (
      <section className="group-section" aria-labelledby={headingID}>
        <div className="section-heading">
          <div>
            <span className="section-number">{kind === "mine" ? t("group.myGroups") : t("group.publicDirectory")}</span>
            <h2 id={headingID}>{kind === "mine" ? t("group.myGroups") : t("group.directory")}</h2>
          </div>
          <p>{groups.length}</p>
        </div>
        <div className="group-grid">
          {groups.map((group, index) => (
            <article className={`group-tile tone-${index % 4}`} key={group.id}>
              <Link
                className="group-tile-link"
                href={`/g/${group.slug}`}
                aria-labelledby={`group-card-title-${group.id}`}
                aria-describedby={`group-card-context-${group.id}`}
                prefetch={isReadOnly ? false : undefined}
              >
                <div className="group-artwork">
                  <GroupArtwork group={group} locale={locale} />
                  <span className="group-join-badge">
                    {kind === "mine"
                      ? t("group.joined")
                      : group.joinMode === "approval"
                        ? t("group.joinModeApproval")
                        : group.joinMode === "invite_only"
                          ? t("group.joinModeInvite")
                          : t("group.joinModeOpen")}
                  </span>
                </div>
                <div className="group-tile-copy">
                  <div className="group-tile-kicker">
                    <span className="eyebrow-text">{regionName(group.regionId, locale)}</span>
                    {group.categoryId ? <span>{localizedCategoryName(group.categoryId, t)}</span> : null}
                  </div>
                  <h2 id={`group-card-title-${group.id}`}>{group.name}</h2>
                  <div className="group-tile-meta">
                    <span><UsersIcon size={16} /> {t("group.members", { count: group.memberCount })}</span>
                    <span>{t("group.capacity", { count: group.capacity })}</span>
                  </div>
                  <span className="sr-only" id={`group-card-context-${group.id}`}>
                    {accessibleGroupContext(group, kind, locale, t)}
                  </span>
                  <p>
                    {group.description || (locale === "ja"
                      ? "このグループの紹介はまだありません。"
                      : locale === "en"
                        ? "This group has not added a description yet."
                        : "这个群组还没有填写简介。")}
                  </p>
                  {group.owner?.name ? <small className="group-owner-line">{t("group.hostedBy", { name: group.owner.name })}</small> : null}
                  {group.tags?.length ? (
                    <div className="group-tag-list">
                      {localizedPublicTags(group.tags, locale, 3).map((tag) => <span key={tag}>{tag}</span>)}
                    </div>
                  ) : null}
                  {group.announcementSummary?.[0] ? (
                    <div className="group-pulse">
                      <span className="group-pulse-dot" aria-hidden="true" />
                      <small>{group.announcementSummary[0].pinnedAt ? t("group.pinnedUpdate") : t("group.latestUpdate")}</small>
                      <strong>{group.announcementSummary[0].title}</strong>
                    </div>
                  ) : null}
                </div>
                <span className="group-tile-arrow" aria-hidden="true"><ArrowIcon /></span>
              </Link>
            </article>
          ))}
        </div>
      </section>
    );
  }
}

function GroupArtwork({ group, locale }: { group: GroupView; locale: string }) {
  const [failedCoverURL, setFailedCoverURL] = useState<string | null>(null);
  const coverURL = group.coverURL;

  if (coverURL && failedCoverURL !== coverURL) {
    return (
      <img
        src={coverURL}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedCoverURL(coverURL)}
      />
    );
  }

  return (
    <div className="group-artwork-fallback" aria-hidden="true">
      <span className="group-artwork-orbit" />
      <small>{regionName(group.regionId, locale)}</small>
      <strong>{initials(group.name)}</strong>
    </div>
  );
}

function initials(name: string) { return Array.from(name.trim()).slice(0, 2).join("").toUpperCase(); }

function localizedCategoryName(categoryId: string | null | undefined, t: Translate) {
  const key = categoryId ? CATEGORY_MESSAGE_KEYS[categoryId as keyof typeof CATEGORY_MESSAGE_KEYS] : undefined;
  return key ? t(key) : t("group.genericCategory");
}

function accessibleGroupContext(group: GroupView, kind: "mine" | "public", locale: string, t: Translate) {
  const joinMode = kind === "mine"
    ? t("group.joined")
    : group.joinMode === "approval"
      ? t("group.joinModeApproval")
      : group.joinMode === "invite_only"
        ? t("group.joinModeInvite")
        : t("group.joinModeOpen");
  const update = group.announcementSummary?.[0];
  return [
    joinMode,
    regionName(group.regionId, locale),
    group.categoryId ? localizedCategoryName(group.categoryId, t) : null,
    group.owner?.name ? t("group.hostedBy", { name: group.owner.name }) : null,
    update ? `${update.pinnedAt ? t("group.pinnedUpdate") : t("group.latestUpdate")}: ${update.title}` : null,
    t("group.members", { count: group.memberCount }),
    t("group.capacity", { count: group.capacity }),
  ].filter(Boolean).join(". ");
}

function regionName(regionId: string | undefined, locale: string) {
  const region = regionId?.toLowerCase();
  if (region === "tokyo") return locale === "ja" ? "東京" : locale === "en" ? "Tokyo" : "东京";
  if (region === "kanagawa") return locale === "ja" ? "神奈川" : locale === "en" ? "Kanagawa" : "神奈川";
  if (region === "saitama") return locale === "ja" ? "埼玉" : locale === "en" ? "Saitama" : "埼玉";
  if (region === "chiba") return locale === "ja" ? "千葉" : locale === "en" ? "Chiba" : "千叶";
  if (region === "osaka") return locale === "ja" ? "大阪" : locale === "en" ? "Osaka" : "大阪";
  if (region === "kyoto") return locale === "ja" ? "京都" : locale === "en" ? "Kyoto" : "京都";
  if (region === "nationwide") return locale === "ja" ? "日本全国" : locale === "en" ? "All Japan" : "日本全国";
  return locale === "ja" ? "日本" : locale === "en" ? "Japan" : "日本";
}
