if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("sw.js", { scope: "./" })
            .catch((error) => console.warn("Static shell service worker registration failed", error));
    });
}
