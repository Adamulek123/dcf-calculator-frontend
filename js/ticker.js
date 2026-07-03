import { apiCall } from "./api.js";
import { getCachedLogo, setCachedLogo } from "./cache.js";

let cachedTickers = [];
const autocompleteRequestIds = new WeakMap();

const TICKER_CACHE_KEY = "dcf_tickers_cache";
const TICKER_CACHE_EXPIRY_KEY = "dcf_tickers_cache_expiry";
const CACHE_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

async function fetchTickers(fetchApi = apiCall) {
    if (cachedTickers && cachedTickers.length > 0) {
        console.log("Tickers already in memory, skipping fetch");
        return cachedTickers;
    }

    const cachedData = localStorage.getItem(TICKER_CACHE_KEY);
    const cacheExpiry = localStorage.getItem(TICKER_CACHE_EXPIRY_KEY);

    if (cachedData && cacheExpiry) {
        const expiryTime = parseInt(cacheExpiry, 10);
        if (Date.now() < expiryTime) {
            try {
                cachedTickers = JSON.parse(cachedData);
                console.log(`Loaded ${cachedTickers.length} tickers from localStorage cache`);
                return cachedTickers;
            } catch (e) {
                console.error("Error parsing cached tickers:", e);
                localStorage.removeItem(TICKER_CACHE_KEY);
                localStorage.removeItem(TICKER_CACHE_EXPIRY_KEY);
            }
        } else {
            console.log("Ticker cache expired, fetching fresh data");
            localStorage.removeItem(TICKER_CACHE_KEY);
            localStorage.removeItem(TICKER_CACHE_EXPIRY_KEY);
        }
    }

    try {
        console.log("Fetching tickers from API...");
        const response = await fetchApi("/get_tickers");
        if (response.ok) {
            cachedTickers = await response.json();
            console.log(`Fetched ${cachedTickers.length} tickers from API`);
            localStorage.setItem(TICKER_CACHE_KEY, JSON.stringify(cachedTickers));
            localStorage.setItem(TICKER_CACHE_EXPIRY_KEY, (Date.now() + CACHE_DURATION_MS).toString());
            console.log("Tickers cached in localStorage (expires in 1 month)");
        } else {
            console.error("Failed to fetch tickers:", response.status);
        }
    } catch (error) {
        console.error("Error fetching tickers:", error);
    }

    return cachedTickers;
}

function isValidTicker(query, tickers = cachedTickers) {
    if (!query || !tickers || tickers.length === 0) {
        return false;
    }
    const queryUpper = query.toUpperCase().trim();
    return tickers.some((t) => t.symbol && t.symbol.toUpperCase() === queryUpper);
}

function getLogoUrl(ticker, token = "pk_RQ-JlIhmQEOm6yeZvHsSKA") { // Token is CORS-restricted to the production domain — acceptable risk
    const cached = getCachedLogo(ticker);
    if (cached) {
        console.log(`[Logo Cache] HIT for ${ticker}`);
        return cached;
    }
    console.log(`[Logo Cache] MISS for ${ticker}`);
    return `https://img.logo.dev/ticker/${ticker}?token=${token}`;
}

async function onLogoLoad(img, ticker) {
    const imgUrl = img.src;
    if (imgUrl.startsWith("data:")) {
        return imgUrl;
    }

    try {
        const response = await fetch(imgUrl);
        if (!response.ok) {
            throw new Error(`Logo request failed with ${response.status}`);
        }
        const blob = await response.blob();
        const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error("Unable to read logo data"));
            reader.readAsDataURL(blob);
        });
        setCachedLogo(ticker, base64);
        return base64;
    } catch (e) {
        console.warn(`[Logo Cache] Failed to cache ${ticker}:`, e);
        return null;
    }
}

function onLogoError(img, ticker, token = "pk_RQ-JlIhmQEOm6yeZvHsSKA") { // Token is CORS-restricted to the production domain — acceptable risk
    const fallbackUrl = `https://img.logo.dev/${ticker.toLowerCase()}.com?token=${token}`;
    img.src = fallbackUrl;
    img.onerror = null;
}

