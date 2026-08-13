const SHELL_CACHE = "dcf-shell-v16";
const SHELL_ASSETS = [
    "./",
    "./index.html",
    "./login.html",
    "./register.html",
    "./dcf-calculator.html",
    "./portfolio-creator.html",
    "./dip-finder.html",
    "./financial-data.html",
    "./earnings-calendar.html",
    "./css/style.css?v=15",
    "./js/service-worker-register.js",
    "./js/script.js",
    "./js/hero-animation.js",
    "./js/api.js",
    "./js/auth.js",
    "./js/auth-guard.js",
    "./js/login-page.js",
    "./js/register-page.js",
    "./js/dcf-calculator.js",
    "./js/dcf-calculator-entry.js",
    "./js/portfolio-creator.js",
    "./js/dip-finder.js",
    "./js/financial-data.js",
    "./js/financial-data-entry.js",
    "./js/earnings-calendar.js",
    "./js/earnings-calendar-resilience.mjs",
    "./js/cache-metrics.js",
    "./js/cache-policy.js",
    "./js/cache-registry.js",
    "./js/data-store.js",
    "./js/public-data-store.js",
    "./js/sidebar.js",
    "./js/firebase-init.js",
    "./js/toast.js",
    "./js/ticker.js",
    "./js/charts.js",
    "./js/cache.js",
];

const SHELL_NAVIGATION_SUFFIXES = SHELL_ASSETS
    .filter((asset) => asset.endsWith(".html"))
    .map((asset) => asset.replace(/^\./, ""));

const SHELL_ASSET_PATHS = SHELL_ASSETS
    .filter((asset) => asset !== "./")
    .map((asset) => new URL(asset, self.registration.scope).pathname);

function normalizedShellNavigation(request, url) {
    if (request.mode !== "navigate") return null;
    const scopePath = new URL(self.registration.scope).pathname;
    const isKnownShellPath = url.pathname === scopePath
        || SHELL_NAVIGATION_SUFFIXES.some((suffix) => url.pathname.endsWith(suffix));
    if (!isKnownShellPath) return null;
    return new Request(`${url.origin}${url.pathname}`, {
        method: "GET",
        headers: { Accept: request.headers.get("Accept") || "text/html" },
        credentials: "same-origin",
    });
}

self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)));
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(caches.keys().then((names) => Promise.all(
        names.filter((name) => name.startsWith("dcf-shell-") && name !== SHELL_CACHE)
            .map((name) => caches.delete(name)),
    )));
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== self.location.origin) return;

    const navigationCacheKey = normalizedShellNavigation(request, url);
    const isShellNavigation = request.mode === "navigate";
    const isPrecachedAsset = SHELL_ASSET_PATHS.includes(url.pathname);
    if (!isShellNavigation && !isPrecachedAsset) return;

    event.respondWith((async () => {
        const assetCacheKey = isPrecachedAsset
            ? new Request(`${url.origin}${url.pathname}${url.search}`, { method: "GET", credentials: "same-origin" })
            : null;
        const cacheKey = navigationCacheKey || assetCacheKey || request;
        const cached = navigationCacheKey || isPrecachedAsset
            ? await caches.match(cacheKey)
            : null;
        try {
            const network = await fetch(request);
            if (network.ok && (navigationCacheKey || isPrecachedAsset)) {
                const cache = await caches.open(SHELL_CACHE);
                await cache.put(cacheKey, network.clone());
            }
            return network;
        } catch {
            return cached || caches.match("./index.html");
        }
    })());
});
