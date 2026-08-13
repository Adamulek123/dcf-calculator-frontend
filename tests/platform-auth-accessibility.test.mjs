import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readFrontendFile(relativePath) {
    return readFile(path.join(frontendRoot, relativePath), "utf8");
}

test("landing and auth pages use external scripts and CSP-safe markup", async () => {
    for (const pageName of ["index.html", "login.html", "register.html"]) {
        const page = await readFrontendFile(pageName);
        assert.doesNotMatch(page, /<script(?![^>]*\bsrc\s*=)[^>]*>/i, `${pageName} has inline script markup`);
        assert.doesNotMatch(page, /\sstyle\s*=/i, `${pageName} has an inline style attribute`);
        assert.doesNotMatch(page, /unsafe-inline|TODO/i, `${pageName} retains a stale CSP/TODO escape hatch`);
    }
});

test("auth controls expose field semantics and inline error targets", async () => {
    const [login, register] = await Promise.all([
        readFrontendFile("login.html"),
        readFrontendFile("register.html"),
    ]);

    for (const [page, fields] of [[login, ["loginEmail", "loginPassword"]], [register, ["registerEmail", "registerPassword"]]]) {
        for (const id of fields) {
            assert.match(page, new RegExp(`id="${id}"[^>]*name="[^"]+"`));
            assert.match(page, new RegExp(`id="${id}"[^>]*autocomplete="[^"]+"`));
            assert.match(page, new RegExp(`id="${id}"[^>]*spellcheck="false"`));
            assert.match(page, new RegExp(`id="${id}"[^>]*aria-invalid="false"`));
            assert.match(page, new RegExp(`id="${id}"[^>]*aria-describedby="[^"]+"`));
        }
        assert.match(page, /class="field-error"[^>]*role="alert"[^>]*aria-live="polite"/);
    }
});

test("shared UI styles avoid animation and focus anti-patterns", async () => {
    const [css, script, toast] = await Promise.all([
        readFrontendFile("css/style.css"),
        readFrontendFile("js/script.js"),
        readFrontendFile("js/toast.js"),
    ]);

    assert.doesNotMatch(css, /transition\s*:\s*all/i);
    assert.doesNotMatch(css, /outline\s*:\s*(?:0|none)\b/i);
    assert.match(css, /\.topbar\.is-hidden:focus-within/);
    assert.match(css, /\.js \.hero-scroll__cta/);
    assert.match(css, /\.toast\.is-dismissing/);
    assert.match(css, /prefers-reduced-motion/);
    assert.match(script, /document\.documentElement\.classList\.add\("js"\)/);
    assert.match(toast, /prefers-reduced-motion/);
    assert.match(toast, /fallbackCleanup/);
});
