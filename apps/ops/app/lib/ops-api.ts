"use client";

export type CursorPage<T> = {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
};

export type CursorQuery = {
  cursor?: string;
  limit?: number;
};

export type OpsUsersQuery = CursorQuery & {
  q?: string;
  status?: string;
  restriction?: string;
  deviceRisk?: string;
};

export type OpsOrganizersQuery = CursorQuery & {
  q?: string;
  status?: string;
};

export type OpsEventsQuery = CursorQuery & {
  q?: string;
  status?: string;
  riskMin?: number;
  region?: string;
};

export type OpsGroupsQuery = CursorQuery & {
  q?: string;
  status?: string;
};

export type ModerationCasesQuery = CursorQuery & {
  q?: string;
  severity?: string;
  status?: string;
  assignee?: string;
  targetType?: string;
};

export type PointAdjustmentsQuery = CursorQuery & {
  state?: string;
};

export type ConfigRevisionsQuery = CursorQuery & {
  state?: string;
  key?: string;
};

export type AuditLogsQuery = CursorQuery & {
  q?: string;
  actorId?: string;
  action?: string;
  resource?: string;
  from?: string;
  to?: string;
};

export type OpsExportsQuery = CursorQuery & {
  state?: string;
};

export type OpsOverview = {
  generatedAt: string;
  queues: {
    p0Open: number;
    moderationOpen: number;
    eventReviewPending: number;
    pointApprovalsPending: number;
    appealsPending: number;
    outboxBacklog: number;
  };
  health: {
    deliverySuccessRate1h: number;
    ledgerDeltaPaid: number;
    ledgerDeltaFree: number;
  };
  growth: {
    activeUsers30d: number;
    activeGroups: number;
    eventsOpen: number;
    checkinRate30d: number;
    repeatRate60d: number;
  };
};

export type OpsUser = {
  id: string;
  handle: string;
  nickname: string;
  status: string;
  restrictions: string[];
  phoneVerified: boolean;
  deviceRisk: string;
  hostedCount: number;
  registrationCount: number;
  complaintCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
};

export type OpsOrganizer = {
  id: string;
  handle: string;
  nickname: string;
  status: string;
  verificationState: string;
  hostedCount: number;
  upcomingCount: number;
  completionRate: number;
  checkinRate: number;
  repeatRate60d: number;
  complaintRate: number;
  restrictionFlags: string[];
  version: number;
};

export type OpsEvent = {
  id: string;
  slug: string;
  title: string;
  organizer: { id: string; handle: string; nickname: string };
  status: string;
  categoryId: string | null;
  startsAt: string | null;
  publicArea: string | null;
  isFree: boolean | null;
  amountJpy: number | null;
  riskScore: number;
  riskReasons: string[];
  submittedAt: string;
  version: number;
};

export type OpsGroup = {
  id: string;
  slug: string;
  name: string;
  owner: { id: string; handle: string; nickname: string };
  status: string;
  joinMode: string;
  memberCount: number;
  capacity: number;
  openEventCount: number;
  reportCount: number;
  activeTransferState: string | null;
  closingAt: string | null;
  version: number;
};

export type ModerationCase = {
  id: string;
  reference: string;
  targetType: string;
  targetId: string;
  reason: string;
  severity: "p0" | "p1" | "p2";
  status: string;
  assignee: { id: string; label: string } | null;
  slaDueAt: string;
  createdAt: string;
  version: number;
};

export type ModerationCaseDetail = ModerationCase & {
  target: { type: string; idMasked: string };
  reporter: { present: boolean };
  evidence: Array<{
    id: string;
    assetId: string;
    mimeType: string | null;
    byteSize: number;
    retentionUntil: string;
    signedUrl: string | null;
  }>;
  actions: Array<{
    id: string;
    type: string;
    reason: string;
    expiresAt: string | null;
    createdAt: string;
  }>;
  appeals: Array<{
    id: string;
    status: string;
    createdAt: string;
    decidedAt: string | null;
  }>;
};

export type PointAdjustment = {
  id: string;
  target: { id: string; handle: string; nickname: string };
  bucket: "paid" | "free";
  amount: number;
  reason: string;
  state: string;
  requester: { id: string; label: string };
  approver: { id: string; label: string } | null;
  transactionId: string | null;
  requiredApprovals: number;
  approvalCount: number;
  version: number;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
};

export type LedgerHealth = {
  checkedAt: string;
  balanced: boolean;
  paidDelta: number;
  freeDelta: number;
  negativePaidWallets: number;
  pendingStoreReconciliations: number;
  expiringLots: number;
};

