const FILING_CACHE_DURATION_MS = 24 * 60 * 60 * 1000;
const PRICE_CACHE_DURATION_MS = 5 * 60 * 1000;
const MAX_CACHED_COMPANIES = 50;

const FINANCIAL_CACHE_KEY = "dcf_financial_cache";
const FINANCIAL_CACHE_ACCESS_KEY = "dcf_financial_cache_access";

const LOGO_CACHE_KEY = "dcf_logo_cache";
const LOGO_CACHE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

const memoryCache = {};

function getCachedFinancialData(ticker, dataType) {
    const cacheKey = `${ticker}_${dataType}`;

    if (memoryCache[cacheKey]) {
        const cached = memoryCache[cacheKey];
        const maxAge = dataType.includes("price") || dataType.includes("stock_info")
            ? PRICE_CACHE_DURATION_MS
            : FILING_CACHE_DURATION_MS;

        if (Date.now() - cached.timestamp < maxAge) {
            console.log(`[Cache HIT - Memory] ${cacheKey}`);
            return cached.data;
        }
        delete memoryCache[cacheKey];
    }

    try {
        const storedCache = localStorage.getItem(FINANCIAL_CACHE_KEY);
        if (storedCache) {
            const allCached = JSON.parse(storedCache);
            if (allCached[cacheKey]) {
                const cached = allCached[cacheKey];
                const maxAge = dataType.includes("price") || dataType.includes("stock_info")
                    ? PRICE_CACHE_DURATION_MS
                    : FILING_CACHE_DURATION_MS;

                if (Date.now() - cached.timestamp < maxAge) {
                    console.log(`[Cache HIT - LocalStorage] ${cacheKey}`);
                    memoryCache[cacheKey] = cached;
                    updateCacheAccessTime(ticker);
                    return cached.data;
                }
            }
        }
    } catch (e) {
        console.error("Error reading from localStorage cache:", e);
    }

    console.log(`[Cache MISS] ${cacheKey}`);
    return null;
}

function setCachedFinancialData(ticker, dataType, data) {
    const cacheKey = `${ticker}_${dataType}`;
    const cacheEntry = {
        data,
        timestamp: Date.now()
    };

    memoryCache[cacheKey] = cacheEntry;

    try {
        let allCached = {};
        const storedCache = localStorage.getItem(FINANCIAL_CACHE_KEY);
        if (storedCache) {
            allCached = JSON.parse(storedCache);
        }

        allCached[cacheKey] = cacheEntry;
        updateCacheAccessTime(ticker);
        evictOldCacheEntries(allCached);

        localStorage.setItem(FINANCIAL_CACHE_KEY, JSON.stringify(allCached));
        console.log(`[Cache SET] ${cacheKey}`);
    } catch (e) {
        if (e.name === "QuotaExceededError") {
            console.warn("LocalStorage full, clearing old cache entries");
            clearOldestCacheEntries();
            try {
                const allCached = { [cacheKey]: cacheEntry };
                localStorage.setItem(FINANCIAL_CACHE_KEY, JSON.stringify(allCached));
            } catch (e2) {
                console.error("Still cannot save to localStorage:", e2);
            }
        } else {
            console.error("Error saving to localStorage cache:", e);
        }
    }
}

function updateCacheAccessTime(ticker) {
    try {
        let accessTimes = {};
        const stored = localStorage.getItem(FINANCIAL_CACHE_ACCESS_KEY);
        if (stored) {
            accessTimes = JSON.parse(stored);
        }
        accessTimes[ticker] = Date.now();
        localStorage.setItem(FINANCIAL_CACHE_ACCESS_KEY, JSON.stringify(accessTimes));
    } catch (e) {
        console.error("Error updating cache access time:", e);
    }
}

