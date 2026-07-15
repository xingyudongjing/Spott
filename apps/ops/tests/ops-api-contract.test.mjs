import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/lib/ops-api.ts", import.meta.url), "utf8");

test("O1 API client exposes every controller workflow with its real endpoint", () => {
  const contracts = [
    ["restrictOpsUser", "/ops/users/${item.id}/restriction-decisions"],
    ["decideGroupLifecycle", "/ops/groups/${item.id}/lifecycle-decision"],
    ["getModerationCase", "/ops/moderation/cases/${id}"],
    ["createPointAdjustment", "/ops/points/adjustments"],
    ["createConfigRevision", "/ops/config-revisions"],
    ["previewConfigImpact", "/ops/config-revisions/${item.id}/impact-preview"],
    ["activateConfigRevision", "/ops/config-revisions/${item.id}/activate"],
    ["rollbackConfigRevision", "/ops/config-revisions/${item.id}/rollback"],
    ["approveOpsExport", "/ops/exports/${item.id}/approve"],
    ["getOpsExportDownloadTicket", "/ops/exports/${item.id}/download-ticket"],
    ["getOpsAdminUsers", "/ops/admin-users"],
  ];

  for (const [name, endpoint] of contracts) {
    assert.match(source, new RegExp(`export const ${name}\\b`), name);
    assert.ok(source.includes(endpoint), `${name} uses ${endpoint}`);
  }
  assert.match(source, /export type OpsAdminUsersResponse = \{[\s\S]*items: OpsAdminUser\[\]/);
});

test("mutation contracts use explicit reusable idempotency keys and truthful result DTOs", () => {
  assert.match(source, /type MutationRequestOptions = RequestInit & \{[\s\S]*idempotencyKey: string/);
  assert.match(source, /headers\.set\("Idempotency-Key", options\.idempotencyKey\)/);
  assert.doesNotMatch(source, /idempotent\??:\s*boolean/);
  assert.doesNotMatch(source, /if \(options\.idempotent\)/);

  for (const dto of [
    "UserRestrictionDecisionResult",
    "GroupLifecycleDecisionResult",
    "ModerationClaimResult",
    "ModerationDecisionResult",
    "EventReviewResult",
    "PointAdjustmentMutationResult",
    "ConfigRevisionMutationResult",
    "ExportMutationResult",
  ]) assert.match(source, new RegExp(`export type ${dto}\\b`), dto);

  assert.doesNotMatch(source, /claimModerationCase[\s\S]{0,220}request<ModerationCase>/);
  assert.doesNotMatch(source, /decideModerationCase[\s\S]{0,260}request<ModerationCase>/);
  assert.doesNotMatch(source, /reviewOpsEvent[\s\S]{0,260}request<OpsEvent>/);
});

test("every cursor collection accepts cursor and limit; points do not hide approved requests", () => {
  for (const optionsType of [
    "OpsUsersQuery",
    "OpsOrganizersQuery",
    "OpsEventsQuery",
    "OpsGroupsQuery",
    "ModerationCasesQuery",
    "PointAdjustmentsQuery",
    "ConfigRevisionsQuery",
    "AuditLogsQuery",
    "OpsExportsQuery",
  ]) {
    assert.match(source, new RegExp(`export type ${optionsType} = CursorQuery &`), optionsType);
  }
  assert.doesNotMatch(source, /points\/adjustments\?state=pending/);
  assert.match(source, /getPointAdjustments[\s\S]{0,260}query\("\/ops\/points\/adjustments", \{ \.\.\.options, limit: options\.limit \?\? 50 \}\)/);
});

test("unconfigured API base only trusts local development and the production ops host", () => {
  assert.match(source, /\["localhost", "127\.0\.0\.1"\]\.includes\(hostname\)/);
  assert.match(source, /hostname === "ops\.spott\.jp"/);
  assert.match(source, /throw new OpsAPIConfigurationError/);
  assert.doesNotMatch(source, /return "https:\/\/api\.spott\.jp\/v1";\s*\}/);
});

test("auth failures are discriminated for sign-in, forbidden, and step-up UI", () => {
  assert.match(source, /export type OpsAPIErrorKind = "unauthenticated" \| "forbidden" \| "reauth_required" \| "request"/);
  assert.match(source, /code\.includes\("REAUTH_REQUIRED"\)/);
  assert.match(source, /status === 401/);
  assert.match(source, /status === 403/);
  assert.match(source, /readonly kind: OpsAPIErrorKind/);
  for (const detail of ["retryable", "fieldErrors", "actions", "meta"]) {
    assert.match(source, new RegExp(`readonly ${detail}\\b`), detail);
  }
});

test("export requests always send filters, defaulting to an empty record", () => {
  assert.match(source, /filters\?: Record<string, unknown>/);
  assert.match(source, /filters: body\.filters \?\? \{\}/);
});

test("production operations session has email OTP, cookie refresh, and logout contracts", () => {
  for (const endpoint of [
    "/auth/email/challenges",
    "/ops/auth/email/verify",
    "/ops/auth/refresh",
    "/ops/auth/session",
  ]) assert.ok(source.includes(endpoint), endpoint);
  assert.match(source, /response\.status === 401/);
  assert.match(source, /allowRefresh/);
  assert.match(source, /credentials:\s*"include"/);
  assert.match(source, /export type OpsAuthSessionResult/);
  assert.doesNotMatch(source, /verifyOpsEmailChallenge[\s\S]{0,240}request<OpsSession>/);
  assert.match(source, /spott:ops-auth-required/);
});
