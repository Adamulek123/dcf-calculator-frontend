(() => {
    const topbar = document.getElementById("topbar");
    const revealTargets = Array.from(document.querySelectorAll(".reveal"));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function setTopbarVisibility() {
        if (!topbar) {
            return;
        }

        const y = window.scrollY || 0;
        const shouldHide = y > 8;

        topbar.classList.toggle("is-hidden", shouldHide);
        topbar.style.boxShadow = shouldHide ? "0 10px 24px rgba(15, 23, 42, 0.08)" : "none";

    }

    function revealAllImmediately() {
        revealTargets.forEach((target) => target.classList.add("in-view"));
    }

    function setupRevealObserver() {
        if (!revealTargets.length || reducedMotion || !("IntersectionObserver" in window)) {
            revealAllImmediately();
            return;
        }

        const observer = new IntersectionObserver((entries, obs) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                    return;
                }
                entry.target.classList.add("in-view");
                obs.unobserve(entry.target);
            });
        }, {
            root: null,
            rootMargin: "0px 0px -10% 0px",
            threshold: 0.12
        });

        revealTargets.forEach((target) => observer.observe(target));
    }

    setTopbarVisibility();
    setupRevealObserver();

    window.addEventListener("scroll", () => {
        if (window.requestAnimationFrame) {
            window.requestAnimationFrame(setTopbarVisibility);
            return;
        }
        setTopbarVisibility();
    }, { passive: true });

    window.addEventListener("resize", setTopbarVisibility);
})();
