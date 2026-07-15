import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const sections = [
  ["/", "态势总览"],
  ["/ops/users", "用户管理"],
  ["/ops/organizers", "局头管理"],
  ["/ops/events", "活动审核"],
  ["/ops/groups", "群组管理"],
  ["/ops/moderation", "内容安全"],
  ["/ops/points", "积分中心"],
  ["/ops/config", "运营配置"],
  ["/ops/analytics", "数据中心"],
  ["/ops/audit", "权限审计"],
  ["/ops/exports", "受控导出"],
];

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${encodeURIComponent(path)}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders every documented operations module", async () => {
  for (const [path, label] of sections) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    const html = await response.text();
    assert.match(html, new RegExp(label), path);
    assert.match(html, /SPOTT/);
    assert.doesNotMatch(html, /Codex is working|Your site is taking shape|Starter Project/);
  }
});

test("operations chrome is light-only and uses semantic SVG icons", async () => {
  const [component, icons, css, layout] = await Promise.all([
    readFile(new URL("app/components/OpsConsole.tsx", root), "utf8"),
    readFile(new URL("app/components/OpsIcon.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
    readFile(new URL("app/layout.tsx", root), "utf8"),
  ]);

  assert.match(css, /color-scheme:\s*light/);
  assert.doesNotMatch(css, /prefers-color-scheme|color-scheme:\s*dark/i);
  assert.match(icons, /<svg/);
  assert.match(icons, /strokeWidth:\s*1\.8/);
  assert.doesNotMatch(component, /⌕|→|◆|≈|⇣|⌘|◎/);
  assert.doesNotMatch(component, /dark|night|夜间模式/i);
  assert.match(layout, /lang="zh-CN"/);
});

test("client declares real operations API contracts instead of fake success handlers", async () => {
  const api = await readFile(new URL("app/lib/ops-api.ts", root), "utf8");
  for (const endpoint of [
    "/ops/overview",
    "/ops/users",
    "/ops/organizers",
    "/ops/events",
    "/ops/groups",
    "/ops/moderation/cases",
    "/ops/points/adjustments",
    "/ops/config-revisions",
    "/ops/analytics/overview",
    "/ops/audit-logs",
    "/ops/exports",
  ]) {
    assert.match(api, new RegExp(endpoint.replaceAll("/", "\\/")), endpoint);
  }
  assert.match(api, /credentials:\s*"include"/);
  assert.match(api, /If-Match/);
  assert.match(api, /Idempotency-Key/);
  assert.match(api, /process\.env\.NODE_ENV !== "development"/);
  assert.doesNotMatch(api, /mock|fake|setTimeout/i);
});

test("mobile styles transform dense tables into readable records", async () => {
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(css, /@media\s*\(max-width:\s*720px\)/);
  assert.match(css, /data-label/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /min-height:\s*44px/);
});

test("mobile action controls keep a 44px touch target after compact desktop overrides", async () => {
  const css = await readFile(new URL("app/globals.css", root), "utf8");
  assert.match(
    css,
    /@media\s*\(max-width:\s*720px\)[\s\S]*\.locale-switch button,\s*\.table-actions button,\s*\.approval-card footer button,\s*\.config-actions button\s*\{\s*min-height:\s*44px;/,
  );
});

test("high-risk workflows use in-product dialogs, never browser prompts", async () => {
  const workspaces = await readFile(new URL("app/components/OpsWorkspaces.tsx", root), "utf8");
  assert.doesNotMatch(workspaces, /window\.(prompt|alert|confirm)/);
  assert.match(workspaces, /role="dialog"/);
  assert.match(workspaces, /确认并写入审计|确认处理/);
});

test("dialogs trap focus, close on Escape, and cannot dismiss while submitting", async () => {
  const workspaces = await readFile(new URL("app/components/OpsWorkspaces.tsx", root), "utf8");
  assert.match(workspaces, /previousFocus/);
  assert.match(workspaces, /event\.key === "Escape"/);
  assert.match(workspaces, /event\.key === "Tab"/);
  assert.match(workspaces, /focusable/);
  assert.match(workspaces, /dismissible={!submitting}/);
  assert.match(workspaces, /role="alert"/);
});

test("session truth and permissions gate all privileged operations", async () => {
  const [consoleSource, workspaces] = await Promise.all([
    readFile(new URL("app/components/OpsConsole.tsx", root), "utf8"),
    readFile(new URL("app/components/OpsWorkspaces.tsx", root), "utf8"),
  ]);
  assert.match(consoleSource, /sessionState/);
  assert.match(consoleSource, /mfaEnrolled/);
  assert.match(consoleSource, /reauthRequiredFor/);
  assert.match(consoleSource, /<OpsWorkspace[\s\S]*session=/);
  assert.match(workspaces, /hasOpsRole/);
  assert.match(workspaces, /PermissionNote/);
  assert.match(consoleSource, /OpsAccessGate/);
  assert.match(consoleSource, /createOpsEmailChallenge/);
  assert.match(consoleSource, /verifyOpsEmailChallenge/);
  assert.match(consoleSource, /logoutOpsSession/);
});

test("all cursor queues expose continuation controls and approved points remain executable", async () => {
  const [api, workspaces] = await Promise.all([
    readFile(new URL("app/lib/ops-api.ts", root), "utf8"),
    readFile(new URL("app/components/OpsWorkspaces.tsx", root), "utf8"),
  ]);
  assert.match(workspaces, /function CursorRemote/);
  assert.match(workspaces, /加载更多/);
  assert.match(workspaces, /nextCursor/);
  assert.doesNotMatch(api, /points\/adjustments\?state=pending/);
});

test("O1 operational actions have real in-product workflows", async () => {
  const workspaces = await readFile(new URL("app/components/OpsWorkspaces.tsx", root), "utf8");
  for (const action of [
    "restrictOpsUser",
    "decideGroupLifecycle",
    "getModerationCase",
    "createPointAdjustment",
    "createConfigRevision",
    "previewConfigImpact",
    "activateConfigRevision",
    "rollbackConfigRevision",
    "approveOpsExport",
    "getOpsExportDownloadTicket",
  ]) assert.match(workspaces, new RegExp(action), action);
  assert.match(workspaces, /const formElement = event\.currentTarget/);
});

test("dangerous decisions require explicit operator choices and truthful ratios", async () => {
  const workspaces = await readFile(new URL("app/components/OpsWorkspaces.tsx", root), "utf8");
  assert.match(workspaces, /useState<[^>]*published[^>]*>\(""\)/);
  assert.doesNotMatch(workspaces, /useState\(action === "approve" \? "符合补偿政策/);
  assert.doesNotMatch(workspaces, /value > 1 \? value \/ 100/);
});

test("mobile navigation keeps labels and the active route visible; tables become cards before 721px", async () => {
  const [consoleSource, css] = await Promise.all([
    readFile(new URL("app/components/OpsConsole.tsx", root), "utf8"),
    readFile(new URL("app/globals.css", root), "utf8"),
  ]);
  assert.match(consoleSource, /navRef/);
  assert.match(consoleSource, /scrollTo/);
  assert.match(css, /@media\s*\(max-width:\s*960px\)[\s\S]*\.table-shell/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*\.nav-copy/);
});

test("local operator identity resolves to the seeded MFA operator", async () => {
  const [api, seed] = await Promise.all([
    readFile(new URL("app/lib/ops-api.ts", root), "utf8"),
    readFile(new URL("../../database/seeds/development.sql", root), "utf8"),
  ]);
  const operatorId = api.match(/X-Spott-User-Id",\s*"([0-9a-f-]+)"/)?.[1];
  assert.ok(operatorId, "development operator header is declared");
  assert.match(seed, new RegExp(`'${operatorId}'`));
  assert.match(seed, new RegExp(`identity_user_id[\\s\\S]+?'${operatorId}'`));
});
