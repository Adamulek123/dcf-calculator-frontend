const TRANSIENT_ESTIMATE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function hasEstimateData(entry) {
    return Boolean(entry && entry.data !== null && entry.data !== undefined);
}

function isEstimateWithinStaleWindow(entry, now = Date.now()) {
    const staleExpiresAt = Number(entry?.staleExpiresAt);
    return hasEstimateData(entry)
        && Number.isFinite(staleExpiresAt)
        && staleExpiresAt > now;
}

function isEstimateFresh(entry, now = Date.now()) {
    const expiresAt = Number(entry?.expiresAt);
    return hasEstimateData(entry)
        && Number.isFinite(expiresAt)
        && expiresAt > now;
}

function canUseStaleEstimate(status, cachedEntry, now = Date.now()) {
    // Keep accepting a boolean for small consumers/tests that only need the
    // status policy. The earnings page passes the full cache entry so this
    // decision also enforces the absolute stale expiry timestamp.
    const hasCachedData = typeof cachedEntry === "object"
        ? isEstimateWithinStaleWindow(cachedEntry, now)
        : Boolean(cachedEntry);
    if (!hasCachedData) return false;
    // A missing estimate is authoritative: do not resurrect an obsolete cache
    // entry. Only transport failures and explicitly transient HTTP responses
    // may fall back to data still inside the policy's stale window.
    if (status === null || status === undefined) return true;
    return TRANSIENT_ESTIMATE_STATUSES.has(Number(status));
}

export { canUseStaleEstimate, isEstimateFresh, isEstimateWithinStaleWindow };