export type ConfigRevision = {
  id: string;
  key: string;
  value: unknown;
  version: number;
  audience: Record<string, unknown>;
  region: string | null;
  minAppVersion: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  state: string;
  reason: string;
  submittedBy: { id: string; label: string };
  approvedBy: { id: string; label: string } | null;
  createdAt: string;
  canApprove: boolean;
};

export type ConfigImpactPreview = {
  affectedUsers: number;
  affectedRegions: string[];
  warnings: string[];
  quoteProtection: boolean;
};

export type AnalyticsOverview = {
  generatedAt: string;
  participantFunnel: Array<{ stage: string; value: number; rate: number }>;
  hostFunnel: Array<{ stage: string; value: number; rate: number }>;
  groupFunnel: Array<{ stage: string; value: number; rate: number }>;
  points: { freeIssued: number; paidIssued: number; consumed: number; expired: number; refundRate: number };
  safety: { reports: number; severeIncidents: number; complaintRate: number };
  supply: { openEvents: number; categoryCoverage: number; regionCoverage: number };
};

export type AuditLog = {
  id: string;
  createdAt: string;
  actor: { id: string; label: string } | null;
  action: string;
  resource: string;
  resourceIdMasked: string | null;
  purpose: string | null;
  traceId: string;
};

export type OpsAdminUser = {
  id: string;
  identityUserId: string;
  label: string;
  roles: string[];
  dataScopes: string[];
  disabledAt: string | null;
  mfaEnrolledAt: string;
};

export type OpsAdminUsersResponse = {
  items: OpsAdminUser[];
};

export type OpsExport = {
  id: string;
  dataset: string;
  purpose: string;
  state: string;
  requester: { id: string; label: string };
  approver: { id: string; label: string } | null;
  watermark: string;
  expiresAt: string;
  maxDownloads: number;
  downloadCount: number;
  createdAt: string;
};

export type OpsExportDownloadTicket = {
  url: string;
  expiresAt: string;
  downloadCount: number;
  maxDownloads: number;
};

export type OpsSession = {
  operatorId: string;
  label: string;
  roles: string[];
  dataScopes: string[];
  mfaEnrolled: boolean;
  mfaAgeSeconds: number;
  reauthRequiredFor: string[];
};

export type OpsEmailChallenge = {
  challengeId: string;
  expiresAt: string;
  retryAfterSeconds: number;
  developmentCode?: string;
};

export type OpsAuthSessionResult = {
  sessionId: string;
  accessTokenExpiresAt: string;
  user: Record<string, unknown>;
};

export type UserRestrictionDecisionInput = {
  status?: "active" | "restricted" | "suspended";
  restrictions: Array<"loginBlocked" | "publishBlocked" | "registerBlocked" | "pointsBlocked" | "commentBlocked">;
  expiresAt?: string;
  reason: string;
};

export type UserRestrictionDecisionResult = {
  id: string;
  status: string;
  restrictions: string[];
  version: number;
  expiresAt?: string | null;
  decisionState?: "pending_approval";
  approvalId?: string;
  requestId: string;
};

export type GroupLifecycleDecisionInput = {
  decision: "restore" | "start_closing" | "cancel_closing" | "remove";
  reason: string;
};

export type GroupLifecycleDecisionResult = {
  id: string;
  status: string;
  version: number;
  requestId: string;
};

export type ModerationClaimResult = {
  id: string;
  status: string;
  assignee: { id: string; label: string };
  version: number;
  requestId: string;
};

export type ModerationDecisionResult = {
  id: string;
  status: "decided";
  decision: "no_action" | "hide" | "remove" | "restrict";
  version: number;
  requestId: string;
};

export type EventReviewResult = {
  id: string;
  eventId: string;
  status: "published" | "needs_changes" | "rejected";
  reason: string;
  version: number;
  posterJobId: string | null;
  requestId: string;
};

export type PointAdjustmentMutationResult = PointAdjustment;
export type ConfigRevisionMutationResult = ConfigRevision;
export type ExportMutationResult = OpsExport;

export type PointAdjustmentCreateInput = {
  targetUserId: string;
  bucket: "paid" | "free";
  amount: number;
  reason: string;
  evidenceRef?: string;
};

export type ConfigRevisionCreateInput = {
  key: string;
  value: unknown;
  audience?: Record<string, unknown>;
  region?: string;
  minAppVersion?: string;
  effectiveFrom?: string;
  effectiveTo?: string;
  reason: string;
};

export type OpsExportCreateInput = {
  dataset: "event_roster" | "safety_summary" | "points_reconciliation" | "audit_log";
  filters?: Record<string, unknown>;
  purpose: string;
  expiresInHours: number;
  maxDownloads: number;
};