function evictOldCacheEntries(allCached) {
    try {
        const accessTimesStr = localStorage.getItem(FINANCIAL_CACHE_ACCESS_KEY);
        if (!accessTimesStr) {
            return;
        }

        const accessTimes = JSON.parse(accessTimesStr);
        const tickers = Object.keys(accessTimes);
        if (tickers.length <= MAX_CACHED_COMPANIES) {
            return;
        }

        tickers.sort((a, b) => accessTimes[a] - accessTimes[b]);
        const tickersToRemove = tickers.slice(0, tickers.length - MAX_CACHED_COMPANIES);

        for (const ticker of tickersToRemove) {
            const keysToRemove = Object.keys(allCached).filter((k) => k.startsWith(`${ticker}_`));
            for (const key of keysToRemove) {
                delete allCached[key];
                delete memoryCache[key];
            }
            delete accessTimes[ticker];
            console.log(`[Cache EVICT] ${ticker} (LRU)`);
        }

        localStorage.setItem(FINANCIAL_CACHE_ACCESS_KEY, JSON.stringify(accessTimes));
    } catch (e) {
        console.error("Error evicting cache entries:", e);
    }
}

function clearOldestCacheEntries() {
    try {
        const accessTimesStr = localStorage.getItem(FINANCIAL_CACHE_ACCESS_KEY);
        if (!accessTimesStr) {
            localStorage.removeItem(FINANCIAL_CACHE_KEY);
            return;
        }

        const accessTimes = JSON.parse(accessTimesStr);
        const tickers = Object.keys(accessTimes);

        tickers.sort((a, b) => accessTimes[a] - accessTimes[b]);
        const tickersToRemove = tickers.slice(0, Math.ceil(tickers.length / 2));

        let allCached = {};
        const storedCache = localStorage.getItem(FINANCIAL_CACHE_KEY);
        if (storedCache) {
            allCached = JSON.parse(storedCache);
        }

        for (const ticker of tickersToRemove) {
            const keysToRemove = Object.keys(allCached).filter((k) => k.startsWith(`${ticker}_`));
            for (const key of keysToRemove) {
                delete allCached[key];
            }
            delete accessTimes[ticker];
        }

        localStorage.setItem(FINANCIAL_CACHE_KEY, JSON.stringify(allCached));
        localStorage.setItem(FINANCIAL_CACHE_ACCESS_KEY, JSON.stringify(accessTimes));
        console.log(`[Cache CLEANUP] Removed ${tickersToRemove.length} old tickers`);
    } catch (e) {
        localStorage.removeItem(FINANCIAL_CACHE_KEY);
        localStorage.removeItem(FINANCIAL_CACHE_ACCESS_KEY);
        console.log("[Cache CLEARED] Full reset");
    }
}

function getCachedLogo(ticker) {
    try {
        const storedCache = localStorage.getItem(LOGO_CACHE_KEY);
        if (!storedCache) {
            return null;
        }

        const cache = JSON.parse(storedCache);
        const entry = cache[ticker.toUpperCase()];
        if (!entry) {
            return null;
        }

        if (Date.now() - entry.timestamp > LOGO_CACHE_EXPIRY_MS) {
            return null;
        }

        return entry.dataUrl;
    } catch (e) {
        console.warn("[Logo Cache] Error reading cache:", e);
        return null;
    }
}

function setCachedLogo(ticker, dataUrl) {
    try {
        if (!dataUrl || !dataUrl.startsWith("data:")) {
            return;
        }

        let cache = {};
        const storedCache = localStorage.getItem(LOGO_CACHE_KEY);
        if (storedCache) {
            cache = JSON.parse(storedCache);
        }

        cache[ticker.toUpperCase()] = {
            dataUrl,
            timestamp: Date.now()
        };

        const keys = Object.keys(cache);
        if (keys.length > 100) {
            const sortedKeys = keys.sort((a, b) => cache[a].timestamp - cache[b].timestamp);
            const toRemove = sortedKeys.slice(0, keys.length - 100);
            toRemove.forEach((k) => delete cache[k]);
        }

        localStorage.setItem(LOGO_CACHE_KEY, JSON.stringify(cache));
        console.log(`[Logo Cache] STORED ${ticker}`);
    } catch (e) {
        if (e.name === "QuotaExceededError") {
            console.warn("[Logo Cache] Storage full, clearing old logos");
            try {
                localStorage.removeItem(LOGO_CACHE_KEY);
            } catch (_ignored) {}
        } else {
            console.warn("[Logo Cache] Error writing cache:", e);
        }
    }
}

export {
    getCachedFinancialData,
    setCachedFinancialData,
    updateCacheAccessTime,
    evictOldCacheEntries,
    clearOldestCacheEntries,
    getCachedLogo,
    setCachedLogo
};
