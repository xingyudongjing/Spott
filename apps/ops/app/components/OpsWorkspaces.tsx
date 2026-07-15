"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import {
  activateConfigRevision,
  approveOpsExport,
  approveConfigRevision,
  claimModerationCase,
  createConfigRevision,
  createOpsIdempotencyKey,
  createOpsExport,
  createPointAdjustment,
  decideGroupLifecycle,
  decideModerationCase,
  decidePointAdjustment,
  executePointAdjustment,
  getAnalyticsOverview,
  getAuditLogs,
  getConfigRevisions,
  getLedgerHealth,
  getModerationCase,
  getModerationCases,
  getOpsAdminUsers,
  getOpsExportDownloadTicket,
  getOpsEvents,
  getOpsExports,
  getOpsGroups,
  getOpsOrganizers,
  getOpsOverview,
  getOpsUsers,
  getPointAdjustments,
  opsErrorMessage,
  previewConfigImpact,
  restrictOpsUser,
  reviewOpsEvent,
  rollbackConfigRevision,
  type CursorPage,
  type ConfigRevision,
  type ModerationCase,
  type OpsEvent,
  type OpsExport,
  type OpsGroup,
  type OpsSession,
  type OpsUser,
  type PointAdjustment,
} from "../lib/ops-api";
import type { OpsSection } from "./OpsConsole";
import { OpsIcon } from "./OpsIcon";

type Notice = (value: string) => void;
type WorkspaceProps = { section: OpsSection; query: string; onNotice: Notice; session: OpsSession | null };

export function OpsWorkspace({ section, query, onNotice, session }: WorkspaceProps) {
  switch (section) {
    case "overview": return <OverviewWorkspace />;
    case "users": return <UsersWorkspace query={query} session={session} onNotice={onNotice} />;
    case "organizers": return <OrganizersWorkspace query={query} />;
    case "events": return <EventsWorkspace query={query} onNotice={onNotice} session={session} />;
    case "groups": return <GroupsWorkspace query={query} session={session} onNotice={onNotice} />;
    case "moderation": return <ModerationWorkspace query={query} onNotice={onNotice} session={session} />;
    case "points": return <PointsWorkspace onNotice={onNotice} session={session} />;
    case "config": return <ConfigWorkspace onNotice={onNotice} session={session} />;
    case "analytics": return <AnalyticsWorkspace />;
    case "audit": return <AuditWorkspace query={query} />;
    case "exports": return <ExportsWorkspace onNotice={onNotice} session={session} />;
  }
}

function hasOpsRole(session: OpsSession | null, roles: string[]): boolean {
  return Boolean(session?.mfaEnrolled && (session.roles.includes("superAdmin") || roles.some((role) => session.roles.includes(role))));
}

function Remote<T>({ load, children }: { load: () => Promise<T>; children: (value: T, reload: () => void) => ReactNode }) {
  const [value, setValue] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        if (active) {
          setLoading(true);
          setError(null);
        }
        return load();
      })
      .then((next) => { if (active) setValue(next); })
      .catch((cause) => { if (active) setError(opsErrorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, revision]);
  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} retry={() => setRevision((item) => item + 1)} />;
  if (value === null) return <EmptyState />;
  return children(value, () => setRevision((item) => item + 1));
}

