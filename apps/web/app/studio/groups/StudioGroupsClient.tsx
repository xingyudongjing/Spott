"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "../../components/I18nProvider";
import { apiRequest, errorMessage, type GroupView } from "../../lib/client-api";
import { StudioNav } from "../StudioNav";

export function StudioGroupsClient() {
  const { locale, t } = useI18n();
  const [items, setItems] = useState<GroupView[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await apiRequest<{ items: GroupView[] }>("/me/groups", {
        authenticated: true,
      });
      setItems(payload.items.filter((group) => group.availableActions.includes("manage")));
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const copy =
    locale === "ja"
      ? {
          title: "グループ管理",
          body: "メンバー、招待、定員、所有権を Web と iOS で管理します。",
          empty: "管理中のグループはありません",
          members: "メンバー",
          capacity: "定員",
          mode: "参加方法",
          manage: "管理",
        }
      : locale === "en"
        ? {
            title: "Group management",
            body: "Manage members, invitations, capacity, and ownership across Web and iOS.",
            empty: "You don’t manage a group yet",
            members: "Members",
            capacity: "Capacity",
            mode: "Join mode",
            manage: "Manage",
          }
        : {
            title: "群组管理",
            body: "成员、邀请、人数上限和群主责任会在 Web 与 iOS 同步管理。",
            empty: "你还没有管理中的群组",
            members: "成员",
            capacity: "上限",
            mode: "加入方式",
            manage: "管理",
          };

  return (
    <main className="studio-shell">
      <StudioNav current="groups" />
      <section className="studio-content">
        <div className="dashboard-heading">
          <div>
            <span className="section-number">HOST STUDIO / GROUPS</span>
            <h1>{copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          <Link className="create-button" href="/groups/create">
            ＋ {t("group.create")}
          </Link>
        </div>
        {message && (
          <p className="form-message" role="alert">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{t("common.loading")}</p>
          </div>
        ) : items.length ? (
          <div className="managed-group-list">
            {items.map((group) => (
              <article key={group.id}>
                <div className="group-monogram">{Array.from(group.name).slice(0, 2).join("")}</div>
                <div>
                  <span className={`event-status status-${group.status}`}>{group.status}</span>
                  <h2>{group.name}</h2>
                  <p>{group.description}</p>
                  <dl>
                    <div>
                      <dt>{copy.members}</dt>
                      <dd>{group.memberCount}</dd>
                    </div>
                    <div>
                      <dt>{copy.capacity}</dt>
                      <dd>{group.capacity}</dd>
                    </div>
                    <div>
                      <dt>{copy.mode}</dt>
                      <dd>{joinModeLabel(group.joinMode, locale)}</dd>
                    </div>
                  </dl>
                </div>
                <div className="row-actions">
                  <Link href={`/g/${group.slug}`}>{t("common.open")}</Link>
                  <Link href={`/studio/groups/${group.id}`}>{copy.manage}</Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-state compact-empty">
            <h2>{copy.empty}</h2>
            <Link className="primary-action compact" href="/groups/create">
              {t("group.create")}
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}

function joinModeLabel(mode: GroupView["joinMode"], locale: "zh-Hans" | "ja" | "en") {
  if (mode === "approval")
    return locale === "ja" ? "承認制" : locale === "en" ? "Approval" : "审核加入";
  if (mode === "invite_only")
    return locale === "ja" ? "招待のみ" : locale === "en" ? "Invite only" : "仅限邀请";
  return locale === "ja" ? "公開" : locale === "en" ? "Open" : "公开加入";
}