type RequestOptions = RequestInit & { ifMatch?: number };
type MutationRequestOptions = RequestInit & {
  ifMatch?: number;
  idempotencyKey: string;
};

export type OpsAPIErrorKind = "unauthenticated" | "forbidden" | "reauth_required" | "request";

export type OpsAPIFieldError = { field: string; message: string };
export type OpsAPIAction = { type: string; label: string };
type OpsAPIErrorContext = {
  retryable?: boolean;
  fieldErrors?: OpsAPIFieldError[];
  actions?: OpsAPIAction[];
  meta?: Record<string, unknown>;
};

function errorKind(status: number, code: string): OpsAPIErrorKind {
  if (code.includes("REAUTH_REQUIRED")) return "reauth_required";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  return "request";
}

export class OpsAPIError extends Error {
  readonly kind: OpsAPIErrorKind;
  readonly retryable: boolean;
  readonly fieldErrors: OpsAPIFieldError[];
  readonly actions: OpsAPIAction[];
  readonly meta: Record<string, unknown>;

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    context: OpsAPIErrorContext = {},
  ) {
    super(message);
    this.name = "OpsAPIError";
    this.kind = errorKind(status, code);
    this.retryable = context.retryable ?? false;
    this.fieldErrors = context.fieldErrors ?? [];
    this.actions = context.actions ?? [];
    this.meta = context.meta ?? {};
  }
}

export class OpsAPIConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpsAPIConfigurationError";
  }
}

export function opsApiBase(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL;
  if (configured) return configured.replace(/\/$/, "");

  const hostname = typeof window === "undefined" ? "" : window.location.hostname;
  if (["localhost", "127.0.0.1"].includes(hostname)) return "http://127.0.0.1:4100/v1";
  if (hostname === "ops.spott.jp") return "https://api.spott.jp/v1";
  throw new OpsAPIConfigurationError("NEXT_PUBLIC_API_URL 未配置，已拒绝向未知主机发送运营数据。");
}

function developmentHeaders(headers: Headers): void {
  if (
    process.env.NODE_ENV !== "development" ||
    typeof window === "undefined" ||
    !["localhost", "127.0.0.1"].includes(window.location.hostname)
  ) return;
  headers.set("X-Spott-User-Id", "019b0000-0000-7000-8000-000000000004");
  headers.set("X-Spott-Role", "operator");
  headers.set("X-Spott-Device-Id", "00000000-0000-4000-8000-000000000098");
}