function CursorRemote<T>({
  load,
  children,
}: {
  load: (cursor?: string) => Promise<CursorPage<T>>;
  children: (page: CursorPage<T>, reload: () => void, loadMore: () => void, loadingMore: boolean) => ReactNode;
}) {
  const [page, setPage] = useState<CursorPage<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => {
        if (active) {
          setLoading(true);
          setError(null);
        }
        return load();
      })
      .then((next) => { if (active) setPage(next); })
      .catch((cause) => { if (active) setError(opsErrorMessage(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [load, revision]);

  async function loadMore() {
    if (!page?.hasMore || !page.nextCursor || loadingMore) return;
    setLoadingMore(true);
    setError(null);
    try {
      const next = await load(page.nextCursor);
      setPage((current) => current ? {
        items: [...current.items, ...next.items],
        hasMore: next.hasMore,
        nextCursor: next.nextCursor,
      } : next);
    } catch (cause) {
      setError(opsErrorMessage(cause));
    } finally {
      setLoadingMore(false);
    }
  }

  if (loading) return <LoadingState />;
  if (error) return <ErrorState message={error} retry={() => setRevision((item) => item + 1)} />;
  if (!page) return <EmptyState />;
  return children(page, () => setRevision((item) => item + 1), loadMore, loadingMore);
}

function OverviewWorkspace() {
  const load = useCallback(() => getOpsOverview(), []);
  return <Remote load={load}>{(data) => <>
    <div className="metric-grid">
      <Metric label="P0 待处理" value={data.queues.p0Open} meta="紧急安全队列" tone="danger" />
      <Metric label="活动待审核" value={data.queues.eventReviewPending} meta="风险路由结果" />
      <Metric label="投递成功率" value={formatPercent(data.health.deliverySuccessRate1h)} meta="过去 60 分钟" tone="good" />
      <Metric label="账本差额" value={`${data.health.ledgerDeltaPaid + data.health.ledgerDeltaFree}`} meta="付费与免费积分" tone={data.health.ledgerDeltaPaid + data.health.ledgerDeltaFree === 0 ? "good" : "danger"} />
    </div>
    <div className="dashboard-grid">
      <Panel className="span-2" title="履约与复购" kicker="QUALITY SIGNALS">
        <div className="signal-grid">
          <Signal label="30 日活跃用户" value={formatNumber(data.growth.activeUsers30d)} />
          <Signal label="可报名活动" value={formatNumber(data.growth.eventsOpen)} />
          <Signal label="真实到场率" value={formatPercent(data.growth.checkinRate30d)} />
          <Signal label="60 日复购率" value={formatPercent(data.growth.repeatRate60d)} />
        </div>
      </Panel>
      <Panel title="需要关注" kicker="OPERATION QUEUES">
        <dl className="attention-list">
          <Attention label="内容安全" value={data.queues.moderationOpen} tone="danger" />
          <Attention label="积分审批" value={data.queues.pointApprovalsPending} tone="warn" />
          <Attention label="安全申诉" value={data.queues.appealsPending} />
          <Attention label="Outbox 积压" value={data.queues.outboxBacklog} />
        </dl>
      </Panel>
    </div>
    <p className="updated-at"><OpsIcon name="clock" />数据生成于 {formatDateTime(data.generatedAt)}</p>
  </>}</Remote>;
}

function UsersWorkspace({ query, session, onNotice }: { query: string; session: OpsSession | null; onNotice: Notice }) {
  const load = useCallback((cursor?: string) => getOpsUsers({ q: query, cursor, limit: 50 }), [query]);
  const [selected, setSelected] = useState<OpsUser | null>(null);
  const canRestrict = hasOpsRole(session, ["support", "securityLead"]);
  return <CursorRemote load={load}>{(page, reload, loadMore, loadingMore) => <Panel title="用户与账号状态" kicker="MINIMUM DISCLOSURE" meta={`${page.items.length} 条`}>
    {page.items.length === 0 ? <EmptyState /> : <ResponsiveTable headers={["用户", "状态", "验证", "设备风险", "履约", "投诉", "更新时间", "操作"]}>
      {page.items.map((item) => <tr key={item.id}>
        <td data-label="用户"><b>{item.nickname}</b><small>@{item.handle}</small><small className="mono">{item.id}</small></td>
        <td data-label="状态"><Status value={item.status} />{item.restrictions.length > 0 && <small>{item.restrictions.join(" · ")}</small>}</td>
        <td data-label="验证">{item.phoneVerified ? "日本手机号已验证" : "未验证"}</td>
        <td data-label="设备风险"><Status value={item.deviceRisk} /></td>
        <td data-label="履约">发布 {item.hostedCount} · 报名 {item.registrationCount}</td>
        <td data-label="投诉">{item.complaintCount}</td>
        <td data-label="更新时间" className="mono">{formatDateTime(item.updatedAt)}</td>
        <td data-label="操作">{canRestrict ? <button className="secondary-button" type="button" onClick={() => setSelected(item)}>账号处置</button> : <span>只读</span>}</td>
      </tr>)}
    </ResponsiveTable>}
    <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
    {!canRestrict && <PermissionNote>当前会话没有账号处置权限，或 MFA 状态尚未验证。</PermissionNote>}
    {selected && <UserRestrictionDialog item={selected} loginReauthRequired={session?.reauthRequiredFor.includes("user.login_block") ?? true} close={() => setSelected(null)} complete={(result) => { onNotice(result.decisionState === "pending_approval" ? `用户 @${selected.handle} 的高风险处置已提交双人审批，尚未生效。` : `用户 @${selected.handle} 的账号处置已生效并写入审计。`); setSelected(null); reload(); }} />}
  </Panel>}</CursorRemote>;
}

function OrganizersWorkspace({ query }: { query: string }) {
  const load = useCallback((cursor?: string) => getOpsOrganizers({ q: query, cursor, limit: 50 }), [query]);
  return <CursorRemote load={load}>{(page, _reload, loadMore, loadingMore) => <Panel title="局头履约质量" kicker="HOST TRUST" meta={`${page.items.length} 条`}>
    {page.items.length === 0 ? <EmptyState /> : <ResponsiveTable headers={["局头", "状态", "已发布", "完成率", "到场率", "60 日复购", "有效投诉"]}>
      {page.items.map((item) => <tr key={item.id}>
        <td data-label="局头"><b>{item.nickname}</b><small>@{item.handle}</small></td>
        <td data-label="状态"><Status value={item.status} /><small>{item.verificationState}</small></td>
        <td data-label="已发布">{item.hostedCount}<small>未来 {item.upcomingCount}</small></td>
        <td data-label="完成率">{formatPercent(item.completionRate)}</td>
        <td data-label="到场率">{formatPercent(item.checkinRate)}</td>
        <td data-label="60 日复购">{formatPercent(item.repeatRate60d)}</td>
        <td data-label="有效投诉">{formatPercent(item.complaintRate)}</td>
      </tr>)}
    </ResponsiveTable>}
    <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
  </Panel>}</CursorRemote>;
}

function EventsWorkspace({ query, onNotice, session }: { query: string; onNotice: Notice; session: OpsSession | null }) {
  const load = useCallback((cursor?: string) => getOpsEvents({ q: query, status: "pending_review", cursor, limit: 50 }), [query]);
  const [selected, setSelected] = useState<OpsEvent | null>(null);
  const canReview = hasOpsRole(session, ["eventReviewer", "moderator"]);
  return <CursorRemote load={load}>{(page, reload, loadMore, loadingMore) => <>
    <Panel title="活动审核队列" kicker="RISK-BASED REVIEW" meta={`${page.items.length} 条待处理`}>
      {page.items.length === 0 ? <EmptyState /> : <div className="review-list">{page.items.map((item) => <article className="review-card" key={item.id}>
        <div className={`risk-score ${item.riskScore >= 70 ? "high" : item.riskScore >= 30 ? "medium" : "low"}`}><strong>{item.riskScore}</strong><span>风险分</span></div>
        <div className="review-main"><h3>{item.title}</h3><p>@{item.organizer.handle} · {item.publicArea ?? "地区待确认"} · {item.isFree === true ? "免费" : item.amountJpy ? `¥${formatNumber(item.amountJpy)}` : "费用待确认"}</p><div className="tag-row">{item.riskReasons.map((reason) => <span key={reason}>{reason}</span>)}</div></div>
        <div className="review-meta"><span>{formatDateTime(item.submittedAt)}</span>{canReview ? <button className="primary-button" type="button" onClick={() => setSelected(item)}>开始审核</button> : <span>只读</span>}</div>
      </article>)}</div>}
      <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
      {!canReview && <PermissionNote>当前会话没有活动审核权限，或 MFA 状态尚未验证。</PermissionNote>}
    </Panel>
    {selected && <EventDecisionDialog item={selected} close={() => setSelected(null)} complete={() => { setSelected(null); onNotice(`活动《${selected.title}》的审核决定已写入审计。`); reload(); }} />}
  </>}</CursorRemote>;
}

function GroupsWorkspace({ query, session, onNotice }: { query: string; session: OpsSession | null; onNotice: Notice }) {
  const load = useCallback((cursor?: string) => getOpsGroups({ q: query, cursor, limit: 50 }), [query]);
  const [selected, setSelected] = useState<OpsGroup | null>(null);
  const canGovern = hasOpsRole(session, ["groupReviewer", "securityLead"]);
  return <CursorRemote load={load}>{(page, reload, loadMore, loadingMore) => <Panel title="群组治理" kicker="COMMUNITY OPERATIONS" meta={`${page.items.length} 个群组`}>
    {page.items.length === 0 ? <EmptyState /> : <ResponsiveTable headers={["群组", "群主", "状态", "成员", "活动", "举报", "生命周期", "操作"]}>
      {page.items.map((item) => <tr key={item.id}>
        <td data-label="群组"><b>{item.name}</b><small>/{item.slug} · {item.joinMode}</small></td>
        <td data-label="群主">{item.owner.nickname}<small>@{item.owner.handle}</small></td>
        <td data-label="状态"><Status value={item.status} /></td>
        <td data-label="成员">{item.memberCount} / {item.capacity}</td>
        <td data-label="活动">{item.openEventCount}</td>
        <td data-label="举报">{item.reportCount}</td>
        <td data-label="生命周期">{item.activeTransferState ?? (item.closingAt ? `解散于 ${formatDateTime(item.closingAt)}` : "正常")}</td>
        <td data-label="操作">{canGovern ? <button className="secondary-button" type="button" onClick={() => setSelected(item)}>生命周期处置</button> : <span>只读</span>}</td>
      </tr>)}
    </ResponsiveTable>}
    <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
    {!canGovern && <PermissionNote>当前会话没有群组治理权限，或 MFA 状态尚未验证。</PermissionNote>}
    {selected && <GroupLifecycleDialog item={selected} close={() => setSelected(null)} complete={() => { onNotice(`群组「${selected.name}」的生命周期决定已写入审计。`); setSelected(null); reload(); }} />}
  </Panel>}</CursorRemote>;
}

function ModerationWorkspace({ query, onNotice, session }: { query: string; onNotice: Notice; session: OpsSession | null }) {
  const [severity, setSeverity] = useState("");
  const [status, setStatus] = useState("");
  const [selected, setSelected] = useState<ModerationCase | null>(null);
  const [detail, setDetail] = useState<ModerationCase | null>(null);
  const [workingId, setWorkingId] = useState<string | null>(null);
  const load = useCallback((cursor?: string) => getModerationCases({ q: query, severity, status, cursor, limit: 50 }), [query, severity, status]);
  const canModerate = hasOpsRole(session, ["moderator", "securityLead"]);
  return <CursorRemote load={load}>{(page, reload, loadMore, loadingMore) => <>
    <div className="section-toolbar">
      <div className="filter-group"><OpsIcon name="filter" /><label>级别<select value={severity} onChange={(event) => setSeverity(event.target.value)}><option value="">全部</option><option value="p0">P0</option><option value="p1">P1</option><option value="p2">P2</option></select></label><label>状态<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">全部</option><option value="open">待处理</option><option value="investigating">调查中</option><option value="appealed">申诉中</option><option value="decided">已处理</option></select></label></div>
      <button className="secondary-button" type="button" onClick={reload}><OpsIcon name="refresh" />刷新</button>
    </div>
    <Panel title="审核案件" kicker="PRIVACY-FIRST TRIAGE" meta={`${page.items.length} 条`}>
      {page.items.length === 0 ? <EmptyState /> : <ResponsiveTable headers={["级别", "案件与对象", "状态", "负责人", "SLA", "操作"]}>
        {page.items.map((item) => <tr key={item.id}>
          <td data-label="级别"><span className={`severity ${item.severity}`}>{item.severity.toUpperCase()}</span></td>
          <td data-label="案件与对象"><b>{item.reason}</b><small>{item.reference} · {item.targetType} · {maskId(item.targetId)}</small></td>
          <td data-label="状态"><Status value={item.status} /></td>
          <td data-label="负责人">{item.assignee?.label ?? "未认领"}</td>
          <td data-label="SLA" className={new Date(item.slaDueAt).getTime() < Date.now() ? "danger-text mono" : "mono"}>{formatDateTime(item.slaDueAt)}</td>
          <td data-label="操作"><div className="table-actions"><button type="button" onClick={() => setDetail(item)}>详情与证据</button>{canModerate && !item.assignee && <button type="button" disabled={workingId === item.id} onClick={async () => { setWorkingId(item.id); try { await claimModerationCase(item, createOpsIdempotencyKey()); onNotice(`案件 ${item.reference} 已认领。`); reload(); } catch (error) { onNotice(opsErrorMessage(error)); } finally { setWorkingId(null); } }}>认领</button>}{canModerate && <button type="button" className="primary-link" onClick={() => setSelected(item)}>处理</button>}</div></td>
        </tr>)}
      </ResponsiveTable>}
      <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
      {!canModerate && <PermissionNote>当前会话没有安全处置权限；证据查看仍须填写业务用途并单独审计。</PermissionNote>}
    </Panel>
    <div className="policy-note"><OpsIcon name="lock" /><div><b>最小披露策略生效</b><span>举报人身份不会向被举报方或无关客服显示；证据查看必须填写用途并写入审计。</span></div></div>
    {selected && <ModerationDecisionDialog item={selected} close={() => setSelected(null)} complete={() => { setSelected(null); onNotice(`案件 ${selected.reference} 的处理决定已完成并写入不可变审计。`); reload(); }} />}
    {detail && <ModerationDetailDialog item={detail} close={() => setDetail(null)} />}
  </>}</CursorRemote>;
}

function PointsWorkspace({ onNotice, session }: { onNotice: Notice; session: OpsSession | null }) {
  const [listRevision, setListRevision] = useState(0);
  const adjustmentsLoad = useCallback((cursor?: string) => getPointAdjustments({ cursor, limit: 50 }), []);
  const healthLoad = useCallback(() => getLedgerHealth(), []);
  const [selected, setSelected] = useState<{ item: PointAdjustment; action: "approve" | "reject" | "execute" } | null>(null);
  const [creating, setCreating] = useState(false);
  const canRequest = hasOpsRole(session, ["pointsRequester", "financeLead"]);
  const canApprove = hasOpsRole(session, ["pointsApprover", "financeLead"]);
  return <>
    <div className="section-toolbar"><div><b>积分人工调整</b><small> 申请、审批、执行必须分离</small></div>{canRequest && <button className="primary-button" type="button" onClick={() => setCreating(true)}>新建调整申请</button>}</div>
    <div className="two-column">
    <CursorRemote key={listRevision} load={adjustmentsLoad}>{(adjustments, reload, loadMore, loadingMore) => <Panel title="人工积分调整" kicker="REQUEST · APPROVE · EXECUTE" meta={`${adjustments.items.length} 项`}>
      {adjustments.items.length === 0 ? <EmptyState /> : <div className="approval-list">{adjustments.items.map((item) => <article className="approval-card" key={item.id}>
        <header><Status value={item.state} /><code>{maskId(item.id)}</code></header>
        <h3>{item.target.nickname} <small>@{item.target.handle}</small></h3>
        <p><b className={item.amount < 0 ? "danger-text" : "success-text"}>{item.amount > 0 ? "+" : ""}{formatNumber(item.amount)}</b> {item.bucket === "paid" ? "付费积分" : "免费积分"}</p>
        <blockquote>{item.reason}</blockquote>
        <footer><span>申请人 {item.requester.label} · 审批 {item.approvalCount}/{item.requiredApprovals}</span><div>{canApprove && session?.operatorId !== item.requester.id && item.state === "pending" && <><button onClick={() => setSelected({ item, action: "reject" })}>拒绝</button><button className="primary-button" disabled={item.bucket === "paid" && (session?.reauthRequiredFor.includes("points.paid_adjustment") ?? true)} onClick={() => setSelected({ item, action: "approve" })}>审批</button></>}{canApprove && session?.operatorId !== item.requester.id && item.state === "approved" && <button className="primary-button" disabled={item.bucket === "paid" && (session?.reauthRequiredFor.includes("points.paid_adjustment") ?? true)} onClick={() => setSelected({ item, action: "execute" })}>执行入账</button>}</div></footer>
      </article>)}</div>}
      <Pagination page={adjustments} loadMore={loadMore} loading={loadingMore} />
      {!canApprove && <PermissionNote>当前会话没有积分审批权限，或 MFA 状态尚未验证。</PermissionNote>}
      {selected && <PointDecisionDialog item={selected.item} action={selected.action} close={() => setSelected(null)} complete={() => { onNotice(`积分申请 ${selected.item.id} 已${selected.action === "approve" ? "批准" : selected.action === "reject" ? "拒绝" : "执行"}。`); setSelected(null); reload(); }} />}
    </Panel>}</CursorRemote>
    <Remote load={healthLoad}>{(health) => <Panel title="账本不变量" kicker="LEDGER HEALTH">
      <div className="ledger-health"><strong className={health.balanced ? "success-text" : "danger-text"}>{health.balanced ? "平衡" : "需冻结检查"}</strong><p>最后检查 {formatDateTime(health.checkedAt)}</p><dl><Attention label="付费账本差额" value={health.paidDelta} /><Attention label="免费账本差额" value={health.freeDelta} /><Attention label="负付费余额账号" value={health.negativePaidWallets} tone="warn" /><Attention label="待商店对账" value={health.pendingStoreReconciliations} /><Attention label="临近到期批次" value={health.expiringLots} /></dl></div>
    </Panel>}</Remote>
    </div>
    {!canRequest && <PermissionNote>当前会话没有积分调整申请权限。</PermissionNote>}
    {creating && <PointRequestDialog close={() => setCreating(false)} complete={() => { setCreating(false); setListRevision((value) => value + 1); onNotice("积分调整申请已提交；必须由另一名运营审批后才能执行。"); }} />}
  </>;
}

function ConfigWorkspace({ onNotice, session }: { onNotice: Notice; session: OpsSession | null }) {
  const [listRevision, setListRevision] = useState(0);
  const load = useCallback((cursor?: string) => getConfigRevisions({ cursor, limit: 50 }), []);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<ConfigRevision | null>(null);
  const [action, setAction] = useState<{ item: ConfigRevision; action: "approve" | "activate" | "rollback" } | null>(null);
  const canEdit = hasOpsRole(session, ["configEditor"]);
  const canApprove = hasOpsRole(session, ["configApprover"]);
  return <>
    <div className="section-toolbar"><div><b>不可变配置变更</b><small> Revision、影响预览、双人审批、激活与回滚</small></div>{canEdit && <button className="primary-button" type="button" onClick={() => setCreating(true)}>创建 Revision</button>}</div>
  <CursorRemote key={listRevision} load={load}>{(page, reload, loadMore, loadingMore) => <Panel title="配置 Revision" kicker="IMMUTABLE CHANGE CONTROL" meta={`${page.items.length} 条`}>
    {page.items.length === 0 ? <EmptyState /> : <div className="config-list">{page.items.map((item) => <article className="config-row" key={item.id}>
      <div><code>{item.key}</code><p>v{item.version} · {item.region ?? "全局"} · 提交人 {item.submittedBy.label}</p></div>
      <pre>{formatConfigValue(item.value)}</pre>
      <Status value={item.state} />
      <div className="config-actions"><button type="button" onClick={() => setPreview(item)}>影响预览</button>{canApprove && item.canApprove && item.state === "draft" && <button className="primary-button" type="button" onClick={() => setAction({ item, action: "approve" })}>审批</button>}{canApprove && item.state === "approved" && <button className="primary-button" type="button" onClick={() => setAction({ item, action: "activate" })}>激活</button>}{(canEdit || canApprove) && ["active", "superseded"].includes(item.state) && <button type="button" onClick={() => setAction({ item, action: "rollback" })}>创建回滚</button>}</div>
    </article>)}</div>}
    <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
    {!canEdit && !canApprove && <PermissionNote>当前会话没有配置变更权限，或 MFA 状态尚未验证。</PermissionNote>}
    {preview && <ConfigImpactDialog item={preview} close={() => setPreview(null)} />}
    {action && <ConfigActionDialog item={action.item} action={action.action} close={() => setAction(null)} complete={() => { onNotice(`配置 ${action.item.key} 的${action.action === "approve" ? "审批" : action.action === "activate" ? "激活" : "回滚 Revision"}已完成。`); setAction(null); reload(); }} />}
  </Panel>}</CursorRemote>
  {creating && <ConfigCreateDialog close={() => setCreating(false)} complete={() => { setCreating(false); setListRevision((value) => value + 1); onNotice("配置 Revision 已创建，等待另一名运营影响预览与审批。"); }} />}
  </>;
}

function AnalyticsWorkspace() {
  const load = useCallback(() => getAnalyticsOverview(), []);
  return <Remote load={load}>{(data) => <>
    <div className="metric-grid analytics-metrics"><Metric label="可报名活动" value={data.supply.openEvents} meta="当前供给" /><Metric label="严重安全事件" value={data.safety.severeIncidents} meta="选定周期" tone="danger" /><Metric label="退款率" value={formatPercent(data.points.refundRate)} meta="付费积分" /><Metric label="有效投诉率" value={formatPercent(data.safety.complaintRate)} meta="活动与社群" /></div>
    <div className="dashboard-grid">
      <Funnel title="参与者履约漏斗" data={data.participantFunnel} />
      <Funnel title="局头供给漏斗" data={data.hostFunnel} />
      <Funnel title="群组沉淀漏斗" data={data.groupFunnel} />
    </div>
    <p className="privacy-caption"><OpsIcon name="shield" />仅展示达到最小样本阈值的聚合数据，不提供可识别的个人行为导出。</p>
  </>}</Remote>;
}

function AuditWorkspace({ query }: { query: string }) {
  const load = useCallback((cursor?: string) => getAuditLogs({ q: query, cursor, limit: 50 }), [query]);
  const adminsLoad = useCallback(() => getOpsAdminUsers(), []);
  return <div className="audit-workspace"><Remote load={adminsLoad}>{(data) => <Panel title="运营角色与数据范围" kicker="LEAST PRIVILEGE" meta={`${data.items.length} 名运营`}>
    {data.items.length === 0 ? <EmptyState /> : <ResponsiveTable headers={["运营账号", "角色", "数据范围", "MFA", "状态"]}>{data.items.map((item) => <tr key={item.id}><td data-label="运营账号"><b>{item.label}</b><small className="mono">{item.identityUserId}</small></td><td data-label="角色">{item.roles.map(roleLabel).join(" · ")}</td><td data-label="数据范围">{item.dataScopes.join(" · ")}</td><td data-label="MFA">{formatDateTime(item.mfaEnrolledAt)}</td><td data-label="状态"><Status value={item.disabledAt ? "blocked" : "active"} /></td></tr>)}</ResponsiveTable>}
  </Panel>}</Remote><CursorRemote load={load}>{(page, _reload, loadMore, loadingMore) => <Panel title="不可变操作日志" kicker="APPEND-ONLY AUDIT" meta={`${page.items.length} 条`}>
    {page.items.length === 0 ? <EmptyState /> : <ResponsiveTable headers={["时间", "操作者", "动作", "资源", "用途", "Trace"]}>
      {page.items.map((item) => <tr key={item.id}><td data-label="时间" className="mono">{formatDateTime(item.createdAt)}</td><td data-label="操作者">{item.actor?.label ?? "系统"}</td><td data-label="动作"><code>{item.action}</code></td><td data-label="资源">{item.resource}<small>{item.resourceIdMasked}</small></td><td data-label="用途">{item.purpose ?? "系统业务操作"}</td><td data-label="Trace" className="mono">{item.traceId}</td></tr>)}
    </ResponsiveTable>}
    <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
  </Panel>}</CursorRemote></div>;
}

function ExportsWorkspace({ onNotice, session }: { onNotice: Notice; session: OpsSession | null }) {
  const load = useCallback((cursor?: string) => getOpsExports({ cursor, limit: 50 }), []);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<{ item: OpsExport; action: "approve" | "reject" | "download" } | null>(null);
  const exportKeyRef = useRef(createOpsIdempotencyKey());
  const canCreate = hasOpsRole(session, ["auditReader", "securityLead", "financeRead", "moderator"]);
  const canApprove = hasOpsRole(session, ["auditReader", "securityLead", "financeRead"]);
  async function submit(event: FormEvent<HTMLFormElement>, reload: () => void) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitting(true);
    try {
      const dataset = String(form.get("dataset")) as "event_roster" | "safety_summary" | "points_reconciliation" | "audit_log";
      await createOpsExport({ dataset, filters: {}, purpose: String(form.get("purpose")), expiresInHours: Number(form.get("expiresInHours")), maxDownloads: 2 }, exportKeyRef.current);
      formElement.reset();
      exportKeyRef.current = createOpsIdempotencyKey();
      onNotice("导出申请已提交；审批人与申请人必须分离。文件生成后将加水印并短期有效。");
      reload();
    } catch (error) { onNotice(opsErrorMessage(error)); } finally { setSubmitting(false); }
  }
  return <CursorRemote load={load}>{(page, reload, loadMore, loadingMore) => <div className="two-column export-layout">
    <Panel title="创建受控导出" kicker="JUST-IN-TIME ACCESS">{canCreate ? <form className="export-form" onSubmit={(event) => submit(event, reload)}><label>数据范围<select name="dataset" required><option value="event_roster">活动报名履约名单</option><option value="safety_summary">安全案件摘要</option><option value="points_reconciliation">积分对账差异</option><option value="audit_log">权限审计日志</option></select></label><label>业务理由<textarea name="purpose" minLength={10} maxLength={1000} required placeholder="说明必要性，不得填写无关个人信息" /></label><label>有效时间<select name="expiresInHours"><option value="1">1 小时</option><option value="8">8 小时</option><option value="24">24 小时</option></select></label><button className="primary-button" disabled={submitting} type="submit"><OpsIcon name="download" />{submitting ? "提交中" : "提交审批"}</button></form> : <PermissionNote>当前会话没有受控导出权限。</PermissionNote>}</Panel>
    <Panel title="导出记录" kicker="DOWNLOAD POLICY" meta={`${page.items.length} 条`}>
      {page.items.length === 0 ? <EmptyState /> : <div className="export-list">{page.items.map((item) => <article key={item.id}><header><b>{datasetLabel(item.dataset)}</b><Status value={item.state} /></header><p>{item.purpose}</p><dl><div><dt>申请人</dt><dd>{item.requester.label}</dd></div><div><dt>失效</dt><dd>{formatDateTime(item.expiresAt)}</dd></div><div><dt>下载</dt><dd>{item.downloadCount} / {item.maxDownloads}</dd></div></dl><small className="mono">{item.watermark}</small><div className="config-actions">{canApprove && session?.operatorId !== item.requester.id && item.state === "pending" && <><button type="button" onClick={() => setSelected({ item, action: "reject" })}>拒绝</button><button className="primary-button" type="button" onClick={() => setSelected({ item, action: "approve" })}>审批</button></>}{canApprove && item.state === "ready" && <button className="primary-button" type="button" disabled={session?.reauthRequiredFor.includes("export.download")} onClick={() => setSelected({ item, action: "download" })}>获取下载凭证</button>}</div></article>)}</div>}
      <Pagination page={page} loadMore={loadMore} loading={loadingMore} />
    </Panel>
    {selected && <ExportActionDialog item={selected.item} action={selected.action} close={() => setSelected(null)} complete={() => { onNotice(`导出 ${datasetLabel(selected.item.dataset)} 已完成${selected.action === "download" ? "凭证签发" : "审批决定"}。`); if (selected.action !== "download") setSelected(null); reload(); }} />}
  </div>}</CursorRemote>;
}

type UserRestriction = "loginBlocked" | "publishBlocked" | "registerBlocked" | "pointsBlocked" | "commentBlocked";
const restrictionOptions: Array<{ value: UserRestriction; label: string }> = [
  { value: "loginBlocked", label: "禁止登录" },
  { value: "publishBlocked", label: "禁止发布" },
  { value: "registerBlocked", label: "禁止报名" },
  { value: "pointsBlocked", label: "冻结积分" },
  { value: "commentBlocked", label: "禁止评论" },
];

function UserRestrictionDialog({ item, loginReauthRequired, close, complete }: { item: OpsUser; loginReauthRequired: boolean; close: () => void; complete: (result: Awaited<ReturnType<typeof restrictOpsUser>>) => void }) {
  const [status, setStatus] = useState<"active" | "restricted" | "suspended">(
    item.status === "suspended" ? "suspended" : item.status === "restricted" ? "restricted" : "active",
  );
  const [restrictions, setRestrictions] = useState<UserRestriction[]>(
    item.restrictions.filter((value): value is UserRestriction => restrictionOptions.some((option) => option.value === value)),
  );
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  function toggle(value: UserRestriction) {
    setRestrictions((current) => current.includes(value) ? current.filter((itemValue) => itemValue !== value) : [...current, value]);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await restrictOpsUser(item, { status, restrictions, reason }, keyRef.current);
      complete(result);
    } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }
  const blockedByReauth = loginReauthRequired && restrictions.includes("loginBlocked");
  return <Dialog title={`处置用户 @${item.handle}`} close={close} dismissible={!submitting}><form className="decision-form" onSubmit={submit}><label>账号状态<select value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="active">恢复正常</option><option value="restricted">限制能力</option><option value="suspended">暂停账号</option></select></label><fieldset><legend>能力限制（可多选）</legend><div className="checkbox-grid">{restrictionOptions.map((option) => <label key={option.value}><input type="checkbox" checked={restrictions.includes(option.value)} onChange={() => toggle(option.value)} />{option.label}</label>)}</div></fieldset>{blockedByReauth && <p className="form-error" role="alert">禁止登录属于高风险操作，请先重新验证 MFA 会话。</p>}<label>处置依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={2000} required placeholder="填写投诉、设备风险或政策依据" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting || blockedByReauth} type="submit">{submitting ? "提交中" : "确认处置并审计"}</button></div></form></Dialog>;
}

