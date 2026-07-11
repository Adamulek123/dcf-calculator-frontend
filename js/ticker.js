import { apiCall } from "./api.js";
import { getPublicRecord, setPublicRecord } from "./public-data-store.js";

let cachedTickers = [];
const autocompleteRequestIds = new WeakMap();

const TICKER_CACHE_KEY = "ticker-directory:v1";
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

    const storedTickers = await getPublicRecord(TICKER_CACHE_KEY);
    if (Array.isArray(storedTickers)) {
        cachedTickers = storedTickers;
        return cachedTickers;
    }

    try {
        console.log("Fetching tickers from API...");
        const response = await fetchApi("/get_tickers");
        if (response.ok) {
            cachedTickers = await response.json();
            console.log(`Fetched ${cachedTickers.length} tickers from API`);
            void setPublicRecord(TICKER_CACHE_KEY, cachedTickers, CACHE_DURATION_MS);
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
    return `https://img.logo.dev/ticker/${ticker}?token=${token}`;
}

async function onLogoLoad() { return null; }

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

async function showTickerSuggestions(
    query,
    tickerAutocomplete = document.getElementById("tickerAutocomplete"),
    tickers = cachedTickers,
    options = {}
) {
    if (!tickerAutocomplete) return;

    const requestId = (autocompleteRequestIds.get(tickerAutocomplete) || 0) + 1;
    autocompleteRequestIds.set(tickerAutocomplete, requestId);
    tickerAutocomplete.classList.add("hidden");
    tickerAutocomplete.classList.toggle(
        "ticker-autocomplete-terminal",
        options.variant === "terminal"
    );

    if (!query || query.length < 2) return;

    const queryUpper = query.toUpperCase();
    const queryLower = query.toLowerCase();
    const symbolMatches = tickers.filter(
        (item) => item.symbol && item.symbol.toUpperCase().startsWith(queryUpper)
    );
    const nameMatches = tickers.filter(
        (item) => item.name
            && item.name.toLowerCase().includes(queryLower)
            && !symbolMatches.includes(item)
    );
    const suggestions = [...symbolMatches, ...nameMatches].slice(0, 5);
    if (!suggestions.length) return;

    const fragment = document.createDocumentFragment();
    const logoLoads = [];
    suggestions.forEach((item) => {
        const row = document.createElement("div");
        row.className = "ticker-suggestion";
        row.dataset.symbol = item.symbol;

        const img = document.createElement("img");
        img.className = "ticker-suggestion-logo";
        img.alt = "";
        logoLoads.push(new Promise((resolve) => {
            let triedFallback = false;
            img.onload = async () => {
                await onLogoLoad(img, item.symbol);
                resolve();
            };
            img.onerror = () => {
                if (!triedFallback) {
                    triedFallback = true;
                    img.src = `https://img.logo.dev/${item.symbol.toLowerCase()}.com?token=pk_RQ-JlIhmQEOm6yeZvHsSKA`;
                    return;
                }
                img.style.visibility = "hidden";
                resolve();
            };
            img.src = getLogoUrl(item.symbol);
        }));

        const info = document.createElement("div");
        info.className = "ticker-suggestion-info";
        const symbol = document.createElement("span");
        symbol.className = "ticker-suggestion-symbol";
        symbol.textContent = item.symbol;
        const name = document.createElement("span");
        name.className = "ticker-suggestion-name";
        name.textContent = item.name || "Listed instrument";
        const exchange = document.createElement("span");
        exchange.className = "ticker-suggestion-exchange";
        exchange.textContent = options.variant === "terminal"
            ? (item.exchange || "Listed")
            : `${item.exchange || ""} USD`.trim();

        if (options.variant === "terminal") {
            info.append(symbol, name);
            row.append(img, info, exchange);
        } else {
            info.append(name, exchange);
            row.append(img, symbol, info);
        }
        fragment.appendChild(row);
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
