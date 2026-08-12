(() => {
    const FRAME_COUNT = 192;

    // ── Speed control ────────────────────────────────────────────────
    // Total section scroll height (pixels). Set equal to SPEED_START so the
    // slow-start feel is anchored to the same physical distance as before.
    const SCROLL_TRAVEL_PX = 1200;

    // ── Variable-speed scroll curve ───────────────────────────────────
    // SPEED_START     : effective px-travel at the very start of the scroll.
    //                   Higher = slower frame advance early on.
    // SPEED_END       : effective px-travel near the end of the scroll.
    //                   Lower  = faster frame advance at the finish.
    // TRANSITION_CURVE: how quickly the speed shifts from start to end.
    //   1 = linear blend (gradual ramp)
    //   2 = quadratic   (smooth S — recommended default)
    //   4 = sharp snap  (speed jumps abruptly near the middle)
    const SPEED_START       = 1000;
    const SPEED_END         = 600;
    const TRANSITION_CURVE  = 1.5;
    // ─────────────────────────────────────────────────────────────────

    // Text fades out between these scroll progress values
    const TEXT_FADE_START = 0.12;
    const TEXT_FADE_END   = 0.38;

    // CTA fades in between these scroll progress values
    const CTA_FADE_START  = 0.82;
    const CTA_FADE_END    = 1.0;

    // Bottom gradient fades in near the end
    const GRAD_FADE_START = 0.88;
    const GRAD_FADE_END   = 1.0;

    // On mobile (<1024px) we load every Nth frame to save bandwidth
    const MOBILE_STEP = 2;

    function lerp(a, b, t) { return a + (b - a) * t; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function easeOut(t) { return 1 - (1 - t) * (1 - t); }

    // Build a 1000-entry lookup table mapping scroll progress (0–1) → frame
    // progress (0–1). Integrates the instantaneous rate which ramps smoothly
    // from SPEED_START to SPEED_END, so the animation feels slow early and
    // faster at the end without any abrupt jumps.
    function buildSpeedCurve() {
        const N    = 1000;
        const rate = new Float32Array(N + 1);
        const lut  = new Float32Array(N + 1);

        for (let i = 0; i <= N; i++) {
            const p     = i / N;
            const blend = Math.pow(p, TRANSITION_CURVE); // 0 at start → 1 at end
            const spd   = lerp(SPEED_START, SPEED_END, blend);
            rate[i]     = SPEED_START / spd;             // normalised instantaneous rate
        }

        // Trapezoidal integration
        let cumulative = 0;
        lut[0] = 0;
        for (let i = 1; i <= N; i++) {
            cumulative += (rate[i - 1] + rate[i]) * 0.5 / N;
            lut[i]      = cumulative;
        }

        // Normalise to [0, 1]
        const total = lut[N];
        for (let i = 0; i <= N; i++) lut[i] /= total;

        return lut;
    }

    function init() {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

        const section  = document.querySelector('.hero-scroll');
        const sticky   = document.querySelector('.hero-scroll__sticky');
        const canvas   = document.querySelector('.hero-scroll__canvas');
        const textEl   = document.querySelector('.hero-scroll__text');
        const ctaEl    = document.querySelector('.hero-scroll__cta');
        const posterEl = document.querySelector('.hero-scroll__poster');

        if (!section || !canvas) return;

        // Reduced-motion: show poster, reveal UI immediately, skip animation
        if (reducedMotion) {
            if (posterEl) posterEl.style.display = 'block';
            if (textEl)   { textEl.style.opacity = '1'; textEl.style.transform = 'translateX(-50%)'; }
            if (ctaEl)    { ctaEl.style.opacity = '1'; ctaEl.style.pointerEvents = 'auto'; }
            return;
        }

        // Pre-build the variable-speed LUT (only done once at init)
        const speedLut = buildSpeedCurve();

        // Set section height: sticky is 100vh, plus the scroll travel distance
        section.style.height = (window.innerHeight + SCROLL_TRAVEL_PX) + 'px';

        // Choose resolution based on DPR and screen width
        const isMobile  = window.innerWidth < 1024;
        const useHiRes  = window.devicePixelRatio >= 1.5 && !isMobile;
        const basePath  = useHiRes ? 'assets/frames/2x/' : 'assets/frames/1x/';
        const frameStep = isMobile ? MOBILE_STEP : 1;

        // Size canvas with DPR (capped at 2 to avoid excess memory)
        const ctx = canvas.getContext('2d');
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let cssW, cssH;

        function sizeCanvas() {
            cssW = sticky.clientWidth;
            cssH = sticky.clientHeight;
            canvas.style.width  = cssW + 'px';
            canvas.style.height = cssH + 'px';
            canvas.width  = Math.round(cssW * dpr);
            canvas.height = Math.round(cssH * dpr);
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        sizeCanvas();

        // Keep only a moving window of decoded frames. Browser HTTP caching makes
        // backwards scrolling cheap without retaining hundreds of large bitmaps.
        const frames = new Array(FRAME_COUNT).fill(null);
        const loadingFrames = new Set();
        const queuedFrames = new Set();
        const loadQueue = [];
        const LOAD_CONCURRENCY = 4;
        const LOAD_AHEAD = isMobile ? 5 : 8;
        const LOAD_BEHIND = isMobile ? 2 : 4;
        const MAX_RESIDENT_FRAMES = isMobile ? 14 : 24;
        let loadingStarted = false;
        let rafPending = false;

        function frameName(i) {
            // i is 0-based → file is frame-001 through frame-192
            return basePath + 'frame-' + String(i + 1).padStart(3, '0') + '.webp';
        }

        // Draw a single frame centered/contained in the canvas
        function drawFrame(img) {
            if (!img || !img.complete || img.naturalWidth === 0) return;
            const iw = img.naturalWidth;
            const ih = img.naturalHeight;
            const scale = Math.min(cssW / iw, cssH / ih);
            const dw = iw * scale;
            const dh = ih * scale;
            const dx = (cssW - dw) / 2;
            const dy = (cssH - dh) / 2;
            ctx.clearRect(0, 0, cssW, cssH);
            ctx.drawImage(img, dx, dy, dw, dh);
        }

        // Find nearest loaded frame to index (for before all frames load)
        function nearestLoaded(index) {
            if (frames[index]) return frames[index];
            for (let d = 1; d < FRAME_COUNT; d++) {
                if (index + d < FRAME_COUNT && frames[index + d]) return frames[index + d];
                if (index - d >= 0          && frames[index - d]) return frames[index - d];
            }
            return null;
        }

        function pruneFrames(center) {
            const resident = frames
                .map((img, index) => img ? index : -1)
                .filter((index) => index >= 0);
            if (resident.length <= MAX_RESIDENT_FRAMES) return;
            resident
                .filter((index) => index !== center)
                .sort((a, b) => Math.abs(b - center) - Math.abs(a - center))
                .slice(0, resident.length - MAX_RESIDENT_FRAMES)
                .forEach((index) => { frames[index] = null; });
        }

        function pumpFrameQueue() {
            while (loadingFrames.size < LOAD_CONCURRENCY && loadQueue.length) {
                const idx = loadQueue.shift();
                queuedFrames.delete(idx);
                if (frames[idx] || loadingFrames.has(idx)) continue;
                loadingFrames.add(idx);
                const img = new Image();
                img.onload = () => {
                    loadingFrames.delete(idx);
                    frames[idx] = img;
                    const target = lastFrameIndex >= 0 ? lastFrameIndex : idx;
                    const nearest = nearestLoaded(target);
                    if (nearest) {
                        drawFrame(nearest);
                        if (posterEl) posterEl.style.display = 'none';
                    }
                    pruneFrames(lastFrameIndex >= 0 ? lastFrameIndex : idx);
                    pumpFrameQueue();
                };
                img.onerror = () => {
                    loadingFrames.delete(idx);
                    pumpFrameQueue();
                };
                img.src = frameName(idx);
            }
        }

        function queueFrame(index) {
            const normalized = index === FRAME_COUNT - 1
                ? index
                : clamp(Math.round(index / frameStep) * frameStep, 0, FRAME_COUNT - 1);
            if (frames[normalized] || loadingFrames.has(normalized) || queuedFrames.has(normalized)) return;
            queuedFrames.add(normalized);
            loadQueue.push(normalized);
        }

        function loadFrameWindow(center) {
            if (!loadingStarted) return;
            loadQueue.length = 0;
            queuedFrames.clear();
            queueFrame(center);
            for (let offset = 1; offset <= LOAD_AHEAD; offset++) queueFrame(center + offset * frameStep);
            for (let offset = 1; offset <= LOAD_BEHIND; offset++) queueFrame(center - offset * frameStep);
            if (center >= FRAME_COUNT - 1 - LOAD_AHEAD * frameStep) queueFrame(FRAME_COUNT - 1);
            pumpFrameQueue();
        }

        // ------- Scroll handler -------

        function getProgress() {
            const rect = section.getBoundingClientRect();
            const scrollableH = section.offsetHeight - window.innerHeight;
            const scrolled = -rect.top;
            return clamp(scrolled / scrollableH, 0, 1);
        }

        let lastFrameIndex = -1;

        function onScrollTick() {
            rafPending = false;
            const progress = getProgress();

            // Frame — remap progress through the variable-speed LUT
            const lutPos         = clamp(progress * 1000, 0, 1000);
            const lutLo          = Math.floor(lutPos);
            const lutHi          = Math.min(lutLo + 1, 1000);
            const mappedProgress = speedLut[lutLo] + (speedLut[lutHi] - speedLut[lutLo]) * (lutPos - lutLo);
            const rawIndex       = Math.round(mappedProgress * (FRAME_COUNT - 1));
            // Snap to nearest loaded step
            const frameIndex = isMobile
                ? Math.round(rawIndex / MOBILE_STEP) * MOBILE_STEP
                : rawIndex;
            const clamped = clamp(frameIndex, 0, FRAME_COUNT - 1);

            if (clamped !== lastFrameIndex) {
                lastFrameIndex = clamped;
                loadFrameWindow(clamped);
                const img = nearestLoaded(clamped);
                if (img) drawFrame(img);
            }

            // Background: keep white throughout — no interpolation to avoid colour flash
            sticky.style.background = '#ffffff';

            // Text fade-out + slide up
            if (textEl) {
                let opacity, ty;
                if (progress <= TEXT_FADE_START) {
                    opacity = 1; ty = 0;
                } else if (progress >= TEXT_FADE_END) {
                    opacity = 0; ty = -36;
                } else {
                    const t = easeOut((progress - TEXT_FADE_START) / (TEXT_FADE_END - TEXT_FADE_START));
                    opacity = 1 - t;
                    ty = -36 * t;
                }
                textEl.style.opacity = opacity;
                textEl.style.transform = `translateX(-50%) translateY(${ty}px)`;
            }

            // CTA fade-in
            if (ctaEl) {
                let opacity;
                if (progress <= CTA_FADE_START) {
                    opacity = 0;
                } else if (progress >= CTA_FADE_END) {
                    opacity = 1;
                } else {
                    opacity = easeOut((progress - CTA_FADE_START) / (CTA_FADE_END - CTA_FADE_START));
                }
                ctaEl.style.opacity = opacity;
                ctaEl.style.pointerEvents = opacity > 0.1 ? 'auto' : 'none';
            }

            // Bottom gradient vignette
            if (sticky) {
                let gradOpacity;
                if (progress <= GRAD_FADE_START) {
                    gradOpacity = 0;
                } else if (progress >= GRAD_FADE_END) {
                    gradOpacity = 1;
                } else {
                    gradOpacity = (progress - GRAD_FADE_START) / (GRAD_FADE_END - GRAD_FADE_START);
                }
                // The static geometry/background live in the stylesheet. A direct
                // opacity property is CSP-safe and keeps the scroll interpolation
                // smooth without parsing a CSS declaration string.
                if (sticky._gradEl) sticky._gradEl.style.opacity = String(gradOpacity);
            }
        }

        // Create a real div for the gradient (pseudo-element opacity not scriptable)
        const gradDiv = document.createElement('div');
        gradDiv.className = 'hero-scroll__gradient';
        sticky.appendChild(gradDiv);
        sticky._gradEl = gradDiv;

        window.addEventListener('scroll', () => {
            if (!rafPending) {
                rafPending = true;
                requestAnimationFrame(onScrollTick);
            }
        }, { passive: true });

        window.addEventListener('resize', () => {
            sizeCanvas();
            drawFrame(nearestLoaded(lastFrameIndex >= 0 ? lastFrameIndex : 0));
        }, { passive: true });

        // Defer frame requests until the hero is close to the viewport. Only a
        // small window around the current scroll position is requested.
        if (posterEl) posterEl.style.display = 'block';
        const startLoading = () => {
            if (loadingStarted) return;
            loadingStarted = true;
            loadFrameWindow(lastFrameIndex >= 0 ? lastFrameIndex : 0);
        };
        if ("IntersectionObserver" in window) {
            const observer = new IntersectionObserver((entries) => {
                if (!entries.some((entry) => entry.isIntersecting)) return;
                observer.disconnect();
                startLoading();
            }, { rootMargin: "200px 0px" });
            observer.observe(section);
        } else {
            startLoading();
        }
        // Initial paint (progress = 0)
        requestAnimationFrame(onScrollTick);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