function GroupLifecycleDialog({ item, close, complete }: { item: OpsGroup; close: () => void; complete: () => void }) {
  const [decision, setDecision] = useState<"" | "restore" | "start_closing" | "cancel_closing" | "remove">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decision) return;
    setSubmitting(true); setError(null);
    try { await decideGroupLifecycle(item, { decision, reason }, keyRef.current); complete(); }
    catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }
  return <Dialog title={`群组生命周期 · ${item.name}`} close={close} dismissible={!submitting}><form className="decision-form" onSubmit={submit}><label>处置决定<select value={decision} required onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="" disabled>请选择处置决定</option><option value="restore">恢复群组</option><option value="start_closing">启动解散冷静期</option><option value="cancel_closing">取消解散</option><option value="remove">安全下架</option></select></label><label>处置依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={2000} required placeholder="说明举报、转让或解散依据" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting || !decision} type="submit">{submitting ? "提交中" : "确认并写入审计"}</button></div></form></Dialog>;
}

function ModerationDetailDialog({ item, close }: { item: ModerationCase; close: () => void }) {
  const [purpose, setPurpose] = useState("");
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof getModerationCase>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true); setError(null);
    try { setDetail(await getModerationCase(item.id, purpose.trim())); }
    catch (cause) { setError(opsErrorMessage(cause)); } finally { setLoading(false); }
  }
  return <Dialog title={`案件详情 · ${item.reference}`} close={close} dismissible={!loading}>{detail ? <div className="case-detail"><section><h3>最小披露对象</h3><p>{detail.target.type} · {detail.target.idMasked}</p><p>举报人：{detail.reporter.present ? "已留存（身份不披露）" : "匿名/未留存"}</p></section><section><h3>证据（查看用途已审计）</h3>{detail.evidence.length === 0 ? <p>没有留存证据。</p> : detail.evidence.map((evidence) => <p key={evidence.id}>{evidence.mimeType ?? "未知格式"} · {formatNumber(evidence.byteSize)} bytes · 保留至 {formatDateTime(evidence.retentionUntil)} {evidence.signedUrl && <a href={evidence.signedUrl} target="_blank" rel="noreferrer">限时查看</a>}</p>)}</section><section><h3>处置历史</h3>{detail.actions.length === 0 ? <p>尚无处置记录。</p> : detail.actions.map((action) => <p key={action.id}><Status value={action.type} /> {action.reason} · {formatDateTime(action.createdAt)}</p>)}</section><section><h3>申诉</h3>{detail.appeals.length === 0 ? <p>没有申诉。</p> : detail.appeals.map((appeal) => <p key={appeal.id}><Status value={appeal.status} /> {formatDateTime(appeal.createdAt)}</p>)}</section><div className="dialog-actions"><button type="button" onClick={close}>关闭</button></div></div> : <form className="decision-form" onSubmit={submit}><p className="decision-warning"><OpsIcon name="lock" />查看证据会记录操作者、用途与 Trace ID；链接仅在短时间内有效。</p><label>查看用途<textarea value={purpose} onChange={(event) => setPurpose(event.target.value)} minLength={3} maxLength={1000} required placeholder="例如：处理案件申诉并复核原始证据" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={loading} onClick={close}>取消</button><button className="primary-button" disabled={loading} type="submit">{loading ? "读取中" : "记录用途并查看"}</button></div></form>}</Dialog>;
}