function hideTickerSuggestions(tickerAutocomplete = document.getElementById("tickerAutocomplete")) {
    if (!tickerAutocomplete) return;
    autocompleteRequestIds.set(tickerAutocomplete, (autocompleteRequestIds.get(tickerAutocomplete) || 0) + 1);
    tickerAutocomplete.classList.add("hidden");
}

async function showTickerSuggestions(query, tickerAutocomplete = document.getElementById("tickerAutocomplete"), tickers = cachedTickers) {
    if (!tickerAutocomplete) {
        return;
    }

    const requestId = (autocompleteRequestIds.get(tickerAutocomplete) || 0) + 1;
    autocompleteRequestIds.set(tickerAutocomplete, requestId);
    tickerAutocomplete.classList.add("hidden");

    if (!query || query.length < 2) {
        tickerAutocomplete.classList.add("hidden");
        return;
    }

    const queryUpper = query.toUpperCase();
    const queryLower = query.toLowerCase();

    const symbolMatches = tickers.filter((t) => t.symbol && t.symbol.toUpperCase().startsWith(queryUpper));
    const nameMatches = tickers.filter((t) => t.name && t.name.toLowerCase().includes(queryLower) && !symbolMatches.includes(t));
    const suggestions = [...symbolMatches, ...nameMatches].slice(0, 5);

    if (suggestions.length === 0) {
        tickerAutocomplete.classList.add("hidden");
        return;
    }

    const fragment = document.createDocumentFragment();
    const logoLoads = [];

    suggestions.forEach((ticker) => {
        const div = document.createElement("div");
        div.className = "ticker-suggestion";
        div.dataset.symbol = ticker.symbol;

        const img = document.createElement("img");
        img.className = "ticker-suggestion-logo";
        img.alt = ticker.symbol;
        logoLoads.push(new Promise((resolve) => {
            let triedFallback = false;
            img.onload = async () => {
                await onLogoLoad(img, ticker.symbol);
                resolve();
            };
            img.onerror = () => {
                if (!triedFallback) {
                    triedFallback = true;
                    img.src = `https://img.logo.dev/${ticker.symbol.toLowerCase()}.com?token=pk_RQ-JlIhmQEOm6yeZvHsSKA`;
                    return;
                }
                img.style.visibility = "hidden";
                resolve();
            };
            img.src = getLogoUrl(ticker.symbol);
        }));

        const symbolSpan = document.createElement("span");
        symbolSpan.className = "ticker-suggestion-symbol";
        symbolSpan.textContent = ticker.symbol;

        const infoDiv = document.createElement("div");
        infoDiv.className = "ticker-suggestion-info";

        const nameSpan = document.createElement("span");
        nameSpan.className = "ticker-suggestion-name";
        nameSpan.textContent = ticker.name || "";

        const exchangeSpan = document.createElement("span");
        exchangeSpan.className = "ticker-suggestion-exchange";
        exchangeSpan.textContent = (ticker.exchange || "") + " USD";

        infoDiv.appendChild(nameSpan);
        infoDiv.appendChild(exchangeSpan);

        div.appendChild(img);
        div.appendChild(symbolSpan);
        div.appendChild(infoDiv);

        fragment.appendChild(div);
    });

    await Promise.all(logoLoads);
    if (autocompleteRequestIds.get(tickerAutocomplete) !== requestId) return;

    tickerAutocomplete.replaceChildren(fragment);
    tickerAutocomplete.classList.remove("hidden");
}

if (typeof window !== "undefined") {
    window.dcfOnLogoLoad = onLogoLoad;
    window.dcfOnLogoError = onLogoError;
}

export {
    debounce,
    isValidTicker,
    fetchTickers,
    showTickerSuggestions,
    hideTickerSuggestions,
    getLogoUrl,
    onLogoLoad,
    onLogoError
};
