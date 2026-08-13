import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_RETRY_ATTEMPTS,
    MAX_RETRY_DELAY_MS,
    normaliseRetryAttempts,
    publicApiCall,
    retryAfterMs,
    sleep,
} from "../js/api.js";
import { CACHE_TTL, createUserDataStore } from "../js/data-store.js";

test("API retry controls clamp attempts and Retry-After values", () => {
    assert.equal(normaliseRetryAttempts(999, true), MAX_RETRY_ATTEMPTS);
    assert.equal(normaliseRetryAttempts(-10, true), 0);
    assert.equal(normaliseRetryAttempts(Number.NaN, true), 2);
    const response = new Response("busy", { status: 503, headers: { "Retry-After": "999999999" } });
    assert.equal(retryAfterMs(response), MAX_RETRY_DELAY_MS);
});

test("retry waits can be aborted", async () => {
    const controller = new AbortController();
    const pending = sleep(5000, controller.signal);
    controller.abort();
    await assert.rejects(pending, (error) => error?.name === "AbortError");
});

test("GET coalescing keeps distinct headers and caller signals isolated", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, options) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response(JSON.stringify({ call: calls, signal: Boolean(options.signal) }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
        });
    };
    try {
        const [first, second] = await Promise.all([
            publicApiCall("/same", { headers: { "X-Revision": "one" } }, { backendBaseUrl: "http://test" }),
            publicApiCall("/same", { headers: { "X-Revision": "one" } }, { backendBaseUrl: "http://test" }),
        ]);
        assert.equal(calls, 1);
        assert.deepEqual(await first.json(), await second.json());

        await Promise.all([
            publicApiCall("/same", { headers: { "X-Revision": "two" } }, { backendBaseUrl: "http://test" }),
            publicApiCall("/same", { headers: { "X-Revision": "three" } }, { backendBaseUrl: "http://test" }),
        ]);
        assert.equal(calls, 3);

        const controller = new AbortController();
        await Promise.all([
            publicApiCall("/forced", { signal: controller.signal }, { backendBaseUrl: "http://test" }),
            publicApiCall("/forced", {}, { backendBaseUrl: "http://test" }),
        ]);
        assert.equal(calls, 5);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("fetch calls have a bounded total deadline", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
    try {
        await assert.rejects(
            publicApiCall("/never", { timeoutMs: 20 }, { backendBaseUrl: "http://test" }),
            (error) => error?.name === "TimeoutError",
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("private mutation entries report memory-only persistence and do not expire", async () => {
    const uid = `test-uid-${Date.now()}-${Math.random()}`;
    const store = createUserDataStore(uid, { now: () => Number.MAX_SAFE_INTEGER - 1 });
    const result = await store.set(store.keys.calculationOutbox(), { operations: [{ type: "save" }] }, {
        ttlMs: CACHE_TTL.calculationOutbox,
        staleTtlMs: 0,
    });
    assert.equal(result.persisted, false);
    assert.equal(result.expiresAt, Number.MAX_SAFE_INTEGER);
    const loaded = await store.get(store.keys.calculationOutbox());
    assert.equal(loaded.data.operations.length, 1);
});

test("private cache maxEntries is enforced per UID and family", async () => {
    const uid = `test-limit-${Date.now()}-${Math.random()}`;
    let timestamp = 1;
    const store = createUserDataStore(uid, { now: () => timestamp++ });
    await Promise.all([
        store.set(store.keys.portfolio("one"), { id: "one" }, { ttlMs: 1000, maxEntries: 2 }),
        store.set(store.keys.portfolio("two"), { id: "two" }, { ttlMs: 1000, maxEntries: 2 }),
        store.set(store.keys.portfolio("three"), { id: "three" }, { ttlMs: 1000, maxEntries: 2 }),
    ]);
    assert.equal(await store.get(store.keys.portfolio("one"), { allowExpired: true }), null);
    assert.equal((await store.get(store.keys.portfolio("two")))?.data.id, "two");
    assert.equal((await store.get(store.keys.portfolio("three")))?.data.id, "three");
});