function PointRequestDialog({ close, complete }: { close: () => void; complete: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setSubmitting(true); setError(null);
    try {
      await createPointAdjustment({ targetUserId: String(form.get("targetUserId")), bucket: String(form.get("bucket")) as "paid" | "free", amount: Number(form.get("amount")), reason: String(form.get("reason")), evidenceRef: String(form.get("evidenceRef") || "") || undefined }, keyRef.current);
      complete();
    } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }
  return <Dialog title="新建积分调整申请" close={close} dismissible={!submitting}><form className="decision-form action-grid" onSubmit={submit}><label className="wide">目标用户 UUID<input name="targetUserId" type="text" required pattern="[0-9a-fA-F-]{36}" placeholder="从用户管理复制权威用户 ID" /></label><label>积分桶<select name="bucket"><option value="free">免费积分</option><option value="paid">付费积分（高风险）</option></select></label><label>调整数量<input name="amount" type="number" min="-1000000" max="1000000" required /></label><label className="wide">申请依据<textarea name="reason" minLength={3} maxLength={2000} required placeholder="说明补偿政策、订单或安全事件" /></label><label className="wide">证据引用（可选）<input name="evidenceRef" maxLength={500} placeholder="工单、订单或案件引用" /></label>{error && <p className="form-error wide" role="alert">{error}</p>}<div className="dialog-actions wide"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting} type="submit">{submitting ? "提交中" : "提交双人审批"}</button></div></form></Dialog>;
}

