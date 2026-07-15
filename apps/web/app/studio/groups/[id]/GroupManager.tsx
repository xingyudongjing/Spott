"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useAppDialog } from "../../../components/AppDialog";
import { useI18n } from "../../../components/I18nProvider";
import type { Locale } from "../../../i18n/messages";
import { APIError, apiRequest, errorMessage, type GroupView } from "../../../lib/client-api";
import { uploadProcessedImage } from "../../../lib/media-upload";
import { StudioNav } from "../../StudioNav";

interface InviteView {
  id: string;
  groupId: string;
  code: string;
  expiresAt: string;
}

interface TransferView {
  id: string;
  groupId?: string;
  fromUserId?: string;
  toUserId?: string;
  state?: string;
  expiresAt?: string;
  cooldownUntil?: string;
}

interface GroupMemberView {
  user: { id: string; name: string; handle: string };
  role: "owner" | "admin" | "member";
  status: "active" | "muted" | "pending" | "removed";
  joinedAt: string;
  updatedAt: string;
}

interface GroupMembersResponse {
  items: GroupMemberView[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function GroupManager({ groupId }: { groupId: string }) {
  const { locale, t } = useI18n();
  const appDialog = useAppDialog();
  const [group, setGroup] = useState<GroupView | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [maxUses, setMaxUses] = useState(1);
  const [expiresInHours, setExpiresInHours] = useState(168);
  const [invite, setInvite] = useState<InviteView | null>(null);
  const [targetUserId, setTargetUserId] = useState("");
  const [transfer, setTransfer] = useState<TransferView | null>(null);
  const [members, setMembers] = useState<GroupMemberView[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersHasMore, setMembersHasMore] = useState(false);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [memberBusyId, setMemberBusyId] = useState("");
  const [coverBusy, setCoverBusy] = useState(false);

  const loadActiveTransfer = useCallback(async () => {
    try {
      const active = await apiRequest<TransferView>(`/groups/${groupId}/transfers/active`, {
        authenticated: true,
      });
      setTransfer(active);
      window.localStorage.setItem(`spott.group-transfer.${groupId}`, JSON.stringify(active));
    } catch (error) {
      if (error instanceof APIError && error.status === 404) {
        setTransfer(null);
        window.localStorage.removeItem(`spott.group-transfer.${groupId}`);
        return;
      }
      if (error instanceof APIError && error.status === 403) return;
      throw error;
    }
  }, [groupId]);

  const loadMembers = useCallback(
    async (cursor?: string) => {
      setMembersLoading(true);
      try {
        const query = new URLSearchParams({ limit: "100" });
        if (cursor) query.set("cursor", cursor);
        const result = await apiRequest<GroupMembersResponse>(
          `/groups/${groupId}/members?${query.toString()}`,
          { authenticated: true },
        );
        setMembers((current) => (cursor ? [...current, ...result.items] : result.items));
        setMembersHasMore(result.hasMore);
        setMembersCursor(result.nextCursor);
      } catch (error) {
        setMessage(errorMessage(error));
      } finally {
        setMembersLoading(false);
      }
    },
    [groupId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const value = await apiRequest<GroupView>(`/groups/${groupId}`, { authenticated: true });
      setGroup(value);
      setMessage("");
      await loadActiveTransfer();
      if (
        value.availableActions.includes("manage") ||
        value.membershipRole === "owner" ||
        value.membershipRole === "admin"
      ) {
        await loadMembers();
      } else {
        setMembers([]);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [groupId, loadActiveTransfer, loadMembers]);

  useEffect(() => {
    const transferId = new URLSearchParams(window.location.search).get("transfer");
    const saved = window.localStorage.getItem(`spott.group-transfer.${groupId}`);
    const timer = window.setTimeout(() => {
      if (transferId) setTransfer({ id: transferId, groupId });
      else if (saved) {
        try {
          setTransfer(JSON.parse(saved) as TransferView);
        } catch {
          window.localStorage.removeItem(`spott.group-transfer.${groupId}`);
        }
      }
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [groupId, load]);

  const copy = groupManagerCopy(locale);
  const canManage = group?.availableActions.includes("manage") ?? false;

  function rememberTransfer(value: TransferView | null) {
    setTransfer(value);
    if (value) window.localStorage.setItem(`spott.group-transfer.${groupId}`, JSON.stringify(value));
    else window.localStorage.removeItem(`spott.group-transfer.${groupId}`);
  }

  async function createInvite() {
    setBusy(true);
    setMessage("");
    try {
      const result = await apiRequest<InviteView>(`/groups/${groupId}/invites`, {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ maxUses, expiresInHours }),
      });
      setInvite(result);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function increaseCapacity() {
    if (!group) return;
    setBusy(true);
    setMessage("");
    try {
      const quote = await apiRequest<{ id: string; amount: number }>("/quotes", {
        method: "POST",
        authenticated: true,
        body: JSON.stringify({ purpose: "group_capacity", resourceId: group.id }),
      });
      await appDialog.run({
        title: copy.increase,
        message: tr(
          locale,
          `使用 ${quote.amount} 积分把人数上限从 ${group.capacity} 提升到 ${group.capacity + 50}，是否继续？`,
          `${quote.amount}ポイントを使い、定員を${group.capacity}人から${group.capacity + 50}人に増やしますか？`,
          `Use ${quote.amount} points to increase capacity from ${group.capacity} to ${group.capacity + 50}?`,
        ),
        confirmLabel: copy.increase,
        onConfirm: async () => {
          const updated = await apiRequest<GroupView>(`/groups/${group.id}/capacity-purchases`, {
            method: "POST",
            authenticated: true,
            idempotent: true,
            body: JSON.stringify({ quoteId: quote.id }),
          });
          setGroup(updated);
          setMessage(copy.capacityDone);
        },
      });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function uploadCover(file: File) {
    if (!group) return;
    setCoverBusy(true);
    setMessage("");
    try {
      const result = await uploadProcessedImage<{ url: string; version: number }>({
        file,
        purpose: "group_cover",
        attachPath: (assetId) => `/media/${assetId}/attach/group/${groupId}`,
      });
      setGroup({ ...group, coverURL: result.url, version: result.version });
      setMessage(
        tr(locale, "社群封面已更新。", "コミュニティカバーを更新しました。", "Community cover updated."),
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setCoverBusy(false);
    }
  }

  async function startTransfer() {
    if (!group || !targetUserId.match(/^[0-9a-f-]{36}$/i)) {
      setMessage(copy.targetInvalid);
      return;
    }
    await appDialog.run({
      title: copy.transfer,
      message: copy.transferConfirm,
      confirmLabel: copy.startTransfer,
      onConfirm: async () => {
        setBusy(true);
        setMessage("");
        try {
          const result = await apiRequest<TransferView>(`/groups/${group.id}/transfers`, {
            method: "POST",
            authenticated: true,
            body: JSON.stringify({ targetUserId }),
          });
          rememberTransfer(result);
          setMessage(copy.transferStarted);
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function updateMember(
    member: GroupMemberView,
    patch: { role?: "admin" | "member"; status?: "active" | "muted" | "removed" },
  ) {
    const applyUpdate = async () => {
      setMemberBusyId(member.user.id);
      setMessage("");
      try {
        await apiRequest(`/groups/${groupId}/members/${member.user.id}`, {
          method: "PATCH",
          authenticated: true,
          body: JSON.stringify(patch),
        });
        const refreshedGroup = await apiRequest<GroupView>(`/groups/${groupId}`, {
          authenticated: true,
        });
        setGroup(refreshedGroup);
        await loadMembers();
        setMessage(
          tr(locale, "成员权限已更新。", "メンバー権限を更新しました。", "Member access updated."),
        );
      } catch (error) {
        setMessage(errorMessage(error));
        if (patch.status === "removed") throw error;
      } finally {
        setMemberBusyId("");
      }
    };
    if (patch.status === "removed") {
      const removeLabel = tr(locale, "移出群组", "グループから削除", "Remove member");
      await appDialog.run({
        title: removeLabel,
        message: tr(
          locale,
          `确定把 ${member.user.name} 移出群组吗？`,
          `${member.user.name}さんをグループから削除しますか？`,
          `Remove ${member.user.name} from this group?`,
        ),
        confirmLabel: removeLabel,
        destructive: true,
        onConfirm: applyUpdate,
      });
      return;
    }
    await applyUpdate();
  }

  async function transferAction(action: "accept" | "complete" | "cancel") {
    if (!transfer) return;
    const applyAction = async (reason?: string) => {
      setBusy(true);
      setMessage("");
      try {
        const result = await apiRequest<TransferView>(
          `/groups/${groupId}/transfers/${transfer.id}/${action}`,
          {
            method: "POST",
            authenticated: true,
            body: action === "cancel" ? JSON.stringify({ reason }) : undefined,
          },
        );
        if (result.state === "completed" || result.state === "cancelled") rememberTransfer(null);
        else rememberTransfer(result);
        setMessage(
          action === "accept"
            ? copy.transferAccepted
            : action === "complete"
              ? copy.transferCompleted
              : copy.transferCancelled,
        );
        await load();
      } catch (error) {
        setMessage(errorMessage(error));
        if (action === "cancel") throw error;
      } finally {
        setBusy(false);
      }
    };
    if (action === "cancel") {
      await appDialog.run({
        title: copy.cancelTransfer,
        confirmLabel: copy.cancelTransfer,
        destructive: true,
        input: { label: copy.cancelReason, required: true, minLength: 1, multiline: true },
        onConfirm: applyAction,
      });
      return;
    }
    await applyAction();
  }

  async function scheduleDissolution() {
    await appDialog.run({
      title: copy.dissolve,
      message: copy.dissolutionConfirm,
      confirmLabel: copy.scheduleDissolution,
      destructive: true,
      input: { label: copy.dissolutionReason, required: true, minLength: 3, multiline: true },
      onConfirm: async (reason) => {
        setBusy(true);
        setMessage("");
        try {
          await apiRequest(`/groups/${groupId}/dissolution`, {
            method: "POST",
            authenticated: true,
            body: JSON.stringify({ reason }),
          });
          setMessage(copy.dissolutionScheduled);
          await load();
        } catch (error) {
          setMessage(errorMessage(error));
          throw error;
        } finally {
          setBusy(false);
        }
      },
    });
  }

  async function dissolutionAction(action: "cancel" | "finalize") {
    setBusy(true);
    setMessage("");
    try {
      await apiRequest(`/groups/${groupId}/dissolution${action === "finalize" ? "/finalize" : ""}`, {
        method: action === "cancel" ? "DELETE" : "POST",
        authenticated: true,
      });
      setMessage(action === "cancel" ? copy.dissolutionCancelled : copy.dissolutionFinalized);
      if (action === "finalize") window.location.assign("/studio/groups");
      else await load();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const inviteURL =
    invite && group ? `${typeof window === "undefined" ? "https://spott.jp" : window.location.origin}/g/${group.slug}?invite=${encodeURIComponent(invite.code)}` : "";
  const transferURL =
    transfer && group ? `${typeof window === "undefined" ? "https://spott.jp" : window.location.origin}/studio/groups/${group.id}?transfer=${encodeURIComponent(transfer.id)}` : "";

  return (
    <main className="studio-shell">
      <StudioNav current="groups" />
      <section className="studio-content group-manager-page">
        <div className="dashboard-heading">
          <div>
            <Link className="back-link" href="/studio/groups">
              ← {copy.back}
            </Link>
            <span className="section-number">HOST STUDIO / COMMUNITY</span>
            <h1>{group?.name ?? copy.title}</h1>
            <p>{copy.body}</p>
          </div>
          {group && (
            <Link className="secondary-action compact" href={`/g/${group.slug}`}>
              {t("common.open")}
            </Link>
          )}
        </div>
        {message && (
          <p className="form-message" role="status">
            {message}
          </p>
        )}
        {loading ? (
          <div className="loading-state">
            <span />
            <p>{t("common.loading")}</p>
          </div>
        ) : !group ? (
          <div className="empty-state compact-empty">
            <h2>{copy.notFound}</h2>
          </div>
        ) : (
          <>
            <div className="metric-grid studio-metrics">
              <div>
                <span>{copy.members}</span>
                <strong>{group.memberCount}</strong>
              </div>
              <div>
                <span>{copy.capacity}</span>
                <strong>{group.capacity}</strong>
              </div>
              <div>
                <span>{copy.status}</span>
                <strong className="group-status-value">{group.status}</strong>
              </div>
            </div>

            {canManage && (
              <section className="management-card member-roster-card">
                <div className="member-roster-heading">
                  <div>
                    <span className="section-number">MEMBER DIRECTORY</span>
                    <h2>{copy.members}</h2>
                    <p>
                      {tr(
                        locale,
                        "管理审核、管理员权限、禁言与移除；变更会同步到 iOS。",
                        "承認、管理者権限、ミュート、削除を管理します。変更はiOSにも同期されます。",
                        "Manage approvals, admin access, muting, and removal. Changes sync to iOS.",
                      )}
                    </p>
                  </div>
                  <span className="member-count-pill">{members.length}</span>
                </div>
                {membersLoading && !members.length ? (
                  <div className="loading-state compact-loading">
                    <span />
                    <p>{t("common.loading")}</p>
                  </div>
                ) : members.length ? (
                  <div className="member-roster-list">
                    {members.map((member) => {
                      const isOwner = member.role === "owner";
                      const canChangeRole = group.membershipRole === "owner" && !isOwner;
                      const isBusy = memberBusyId === member.user.id;
                      return (
                        <article className="member-roster-row" key={member.user.id}>
                          <div className="member-avatar" aria-hidden="true">
                            {(member.user.name || member.user.handle || "S").slice(0, 1).toUpperCase()}
                          </div>
                          <div className="member-identity">
                            <strong>{member.user.name}</strong>
                            <span>@{member.user.handle}</span>
                            <small>
                              {tr(locale, "加入于", "参加日", "Joined")} {" "}
                              {new Intl.DateTimeFormat(intlLocale(locale), {
                                dateStyle: "medium",
                              }).format(new Date(member.joinedAt))}
                            </small>
                          </div>
                          <div className="member-role-control">
                            <span className={`member-status status-${member.status}`}>
                              {memberStatusLabel(locale, member.status)}
                            </span>
                            <select
                              aria-label={`${member.user.name} ${tr(locale, "角色", "役割", "role")}`}
                              value={member.role}
                              disabled={!canChangeRole || isBusy}
                              onChange={(event) =>
                                void updateMember(member, {
                                  role: event.target.value as "admin" | "member",
                                })
                              }
                            >
                              {isOwner && <option value="owner">{tr(locale, "群主", "オーナー", "Owner")}</option>}
                              <option value="admin">{tr(locale, "管理员", "管理者", "Admin")}</option>
                              <option value="member">{tr(locale, "成员", "メンバー", "Member")}</option>
                            </select>
                          </div>
                          {!isOwner && (
                            <div className="member-row-actions">
                              {member.status === "pending" && (
                                <button
                                  disabled={isBusy}
                                  onClick={() => void updateMember(member, { status: "active" })}
                                >
                                  {tr(locale, "通过", "承認", "Approve")}
                                </button>
                              )}
                              {member.status === "active" && (
                                <button
                                  disabled={isBusy}
                                  onClick={() => void updateMember(member, { status: "muted" })}
                                >
                                  {tr(locale, "禁言", "ミュート", "Mute")}
                                </button>
                              )}
                              {member.status === "muted" && (
                                <button
                                  disabled={isBusy}
                                  onClick={() => void updateMember(member, { status: "active" })}
                                >
                                  {tr(locale, "恢复", "解除", "Restore")}
                                </button>
                              )}
                              {member.status !== "removed" && (
                                <button
                                  className="danger-text"
                                  disabled={isBusy}
                                  onClick={() => void updateMember(member, { status: "removed" })}
                                >
                                  {tr(locale, "移除", "削除", "Remove")}
                                </button>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ) : (
                  <p>{tr(locale, "暂无成员。", "メンバーはいません。", "No members yet.")}</p>
                )}
                {membersHasMore && membersCursor && (
                  <button
                    className="secondary-action compact"
                    disabled={membersLoading}
                    onClick={() => void loadMembers(membersCursor)}
                  >
                    {membersLoading
                      ? t("common.loading")
                      : tr(locale, "加载更多", "さらに表示", "Load more")}
                  </button>
                )}
              </section>
            )}

            {transfer && (
              <section className="management-card transfer-card">
                <span className="section-number">OWNERSHIP TRANSFER</span>
                <h2>{copy.activeTransfer}</h2>
                <p>
                  {copy.transferId}: <code>{transfer.id}</code>
                </p>
                {transfer.cooldownUntil && (
                  <p>
                    {copy.cooldown}:{" "}
                    {new Intl.DateTimeFormat(intlLocale(locale), {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(transfer.cooldownUntil))}
                  </p>
                )}
                <div className="management-actions">
                  <button disabled={busy} onClick={() => void transferAction("accept")}>
                    {copy.acceptTransfer}
                  </button>
                  <button disabled={busy} onClick={() => void transferAction("complete")}>
                    {copy.completeTransfer}
                  </button>
                  <button
                    className="danger-text"
                    disabled={busy}
                    onClick={() => void transferAction("cancel")}
                  >
                    {copy.cancelTransfer}
                  </button>
                  <button type="button" onClick={() => void navigator.clipboard.writeText(transferURL)}>
                    {copy.copyTransfer}
                  </button>
                </div>
              </section>
            )}

            {canManage && (
              <div className="management-grid">
                {group.membershipRole === "owner" && (
                  <section className="management-card group-cover-manager">
                    <span className="section-number">PUBLIC COVER</span>
                    <h2>{tr(locale, "社群封面", "コミュニティカバー", "Community cover")}</h2>
                    <p>
                      {tr(
                        locale,
                        "封面会显示在公开社群主页。图片通过病毒扫描和内容安全处理后再替换现有封面。",
                        "公開コミュニティページに表示されます。ウイルススキャンと安全処理の完了後に置き換えます。",
                        "Shown on the public community page and replaced only after virus scanning and content-safety processing.",
                      )}
                    </p>
                    {group.coverURL && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={group.coverURL} alt="" />
                    )}
                    <label className="secondary-action compact">
                      {coverBusy
                        ? tr(locale, "正在安全处理…", "安全処理中…", "Processing securely…")
                        : tr(locale, "选择或更换封面", "カバーを選択・変更", "Choose or change cover")}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic"
                        disabled={coverBusy}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadCover(file);
                          event.currentTarget.value = "";
                        }}
                      />
                    </label>
                  </section>
                )}
                <section className="management-card">
                  <span className="section-number">INVITATIONS</span>
                  <h2>{copy.invites}</h2>
                  <p>{copy.invitesBody}</p>
                  <div className="form-grid">
                    <label className="form-field">
                      {copy.maxUses}
                      <input
                        type="number"
                        min={1}
                        max={1000}
                        value={maxUses}
                        onChange={(event) => setMaxUses(Number(event.target.value))}
                      />
                    </label>
                    <label className="form-field">
                      {copy.expires}
                      <select
                        value={expiresInHours}
                        onChange={(event) => setExpiresInHours(Number(event.target.value))}
                      >
                        <option value={24}>24h</option>
                        <option value={168}>7d</option>
                        <option value={720}>30d</option>
                      </select>
                    </label>
                  </div>
                  <button className="primary-action compact" disabled={busy} onClick={() => void createInvite()}>
                    {copy.createInvite}
                  </button>
                  {invite && (
                    <div className="generated-link">
                      <code>{inviteURL}</code>
                      <button onClick={() => void navigator.clipboard.writeText(inviteURL)}>
                        {copy.copy}
                      </button>
                    </div>
                  )}
                </section>

                <section className="management-card">
                  <span className="section-number">CAPACITY</span>
                  <h2>{copy.increase}</h2>
                  <p>{copy.increaseBody}</p>
                  <button
                    className="primary-action compact"
                    disabled={busy || group.capacity >= 500}
                    onClick={() => void increaseCapacity()}
                  >
                    {group.capacity >= 500 ? copy.maxCapacity : copy.quoteCapacity}
                  </button>
                </section>

                {group.availableActions.includes("transferGroup") && (
                  <section className="management-card">
                    <span className="section-number">OWNERSHIP</span>
                    <h2>{copy.transfer}</h2>
                    <p>{copy.transferBody}</p>
                    <label className="form-field">
                      {copy.target}
                      <select
                        value={targetUserId}
                        onChange={(event) => setTargetUserId(event.target.value)}
                      >
                        <option value="">
                          {tr(locale, "选择一位有效成员", "有効なメンバーを選択", "Choose an active member")}
                        </option>
                        {members
                          .filter((member) => member.role !== "owner" && member.status === "active")
                          .map((member) => (
                            <option key={member.user.id} value={member.user.id}>
                              {member.user.name} · @{member.user.handle}
                            </option>
                          ))}
                      </select>
                    </label>
                    <button className="secondary-action compact" disabled={busy} onClick={() => void startTransfer()}>
                      {copy.startTransfer}
                    </button>
                  </section>
                )}

                {group.availableActions.includes("dissolveGroup") && (
                  <section className="management-card danger-management-card">
                    <span className="section-number">DISSOLUTION</span>
                    <h2>{copy.dissolve}</h2>
                    <p>{copy.dissolveBody}</p>
                    {group.status === "closing" ? (
                      <>
                        {group.dissolveAfter && (
                          <p>
                            {copy.scheduledFor}:{" "}
                            {new Intl.DateTimeFormat(intlLocale(locale), {
                              dateStyle: "long",
                              timeStyle: "short",
                            }).format(new Date(group.dissolveAfter))}
                          </p>
                        )}
                        <div className="management-actions">
                          <button disabled={busy} onClick={() => void dissolutionAction("cancel")}>
                            {copy.cancelDissolution}
                          </button>
                          <button
                            className="danger-text"
                            disabled={busy}
                            onClick={() => void dissolutionAction("finalize")}
                          >
                            {copy.finalizeDissolution}
                          </button>
                        </div>
                      </>
                    ) : (
                      <button
                        className="danger-action compact"
                        disabled={busy}
                        onClick={() => void scheduleDissolution()}
                      >
                        {copy.scheduleDissolution}
                      </button>
                    )}
                  </section>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}

function groupManagerCopy(locale: Locale) {
  if (locale === "ja")
    return {
      title: "グループ管理", body: "招待、定員、所有権、解散手続きを Web と iOS に同期します。", back: "グループ管理", notFound: "グループを読み込めませんでした", members: "メンバー", capacity: "定員", status: "状態", invites: "招待リンク", invitesBody: "有効期限と利用回数を設定した招待リンクを作成します。", maxUses: "利用回数", expires: "有効期間", createInvite: "招待リンクを作成", copy: "コピー", increase: "定員を50人増やす", increaseBody: "最新のポイント見積もりを確認してから拡張します。上限は500人です。", quoteCapacity: "見積もりを確認", maxCapacity: "上限に達しています", capacityDone: "定員を更新しました。", transfer: "所有権を移行", transferBody: "対象者は電話認証済みで、参加から7日以上経過している必要があります。", target: "対象ユーザーID", targetInvalid: "有効な対象ユーザーIDを入力してください。", startTransfer: "移行を開始", transferConfirm: "所有権移行を開始しますか？対象者の承認後に24時間の待機期間があります。", transferStarted: "移行を開始しました。対象者にリンクを共有してください。", activeTransfer: "進行中の所有権移行", transferId: "移行ID", cooldown: "完了可能日時", acceptTransfer: "移行を承認", completeTransfer: "移行を完了", cancelTransfer: "移行をキャンセル", copyTransfer: "承認リンクをコピー", cancelReason: "キャンセル理由", transferAccepted: "移行を承認しました。24時間の待機期間が始まりました。", transferCompleted: "所有権を移行しました。", transferCancelled: "移行をキャンセルしました。", dissolve: "グループを解散", dissolveBody: "未終了の関連イベントがない場合、7日間の通知期間を経て解散できます。", dissolutionReason: "解散理由を入力してください", dissolutionConfirm: "7日後の解散を予約しますか？メンバーに通知されます。", scheduleDissolution: "解散を予約", scheduledFor: "解散予定", cancelDissolution: "解散を取り消す", finalizeDissolution: "解散を完了", dissolutionScheduled: "解散を予約しました。", dissolutionCancelled: "解散予定を取り消しました。", dissolutionFinalized: "グループを解散しました。",
    };
  if (locale === "en")
    return {
      title: "Group management", body: "Keep invitations, capacity, ownership, and dissolution in sync across Web and iOS.", back: "Group management", notFound: "The group could not be loaded", members: "Members", capacity: "Capacity", status: "Status", invites: "Invite links", invitesBody: "Create an invite with an expiry and maximum number of uses.", maxUses: "Maximum uses", expires: "Expires in", createInvite: "Create invite link", copy: "Copy", increase: "Add 50 places", increaseBody: "Review a live points quote before increasing capacity. The maximum is 500.", quoteCapacity: "Review quote", maxCapacity: "Maximum reached", capacityDone: "Capacity updated.", transfer: "Transfer ownership", transferBody: "The recipient must be phone-verified and have been an active member for at least 7 days.", target: "Recipient user ID", targetInvalid: "Enter a valid recipient user ID.", startTransfer: "Start transfer", transferConfirm: "Start ownership transfer? A 24-hour cooling-off period begins after the recipient accepts.", transferStarted: "Transfer started. Share the acceptance link with the recipient.", activeTransfer: "Active ownership transfer", transferId: "Transfer ID", cooldown: "Can complete after", acceptTransfer: "Accept transfer", completeTransfer: "Complete transfer", cancelTransfer: "Cancel transfer", copyTransfer: "Copy acceptance link", cancelReason: "Reason for cancellation", transferAccepted: "Transfer accepted. The 24-hour cooling-off period has started.", transferCompleted: "Ownership transferred.", transferCancelled: "Transfer cancelled.", dissolve: "Dissolve group", dissolveBody: "If no linked events are active, you can dissolve after a 7-day notice period.", dissolutionReason: "Reason for dissolution", dissolutionConfirm: "Schedule dissolution in 7 days? Members will be notified.", scheduleDissolution: "Schedule dissolution", scheduledFor: "Scheduled for", cancelDissolution: "Cancel dissolution", finalizeDissolution: "Complete dissolution", dissolutionScheduled: "Dissolution scheduled.", dissolutionCancelled: "Dissolution cancelled.", dissolutionFinalized: "Group dissolved.",
    };
  return {
    title: "群组管理", body: "邀请、人数上限、群主转让和解散流程会同步到 Web 与 iOS。", back: "群组管理", notFound: "无法加载这个群组", members: "成员", capacity: "人数上限", status: "状态", invites: "邀请链接", invitesBody: "创建带有效期和最多使用次数的邀请链接。", maxUses: "最多使用次数", expires: "有效期", createInvite: "创建邀请链接", copy: "复制", increase: "增加 50 人上限", increaseBody: "扩容前会显示实时积分报价，普通群组上限为 500 人。", quoteCapacity: "查看实时报价", maxCapacity: "已达到上限", capacityDone: "人数上限已更新。", transfer: "转让群主", transferBody: "接收人必须已验证手机号，并已作为有效成员加入至少 7 天。", target: "接收人用户 ID", targetInvalid: "请输入有效的接收人用户 ID。", startTransfer: "发起转让", transferConfirm: "确定发起群主转让吗？对方接受后有 24 小时冷静期。", transferStarted: "转让已发起，请把接受链接发给接收人。", activeTransfer: "进行中的群主转让", transferId: "转让 ID", cooldown: "最早完成时间", acceptTransfer: "接受转让", completeTransfer: "完成转让", cancelTransfer: "取消转让", copyTransfer: "复制接受链接", cancelReason: "请输入取消原因", transferAccepted: "已接受转让，24 小时冷静期开始。", transferCompleted: "群主转让已完成。", transferCancelled: "转让已取消。", dissolve: "解散群组", dissolveBody: "没有未结束的关联活动时，可在 7 天通知期后解散。", dissolutionReason: "请输入解散原因", dissolutionConfirm: "确定安排 7 天后解散吗？系统会通知成员。", scheduleDissolution: "安排解散", scheduledFor: "计划解散时间", cancelDissolution: "取消解散", finalizeDissolution: "完成解散", dissolutionScheduled: "已安排解散。", dissolutionCancelled: "解散计划已取消。", dissolutionFinalized: "群组已解散。",
  };
}

function tr(locale: Locale, zh: string, ja: string, en: string): string {
  return locale === "ja" ? ja : locale === "en" ? en : zh;
}

function intlLocale(locale: Locale): string {
  return locale === "ja" ? "ja-JP" : locale === "en" ? "en-US" : "zh-CN";
}

function memberStatusLabel(locale: Locale, status: GroupMemberView["status"]): string {
  const labels = {
    active: ["正常", "参加中", "Active"],
    muted: ["已禁言", "ミュート中", "Muted"],
    pending: ["待审核", "承認待ち", "Pending"],
    removed: ["已移除", "削除済み", "Removed"],
  } as const;
  const [zh, ja, en] = labels[status];
  return tr(locale, zh, ja, en);
}
