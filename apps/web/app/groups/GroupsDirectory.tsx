"use client";
/* eslint-disable @next/next/no-img-element */

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { APIError, apiRequest, errorMessage, readSession, type GroupView } from "../lib/client-api";
import { useI18n } from "../components/I18nProvider";
import { ArrowIcon, UsersIcon } from "../components/icons";
import { usePreviewMode } from "../components/PreviewModeProvider";
import { ReadOnlyCommunityNotice } from "../components/ReadOnlyCommunityNotice";

export function GroupsDirectory() {
  const { locale, t } = useI18n();
  const isReadOnly = usePreviewMode() === "read-only";
  const [items, setItems] = useState<GroupView[]>([]);
  const [mine, setMine] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setMessage("");
    try {
      const session = isReadOnly ? null : readSession();
      const [publicResult, mineResult] = await Promise.allSettled([
        apiRequest<{ items: GroupView[] }>("/groups?limit=60"),
        session ? apiRequest<{ items: GroupView[] }>("/me/groups", { authenticated: true }) : Promise.resolve({ items: [] }),
      ]);
      const publicItems = publicResult.status === "fulfilled" ? publicResult.value.items : [];
      const myItems = mineResult.status === "fulfilled" ? mineResult.value.items : [];
      const merged = [...myItems, ...publicItems.filter((group) => !myItems.some((mine) => mine.id === group.id))];
      setItems(merged);
      setMine(new Set(myItems.map((group) => group.id)));
      if (!merged.length && publicResult.status === "rejected" && !(publicResult.reason instanceof APIError && publicResult.reason.status === 404)) setMessage(errorMessage(publicResult.reason));
    } finally { setLoading(false); }
  }, [isReadOnly]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  return (
    <div className="standard-shell groups-directory">
      <section className="directory-hero">
        <div>
          <span className="eyebrow-text">{t("group.directoryEyebrow")}</span>
          <h1>{t("group.directory")}</h1>
          <p>{t("group.directoryBody")}</p>
        </div>
        {!isReadOnly ? (
          <Link className="primary-action compact" href="/groups/create">
            ＋ {t("group.create")}
          </Link>
        ) : null}
      </section>
      {isReadOnly ? <ReadOnlyCommunityNotice /> : null}
      <div className="section-heading">
        <div>
          <span className="section-number">{isReadOnly ? t("group.publicDirectory") : t("group.myGroups")}</span>
          <h2>{isReadOnly ? t("group.directory") : t("group.myGroups")}</h2>
        </div>
        <p>{items.length}</p>
      </div>
      {message && (
        <div className="inline-error" role="alert">
          <p>{message}</p>
          <button onClick={() => void load()}>{t("common.retry")}</button>
        </div>
      )}
      {loading ? (
        <div className="group-skeleton-grid">
          {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
        </div>
      ) : items.length ? (
        <div className="group-grid">
          {items.map((group, index) => (
            <article className="group-tile" key={group.id}>
              {group.coverURL ? (
                <img className="group-cover-thumb" src={group.coverURL} alt="" />
              ) : (
                <div className={`group-monogram tone-${index % 4}`}>{initials(group.name)}</div>
              )}
              <div>
                <span className="eyebrow-text">
                  {!isReadOnly && mine.has(group.id)
                    ? t("group.joined")
                    : group.joinMode === "approval"
                      ? t("group.joinModeApproval")
                      : group.joinMode === "invite_only"
                        ? t("group.joinModeInvite")
                        : t("group.joinModeOpen")}
                </span>
                <h2>{group.name}</h2>
                <p>
                  {group.description || (locale === "ja"
                    ? "このグループの紹介はまだありません。"
                    : locale === "en"
                      ? "This group has not added a description yet."
                      : "这个群组还没有填写简介。")}
                </p>
                <div className="group-tile-meta">
                  <span><UsersIcon size={16} /> {t("group.members", { count: group.memberCount })}</span>
                  <span>{t("group.capacity", { count: group.capacity })}</span>
                </div>
              </div>
              <Link
                href={`/g/${group.slug}`}
                aria-label={`${t("common.open")} ${group.name}`}
                prefetch={isReadOnly ? false : undefined}
              >
                <ArrowIcon />
              </Link>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state compact-empty">
          <span className="spotlight-empty" />
          <h2>{t("group.empty")}</h2>
          <p>{t("group.emptyBody")}</p>
          <Link className="primary-action compact" href="/discover" prefetch={isReadOnly ? false : undefined}>
            {t("nav.discover")}
          </Link>
        </div>
      )}
    </div>
  );
}

function initials(name: string) { return Array.from(name.trim()).slice(0, 2).join("").toUpperCase(); }
