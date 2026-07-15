import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function render(path = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`, { headers: { accept: "text/html", ...headers } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("renders the real discovery product instead of starter content", async () => {
  const response = await render("/discover");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, />Spott</);
  assert.match(html, /遇见真正想参加的活动/);
  assert.match(html, /搜索活动、地点、主办方或兴趣/);
  assert.doesNotMatch(html, /Codex is working|Your site is taking shape|codex-preview/);
});

test("uses the locale cookie for Japanese server rendering", async () => {
  const response = await render("/discover", { cookie: "spott_locale=ja" });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /lang="ja"/);
  assert.match(html, /本当に参加したいイベントに出会う/);
  assert.match(html, /<title>[^<]*[\u3040-\u30ff][^<]*<\/title>/);
  assert.match(html, /<meta name="description" content="[^"]*[\u3040-\u30ff][^"]*"\/>/);
});

test("ships installable PWA metadata and a privacy-safe service worker", async () => {
  const [manifest, worker] = await Promise.all([
    readFile(new URL("../app/manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(manifest, /display:\s*"standalone"/);
  assert.match(manifest, /spott-icon\.svg/);
  assert.match(worker, /\/\(me\|studio\|create\|register\|notifications\|login\|phone-verification\)/);
  assert.match(worker, /caches\.match\("\/offline"\)/);
});

test("exposes real API-driven group and host surfaces", async () => {
  const [groups, studio, discovery] = await Promise.all([
    readFile(new URL("../app/groups/GroupsDirectory.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/events/StudioEventsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/discovery/DiscoveryShell.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(groups, /apiRequest<\{ items: GroupView\[\] \}>\("\/groups\?limit=60"\)/);
  assert.match(studio, /\/me\/hosted-events/);
  assert.match(studio, /\/checkin-codes/);
  assert.match(discovery, /searchEvents\(/);
  assert.doesNotMatch(studio, /eventRows\s*=/);
});

test("keeps the fixed mobile dock outside the filtered site header", async () => {
  const source = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  const headerClose = source.indexOf("</header>");
  const dockStart = source.search(/<nav\s+className=\{styles\.mobileDock\}/);
  assert.ok(headerClose >= 0 && dockStart > headerClose, "mobile dock must be a sibling after the header");
});

test("hides global mobile navigation on immersive flows and account studios", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /body:has\(\.auth-page\)\s*>\s*\.mobile-dock/);
  assert.match(css, /body:has\(\.flow-page\)\s*>\s*\.mobile-dock/);
  assert.match(css, /body:has\(\.studio-shell\)\s*>\s*\.mobile-dock/);
});

test("unwraps the API problem envelope without dropping its message", async () => {
  const clientApi = await readFile(new URL("../app/lib/client-api.ts", import.meta.url), "utf8");
  assert.match(clientApi, /payload\.error\s*\?\?\s*payload/);
});

test("generates a stable valid public slug for CJK-only group names", async () => {
  const source = await readFile(new URL("../app/groups/create/GroupCreator.tsx", import.meta.url), "utf8");
  const start = source.indexOf("function slugify");
  const functionSource = source.slice(start).replace(/:\s*string/g, "");
  const slugify = Function(`return (${functionSource})`)();
  const first = slugify("東京朝活コミュニティ");
  assert.match(first, /^[a-z0-9-]{3,80}$/);
  assert.equal(first, slugify("東京朝活コミュニティ"));
});

test("covers canonical notification, post-event, feedback, and safety contracts", async () => {
  const [notifications, registrations, safety, eventPage, studio, profile, settings, report, attendees] = await Promise.all([
    readFile(new URL("../app/notifications/NotificationsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/events/MyEventsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/safety/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/e/[slug]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/events/StudioEventsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/u/[handle]/HostProfile.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/settings/SettingsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/reports/new/ReportForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/events/[id]/attendees/AttendeeManager.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(notifications, /\/notifications\/items\/\$\{item\.id\}\/read/);
  assert.match(notifications, /idempotent:\s*true/);
  assert.match(registrations, /\/registrations\/\$\{registration\.id\}\/checkin-corrections/);
  assert.match(registrations, /EventFeedback/);
  assert.match(safety, /SafetyCaseTracker/);
  assert.match(eventPage, /EventFeedbackSummary/);
  assert.match(studio, /\/feedback/);
  assert.match(profile, /\/users\/\$\{profile\.userId\}\/block/);
  assert.match(settings, /\/me\/achievements\/evaluate/);
  assert.match(settings, /\/me\/achievements/);
  assert.match(report, /purpose:\s*["']report_evidence["']/);
  assert.match(report, /evidenceAssetIds/);
  assert.match(report, /idempotent:\s*true/);
  assert.match(attendees, /\/events\/\$\{eventId\}\/checkin-corrections\?status=pending/);
  assert.match(attendees, /\/checkin-corrections\/\$\{correction\.id\}\/decision/);
});

test("resolves attributable share links into real product routes", async () => {
  const resolver = await readFile(new URL("../app/s/[code]/page.tsx", import.meta.url), "utf8");
  assert.match(resolver, /\/shares\/\$\{encodeURIComponent\(code\)\}/);
  assert.match(resolver, /redirect\(resolved\.canonicalPath\)/);
});

test("exposes cross-device account, media, transfer, and poster recovery contracts", async () => {
  const [settings, merge, media, group, events] = await Promise.all([
    readFile(new URL("../app/me/settings/SettingsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/account-merge/AccountMergeClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/media-upload.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/groups/[id]/GroupManager.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/events/StudioEventsClient.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(settings, /purpose:\s*["']profile_avatar["']/);
  assert.match(settings, /\/attach\/profile/);
  assert.match(settings, /\/me\/account-merge/);
  assert.match(merge, /\/accounts\/merge\/preview/);
  assert.match(merge, /provider:\s*["']email["']/);
  assert.match(merge, /\/accounts\/merge\/commit/);
  assert.match(merge, /saveSession\(session\)/);
  assert.match(media, /MEDIA_NOT_READY/);
  assert.match(media, /setTimeout/);
  assert.match(group, /purpose:\s*["']group_cover["']/);
  assert.match(group, /\/attach\/group\/\$\{groupId\}/);
  assert.match(group, /\/groups\/\$\{groupId\}\/transfers\/active/);
  assert.match(events, /\/events\/\$\{event\.id\}\/poster/);
  assert.match(events, /["']\/posters["']/);
  assert.match(events, /\/posters\/\$\{receipt\.id\}/);
});

test("sends the same privacy-gated core funnel analytics from Web", async () => {
  const [analytics, discovery, eventActions, registration, composer, settings] = await Promise.all([
    readFile(new URL("../app/lib/analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/discovery/DiscoveryShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/e/[slug]/EventActions.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/register/[slug]/RegistrationFlow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/create/EventComposer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/settings/SettingsClient.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(analytics, /\/analytics\/events\/batch/);
  assert.match(analytics, /spott\.analytics\.consent\.v1/);
  assert.match(analytics, /forbiddenProperty/);
  assert.match(analytics, /platform:\s*["']web["']/);
  assert.match(discovery, /trackProductEvent\(["']discovery_viewed["']/);
  assert.match(eventActions, /trackProductEvent\(["']event_detail_viewed["']/);
  assert.match(registration, /trackProductEvent\(["']registration_completed["']/);
  assert.match(composer, /trackProductEvent\(["']event_submission_completed["']/);
  assert.match(settings, /setAnalyticsConsent/);
});

test("app source never uses blocking browser confirm, prompt, or alert dialogs", async () => {
  const appRoot = new URL("../app/", import.meta.url);
  const files = (await readdir(appRoot, { recursive: true }))
    .filter((file) => /\.(?:ts|tsx)$/.test(file));

  for (const file of files) {
    const source = await readFile(new URL(file, appRoot), "utf8");
    assert.doesNotMatch(
      source,
      /\b(?:window\s*\.\s*)?(?:confirm|prompt|alert)\s*\(/,
      `${file} must use the shared in-product dialog`,
    );
  }
});

test("shared app dialog owns accessible focus, async locking, and prompt return contracts", async () => {
  const [dialog, layout, css] = await Promise.all([
    readFile(new URL("../app/components/AppDialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(layout, /<AppDialogProvider>/);
  assert.match(dialog, /role="dialog"/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /event\.key === "Escape"/);
  assert.match(dialog, /if \(busy\) return/);
  assert.match(dialog, /previousFocus\?\.focus\(\)/);
  assert.match(dialog, /pendingRef\.current !== current/);
  assert.match(dialog, /activeIndex === -1/);
  assert.match(dialog, /tabIndex=\{-1\}/);
  assert.match(dialog, /Promise<boolean>/);
  assert.match(dialog, /Promise<string \| null>/);
  assert.match(dialog, /onConfirm/);
  assert.match(dialog, /value\.length < requiredLength/);
  assert.match(css, /\.app-dialog-actions[\s\S]*min-height:\s*44px/);
});

test("dialog-backed API failures stay open and preserve typed input for retry", async () => {
  const expectedRethrows = new Map([
    ["safety/SafetyCaseTracker.tsx", 1],
    ["me/events/MyEventsClient.tsx", 3],
    ["u/[handle]/HostProfile.tsx", 1],
    ["studio/events/StudioEventsClient.tsx", 1],
    ["me/settings/SettingsClient.tsx", 3],
    ["g/[slug]/GroupDiscussion.tsx", 4],
    ["studio/events/[id]/attendees/AttendeeManager.tsx", 3],
    ["studio/groups/[id]/GroupManager.tsx", 5],
  ]);
  const appRoot = new URL("../app/", import.meta.url);

  for (const [file, minimum] of expectedRethrows) {
    const source = await readFile(new URL(file, appRoot), "utf8");
    const count = source.match(/throw error;/g)?.length ?? 0;
    assert.ok(count >= minimum, `${file} must rethrow dialog action failures to the shared provider`);
  }
});
