const CACHE = "spott-public-v8";
const LOCALE_KEY = "/__spott-locale__";
const SUPPORTED_LOCALES = ["zh-Hans", "ja", "en"];
const OFFLINE_ROUTES = [
  "/offline?locale=zh-Hans",
  "/offline?locale=ja",
  "/offline?locale=en",
];
const BRAND_PWA_ROUTES = [
  "/favicon.svg",
  "/spott-icon.svg",
  "/spott-icon-192.png",
  "/spott-icon-512.png",
  "/spott-icon-maskable-512.png",
];
const PUBLIC_ROUTES = [
  ...OFFLINE_ROUTES,
  ...BRAND_PWA_ROUTES,
];
const BRAND_PWA_PATHS = new Set(BRAND_PWA_ROUTES);
const VERSIONED_ASSET_PATH = /^\/assets\/(?:[^/?#]+\/)*[^/?#]+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2?|png|svg|webp|avif)$/;

async function precachePublicShell() {
  const cache = await caches.open(CACHE);
  await cache.addAll(PUBLIC_ROUTES);

  // The offline documents are server-rendered, but vinext still hydrates them.
  // Cache only the immutable assets referenced by those three public shells so
  // an offline navigation cannot collapse to a blank page during hydration.
  const assetPaths = new Set();
  for (const route of OFFLINE_ROUTES) {
    const response = await cache.match(route, { ignoreVary: true });
    if (!response) throw new Error(`Missing offline shell: ${route}`);
    const html = await response.text();
    for (const match of html.matchAll(/\/assets\/[^"'\\\s<>)]+/g)) {
      if (VERSIONED_ASSET_PATH.test(match[0])) assetPaths.add(match[0]);
    }
  }
  await cache.addAll([...assetPaths]);
}

self.addEventListener("install", (event) => {
  event.waitUntil(precachePublicShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "SPOTT_LOCALE" || !SUPPORTED_LOCALES.includes(event.data.locale)) return;
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.put(
      LOCALE_KEY,
      new Response(event.data.locale, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
    )),
  );
});

function routedLocale(url) {
  const queryLocale = url.searchParams.get("locale");
  if (SUPPORTED_LOCALES.includes(queryLocale)) return queryLocale;
  if (url.pathname === "/tokyo" || url.pathname === "/tokyo/") return "zh-Hans";
  if (url.pathname === "/ja/tokyo" || url.pathname === "/ja/tokyo/") return "ja";
  if (url.pathname === "/en/tokyo" || url.pathname === "/en/tokyo/") return "en";
  return null;
}

async function storedLocale() {
  const response = await caches.open(CACHE).then((cache) => cache.match(LOCALE_KEY));
  const locale = response ? await response.text() : "zh-Hans";
  return SUPPORTED_LOCALES.includes(locale) ? locale : "zh-Hans";
}

async function offlineFallback(url) {
  const locale = routedLocale(url) ?? await storedLocale();
  return (await caches.open(CACHE).then((cache) => (
    cache.match(`/offline?locale=${locale}`, { ignoreVary: true })
  )))
    ?? new Response("Offline", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function isExplicitPublicAssetRequest(request, url) {
  if (url.search || request.cache === "no-store" || request.headers.has("authorization")) return false;
  return BRAND_PWA_PATHS.has(url.pathname) || VERSIONED_ASSET_PATH.test(url.pathname);
}

function isExplicitPublicResponse(response) {
  if (!response.ok) return false;
  const cacheControl = response.headers.get("cache-control")?.toLowerCase() ?? "";
  if (/(?:^|,)\s*(?:private|no-store)(?:\s|,|=|$)/.test(cacheControl)) return false;
  const vary = response.headers.get("vary")?.toLowerCase() ?? "";
  if (vary === "*" || /(?:^|,)\s*(?:authorization|cookie)\s*(?:,|$)/.test(vary)) return false;
  return !response.headers.has("set-cookie");
}

async function publicAssetResponse(event, request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isExplicitPublicResponse(response)) {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, response.clone())));
  }
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => offlineFallback(url)));
    return;
  }

  if (/\/(me|studio|create|register|notifications|login|phone-verification)\b/.test(url.pathname)) return;
  if (isExplicitPublicAssetRequest(request, url)) event.respondWith(publicAssetResponse(event, request));
});
