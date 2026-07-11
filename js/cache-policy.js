const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function policy({
    ownership,
    ttlMs,
    staleTtlMs,
    maxEntries = null,
    maxBytes = null,
    version = 1,
    invalidatedBy = [],
    key,
}) {
    return Object.freeze({
        ownership,
        ttlMs,
        staleTtlMs,
        maxEntries,
        maxBytes,
        version,
        invalidatedBy: Object.freeze([...invalidatedBy]),
        key,
    });
}

// This is the single source of truth for browser data-cache behaviour. A
// policy must explicitly say whether data is public or bound to a Firebase UID.
const CACHE_POLICIES = Object.freeze({
    tickerDirectory: policy({
        ownership: "public",
        ttlMs: 30 * DAY,
        staleTtlMs: 30 * DAY,
        maxBytes: 12 * 1024 * 1024,
        version: 2,
        invalidatedBy: ["ticker-directory-version-change", "manual-refresh"],
        key: () => "ticker-directory:v2",
    }),
    financialFilings: policy({
        ownership: "public",
        ttlMs: DAY,
        staleTtlMs: 7 * DAY,
        maxEntries: 200,
        maxBytes: 12 * 1024 * 1024,
        version: 2,
        invalidatedBy: ["financial-data-refresh", "ticker-data-version-change"],
        key: ({ ticker, dataType }) => `financial-data:v2:${encodeURIComponent(String(ticker || "").toUpperCase())}:${encodeURIComponent(String(dataType || ""))}`,
    }),
    marketSnapshot: policy({
        ownership: "public",
        ttlMs: 5 * MINUTE,
        staleTtlMs: HOUR,
        maxEntries: 200,
        maxBytes: 12 * 1024 * 1024,
        version: 2,
        invalidatedBy: ["manual-refresh", "quote-expiry"],
        key: ({ ticker, dataType }) => `financial-data:v2:${encodeURIComponent(String(ticker || "").toUpperCase())}:${encodeURIComponent(String(dataType || ""))}`,
    }),
    portfolioIndex: policy({
        ownership: "uid",
        ttlMs: 10 * MINUTE,
        staleTtlMs: DAY,
        maxEntries: 20,
        invalidatedBy: ["portfolio-create", "portfolio-rename", "portfolio-delete", "portfolio-position-change", "portfolio-currency-change"],
    }),
    portfolioDetail: policy({
        ownership: "uid",
        ttlMs: 10 * MINUTE,
        staleTtlMs: DAY,
        maxEntries: 20,
        invalidatedBy: ["portfolio-position-change", "portfolio-currency-change", "portfolio-delete", "portfolio-conflict"],
    }),
    portfolioOutbox: policy({
        ownership: "uid",
        ttlMs: 7 * DAY,
        staleTtlMs: 7 * DAY,
        maxEntries: 20,
        invalidatedBy: ["portfolio-sync-success", "portfolio-delete"],
    }),
    watchlists: policy({
        ownership: "uid",
        ttlMs: 10 * MINUTE,
        staleTtlMs: DAY,
        maxEntries: 20,
        invalidatedBy: ["watchlist-create", "watchlist-rename", "watchlist-delete", "watchlist-ticker-change"],
    }),
    dipPerformance: policy({
        ownership: "uid",
        ttlMs: 5 * MINUTE,
        staleTtlMs: DAY,
        maxEntries: 20,
        invalidatedBy: ["watchlist-ticker-change", "manual-refresh", "expiry"],
    }),
    fxRates: policy({
        ownership: "uid",
        ttlMs: 6 * HOUR,
        staleTtlMs: DAY,
        maxEntries: 10,
        invalidatedBy: ["currency-change", "manual-refresh", "expiry"],
    }),
});

export { CACHE_POLICIES };
