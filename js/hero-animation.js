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
            ctx.scale(dpr, dpr);
        }
        sizeCanvas();

        // Frame image pool
        const frames = new Array(FRAME_COUNT).fill(null);
        let currentFrame = 0;
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

        // Preload all (or every Nth) frames with a concurrency cap
        function preloadFrames() {
            const indices = [];
            for (let i = 0; i < FRAME_COUNT; i += frameStep) indices.push(i);
            // Always include first and last
            if (!indices.includes(FRAME_COUNT - 1)) indices.push(FRAME_COUNT - 1);

            let nextToLoad = 0;
            const CONCURRENCY = 6;

            function loadNext() {
                if (nextToLoad >= indices.length) return;
                const idx = indices[nextToLoad++];
                const img = new Image();
                img.onload = () => {
                    frames[idx] = img;
                    // Draw first frame immediately so canvas is not blank
                    if (idx === 0) drawFrame(img);
                    loadNext();
                };
                img.onerror = () => loadNext();
                img.src = frameName(idx);
            }

            for (let i = 0; i < CONCURRENCY; i++) loadNext();
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
                sticky.style.setProperty('--grad-opacity', gradOpacity);
                // Apply via inline ::after pseudo – use a wrapper div instead
                if (sticky._gradEl) sticky._gradEl.style.opacity = gradOpacity;
            }
        }

        // Create a real div for the gradient (pseudo-element opacity not scriptable)
        const gradDiv = document.createElement('div');
        gradDiv.style.cssText = [
            'position:absolute', 'inset:0 0 0 0', 'bottom:0', 'left:0', 'right:0',
            'height:28vh', 'top:auto',
            'background:linear-gradient(to bottom, transparent, #ffffff)',
            'pointer-events:none', 'opacity:0', 'z-index:3',
        ].join(';');
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

        // Kick off
        preloadFrames();
        // Initial paint (progress = 0)
        requestAnimationFrame(onScrollTick);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