function ConfigCreateDialog({ close, complete }: { close: () => void; complete: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setSubmitting(true); setError(null);
    try {
      let value: unknown;
      let audience: Record<string, unknown>;
      try {
        value = JSON.parse(String(form.get("value")));
        audience = JSON.parse(String(form.get("audience")) || "{}");
      } catch { throw new Error("配置值与受众必须是有效 JSON。"); }
      await createConfigRevision({ key: String(form.get("key")), value, audience, region: String(form.get("region") || "") || undefined, minAppVersion: String(form.get("minAppVersion") || "") || undefined, reason: String(form.get("reason")) }, keyRef.current);
      complete();
    } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }
  return <Dialog title="创建配置 Revision" close={close} dismissible={!submitting}><form className="decision-form action-grid" onSubmit={submit}><label className="wide">配置 Key<input name="key" minLength={3} maxLength={200} required placeholder="例如 points.event_publish.cost" /></label><label className="wide">配置值（JSON）<textarea name="value" required defaultValue="{}" /></label><label className="wide">受众（JSON）<textarea name="audience" required defaultValue="{}" /></label><label>区域<input name="region" maxLength={100} placeholder="留空为全局" /></label><label>最低 App 版本<input name="minAppVersion" maxLength={50} placeholder="可选" /></label><label className="wide">变更原因<textarea name="reason" minLength={3} maxLength={2000} required /></label>{error && <p className="form-error wide" role="alert">{error}</p>}<div className="dialog-actions wide"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting} type="submit">{submitting ? "创建中" : "创建并等待审批"}</button></div></form></Dialog>;
}

