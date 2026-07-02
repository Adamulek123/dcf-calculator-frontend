import { apiCall, setButtonState } from "./api.js";
import { showToast } from "./toast.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import {
    debounce,
    fetchTickers,
    isValidTicker,
    showTickerSuggestions,
    hideTickerSuggestions
} from "./ticker.js";

window.addEventListener("DOMContentLoaded", () => {
    const els = {
        form: document.getElementById("positionForm"),
        formTitle: document.getElementById("positionFormTitle"),
        formDescription: document.getElementById("positionFormDescription"),
        tickerInput: document.getElementById("portfolioTickerInput"),
        autocomplete: document.getElementById("portfolioTickerAutocomplete"),
        tickerPriceStatus: document.getElementById("tickerPriceStatus"),
        sizingModeSelect: document.getElementById("sizingModeSelect"),
        sizeInput: document.getElementById("positionSizeInput"),
        sizeLabel: document.getElementById("positionSizeLabel"),
        sizeSuffix: document.getElementById("positionSizeSuffix"),
        entryPriceInput: document.getElementById("entryPriceInput"),
        entryCurrencyPrefix: document.getElementById("entryCurrencyPrefix"),
        leverageInput: document.getElementById("leverageInput"),
        advancedOptions: document.getElementById("advancedPositionOptions"),
        advancedSummaryValue: document.getElementById("advancedSummaryValue"),
        addPositionBtn: document.getElementById("addPositionBtn"),
        cancelEditBtn: document.getElementById("cancelEditBtn"),
        savePortfolioBtn: document.getElementById("savePortfolioBtn"),
        loadPortfolioBtn: document.getElementById("loadPortfolioBtn"),
        refreshPricesBtn: document.getElementById("refreshPricesBtn"),
        currencySelect: document.getElementById("portfolioCurrencySelect"),
        refreshRatesBtn: document.getElementById("refreshRatesBtn"),
        positionsList: document.getElementById("positionsList"),
        positionsCountBadge: document.getElementById("positionsCountBadge"),
        pricesUpdatedStatus: document.getElementById("pricesUpdatedStatus"),
        saveStatus: document.getElementById("portfolioSaveStatus"),
        summaryPositionCount: document.getElementById("summaryPositionCount"),
        summaryExposure: document.getElementById("summaryExposure"),
        summaryPnl: document.getElementById("summaryPnl"),
        summaryReturn: document.getElementById("summaryReturn"),
        previewSharesLabel: document.getElementById("previewSharesLabel"),
        previewShares: document.getElementById("previewShares"),
        previewEntryValueLabel: document.getElementById("previewEntryValueLabel"),
        previewEntryValue: document.getElementById("previewEntryValue"),
        previewExposure: document.getElementById("previewExposure"),
        deleteDialog: document.getElementById("deletePositionDialog"),
        deleteDialogTitle: document.getElementById("deleteDialogTitle"),
        liveStatus: document.getElementById("portfolioLiveStatus"),
        toastContainer: document.getElementById("toast-container")
    };

    const apiDeps = {
        auth,
        handleLogout: async () => {
            try {
                await logoutUser();
            } finally {
                window.location.replace("login.html");
            }
        }
    };

    const CLIENT_QUOTE_TTL_MS = 60 * 1000;
    const FRONTEND_QUOTE_CACHE_KEY = "dcf_portfolio_quote_cache_v1";
    const DEFAULT_API_TIMEOUT_MS = 30 * 1000;
    const PORTFOLIO_LOAD_TIMEOUT_MS = 45 * 1000;
    let positions = [];
    let ratesBaseUsd = { USD: 1 };
    let selectedCurrency = "USD";
    let hasTickerDataset = false;
    let editingPositionId = null;
    let entryPriceDirty = false;
    let portfolioDirty = false;
    let initializedUserId = null;
    const quotes = new Map();
    const inFlightQuotes = new Map();

    function toNum(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function escapeHtml(value) {
        return String(value ?? "")
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }

    function formatMoney(value, currency = selectedCurrency) {
        if (!Number.isFinite(value)) return "—";
        return new Intl.NumberFormat("en-US", {
            style: "currency",
            currency,
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value);
    }

    function formatNumber(value, maximumFractionDigits = 4) {
        if (!Number.isFinite(value)) return "—";
        return new Intl.NumberFormat("en-US", {
            maximumFractionDigits
        }).format(value);
    }

    function formatPct(value) {
        if (!Number.isFinite(value)) return "—";
        return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
    }

    function formatRelativeTime(isoValue) {
        const timestamp = Date.parse(isoValue || "");
        if (!Number.isFinite(timestamp)) return "";
        const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
        if (seconds < 10) return "just now";
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        return new Intl.DateTimeFormat("en-US", {
            hour: "numeric",
            minute: "2-digit"
        }).format(timestamp);
    }

    function getRate(currency = selectedCurrency) {
        const rate = ratesBaseUsd[currency];
        return Number.isFinite(rate) && rate > 0 ? rate : 1;
    }

    async function guardedApiCall(endpoint, options = {}, timeoutMs = DEFAULT_API_TIMEOUT_MS) {
        const controller = new AbortController();
        const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await apiCall(endpoint, { ...options, signal: controller.signal }, apiDeps);
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error("The request took too long. The service may be waking up; please try again.");
            }
            throw new Error(String(error?.message || error));
        } finally {
            window.clearTimeout(timeoutId);
        }
    }

    function normalizeTicker(value) {
        return String(value || "").trim().toUpperCase();
    }

    function validateTickerInput(ticker) {
        if (!ticker) return false;
        if (hasTickerDataset) return isValidTicker(ticker);
        return /^[A-Z0-9.-]{1,15}$/.test(ticker);
    }

    function getDraftTicker() {
        return normalizeTicker(els.tickerInput.value);
    }

    function getSelectedSide() {
        return els.form.querySelector('input[name="positionSide"]:checked')?.value || "buy";
    }

    function getQuote(ticker) {
        return quotes.get(normalizeTicker(ticker));
    }

    function hydrateFrontendQuoteCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(FRONTEND_QUOTE_CACHE_KEY) || "{}");
            const now = Date.now();
            Object.entries(cached).forEach(([ticker, quote]) => {
                const price = toNum(quote?.price);
                const fetchedAt = Date.parse(quote?.asOf || "");
                if (!Number.isFinite(price) || !Number.isFinite(fetchedAt)) return;
                if (now - fetchedAt >= CLIENT_QUOTE_TTL_MS) return;
                quotes.set(normalizeTicker(ticker), {
                    price,
                    asOf: new Date(fetchedAt).toISOString(),
                    status: "ready"
                });
            });
        } catch (error) {
            console.warn("Unable to read the frontend quote cache:", error);
        }
    }

    function persistFrontendQuoteCache() {
        try {
            const now = Date.now();
            const cache = {};
            quotes.forEach((quote, ticker) => {
                const fetchedAt = Date.parse(quote?.asOf || "");
                if (!Number.isFinite(quote?.price) || !Number.isFinite(fetchedAt)) return;
                if (now - fetchedAt >= CLIENT_QUOTE_TTL_MS) return;
                cache[ticker] = { price: quote.price, asOf: quote.asOf };
            });
            localStorage.setItem(FRONTEND_QUOTE_CACHE_KEY, JSON.stringify(cache));
        } catch (error) {
            console.warn("Unable to update the frontend quote cache:", error);
        }
    }

    function updateCurrencyOptions() {
        const currencies = new Set(Object.keys(ratesBaseUsd || {}));
        currencies.add("USD");
        currencies.add(selectedCurrency);
        const sortedCurrencies = [...currencies].sort();

        els.currencySelect.replaceChildren();
        sortedCurrencies.forEach((currency) => {
            const option = document.createElement("option");
            option.value = currency;
            option.textContent = currency;
            option.selected = currency === selectedCurrency;
            els.currencySelect.appendChild(option);
        });
        els.entryCurrencyPrefix.textContent = selectedCurrency;
        updateFormLabels();
    }

    async function loadConversionRates(silent = false) {
        setButtonState(els.refreshRatesBtn, "…", true);
        try {
            const response = await guardedApiCall("/portfolio/conversion-rates?base=USD");
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || "Failed to load exchange rates.");
            }
            ratesBaseUsd = { ...(data.rates || {}), USD: 1 };
            if (!ratesBaseUsd[selectedCurrency]) selectedCurrency = "USD";
            updateCurrencyOptions();
            renderAll();
            if (!silent) {
                showToast("Exchange rates updated.", false, 2500, els.toastContainer);
            }
        } catch (error) {
            if (!silent) showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.refreshRatesBtn, "↻", false);
        }
    }

    function computePositionMetrics(position) {
        const entryPriceUsd = toNum(position.entryPriceUsd);
        const sizeValue = toNum(position.sizeValue);
        const leverage = toNum(position.leverage) || 1;
        const quote = getQuote(position.ticker);
        const currentPriceUsd = quote?.price;
        const marketShares = position.sizingMode === "shares"
            ? sizeValue
            : (entryPriceUsd > 0 ? (sizeValue / entryPriceUsd) * leverage : 0);
        const fundedShares = leverage > 0 ? marketShares / leverage : 0;
        const baseExposureUsd = position.sizingMode === "shares"
            ? entryPriceUsd * fundedShares
            : sizeValue;
        const grossExposureUsd = position.sizingMode === "shares"
            ? entryPriceUsd * marketShares
            : baseExposureUsd * leverage;

        let pnlUsd = null;
        let pnlPct = null;
        if (Number.isFinite(currentPriceUsd)) {
            const delta = position.side === "sell"
                ? entryPriceUsd - currentPriceUsd
                : currentPriceUsd - entryPriceUsd;
            pnlUsd = delta * marketShares;
            pnlPct = baseExposureUsd > 0 ? (pnlUsd / baseExposureUsd) * 100 : null;
        }

        return {
            quote,
            entryPriceUsd,
            currentPriceUsd,
            marketShares,
            fundedShares,
            baseExposureUsd,
            grossExposureUsd,
            pnlUsd,
            pnlPct
        };
    }

    function renderSummary() {
        const rate = getRate();
        let grossExposureUsd = 0;
        let totalBaseExposureUsd = 0;
        let totalPnlUsd = 0;
        let pricedCount = 0;

        positions.forEach((position) => {
            const metrics = computePositionMetrics(position);
            grossExposureUsd += metrics.grossExposureUsd || 0;
            if (Number.isFinite(metrics.pnlUsd)) {
                totalPnlUsd += metrics.pnlUsd;
                totalBaseExposureUsd += metrics.baseExposureUsd || 0;
                pricedCount += 1;
            }
        });

        const totalReturn = totalBaseExposureUsd > 0
            ? (totalPnlUsd / totalBaseExposureUsd) * 100
            : null;
        els.summaryPositionCount.textContent = String(positions.length);
        els.summaryExposure.textContent = positions.length
            ? formatMoney(grossExposureUsd * rate)
            : "—";
        els.summaryPnl.textContent = pricedCount
            ? formatMoney(totalPnlUsd * rate)
            : "—";
        els.summaryReturn.textContent = pricedCount
            ? formatPct(totalReturn)
            : "—";
        setPerformanceClass(els.summaryPnl, pricedCount ? totalPnlUsd : null);
        setPerformanceClass(els.summaryReturn, totalReturn);
    }

    function setPerformanceClass(element, value) {
        element.classList.remove("positive", "negative");
        if (!Number.isFinite(value)) return;
        element.classList.add(value >= 0 ? "positive" : "negative");
    }

    function getQuoteDisplay(metrics) {
        const quote = metrics.quote;
        if (!quote) return { value: "Not loaded", meta: "", state: "idle" };
        if (quote.status === "loading" && !Number.isFinite(quote.price)) {
            return { value: "Fetching…", meta: "Contacting price service", state: "loading" };
        }
        if (Number.isFinite(quote.price)) {
            const isStale = Date.now() - Date.parse(quote.asOf || 0) > CLIENT_QUOTE_TTL_MS;
            return {
                value: formatMoney(quote.price * getRate()),
                meta: quote.status === "loading"
                    ? "Refreshing…"
                    : `Updated ${formatRelativeTime(quote.asOf)}`,
                state: isStale ? "stale" : "ready"
            };
        }
        return { value: "Unavailable", meta: "Try refreshing prices", state: "error" };
    }

    function renderPositions() {
        els.positionsCountBadge.textContent = String(positions.length);
        if (!positions.length) {
            els.positionsList.innerHTML = `
                <div class="portfolio-empty-state">
                    <span class="portfolio-empty-icon" aria-hidden="true">＋</span>
                    <h3>No positions yet</h3>
                    <p>Use the guided form to add your first investment.</p>
                </div>`;
            return;
        }

        const wrapper = document.createElement("div");
        wrapper.className = "portfolio-table-scroll";
        const table = document.createElement("table");
        table.className = "portfolio-table";
        table.innerHTML = `
            <thead>
                <tr>
                    <th scope="col">Position</th>
                    <th scope="col">Size</th>
                    <th scope="col">Entry</th>
                    <th scope="col">Latest price</th>
                    <th scope="col">Leverage</th>
                    <th scope="col">Gross exposure</th>
                    <th scope="col">Return</th>
                    <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
            </thead>`;
        const body = document.createElement("tbody");
        const rate = getRate();

        positions.forEach((position) => {
            const metrics = computePositionMetrics(position);
            const quoteDisplay = getQuoteDisplay(metrics);
            const row = document.createElement("tr");
            if (editingPositionId === position.id) row.classList.add("is-editing");
            row.innerHTML = `
                <td data-label="Position">
                    <div class="portfolio-position-identity">
                        <span class="portfolio-ticker-mark" aria-hidden="true">${escapeHtml(position.ticker.slice(0, 1))}</span>
                        <span><strong>${escapeHtml(position.ticker)}</strong><span class="portfolio-side-badge ${position.side === "sell" ? "short" : "long"}">${position.side === "sell" ? "Short" : "Long"}</span></span>
                    </div>
                </td>
                <td data-label="Size">
                    <strong>${position.sizingMode === "shares"
                        ? `${formatNumber(position.sizeValue)} shares exposure`
                        : formatMoney(position.sizeValue * rate)}</strong>
                    <small>${position.sizingMode === "shares"
                        ? `${formatNumber(metrics.fundedShares)} shares purchased`
                        : "Cash amount"}</small>
                </td>
                <td data-label="Entry"><strong>${formatMoney(metrics.entryPriceUsd * rate)}</strong><small>Per share</small></td>
                <td data-label="Latest price" class="portfolio-quote-cell ${quoteDisplay.state}"><strong>${quoteDisplay.value}</strong><small>${quoteDisplay.meta}</small></td>
                <td data-label="Leverage"><strong>${formatNumber(position.leverage, 2)}×</strong></td>
                <td data-label="Gross exposure"><strong>${formatMoney(metrics.grossExposureUsd * rate)}</strong><small>Entry value × leverage</small></td>
                <td data-label="Return" class="${Number.isFinite(metrics.pnlUsd) ? (metrics.pnlUsd >= 0 ? "positive" : "negative") : ""}">
                    <strong>${Number.isFinite(metrics.pnlUsd) ? formatMoney(metrics.pnlUsd * rate) : "—"}</strong>
                    <small>${formatPct(metrics.pnlPct)}</small>
                </td>
                <td class="portfolio-row-action"><button type="button" class="portfolio-edit-button" aria-label="Edit ${escapeHtml(position.ticker)} position">Edit</button></td>`;
            row.querySelector(".portfolio-edit-button").addEventListener("click", () => startEditing(position.id));
            body.appendChild(row);
        });

        table.appendChild(body);
        wrapper.appendChild(table);
        els.positionsList.replaceChildren(wrapper);
    }

    function renderPriceStatus() {
        if (!positions.length) {
            els.pricesUpdatedStatus.textContent = "Add a position to start tracking prices.";
            els.refreshPricesBtn.disabled = true;
            return;
        }
        els.refreshPricesBtn.disabled = false;
        const positionTickers = [...new Set(positions.map((position) => position.ticker))];
        const states = positionTickers.map((ticker) => getQuote(ticker));
        const loadingCount = states.filter((quote) => quote?.status === "loading").length;
        const errorCount = states.filter((quote) => quote?.status === "error" && !Number.isFinite(quote.price)).length;
        const timestamps = states
            .map((quote) => Date.parse(quote?.asOf || ""))
            .filter(Number.isFinite);

        if (loadingCount) {
            els.pricesUpdatedStatus.textContent = `Updating ${loadingCount} price${loadingCount === 1 ? "" : "s"}…`;
        } else if (timestamps.length) {
            const newest = new Date(Math.max(...timestamps)).toISOString();
            els.pricesUpdatedStatus.textContent = `Prices updated ${formatRelativeTime(newest)}${errorCount ? ` · ${errorCount} unavailable` : ""}`;
        } else if (errorCount) {
            els.pricesUpdatedStatus.textContent = "Prices are currently unavailable. Try again.";
        } else {
            els.pricesUpdatedStatus.textContent = "Prices are ready to load.";
        }
    }

    function renderSaveStatus() {
        if (portfolioDirty) {
            els.saveStatus.textContent = "Unsaved changes";
            els.saveStatus.classList.add("is-dirty");
        } else {
            els.saveStatus.textContent = "All changes saved";
            els.saveStatus.classList.remove("is-dirty");
        }
    }

    function renderAll() {
        renderSummary();
        renderPositions();
        renderPriceStatus();
        renderSaveStatus();
        updateDraftPriceStatus();
        updatePositionPreview();
    }

    function updateFormLabels() {
        const isShares = els.sizingModeSelect.value === "shares";
        els.sizeLabel.textContent = isShares ? "Shares of market exposure" : "Cash amount";
        els.sizeSuffix.textContent = isShares ? "shares" : selectedCurrency;
        els.entryCurrencyPrefix.textContent = selectedCurrency;
        updatePositionPreview();
    }

    function updatePositionPreview() {
        const size = toNum(els.sizeInput.value);
        const entryPrice = toNum(els.entryPriceInput.value);
        const leverage = toNum(els.leverageInput.value) || 1;
        const isShares = els.sizingModeSelect.value === "shares";
        let fundedShares = null;
        let capitalRequired = null;
        let grossExposure = null;

        if (Number.isFinite(size) && size > 0 && Number.isFinite(entryPrice) && entryPrice > 0) {
            if (isShares) {
                fundedShares = size / leverage;
                capitalRequired = fundedShares * entryPrice;
                grossExposure = size * entryPrice;
            } else {
                capitalRequired = size;
                grossExposure = size * leverage;
                fundedShares = size / entryPrice;
            }
        }

        els.previewSharesLabel.textContent = "Shares purchased";
        els.previewEntryValueLabel.textContent = "Capital required";
        els.previewShares.textContent = Number.isFinite(fundedShares) ? formatNumber(fundedShares) : "—";
        els.previewEntryValue.textContent = Number.isFinite(capitalRequired) ? formatMoney(capitalRequired) : "—";
        els.previewExposure.textContent = Number.isFinite(grossExposure)
            ? formatMoney(grossExposure)
            : "—";
        els.advancedSummaryValue.textContent = `${formatNumber(leverage, 2)}× leverage`;
    }

    function updateDraftPriceStatus() {
        const ticker = getDraftTicker();
        if (!ticker) {
            els.tickerPriceStatus.textContent = "Latest price will appear here.";
            els.tickerPriceStatus.className = "portfolio-price-status";
            return;
        }
        const quote = getQuote(ticker);
        if (!quote) {
            els.tickerPriceStatus.textContent = "Choose the ticker to load its latest price.";
            els.tickerPriceStatus.className = "portfolio-price-status";
            return;
        }
        if (quote.status === "loading") {
            els.tickerPriceStatus.textContent = "Fetching latest price…";
            els.tickerPriceStatus.className = "portfolio-price-status loading";
            return;
        }
        if (Number.isFinite(quote.price)) {
            els.tickerPriceStatus.textContent = `Latest: ${formatMoney(quote.price * getRate())} · ${formatRelativeTime(quote.asOf)}`;
            els.tickerPriceStatus.className = "portfolio-price-status ready";
            return;
        }
        els.tickerPriceStatus.textContent = "Price unavailable. You can enter the price manually.";
        els.tickerPriceStatus.className = "portfolio-price-status error";
    }

    function autofillEntryPrice(ticker) {
        const quote = getQuote(ticker);
        if (entryPriceDirty || !Number.isFinite(quote?.price)) return;
        els.entryPriceInput.value = (quote.price * getRate()).toFixed(4);
        updatePositionPreview();
    }

    async function requestQuotes(tickers, { force = false } = {}) {
        const normalized = [...new Set(tickers.map(normalizeTicker).filter(Boolean))];
        if (!normalized.length) return;

        const now = Date.now();
        const waitingPromises = new Set();
        const needed = [];

        normalized.forEach((ticker) => {
            const running = inFlightQuotes.get(ticker);
            if (running) {
                waitingPromises.add(running);
                return;
            }
            const quote = getQuote(ticker);
            const fresh = Number.isFinite(quote?.price)
                && now - Date.parse(quote.asOf || 0) < CLIENT_QUOTE_TTL_MS;
            if (!force && fresh) return;
            needed.push(ticker);
            quotes.set(ticker, {
                price: quote?.price ?? null,
                asOf: quote?.asOf ?? null,
                status: "loading"
            });
        });

        if (!needed.length) {
            if (waitingPromises.size) await Promise.allSettled([...waitingPromises]);
            return;
        }

        renderAll();
        const requestPromise = (async () => {
            try {
                const response = await guardedApiCall("/portfolio/current-prices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tickers: needed })
                });
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.message || "Failed to refresh prices.");
                }
                const responseTickers = Array.isArray(data.tickers) ? data.tickers : [];
                const prices = Array.isArray(data.prices) ? data.prices : [];
                const timestamps = Array.isArray(data.quoteTimestamps) ? data.quoteTimestamps : [];
                const returned = new Set();

                responseTickers.forEach((tickerValue, index) => {
                    const ticker = normalizeTicker(tickerValue);
                    const price = toNum(prices[index]);
                    returned.add(ticker);
                    quotes.set(ticker, {
                        price,
                        asOf: timestamps[index] || data.requestedAt || new Date().toISOString(),
                        status: Number.isFinite(price) ? "ready" : "error"
                    });
                });
                needed.filter((ticker) => !returned.has(ticker)).forEach((ticker) => {
                    quotes.set(ticker, { price: null, asOf: null, status: "error" });
                });
                persistFrontendQuoteCache();
                needed.forEach(autofillEntryPrice);
            } catch (error) {
                needed.forEach((ticker) => {
                    const previous = getQuote(ticker);
                    quotes.set(ticker, {
                        price: previous?.price ?? null,
                        asOf: previous?.asOf ?? null,
                        status: "error"
                    });
                });
                throw error;
            } finally {
                needed.forEach((ticker) => {
                    if (inFlightQuotes.get(ticker) === requestPromise) {
                        inFlightQuotes.delete(ticker);
                    }
                });
                renderAll();
            }
        })();

        needed.forEach((ticker) => inFlightQuotes.set(ticker, requestPromise));
        waitingPromises.add(requestPromise);
        await Promise.all([...waitingPromises]);
    }

    async function loadDraftQuote(ticker, showError = false) {
        const normalized = normalizeTicker(ticker);
        if (!validateTickerInput(normalized)) {
            if (showError) showToast("Choose a valid ticker from the list.", true, 3000, els.toastContainer);
            return;
        }
        try {
            await requestQuotes([normalized]);
            autofillEntryPrice(normalized);
        } catch (error) {
            if (showError) showToast(error.message, true, 3500, els.toastContainer);
        }
    }

    function buildPositionFromForm() {
        const ticker = getDraftTicker();
        const side = getSelectedSide();
        const sizingMode = els.sizingModeSelect.value;
        const enteredSize = toNum(els.sizeInput.value);
        const entryDisplay = toNum(els.entryPriceInput.value);
        const leverage = toNum(els.leverageInput.value);
        const rate = getRate();

        if (!validateTickerInput(ticker)) throw new Error("Choose a valid ticker from the list.");
        if (!["buy", "sell"].includes(side)) throw new Error("Choose long or short.");
        if (!["shares", "notional"].includes(sizingMode)) throw new Error("Choose a size type.");
        if (!Number.isFinite(enteredSize) || enteredSize <= 0) throw new Error("Enter a size greater than 0.");
        if (!Number.isFinite(entryDisplay) || entryDisplay <= 0) throw new Error("Enter an entry price greater than 0.");
        if (!Number.isFinite(leverage) || leverage <= 0) throw new Error("Leverage must be greater than 0.");

        const existing = positions.find((position) => position.id === editingPositionId);
        return {
            id: existing?.id || `${ticker}-${Date.now()}`,
            ticker,
            side,
            sizingMode,
            sizeValue: sizingMode === "notional" ? enteredSize / rate : enteredSize,
            entryPriceUsd: entryDisplay / rate,
            leverage,
            currency: selectedCurrency,
            createdAt: existing?.createdAt || new Date().toISOString()
        };
    }

    function markDirty(message = "") {
        portfolioDirty = true;
        renderSaveStatus();
        if (message) els.liveStatus.textContent = message;
    }

    function handlePositionSubmit(event) {
        event.preventDefault();
        try {
            const position = buildPositionFromForm();
            const index = positions.findIndex((item) => item.id === editingPositionId);
            const wasEditing = index >= 0;
            if (wasEditing) {
                positions[index] = position;
            } else {
                positions.push(position);
            }
            markDirty(wasEditing ? "Position updated." : "Position added.");
            resetForm();
            renderAll();
            showToast(wasEditing ? "Position updated." : "Position added.", false, 2500, els.toastContainer);
            void requestQuotes([position.ticker]).catch((error) => {
                showToast(error.message, true, 3500, els.toastContainer);
            });
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        }
    }

    function resetForm() {
        editingPositionId = null;
        entryPriceDirty = false;
        els.form.reset();
        els.leverageInput.value = "1";
        els.advancedOptions.open = false;
        els.formTitle.textContent = "Add a position";
        els.formDescription.textContent = "Tell us what you own and where you entered.";
        els.addPositionBtn.textContent = "Add position";
        els.cancelEditBtn.classList.add("hidden");
        updateFormLabels();
        updateDraftPriceStatus();
    }

    function startEditing(positionId) {
        const position = positions.find((item) => item.id === positionId);
        if (!position) return;
        editingPositionId = position.id;
        entryPriceDirty = true;
        els.tickerInput.value = position.ticker;
        const sideRadio = els.form.querySelector(`input[name="positionSide"][value="${position.side}"]`);
        if (sideRadio) sideRadio.checked = true;
        els.sizingModeSelect.value = position.sizingMode;
        els.sizeInput.value = position.sizingMode === "notional"
            ? (position.sizeValue * getRate()).toFixed(2)
            : position.sizeValue;
        els.entryPriceInput.value = (position.entryPriceUsd * getRate()).toFixed(4);
        els.leverageInput.value = position.leverage;
        els.advancedOptions.open = Number(position.leverage) !== 1;
        els.formTitle.textContent = `Edit ${position.ticker}`;
        els.formDescription.textContent = "Update the position details, then save your changes.";
        els.addPositionBtn.textContent = "Save position";
        els.cancelEditBtn.classList.remove("hidden");
        updateFormLabels();
        renderPositions();
        els.formTitle.scrollIntoView({ behavior: "smooth", block: "start" });
        els.tickerInput.focus({ preventScroll: true });
    }

    function requestDelete(positionId) {
        const position = positions.find((item) => item.id === positionId);
        if (!position) return;
        editingPositionId = positionId;
        els.deleteDialogTitle.textContent = `Delete ${position.ticker}?`;
        if (typeof els.deleteDialog.showModal === "function") {
            els.deleteDialog.showModal();
        } else if (window.confirm(`Delete ${position.ticker} from this portfolio?`)) {
            deleteEditingPosition();
        }
    }

    function deleteEditingPosition() {
        const position = positions.find((item) => item.id === editingPositionId);
        if (!position) return;
        positions = positions.filter((item) => item.id !== editingPositionId);
        resetForm();
        markDirty(`${position.ticker} removed.`);
        renderAll();
        showToast(`${position.ticker} removed. Save changes to keep this update.`, false, 3000, els.toastContainer);
    }

    async function savePortfolio() {
        setButtonState(els.savePortfolioBtn, "Saving…", true);
        els.saveStatus.textContent = "Saving…";
        try {
            const response = await guardedApiCall("/portfolio/save", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    positions,
                    baseCurrency: selectedCurrency
                })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Failed to save portfolio.");
            portfolioDirty = false;
            renderSaveStatus();
            showToast("Portfolio saved.", false, 2500, els.toastContainer);
        } catch (error) {
            renderSaveStatus();
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.savePortfolioBtn, "Save changes", false);
        }
    }

    function sanitizeLoadedPositions(rawPositions) {
        return (Array.isArray(rawPositions) ? rawPositions : [])
            .filter((position) => position && position.ticker && position.side && position.sizingMode)
            .map((position, index) => ({
                ...position,
                id: String(position.id || `loaded-${index}-${Date.now()}`),
                ticker: normalizeTicker(position.ticker),
                leverage: toNum(position.leverage) || 1
            }));
    }

    function waitForRetry(delayMs) {
        return new Promise((resolve) => window.setTimeout(resolve, delayMs));
    }

    async function fetchPortfolioData() {
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const response = await guardedApiCall(
                    "/portfolio/load",
                    {},
                    PORTFOLIO_LOAD_TIMEOUT_MS
                );
                const data = await response.json();
                if (response.ok) return data;

                const error = new Error(data.message || "Failed to load portfolio.");
                if (response.status < 500 || attempt === 1) throw error;
                lastError = error;
            } catch (error) {
                if (/session expired|authentication|log in/i.test(error.message)) throw error;
                if (attempt === 1) throw error;
                lastError = error;
            }
            els.saveStatus.textContent = "Waking up portfolio service…";
            await waitForRetry(900);
        }
        throw lastError || new Error("Failed to load portfolio.");
    }

    async function loadPortfolio({ initial = false } = {}) {
        if (!initial && portfolioDirty && !window.confirm("Reload the saved portfolio and discard your unsaved changes?")) {
            return;
        }
        setButtonState(els.loadPortfolioBtn, "Loading…", true);
        els.saveStatus.textContent = "Loading portfolio…";
        try {
            const data = await fetchPortfolioData();

            positions = sanitizeLoadedPositions(data.positions);
            selectedCurrency = normalizeTicker(data.baseCurrency) || "USD";
            updateCurrencyOptions();
            portfolioDirty = false;
            resetForm();
            renderAll();
            if (!initial) showToast("Saved portfolio reloaded.", false, 2500, els.toastContainer);

            const tickers = positions.map((position) => position.ticker);
            if (tickers.length) {
                void requestQuotes(tickers).catch((error) => {
                    showToast(error.message, true, 3500, els.toastContainer);
                });
            }
        } catch (error) {
            els.saveStatus.textContent = "Portfolio could not be loaded";
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.loadPortfolioBtn, "Reload saved", false);
        }
    }

    async function refreshAllPrices() {
        const tickers = positions.map((position) => position.ticker);
        if (!tickers.length) return;
        setButtonState(els.refreshPricesBtn, "Refreshing…", true);
        try {
            await requestQuotes(tickers, { force: true });
            const failed = [...new Set(tickers)].filter((ticker) => !Number.isFinite(getQuote(ticker)?.price));
            showToast(
                failed.length ? `${failed.length} price${failed.length === 1 ? "" : "s"} unavailable.` : "Prices updated.",
                Boolean(failed.length),
                3000,
                els.toastContainer
            );
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.refreshPricesBtn, "↻ Refresh prices", false);
            renderPriceStatus();
        }
    }

    function bindEvents() {
        const debouncedSuggestions = debounce((query) => {
            showTickerSuggestions(query, els.autocomplete);
        }, 200);
        const debouncedPriceLookup = debounce((ticker) => {
            void loadDraftQuote(ticker);
        }, 450);

        els.tickerInput.addEventListener("input", (event) => {
            const value = String(event.target.value || "");
            entryPriceDirty = false;
            els.entryPriceInput.value = "";
            hideTickerSuggestions(els.autocomplete);
            debouncedSuggestions(value.trim());
            const ticker = normalizeTicker(value);
            updateDraftPriceStatus();
            updatePositionPreview();
            if (validateTickerInput(ticker)) debouncedPriceLookup(ticker);
        });
        els.tickerInput.addEventListener("focus", () => {
            const value = els.tickerInput.value.trim();
            if (value.length >= 2) showTickerSuggestions(value, els.autocomplete);
        });
        els.tickerInput.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            void loadDraftQuote(getDraftTicker(), true);
        });
        els.autocomplete.addEventListener("click", (event) => {
            const suggestion = event.target.closest(".ticker-suggestion");
            if (!suggestion) return;
            els.tickerInput.value = suggestion.dataset.symbol;
            entryPriceDirty = false;
            els.entryPriceInput.value = "";
            hideTickerSuggestions(els.autocomplete);
            void loadDraftQuote(suggestion.dataset.symbol, true);
        });
        document.addEventListener("click", (event) => {
            if (!event.target.closest(".portfolio-search-wrapper")) {
                hideTickerSuggestions(els.autocomplete);
            }
        });

        els.entryPriceInput.addEventListener("input", () => {
            entryPriceDirty = true;
            updatePositionPreview();
        });
        els.sizeInput.addEventListener("input", updatePositionPreview);
        els.leverageInput.addEventListener("input", updatePositionPreview);
        els.sizingModeSelect.addEventListener("change", updateFormLabels);
        els.form.querySelectorAll('input[name="positionSide"]').forEach((radio) => {
            radio.addEventListener("change", updatePositionPreview);
        });

        els.currencySelect.addEventListener("change", () => {
            const oldRate = getRate(selectedCurrency);
            const currentEntry = toNum(els.entryPriceInput.value);
            const currentSize = toNum(els.sizeInput.value);
            selectedCurrency = normalizeTicker(els.currencySelect.value) || "USD";
            const newRate = getRate(selectedCurrency);
            if (Number.isFinite(currentEntry)) {
                els.entryPriceInput.value = ((currentEntry / oldRate) * newRate).toFixed(4);
            }
            if (els.sizingModeSelect.value === "notional" && Number.isFinite(currentSize)) {
                els.sizeInput.value = ((currentSize / oldRate) * newRate).toFixed(2);
            }
            markDirty("Display currency changed.");
            updateCurrencyOptions();
            renderAll();
        });

        els.form.addEventListener("submit", handlePositionSubmit);
        els.cancelEditBtn.addEventListener("click", resetForm);
        els.savePortfolioBtn.addEventListener("click", savePortfolio);
        els.loadPortfolioBtn.addEventListener("click", () => loadPortfolio());
        els.refreshPricesBtn.addEventListener("click", refreshAllPrices);
        els.refreshRatesBtn.addEventListener("click", () => loadConversionRates(false));
        els.deleteDialog.addEventListener("close", () => {
            if (els.deleteDialog.returnValue === "confirm") deleteEditingPosition();
        });
        els.form.addEventListener("dblclick", (event) => {
            if (editingPositionId && event.target === els.formTitle) requestDelete(editingPositionId);
        });

        window.addEventListener("beforeunload", (event) => {
            if (!portfolioDirty) return;
            event.preventDefault();
            event.returnValue = "";
        });
    }

    function addEditDeleteControl() {
        const actions = document.createElement("div");
        actions.className = "portfolio-edit-actions hidden";
        actions.id = "portfolioEditActions";
        actions.innerHTML = '<button type="button" class="portfolio-text-button portfolio-delete-text">Delete this position</button>';
        els.form.querySelector(".portfolio-form-actions").prepend(actions);
        actions.querySelector("button").addEventListener("click", () => requestDelete(editingPositionId));

        const observer = new MutationObserver(() => {
            actions.classList.toggle("hidden", !editingPositionId);
        });
        observer.observe(els.cancelEditBtn, { attributes: true, attributeFilter: ["class"] });
    }

    function initialize() {
        bindEvents();
        addEditDeleteControl();
        hydrateFrontendQuoteCache();
        updateCurrencyOptions();
        renderAll();

        observeAuthState((user) => {
            if (!user) {
                els.saveStatus.textContent = "Sign in required";
                return;
            }
            if (initializedUserId === user.uid) return;
            initializedUserId = user.uid;

            void fetchTickers(async (endpoint) => guardedApiCall(endpoint))
                .then((result) => {
                    hasTickerDataset = Array.isArray(result) && result.length > 0;
                });
            void loadConversionRates(true);
            void loadPortfolio({ initial: true });
        });
    }

    initialize();
});
