(() => {
    document.documentElement.classList.add("js");

    const topbar = document.getElementById("topbar");
    const revealTargets = Array.from(document.querySelectorAll(".reveal"));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    function setTopbarVisibility() {
        if (!topbar) {
            return;
        }

        const y = window.scrollY || 0;
        const hasScrolled = y > 8;
        const shouldHide = hasScrolled && !topbar.matches(":focus-within");

        topbar.classList.toggle("is-hidden", shouldHide);
        topbar.classList.toggle("is-scrolled", hasScrolled);
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

    if (topbar) {
        topbar.addEventListener("focusin", () => {
            topbar.classList.remove("is-hidden");
        });
        topbar.addEventListener("focusout", () => {
            if (window.requestAnimationFrame) {
                window.requestAnimationFrame(setTopbarVisibility);
                return;
            }
            setTopbarVisibility();
        });
    }

    window.addEventListener("scroll", () => {
        if (window.requestAnimationFrame) {
            window.requestAnimationFrame(setTopbarVisibility);
            return;
        }
        setTopbarVisibility();
    }, { passive: true });

    window.addEventListener("resize", setTopbarVisibility);
})();