function ConfigImpactDialog({ item, close }: { item: ConfigRevision; close: () => void }) {
  const load = useCallback(() => previewConfigImpact(item), [item]);
  return <Dialog title={`影响预览 · ${item.key}`} close={close}><Remote load={load}>{(impact) => <div className="case-detail"><section><h3>预计影响</h3><p>{formatNumber(impact.affectedUsers)} 名用户 · {impact.affectedRegions.join("、")}</p><p>报价保护：{impact.quoteProtection ? "启用" : "不适用"}</p></section><section><h3>警告</h3>{impact.warnings.length === 0 ? <p>没有额外警告。</p> : impact.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section><div className="dialog-actions"><button type="button" onClick={close}>关闭</button></div></div>}</Remote></Dialog>;
}

function ConfigActionDialog({ item, action, close, complete }: { item: ConfigRevision; action: "approve" | "activate" | "rollback"; close: () => void; complete: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try {
      if (action === "approve") await approveConfigRevision(item, keyRef.current);
      else if (action === "activate") await activateConfigRevision(item, keyRef.current);
      else await rollbackConfigRevision(item, reason, keyRef.current);
      complete();
    } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }
  const verb = action === "approve" ? "批准" : action === "activate" ? "激活" : "创建回滚 Revision";
  return <Dialog title={`${verb} · ${item.key} v${item.version}`} close={close} dismissible={!submitting}><form className="decision-form" onSubmit={submit}><p className="decision-warning"><OpsIcon name="key" />{action === "activate" ? "激活后会取代同 Key 的当前版本；既有报价继续受保护。" : action === "approve" ? "提交人与审批人必须不同；决定将写入不可变审计。" : "回滚不会改写历史，而是创建一个新的 Revision。"}</p>{action === "rollback" && <label>回滚原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={2000} required /></label>}{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting} type="submit">{submitting ? "提交中" : `确认${verb}`}</button></div></form></Dialog>;
}

function ExportActionDialog({ item, action, close, complete }: { item: OpsExport; action: "approve" | "reject" | "download"; close: () => void; complete: () => void }) {
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState<Awaited<ReturnType<typeof getOpsExportDownloadTicket>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent) {
    event.preventDefault(); setSubmitting(true); setError(null);
    try {
      if (action === "download") {
        setTicket(await getOpsExportDownloadTicket(item, reason));
      } else {
        await approveOpsExport(item, action, reason, keyRef.current);
      }
      complete();
    } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); }
  }
  const title = action === "download" ? "签发限时下载凭证" : action === "approve" ? "批准受控导出" : "拒绝受控导出";
  return <Dialog title={`${title} · ${datasetLabel(item.dataset)}`} close={close} dismissible={!submitting}>{ticket ? <div className="case-detail"><div className="download-ticket"><b>凭证将在 {formatDateTime(ticket.expiresAt)} 失效</b><span>下载次数 {ticket.downloadCount} / {ticket.maxDownloads}</span><a href={ticket.url} target="_blank" rel="noreferrer">打开加水印导出文件</a></div><div className="dialog-actions"><button type="button" onClick={close}>关闭</button></div></div> : <form className="decision-form" onSubmit={submit}><p className="decision-warning"><OpsIcon name="lock" />{action === "download" ? "签发会占用一次下载额度并记录用途；凭证 5 分钟有效。" : "申请人与审批人必须分离；导出文件会加水印、限时并限制下载次数。"}</p><label>{action === "download" ? "本次下载用途" : action === "approve" ? "审批依据" : "拒绝原因"}<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={2000} required /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting} type="submit">{submitting ? "提交中" : "确认并写入审计"}</button></div></form>}</Dialog>;
}

