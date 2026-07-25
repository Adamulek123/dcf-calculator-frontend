const SHELL_CACHE = "dcf-shell-v8";
const SHELL_ASSETS = [
    "./",
    "./index.html",
    "./login.html",
    "./register.html",
    "./dcf-calculator.html",
    "./portfolio-creator.html",
    "./dip-finder.html",
    "./financial-data.html",
    "./css/style.css",
    "./js/service-worker-register.js",
    "./js/script.js",
    "./js/hero-animation.js",
    "./js/api.js",
    "./js/auth.js",
    "./js/auth-guard.js",
    "./js/dcf-calculator.js",
    "./js/portfolio-creator.js",
    "./js/dip-finder.js",
    "./js/financial-data.js",
];

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

    const isShellNavigation = request.mode === "navigate";
    const isPrecachedAsset = SHELL_ASSETS.some((asset) => url.pathname.endsWith(asset.replace(/^\.\//, "/")));
    if (!isShellNavigation && !isPrecachedAsset) return;

    event.respondWith((async () => {
        const cached = await caches.match(request);
        if (cached && !isShellNavigation) return cached;
        try {
            const network = await fetch(request);
            if (isShellNavigation && network.ok) {
                const cache = await caches.open(SHELL_CACHE);
                cache.put(request, network.clone());
            }
            return network;
        } catch {
            return cached || caches.match("./index.html");
        }
    })());
});
