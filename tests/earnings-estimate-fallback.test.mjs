import test from "node:test";
import assert from "node:assert/strict";

import {
    canUseStaleEstimate,
    isEstimateFresh,
    isEstimateWithinStaleWindow,
} from "../js/earnings-calendar-resilience.mjs";

test("stale estimates are used only for transport and transient HTTP failures", () => {
    const now = 1_000_000;
    const entry = {
        data: { epsEstimate: 1.2 },
        expiresAt: now - 1,
        staleExpiresAt: now + 1_000,
    };
    assert.equal(isEstimateFresh(entry, now), false);
    assert.equal(isEstimateWithinStaleWindow(entry, now), true);
    assert.equal(canUseStaleEstimate(null, entry, now), true);
    assert.equal(canUseStaleEstimate(503, entry, now), true);
    assert.equal(canUseStaleEstimate(429, entry, now), true);
    assert.equal(canUseStaleEstimate(404, entry, now), false);
    assert.equal(canUseStaleEstimate(409, entry, now), false);
    assert.equal(canUseStaleEstimate(503, null, now), false);
});

test("an in-memory entry is never used after its absolute seven-day stale expiry", () => {
    const now = 10_000;
    const entry = {
        data: { revenueEstimate: 42 },
        expiresAt: now - 1,
        staleExpiresAt: now + 7 * 24 * 60 * 60 * 1000,
    };
    assert.equal(canUseStaleEstimate(503, entry, now + 7 * 24 * 60 * 60 * 1000 + 1), false);
    assert.equal(isEstimateWithinStaleWindow(entry, now + 7 * 24 * 60 * 60 * 1000 + 1), false);
});