function EventDecisionDialog({ item, close, complete }: { item: OpsEvent; close: () => void; complete: () => void }) {
  const [decision, setDecision] = useState<"" | "published" | "needs_changes" | "rejected">("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent) { event.preventDefault(); if (!decision) return; setSubmitting(true); setError(null); try { await reviewOpsEvent(item, { decision, reason }, keyRef.current); complete(); } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); } }
  return <Dialog title={`审核《${item.title}》`} close={close} dismissible={!submitting}><form className="decision-form" onSubmit={submit}><label>审核结果<select value={decision} required onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="" disabled>请选择审核结果</option><option value="published">通过并发布（将扣除发布积分）</option><option value="needs_changes">需要修改</option><option value="rejected">拒绝并释放积分预占</option></select></label><label>审核依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={2000} required placeholder="说明命中规则与决定依据" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting || !decision} type="submit">{submitting ? "提交中" : decision === "published" ? "确认发布并写入审计" : "确认并写入审计"}</button></div></form></Dialog>;
}

function ModerationDecisionDialog({ item, close, complete }: { item: ModerationCase; close: () => void; complete: () => void }) {
  const [decision, setDecision] = useState<"" | "no_action" | "hide" | "remove" | "restrict">("");
  const [reason, setReason] = useState("");
  const [durationHours, setDurationHours] = useState(24);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  async function submit(event: FormEvent) { event.preventDefault(); if (!decision) return; setSubmitting(true); setError(null); try { await decideModerationCase(item, { decision, reason, ...(decision === "restrict" ? { durationHours } : {}) }, keyRef.current); complete(); } catch (cause) { setError(opsErrorMessage(cause)); } finally { setSubmitting(false); } }
  return <Dialog title={`处理案件 ${item.reference}`} close={close} dismissible={!submitting}><form className="decision-form" onSubmit={submit}><label>处理决定<select value={decision} required onChange={(event) => setDecision(event.target.value as typeof decision)}><option value="" disabled>请选择处理决定</option><option value="no_action">无需处置</option><option value="hide">隐藏内容</option><option value="remove">紧急下架</option><option value="restrict">限制账号能力</option></select></label>{decision === "restrict" && <label>限制时长（小时）<input type="number" min="1" max="8760" value={durationHours} onChange={(event) => setDurationHours(Number(event.target.value))} /></label>}<label>处理依据<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={2000} required placeholder="说明证据、规则和处置范围" /></label>{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting || !decision} type="submit">{submitting ? "提交中" : "确认处理"}</button></div></form></Dialog>;
}

function PointDecisionDialog({ item, action, close, complete }: { item: PointAdjustment; action: "approve" | "reject" | "execute"; close: () => void; complete: () => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyRef = useRef(createOpsIdempotencyKey());
  const title = action === "approve" ? "审批积分调整" : action === "reject" ? "拒绝积分调整" : "执行已批准调整";
  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (action === "execute") await executePointAdjustment(item, keyRef.current);
      else await decidePointAdjustment(item, action, reason.trim(), keyRef.current);
      complete();
    } catch (cause) {
      setError(opsErrorMessage(cause));
    } finally {
      setSubmitting(false);
    }
  }
  return <Dialog title={title} close={close} dismissible={!submitting}><form className="decision-form" onSubmit={submit}><div className="decision-summary"><span>{item.target.nickname} · {item.bucket === "paid" ? "付费积分" : "免费积分"}</span><strong className={item.amount < 0 ? "danger-text" : "success-text"}>{item.amount > 0 ? "+" : ""}{formatNumber(item.amount)}</strong></div>{action === "execute" ? <p className="decision-warning"><OpsIcon name="key" />执行后将生成不可变双分录流水；审批人与申请人必须不同。</p> : <label>{action === "approve" ? "审批依据" : "拒绝原因"}<textarea value={reason} onChange={(event) => setReason(event.target.value)} minLength={3} maxLength={1000} required placeholder="填写具体政策条款、证据与必要说明" /></label>}{error && <p className="form-error" role="alert">{error}</p>}<div className="dialog-actions"><button type="button" disabled={submitting} onClick={close}>取消</button><button className="primary-button" disabled={submitting} type="submit">{submitting ? "提交中" : action === "execute" ? "确认执行" : "确认并写入审计"}</button></div></form></Dialog>;
}

