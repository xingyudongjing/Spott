import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";

async function render(path = "/", headers = {}, origin = "http://localhost") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`${origin}${path}`, { headers: { accept: "text/html", ...headers } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
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

test("serves indexable Tokyo discovery URLs with matching language and metadata", async () => {
  const [zhResponse, jaResponse, enResponse] = await Promise.all([
    render("/tokyo", { cookie: "spott_locale=en" }),
    render("/ja/tokyo"),
    render("/en/tokyo"),
  ]);
  for (const response of [zhResponse, jaResponse, enResponse]) assert.equal(response.status, 200);

  const [zh, ja, en] = await Promise.all([
    zhResponse.text(),
    jaResponse.text(),
    enResponse.text(),
  ]);

  assert.match(zh, /<html[^>]+lang="zh-Hans"/);
  assert.match(zh, /<title>东京活动 · Spott<\/title>/);
  assert.match(zh, /<link rel="canonical" href="https:\/\/spott\.jp\/tokyo"/);
  assert.match(zh, /东京，遇见真正想参加的活动/);

  assert.match(ja, /<html[^>]+lang="ja"/);
  assert.match(ja, /<title>東京のイベント · Spott<\/title>/);
  assert.match(ja, /<link rel="canonical" href="https:\/\/spott\.jp\/ja\/tokyo"/);
  assert.match(ja, /東京で、本当に参加したいイベントに出会う/);

  assert.match(en, /<html[^>]+lang="en"/);
  assert.match(en, /<title>Tokyo events · Spott<\/title>/);
  assert.match(en, /<link rel="canonical" href="https:\/\/spott\.jp\/en\/tokyo"/);
  assert.match(en, /Find Tokyo events you genuinely want to join/);

  for (const html of [zh, ja, en]) {
    assert.match(html, /hreflang="zh-Hans" href="https:\/\/spott\.jp\/tokyo"/i);
    assert.match(html, /hreflang="ja" href="https:\/\/spott\.jp\/ja\/tokyo"/i);
    assert.match(html, /hreflang="en" href="https:\/\/spott\.jp\/en\/tokyo"/i);
    assert.match(html, /"@type":"CollectionPage"/);
    assert.match(html, /"@type":"ItemList"/);
    assert.doesNotMatch(html, /exactAddress|exactCoordinate|registrationQuestions/);
  }
});

test("deindexes every filtered Tokyo variant without publishing filter-shaped structured data", async () => {
  const cases = [
    ["/tokyo?source=pwa", "https://spott.jp/tokyo"],
    ["/ja/tokyo?q=coffee", "https://spott.jp/ja/tokyo"],
    ["/en/tokyo?date=this-weekend&map=1", "https://spott.jp/en/tokyo"],
  ];

  for (const [path, canonical] of cases) {
    const response = await render(path);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
    const html = await response.text();
    assert.match(html, /name="robots" content="noindex, nofollow"/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${canonical.replaceAll("/", "\\/")}"`));
    assert.doesNotMatch(html, /type="application\/ld\+json"/);
    assert.doesNotMatch(html, /"@type":"(?:Event|CollectionPage|ItemList)"/);
  }
});

test("adds production security headers without replacing the streamed body or status", async () => {
  const http = await render("/tokyo");
  const secure = await render("/tokyo", {}, "https://localhost");
  assert.equal(http.status, 200);
  assert.equal(secure.status, 200);
  assert.match(await secure.text(), /东京，遇见真正想参加的活动/);

  const csp = secure.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.equal(secure.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assert.equal(http.headers.get("strict-transport-security"), null);
  assert.equal(secure.headers.get("x-content-type-options"), "nosniff");
  assert.equal(secure.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(secure.headers.get("permissions-policy") ?? "", /camera=\(\)/);
});

test("serves distinct localized Terms and Privacy documents with canonical metadata", async () => {
  const [termsResponse, privacyResponse] = await Promise.all([
    render("/terms", { cookie: "spott_locale=en" }),
    render("/privacy", { cookie: "spott_locale=ja" }),
  ]);
  assert.equal(termsResponse.status, 200);
  assert.equal(privacyResponse.status, 200);

  const [terms, privacy] = await Promise.all([
    termsResponse.text(),
    privacyResponse.text(),
  ]);

  assert.match(terms, /<html[^>]+lang="en"/);
  assert.match(terms, /<title>Terms of Service · Spott<\/title>/);
  assert.match(terms, /<h1[^>]*>Terms of Service<\/h1>/);
  assert.match(terms, /Hosts and participants/);
  assert.match(terms, /<link rel="canonical" href="https:\/\/spott\.jp\/terms"/);
  assert.doesNotMatch(terms, /<h1[^>]*>Privacy Policy<\/h1>/);

  assert.match(privacy, /<html[^>]+lang="ja"/);
  assert.match(privacy, /<title>プライバシーポリシー · Spott<\/title>/);
  assert.match(privacy, /<h1[^>]*>プライバシーポリシー<\/h1>/);
  assert.match(privacy, /利用目的/);
  assert.match(privacy, /<link rel="canonical" href="https:\/\/spott\.jp\/privacy"/);
  assert.doesNotMatch(privacy, /<h1[^>]*>利用規約<\/h1>/);
});

test("ships installable PWA metadata and a privacy-safe service worker", async () => {
  const [manifest, worker, icon] = await Promise.all([
    readFile(new URL("../app/lib/pwa-manifest.ts", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../public/spott-icon.svg", import.meta.url), "utf8"),
  ]);
  assert.match(manifest, /display:\s*"standalone"/);
  assert.match(manifest, /spott-icon\.svg/);
  assert.match(worker, /spott-public-v8/);
  assert.match(worker, /precachePublicShell/);
  assert.match(worker, /ignoreVary: true/);
  assert.match(worker, /SPOTT_LOCALE/);
  assert.match(worker, /\/offline\?locale=zh-Hans/);
  assert.match(worker, /\/offline\?locale=ja/);
  assert.match(worker, /\/offline\?locale=en/);
  const publicRoutes = worker.match(/PUBLIC_ROUTES\s*=\s*(\[[^\]]*\])/)?.[1];
  assert.ok(publicRoutes, "service worker must declare its public precache allow-list");
  assert.doesNotMatch(publicRoutes, /["']\/["']/, "the redirecting root document must never be publicly cached");
  assert.doesNotMatch(publicRoutes, /["']\/discover["']/, "personalized discovery must never be publicly cached");
  assert.match(worker, /\/\(me\|studio\|create\|register\|notifications\|login\|phone-verification\)/);
  assert.doesNotMatch(worker, /caches\.match\("\/offline",\s*\{\s*ignoreVary:\s*true\s*\}\)/);
  assert.match(icon, /<linearGradient/);
  assert.match(icon, /<path/);
  assert.doesNotMatch(icon, /<text|font-family=/);
});

test("localizes the install manifest and system fallback pages", async () => {
  const [zhManifestResponse, jaManifestResponse, enManifestResponse, missing, offline] = await Promise.all([
    render("/manifest/zh-Hans.webmanifest", { cookie: "spott_locale=en" }),
    render("/manifest/ja.webmanifest", { cookie: "spott_locale=zh-Hans" }),
    render("/manifest/en.webmanifest", { cookie: "spott_locale=ja" }),
    render("/this-route-does-not-exist", { cookie: "spott_locale=ja" }),
    render("/offline?locale=en", { cookie: "spott_locale=ja" }),
  ]);
  const manifests = await Promise.all([
    zhManifestResponse.json(),
    jaManifestResponse.json(),
    enManifestResponse.json(),
  ]);
  assert.deepEqual(
    [zhManifestResponse, jaManifestResponse, enManifestResponse].map((response) => response.headers.get("content-language")),
    ["zh-Hans", "ja", "en"],
  );
  for (const response of [zhManifestResponse, jaManifestResponse, enManifestResponse]) {
    assert.match(response.headers.get("content-type") ?? "", /^application\/manifest\+json(?:;|$)/);
    assert.match(response.headers.get("cache-control") ?? "", /public.*must-revalidate/);
    assert.doesNotMatch(response.headers.get("cache-control") ?? "", /immutable/);
  }
  assert.deepEqual(manifests.map(({ lang }) => lang), ["zh-Hans", "ja", "en"]);
  assert.deepEqual(manifests.map(({ name }) => name), [
    "Spott · 东京与日本本地活动",
    "Spott · 東京と日本のローカルイベント",
    "Spott · Local events in Tokyo and Japan",
  ]);
  for (const manifest of manifests) {
    assert.equal(manifest.theme_color, "#F7F5F0");
    assert.equal(manifest.background_color, "#F7F5F0");
    assert.ok(manifest.icons.some(({ sizes, purpose }) => sizes === "512x512" && purpose === "maskable"));
    assert.equal(manifest.shortcuts.length, 3);
  }

  const manifestLinkHTML = await (await render("/en/tokyo", { cookie: "spott_locale=ja" })).text();
  assert.match(manifestLinkHTML, /rel="manifest" href="https:\/\/spott\.jp\/manifest\/en\.webmanifest"/);

  assert.equal(missing.status, 404);
  const missingHTML = await missing.text();
  assert.match(missingHTML, /この場所にはイベントがありません。/);
  assert.match(missingHTML, /<meta[^>]+(?:name="robots"[^>]+content="noindex|content="noindex"[^>]+name="robots")/);
  assert.doesNotMatch(missingHTML, /name="robots" content="index, follow"/);
  assert.equal(offline.status, 200);
  const offlineHTML = await offline.text();
  assert.match(offlineHTML, /You’re offline/);
  assert.match(offlineHTML, /Public event pages are not stored on this device/);
  assert.doesNotMatch(offlineHTML, /View cached events/);
  assert.match(offlineHTML, /name="robots" content="noindex, nofollow"/);
});

test("canonicalizes and deindexes filtered discovery variants", async () => {
  const response = await render("/discover?region=tokyo");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<link rel="canonical" href="https:\/\/spott\.jp\/discover"/);
  assert.match(html, /name="robots" content="noindex, follow"/);
});

test("deindexes the safety surface in both metadata and the response header", async () => {
  const response = await render("/safety");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow");
  assert.match(await response.text(), /name="robots" content="noindex, nofollow"/);
});

test("keeps Web and shared Web/Ops tokens light-only", async () => {
  const [layout, globals, tokens, itinerary] = await Promise.all([
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../../../packages/design-tokens/src/tokens.css", import.meta.url), "utf8"),
    readFile(new URL("../app/me/events/MyEvents.module.css", import.meta.url), "utf8"),
  ]);
  assert.match(layout, /colorScheme:\s*"light"/);
  assert.match(layout, /themeColor:\s*"#F7F5F0"/);
  for (const source of [layout, globals, tokens, itinerary]) {
    assert.doesNotMatch(source, /prefers-color-scheme:\s*dark|color-scheme:\s*light dark|color-scheme:\s*dark/);
  }
  assert.match(`${globals}\n${itinerary}`, /prefers-contrast:\s*more/);
  assert.match(`${globals}\n${itinerary}`, /forced-colors:\s*active/);
  assert.match(tokens, /prefers-reduced-motion:\s*reduce/);

  const colors = Object.fromEntries([...tokens.matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map((match) => [match[1], match[2]]));
  assert.ok(contrastRatio(colors["spott-muted"], colors["spott-canvas"]) >= 4.5);
  assert.ok(contrastRatio(colors["spott-danger"], colors["spott-canvas"]) >= 4.5);
  assert.ok(contrastRatio(colors["spott-coral-strong"], colors["spott-canvas"]) >= 4.5);
  assert.ok(contrastRatio(colors["spott-coral-strong"], colors["spott-surface"]) >= 4.5);
});

function contrastRatio(first, second) {
  const luminance = (hex) => {
    const channels = [1, 3, 5]
      .map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("keeps Tokyo identity and the language control visible on narrow mobile layouts", async () => {
  const [discoveryCSS, headerCSS] = await Promise.all([
    readFile(new URL("../app/components/discovery/DiscoveryShell.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SiteHeader.module.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(discoveryCSS, /\.intro\s*\{\s*display:\s*none/);
  assert.doesNotMatch(headerCSS, /\.locale\s*,\s*\n\s*\.account/);
  assert.match(headerCSS, /\.locale[^}]*min-(?:width|height):\s*44px/s);
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
  assert.match(discovery, /apiRequest<unknown>/);
  assert.match(discovery, /\/events\/search/);
  assert.doesNotMatch(studio, /eventRows\s*=/);
});

test("keeps the fixed mobile dock outside the filtered site header", async () => {
  const source = await readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8");
  const headerClose = source.indexOf("</header>");
  const dockStart = source.indexOf('<nav className={`${styles.mobileDock}');
  assert.ok(headerClose >= 0 && dockStart > headerClose, "mobile dock must be a sibling after the header");
});

test("hides global mobile navigation on immersive flows and account studios", async () => {
  const [css, header] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/SiteHeader.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(css, /body:has\(\.auth-page\)\s*>\s*\.mobile-dock/);
  assert.match(css, /body:has\(\.flow-page\)\s*>\s*\.mobile-dock/);
  assert.match(css, /body:has\(\.studio-shell\)\s*>\s*\.mobile-dock/);
  assert.match(header, /\$\{styles\.header\} site-header/);
  assert.match(header, /\$\{styles\.mobileDock\}[\s\S]*mobile-dock/);
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
  const [notifications, itineraryClient, itineraryCard, safety, eventPage, eventClient, studio, profile, settings, report, attendees] = await Promise.all([
    readFile(new URL("../app/notifications/NotificationsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/events/MyEventsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/events/ItineraryCard.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/safety/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/e/[slug]/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/e/[slug]/EventDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/events/StudioEventsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/u/[handle]/HostProfile.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/settings/SettingsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/reports/new/ReportForm.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/studio/events/[id]/attendees/AttendeeManager.tsx", import.meta.url), "utf8"),
  ]);
  const registrations = `${itineraryClient}\n${itineraryCard}`;
  assert.match(notifications, /\/notifications\/items\/\$\{item\.id\}\/read/);
  assert.match(notifications, /idempotent:\s*true/);
  assert.match(registrations, /\/registrations\/\$\{item\.registration\.id\}\/checkin-corrections/);
  assert.match(registrations, /EventFeedback/);
  assert.match(safety, /SafetyCaseTracker/);
  assert.match(`${eventPage}\n${eventClient}`, /EventFeedbackSummary/);
  assert.match(studio, /\/feedback/);
  assert.match(profile, /\/users\/\$\{profile\.userId\}\/block/);
  assert.match(settings, /\/me\/achievements\/evaluate/);
  assert.match(settings, /\/me\/achievements/);
  assert.match(report, /purpose:\s*["']report_evidence["']/);
  assert.match(report, /evidenceAssetIds/);
  assert.match(report, /idempotencyKey/);
  assert.doesNotMatch(report, /idempotent:\s*true/);
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
  const [analytics, discovery, eventDetail, registration, composer, settings, wallet] = await Promise.all([
    readFile(new URL("../app/lib/analytics.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/discovery/DiscoveryShell.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/e/[slug]/EventDetailClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/register/[slug]/RegistrationFlow.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/create/EventComposer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/settings/SettingsClient.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/me/wallet/WalletClient.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(analytics, /\/analytics\/events\/batch/);
  assert.match(analytics, /spott\.analytics\.consent\.v1/);
  assert.match(analytics, /forbiddenProperty/);
  assert.match(analytics, /platform:\s*["']web["']/);
  assert.match(discovery, /trackProductEvent\(["']discovery_viewed["']/);
  assert.match(eventDetail, /trackProductEvent\(["']event_detail_viewed["']/);
  assert.match(registration, /trackProductEvent\(["']registration_completed["']/);
  assert.match(composer, /trackProductEvent\(["']event_submission_completed["']/);
  assert.match(settings, /setAnalyticsConsent/);
  // Points funnel (product §P1): 查看钱包 → 进入购买.
  assert.match(wallet, /trackProductEvent\(["']wallet_viewed["']/);
  assert.match(wallet, /trackProductEvent\(["']points_purchase_viewed["']/);
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
    ["me/events/ItineraryCard.tsx", 3],
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
