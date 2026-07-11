import { createCacheRegistry } from "./cache-registry.js";

const publicCache = createCacheRegistry();

function financialPolicy(dataType) {
    return dataType.includes("price") || dataType.includes("stock_info")
        ? "marketSnapshot"
        : "financialFilings";
}

async function getCachedFinancialData(ticker, dataType) {
    const policy = financialPolicy(dataType);
    const cacheKey = publicCache.key(policy, { ticker, dataType });
    const entry = await publicCache.get(policy, cacheKey, { allowStale: false });
    return entry?.data ?? null;
}

async function setCachedFinancialData(ticker, dataType, data) {
    const policy = financialPolicy(dataType);
    const cacheKey = publicCache.key(policy, { ticker, dataType });
    return publicCache.set(policy, cacheKey, data);
}

export { getCachedFinancialData, setCachedFinancialData };