function Dialog({ title, close, children, dismissible = true }: { title: string; close: () => void; children: ReactNode; dismissible?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const initial = dialog?.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled]), .dialog-actions button:not([disabled])");
    initial?.focus();
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && dismissible) {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab" && dialog) {
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'));
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [close, dismissible]);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (dismissible && event.target === event.currentTarget) close(); }}><section ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><header><h2 id="dialog-title">{title}</h2><button type="button" disabled={!dismissible} aria-label={dismissible ? "关闭" : "正在提交，暂不可关闭"} onClick={close}><OpsIcon name="close" /></button></header>{children}</section></div>;
}
function Panel({ title, kicker, meta, className = "", children }: { title: string; kicker: string; meta?: string; className?: string; children: ReactNode }) { return <article className={`panel ${className}`}><header className="panel-head"><div><p>{kicker}</p><h2>{title}</h2></div>{meta && <span>{meta}</span>}</header>{children}</article>; }
function Metric({ label, value, meta, tone = "neutral" }: { label: string; value: ReactNode; meta: string; tone?: string }) { return <article className={`metric ${tone}`}><span>{label}</span><strong>{value}</strong><small>{meta}</small></article>; }
function Signal({ label, value }: { label: string; value: ReactNode }) { return <div className="signal"><span>{label}</span><strong>{value}</strong></div>; }
function Attention({ label, value, tone = "calm" }: { label: string; value: ReactNode; tone?: string }) { return <div className={`attention ${tone}`}><dt>{label}</dt><dd>{value}</dd></div>; }
function ResponsiveTable({ headers, children }: { headers: string[]; children: ReactNode }) { return <div className="table-shell"><table><thead><tr>{headers.map((header) => <th key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
function Pagination<T>({ page, loadMore, loading }: { page: CursorPage<T>; loadMore: () => void; loading: boolean }) { return page.hasMore && page.nextCursor ? <div className="pagination"><button type="button" disabled={loading} onClick={loadMore}>{loading ? "读取中…" : "加载更多"}</button></div> : null; }
function PermissionNote({ children }: { children: ReactNode }) { return <p className="permission-note"><OpsIcon name="lock" />{children}</p>; }
function Status({ value }: { value: string }) { const normalized = value.toLowerCase(); const tone = ["active", "approved", "executed", "published", "normal", "balanced", "ready", "closed"].includes(normalized) ? "positive" : ["rejected", "removed", "blocked", "failed", "p0", "suspended", "expired"].includes(normalized) ? "negative" : ["pending", "pending_review", "draft", "appealed", "investigating", "elevated", "claimed", "restricted", "closing", "needs_changes"].includes(normalized) ? "warning" : "neutral"; return <span className={`status ${tone}`}>{statusLabel(value)}</span>; }
function Funnel({ title, data }: { title: string; data: Array<{ stage: string; value: number; rate: number }> }) { const max = Math.max(...data.map((item) => item.value), 1); return <Panel title={title} kicker="CONVERSION"><div className="funnel">{data.map((item) => <div key={item.stage}><header><span>{item.stage}</span><b>{formatNumber(item.value)} · {formatPercent(item.rate)}</b></header><span className="funnel-track"><i style={{ width: `${Math.max(5, item.value / max * 100)}%` }} /></span></div>)}</div></Panel>; }
function LoadingState() { return <div className="loading-state" role="status"><span /><span /><span /><p>正在读取权威数据</p></div>; }
function EmptyState() { return <div className="empty-state"><OpsIcon name="check" /><h3>当前没有待处理项目</h3><p>筛选条件下没有结果，或队列已经处理完毕。</p></div>; }
function ErrorState({ message, retry }: { message: string; retry: () => void }) { return <div className="error-state" role="alert"><OpsIcon name="alert" /><div><h3>暂时无法读取运营数据</h3><p>{message}</p></div><button type="button" onClick={retry}><OpsIcon name="refresh" />重试</button></div>; }

function formatNumber(value: number) { return new Intl.NumberFormat("zh-CN").format(value); }
function formatPercent(value: number) { return new Intl.NumberFormat("zh-CN", { style: "percent", maximumFractionDigits: 1 }).format(value); }
function formatDateTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date); }
function maskId(value: string) { return value.length > 12 ? `${value.slice(0, 6)}••${value.slice(-4)}` : value; }
function formatConfigValue(value: unknown) { const text = JSON.stringify(value); return text && text.length > 72 ? `${text.slice(0, 69)}...` : text ?? "null"; }
function datasetLabel(value: string) { return ({ event_roster: "活动履约名单", safety_summary: "安全案件摘要", points_reconciliation: "积分对账", audit_log: "权限审计" } as Record<string, string>)[value] ?? value; }
function roleLabel(value: string) { return ({ moderator: "内容审核", support: "用户支持", securityLead: "安全负责人", eventReviewer: "活动审核", groupReviewer: "群组治理", pointsRequester: "积分申请", pointsApprover: "积分审批", financeRead: "财务只读", financeLead: "财务负责人", configEditor: "配置编辑", configApprover: "配置审批", analyst: "数据分析", auditReader: "审计读取", superAdmin: "超级管理员" } as Record<string, string>)[value] ?? value; }
function statusLabel(value: string) { return ({ active: "正常", restricted: "受限", suspended: "已暂停", pending: "待处理", pending_review: "待审核", draft: "草稿", approved: "已批准", active_revision: "已生效", superseded: "已替代", executed: "已执行", rejected: "已拒绝", failed: "失败", appealed: "申诉中", investigating: "调查中", claimed: "已认领", open: "待认领", closed: "已关闭", decided: "已处理", published: "已发布", needs_changes: "需修改", removed: "已下架", normal: "正常", elevated: "需关注", blocked: "已阻断", closing: "解散冷静期", awaiting_target: "待对方确认", cooling_off: "冷静期", ready: "可下载", expired: "已过期", restore: "恢复", start_closing: "启动解散", cancel_closing: "取消解散", hide: "隐藏", remove: "下架", restrict: "限制", no_action: "无需处置" } as Record<string, string>)[value] ?? `未知状态（${value}）`; }