async function request<T>(
  path: string,
  options: RequestOptions | MutationRequestOptions = {},
  allowRefresh = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (options.ifMatch !== undefined) headers.set("If-Match", `"${options.ifMatch}"`);
  if ("idempotencyKey" in options) headers.set("Idempotency-Key", options.idempotencyKey);
  developmentHeaders(headers);

  const response = await fetch(`${opsApiBase()}${path}`, {
    ...options,
    headers,
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 401 && allowRefresh && !path.startsWith("/ops/auth/")) {
    try {
      await request<OpsAuthSessionResult>("/ops/auth/refresh", { method: "POST" }, false);
      return request<T>(path, options, false);
    } catch {
      // Preserve the original protected-resource error so the access gate can
      // distinguish an expired session from a refresh endpoint failure.
    }
  }
  if (!response.ok) {
    let payload: {
      error?: {
        code?: string;
        message?: string;
        requestId?: string;
        retryable?: boolean;
        fieldErrors?: OpsAPIFieldError[];
        actions?: OpsAPIAction[];
        meta?: Record<string, unknown>;
      };
      code?: string;
      message?: string;
      requestId?: string;
      retryable?: boolean;
      fieldErrors?: OpsAPIFieldError[];
      actions?: OpsAPIAction[];
      meta?: Record<string, unknown>;
    } = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    const error = payload.error ?? payload;
    const apiError = new OpsAPIError(
      response.status,
      error.code ?? "OPS_REQUEST_FAILED",
      error.message ?? `请求失败（${response.status}）`,
      error.requestId ?? response.headers.get("x-request-id") ?? undefined,
      {
        retryable: error.retryable,
        fieldErrors: error.fieldErrors,
        actions: error.actions,
        meta: error.meta,
      },
    );
    if (apiError.kind === "unauthenticated" && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("spott:ops-auth-required", { detail: apiError }));
    }
    throw apiError;
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function query(path: string, values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const suffix = params.toString();
  return suffix ? `${path}?${suffix}` : path;
}

function collectionQuery<T extends CursorQuery>(options: T): T & { limit: number } {
  return { ...options, limit: options.limit ?? 50 };
}

function queryCompat<T extends { q?: string }>(options: T | string): T {
  return (typeof options === "string" ? { q: options } : options) as T;
}

export function createOpsIdempotencyKey(): string {
  return crypto.randomUUID();
}

export const getOpsOverview = () => request<OpsOverview>("/ops/overview");

export const createOpsEmailChallenge = (email: string, deviceId: string) =>
  request<OpsEmailChallenge>("/auth/email/challenges", {
    method: "POST",
    body: JSON.stringify({ email, deviceId }),
  });

export const verifyOpsEmailChallenge = (challengeId: string, code: string, deviceId: string) =>
  request<OpsAuthSessionResult>("/ops/auth/email/verify", {
    method: "POST",
    body: JSON.stringify({ challengeId, code, deviceId }),
  }, false);

export const refreshOpsSession = () =>
  request<OpsAuthSessionResult>("/ops/auth/refresh", { method: "POST" }, false);

export const logoutOpsSession = () =>
  request<void>("/ops/auth/session", { method: "DELETE" }, false);

export const getOpsUsers = (options: OpsUsersQuery | string = {}) =>
  request<CursorPage<OpsUser>>(query("/ops/users", collectionQuery(queryCompat<OpsUsersQuery>(options))));

export const restrictOpsUser = (
  item: Pick<OpsUser, "id" | "version">,
  body: UserRestrictionDecisionInput,
  idempotencyKey: string,
) => request<UserRestrictionDecisionResult>(`/ops/users/${item.id}/restriction-decisions`, {
  method: "POST",
  body: JSON.stringify(body),
  ifMatch: item.version,
  idempotencyKey,
});

export const getOpsOrganizers = (options: OpsOrganizersQuery | string = {}) =>
  request<CursorPage<OpsOrganizer>>(query("/ops/organizers", collectionQuery(queryCompat<OpsOrganizersQuery>(options))));

export const getOpsEvents = (options: OpsEventsQuery | string = {}) => {
  const values = queryCompat<OpsEventsQuery>(options);
  const defaults = typeof options === "string" ? { status: "pending_review" } : {};
  return request<CursorPage<OpsEvent>>(query("/ops/events", collectionQuery({ ...defaults, ...values })));
};

export const reviewOpsEvent = (
  item: Pick<OpsEvent, "id" | "version">,
  body: { decision: "published" | "needs_changes" | "rejected"; reason: string },
  idempotencyKey: string,
) => request<EventReviewResult>(`/ops/events/${item.id}/review`, {
  method: "POST",
  body: JSON.stringify(body),
  ifMatch: item.version,
  idempotencyKey,
});

export const getOpsGroups = (options: OpsGroupsQuery | string = {}) =>
  request<CursorPage<OpsGroup>>(query("/ops/groups", collectionQuery(queryCompat<OpsGroupsQuery>(options))));

export const decideGroupLifecycle = (
  item: Pick<OpsGroup, "id" | "version">,
  body: GroupLifecycleDecisionInput,
  idempotencyKey: string,
) => request<GroupLifecycleDecisionResult>(`/ops/groups/${item.id}/lifecycle-decision`, {
  method: "POST",
  body: JSON.stringify(body),
  ifMatch: item.version,
  idempotencyKey,
});

export const getModerationCases = (options: ModerationCasesQuery = {}) =>
  request<CursorPage<ModerationCase>>(query("/ops/moderation/cases", collectionQuery(options)));

export const getModerationCase = (id: string, purpose?: string) =>
  request<ModerationCaseDetail>(query(`/ops/moderation/cases/${id}`, { purpose }));

export const claimModerationCase = (
  item: Pick<ModerationCase, "id" | "version">,
  idempotencyKey: string,
) => request<ModerationClaimResult>(`/ops/moderation/cases/${item.id}/claim`, {
  method: "POST",
  ifMatch: item.version,
  idempotencyKey,
});

export const decideModerationCase = (
  item: Pick<ModerationCase, "id" | "version">,
  body: { decision: "no_action" | "hide" | "remove" | "restrict"; reason: string; durationHours?: number },
  idempotencyKey: string,
) => request<ModerationDecisionResult>(`/ops/moderation/cases/${item.id}/decision`, {
  method: "POST",
  body: JSON.stringify(body),
  ifMatch: item.version,
  idempotencyKey,
});

export const getPointAdjustments = (options: PointAdjustmentsQuery = {}) =>
  request<CursorPage<PointAdjustment>>(query("/ops/points/adjustments", { ...options, limit: options.limit ?? 50 }));

export const createPointAdjustment = (body: PointAdjustmentCreateInput, idempotencyKey: string) =>
  request<PointAdjustmentMutationResult>("/ops/points/adjustments", {
    method: "POST",
    body: JSON.stringify(body),
    idempotencyKey,
  });

export const decidePointAdjustment = (
  item: Pick<PointAdjustment, "id">,
  decision: "approve" | "reject",
  reason: string,
  idempotencyKey: string,
) => request<PointAdjustmentMutationResult>(`/ops/points/adjustments/${item.id}/decision`, {
  method: "POST",
  body: JSON.stringify({ decision, reason }),
  idempotencyKey,
});

export const executePointAdjustment = (item: Pick<PointAdjustment, "id">, idempotencyKey: string) =>
  request<PointAdjustmentMutationResult>(`/ops/points/adjustments/${item.id}/execute`, {
    method: "POST",
    idempotencyKey,
  });

export const getLedgerHealth = () => request<LedgerHealth>("/ops/points/ledger-health");

export const getConfigRevisions = (options: ConfigRevisionsQuery = {}) =>
  request<CursorPage<ConfigRevision>>(query("/ops/config-revisions", collectionQuery(options)));

export const createConfigRevision = (body: ConfigRevisionCreateInput, idempotencyKey: string) =>
  request<ConfigRevisionMutationResult>("/ops/config-revisions", {
    method: "POST",
    body: JSON.stringify({ ...body, audience: body.audience ?? {} }),
    idempotencyKey,
  });

export const previewConfigImpact = (item: Pick<ConfigRevision, "id">) =>
  request<ConfigImpactPreview>(`/ops/config-revisions/${item.id}/impact-preview`, { method: "POST" });

export const approveConfigRevision = (
  item: Pick<ConfigRevision, "id" | "version">,
  idempotencyKey: string,
) => request<ConfigRevisionMutationResult>(`/ops/config-revisions/${item.id}/approve`, {
  method: "POST",
  ifMatch: item.version,
  idempotencyKey,
});

export const activateConfigRevision = (item: Pick<ConfigRevision, "id">, idempotencyKey: string) =>
  request<ConfigRevisionMutationResult>(`/ops/config-revisions/${item.id}/activate`, {
    method: "POST",
    idempotencyKey,
  });

export const rollbackConfigRevision = (
  item: Pick<ConfigRevision, "id">,
  reason: string,
  idempotencyKey: string,
) => request<ConfigRevisionMutationResult>(`/ops/config-revisions/${item.id}/rollback`, {
  method: "POST",
  body: JSON.stringify({ reason }),
  idempotencyKey,
});

export const getAnalyticsOverview = (options: { from?: string; to?: string; region?: string } = {}) =>
  request<AnalyticsOverview>(query("/ops/analytics/overview", options));

export const getAuditLogs = (options: AuditLogsQuery | string = {}) =>
  request<CursorPage<AuditLog>>(query("/ops/audit-logs", collectionQuery(queryCompat<AuditLogsQuery>(options))));

export const getOpsAdminUsers = () => request<OpsAdminUsersResponse>("/ops/admin-users");

export const getOpsSession = () => request<OpsSession>("/ops/session");

export const getOpsExports = (options: OpsExportsQuery = {}) =>
  request<CursorPage<OpsExport>>(query("/ops/exports", collectionQuery(options)));

export const createOpsExport = (body: OpsExportCreateInput, idempotencyKey: string) =>
  request<ExportMutationResult>("/ops/exports", {
    method: "POST",
    body: JSON.stringify({ ...body, filters: body.filters ?? {} }),
    idempotencyKey,
  });

export const approveOpsExport = (
  item: Pick<OpsExport, "id">,
  decision: "approve" | "reject",
  reason: string,
  idempotencyKey: string,
) => request<ExportMutationResult>(`/ops/exports/${item.id}/approve`, {
  method: "POST",
  body: JSON.stringify({ decision, reason }),
  idempotencyKey,
});

export const getOpsExportDownloadTicket = (item: Pick<OpsExport, "id">, purpose: string) =>
  request<OpsExportDownloadTicket>(query(`/ops/exports/${item.id}/download-ticket`, { purpose }));

export function opsErrorMessage(error: unknown): string {
  if (error instanceof OpsAPIConfigurationError) return error.message;
  if (error instanceof OpsAPIError) return error.requestId ? `${error.message} · ${error.requestId}` : error.message;
  return error instanceof Error ? error.message : "请求没有成功，请稍后再试。";
}
