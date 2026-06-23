import { apiCall, setButtonState } from "./api.js";
import { showToast } from "./toast.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import { debounce, fetchTickers, isValidTicker, showTickerSuggestions } from "./ticker.js";

window.addEventListener("DOMContentLoaded", () => {
    const els = {
        tickerInput: document.getElementById("portfolioTickerInput"),
        autocomplete: document.getElementById("portfolioTickerAutocomplete"),
        sideSelect: document.getElementById("positionSideSelect"),
        sizingModeSelect: document.getElementById("sizingModeSelect"),
        sizeInput: document.getElementById("positionSizeInput"),
        entryPriceInput: document.getElementById("entryPriceInput"),
        leverageInput: document.getElementById("leverageInput"),
        addPositionBtn: document.getElementById("addPositionBtn"),
        savePortfolioBtn: document.getElementById("savePortfolioBtn"),
        loadPortfolioBtn: document.getElementById("loadPortfolioBtn"),
        refreshPricesBtn: document.getElementById("refreshPricesBtn"),
        currencySelect: document.getElementById("portfolioCurrencySelect"),
        refreshRatesBtn: document.getElementById("refreshRatesBtn"),
        positionsList: document.getElementById("positionsList"),
        positionDetails: document.getElementById("positionDetails"),
        deletePositionBtn: document.getElementById("deletePositionBtn"),
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

    let hasTickerDataset = false;
    let positions = [];
    let selectedPositionId = null;
    let ratesBaseUsd = { USD: 1 };
    let selectedCurrency = "USD";
    let currentPricesUsd = {};
    let lastPricesFetchAt = 0;
    const PRICE_REFRESH_MIN_INTERVAL_MS = 4000;

    function toNum(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function formatMoney(value, currency = selectedCurrency) {
        if (!Number.isFinite(value)) return "-";
        return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
    }

    function formatPct(value) {
        if (!Number.isFinite(value)) return "-";
        return `${value.toFixed(2)}%`;
    }

    function getRate(currency) {
        const rate = ratesBaseUsd[currency];
        return Number.isFinite(rate) && rate > 0 ? rate : 1;
    }

    function getSelectedRate() {
        return getRate(selectedCurrency);
    }

    async function guardedApiCall(endpoint, options = {}) {
        try {
            return await apiCall(endpoint, options, apiDeps);
        } catch (error) {
            throw new Error(String(error?.message || error));
        }
    }

    function updateCurrencyOptions() {
        const allCurrencies = Object.keys(ratesBaseUsd || {}).sort();
        if (!allCurrencies.length) {
            ratesBaseUsd = { USD: 1 };
            allCurrencies.push("USD");
        }

        els.currencySelect.innerHTML = "";
        allCurrencies.forEach((currency) => {
            const option = document.createElement("option");
            option.value = currency;
            option.textContent = currency;
            if (currency === selectedCurrency) option.selected = true;
            els.currencySelect.appendChild(option);
        });
    }

    async function loadConversionRates() {
        setButtonState(els.refreshRatesBtn, "Loading...", true);
        try {
            const response = await guardedApiCall("/portfolio/conversion-rates?base=USD");
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || "Failed to load conversion rates.");
            }
            const rates = data.rates || {};
            rates.USD = 1;
            ratesBaseUsd = rates;
            if (!ratesBaseUsd[selectedCurrency]) {
                selectedCurrency = "USD";
            }
            updateCurrencyOptions();
            renderPositions();
            renderSelectedPositionDetails();
            maybeAutofillEntryFromTicker(false);
            showToast("Currency rates updated.", false, 2500, els.toastContainer);
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.refreshRatesBtn, "Recalculate", false);
        }
    }

    function computePositionReturns(position) {
        const currentPriceUsd = currentPricesUsd[position.ticker];
        if (!Number.isFinite(currentPriceUsd)) {
            return {
                entryDisplay: formatMoney(position.entryPriceUsd * getSelectedRate()),
                currentDisplay: "Loading...",
                pnlCash: null,
                pnlPct: null,
                exposureUsd: null
            };
        }

        const entryPriceUsd = position.entryPriceUsd;
        const priceDeltaPerShare = position.side === "sell"
            ? (entryPriceUsd - currentPriceUsd)
            : (currentPriceUsd - entryPriceUsd);

        let exposureUsd;
        let sharesEquivalent;
        if (position.sizingMode === "shares") {
            sharesEquivalent = position.sizeValue;
            exposureUsd = entryPriceUsd * position.sizeValue;
        } else {
            exposureUsd = position.sizeValue;
            sharesEquivalent = entryPriceUsd > 0 ? (position.sizeValue / entryPriceUsd) : 0;
        }

        const pnlUsd = priceDeltaPerShare * sharesEquivalent * position.leverage;
        const pnlPct = exposureUsd > 0 ? (pnlUsd / exposureUsd) * 100 : null;
        const currencyRate = getSelectedRate();

        return {
            entryDisplay: formatMoney(entryPriceUsd * currencyRate),
            currentDisplay: formatMoney(currentPriceUsd * currencyRate),
            pnlCash: pnlUsd * currencyRate,
            pnlPct,
            exposureUsd
        };
    }

    function renderPositions() {
        if (!positions.length) {
            els.positionsList.innerHTML = "<p class=\"muted\">No positions yet.</p>";
            return;
        }

        const list = document.createElement("div");
        list.className = "portfolio-list";

        positions.forEach((position) => {
            const metrics = computePositionReturns(position);
            const item = document.createElement("button");
            item.type = "button";
            item.className = `portfolio-position-item ${position.id === selectedPositionId ? "active" : ""}`;
            item.dataset.id = position.id;

            const cashClass = Number.isFinite(metrics.pnlCash)
                ? (metrics.pnlCash >= 0 ? "positive" : "negative")
                : "";

            item.innerHTML = `
                <span class="portfolio-item-main">${position.ticker} · ${position.side.toUpperCase()}</span>
                <span class="portfolio-item-sub">${position.sizingMode === "shares" ? `${position.sizeValue} sh` : `${formatMoney(position.sizeValue, "USD")} notional`}</span>
                <span class="portfolio-item-return ${cashClass}">
                    ${Number.isFinite(metrics.pnlCash) ? formatMoney(metrics.pnlCash) : "Loading..."} · ${formatPct(metrics.pnlPct)}
                </span>
            `;
            list.appendChild(item);
        });

        els.positionsList.innerHTML = "";
        els.positionsList.appendChild(list);
    }

    function renderSelectedPositionDetails() {
        const position = positions.find((p) => p.id === selectedPositionId);
        if (!position) {
            els.positionDetails.innerHTML = "<p class=\"muted\">Select a position to view details.</p>";
            els.deletePositionBtn.classList.add("hidden");
            return;
        }

        const metrics = computePositionReturns(position);
        const detailsRows = [
            ["Ticker", position.ticker],
            ["Side", position.side.toUpperCase()],
            ["Sizing Mode", position.sizingMode === "shares" ? "Shares" : "Notional"],
            ["Size", position.sizingMode === "shares" ? `${position.sizeValue}` : formatMoney(position.sizeValue, "USD")],
            ["Leverage", `${position.leverage}x`],
            ["Entry Price", metrics.entryDisplay],
            ["Current Price", metrics.currentDisplay],
            ["Return (Cash)", Number.isFinite(metrics.pnlCash) ? formatMoney(metrics.pnlCash) : "Loading..."],
            ["Return (%)", formatPct(metrics.pnlPct)]
        ];

        const wrapper = document.createElement("div");
        wrapper.className = "portfolio-detail-grid";
        detailsRows.forEach(([label, value]) => {
            const row = document.createElement("div");
            row.className = "portfolio-detail-row";
            row.innerHTML = `<span>${label}</span><strong>${value}</strong>`;
            wrapper.appendChild(row);
        });

        els.positionDetails.innerHTML = "";
        els.positionDetails.appendChild(wrapper);
        els.deletePositionBtn.classList.remove("hidden");
    }

    async function refreshCurrentPrices(force = false) {
        const now = Date.now();
        if (!force && now - lastPricesFetchAt < PRICE_REFRESH_MIN_INTERVAL_MS) {
            return;
        }
        lastPricesFetchAt = now;

        const uniqueTickers = [...new Set(positions.map((p) => p.ticker).filter(Boolean))];
        if (!uniqueTickers.length) return;

        setButtonState(els.refreshPricesBtn, "Refreshing...", true);
        try {
            const response = await guardedApiCall("/portfolio/current-prices", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tickers: uniqueTickers })
            });
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || "Failed to refresh prices.");
            }

            const tickers = Array.isArray(data.tickers) ? data.tickers : [];
            const prices = Array.isArray(data.prices) ? data.prices : [];
            for (let i = 0; i < tickers.length; i += 1) {
                const t = tickers[i];
                const p = toNum(prices[i]);
                if (t) currentPricesUsd[t] = p;
            }

            maybeAutofillEntryFromTicker(false);
            renderPositions();
            renderSelectedPositionDetails();
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.refreshPricesBtn, "Refresh Prices", false);
        }
    }

    function getTickerForEntry() {
        return String(els.tickerInput.value || "").trim().toUpperCase();
    }

    function maybeAutofillEntryFromTicker(onlyIfEmpty = true) {
        const ticker = getTickerForEntry();
        if (!ticker) return;
        if (onlyIfEmpty && String(els.entryPriceInput.value || "").trim()) return;
        const currentUsd = currentPricesUsd[ticker];
        if (!Number.isFinite(currentUsd)) return;
        const selectedRate = getSelectedRate();
        els.entryPriceInput.value = (currentUsd * selectedRate).toFixed(4);
    }

    function validateTickerInput(ticker) {
        if (!ticker) return false;
        if (!hasTickerDataset) return true;
        return isValidTicker(ticker);
    }

    function createPositionFromForm() {
        const ticker = getTickerForEntry();
        const side = String(els.sideSelect.value || "").toLowerCase();
        const sizingMode = String(els.sizingModeSelect.value || "").toLowerCase();
        const sizeValue = toNum(els.sizeInput.value);
        const leverage = toNum(els.leverageInput.value);
        const entryInSelectedCurrency = toNum(els.entryPriceInput.value);
        const selectedRate = getSelectedRate();

        if (!validateTickerInput(ticker)) {
            throw new Error("Please select a valid ticker from the list.");
        }
        if (!["buy", "sell"].includes(side)) {
            throw new Error("Invalid side.");
        }
        if (!["shares", "notional"].includes(sizingMode)) {
            throw new Error("Invalid sizing mode.");
        }
        if (!Number.isFinite(sizeValue) || sizeValue <= 0) {
            throw new Error("Size must be greater than 0.");
        }
        if (!Number.isFinite(leverage) || leverage <= 0) {
            throw new Error("Leverage must be greater than 0.");
        }
        if (!Number.isFinite(entryInSelectedCurrency) || entryInSelectedCurrency <= 0) {
            throw new Error("Entry price must be greater than 0.");
        }

        return {
            id: `${ticker}-${Date.now()}`,
            ticker,
            side,
            sizingMode,
            sizeValue,
            entryPriceUsd: entryInSelectedCurrency / selectedRate,
            leverage,
            currency: selectedCurrency,
            createdAt: new Date().toISOString()
        };
    }

    function clearPositionFormAfterAdd() {
        els.sizeInput.value = "";
        els.leverageInput.value = "1";
    }

    async function addPosition() {
        try {
            const position = createPositionFromForm();
            positions.push(position);
            selectedPositionId = position.id;
            await refreshCurrentPrices(true);
            renderPositions();
            renderSelectedPositionDetails();
            clearPositionFormAfterAdd();
            showToast("Position added.", false, 2500, els.toastContainer);
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        }
    }

    async function savePortfolio() {
        setButtonState(els.savePortfolioBtn, "Saving...", true);
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
            if (!response.ok) {
                throw new Error(data.message || "Failed to save portfolio.");
            }
            showToast("Portfolio saved.", false, 2500, els.toastContainer);
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.savePortfolioBtn, "Save Portfolio", false);
        }
    }

    async function loadPortfolio() {
        setButtonState(els.loadPortfolioBtn, "Loading...", true);
        try {
            const response = await guardedApiCall("/portfolio/load");
            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || "Failed to load portfolio.");
            }

            const loadedPositions = Array.isArray(data.positions) ? data.positions : [];
            positions = loadedPositions.filter((p) => p && p.ticker && p.side && p.sizingMode);
            selectedCurrency = String(data.baseCurrency || "USD").toUpperCase();
            if (!ratesBaseUsd[selectedCurrency]) selectedCurrency = "USD";
            updateCurrencyOptions();

            selectedPositionId = positions.length ? positions[0].id : null;
            await refreshCurrentPrices(true);
            renderPositions();
            renderSelectedPositionDetails();
            showToast("Portfolio loaded.", false, 2500, els.toastContainer);
        } catch (error) {
            showToast(error.message, true, 3500, els.toastContainer);
        } finally {
            setButtonState(els.loadPortfolioBtn, "Load Portfolio", false);
        }
    }

    function deleteSelectedPosition() {
        if (!selectedPositionId) return;
        positions = positions.filter((p) => p.id !== selectedPositionId);
        selectedPositionId = positions.length ? positions[0].id : null;
        renderPositions();
        renderSelectedPositionDetails();
    }

    function bindEvents() {
        const debouncedSuggestions = debounce((query) => {
            showTickerSuggestions(query, els.autocomplete);
        }, 200);

        els.tickerInput.addEventListener("input", (e) => {
            debouncedSuggestions(String(e.target.value || "").trim());
            maybeAutofillEntryFromTicker(true);
        });
        els.tickerInput.addEventListener("focus", () => {
            const value = String(els.tickerInput.value || "").trim();
            if (value.length >= 2) showTickerSuggestions(value, els.autocomplete);
        });
        els.tickerInput.addEventListener("keydown", async (event) => {
            if (event.key !== "Enter") return;
            const ticker = getTickerForEntry();
            if (!validateTickerInput(ticker)) {
                showToast("Please select a valid ticker.", true, 3000, els.toastContainer);
                return;
            }
            await refreshCurrentPrices(true);
            maybeAutofillEntryFromTicker(false);
        });
        els.autocomplete.addEventListener("click", async (event) => {
            const suggestion = event.target.closest(".ticker-suggestion");
            if (!suggestion) return;
            els.tickerInput.value = suggestion.dataset.symbol;
            els.autocomplete.classList.add("hidden");
            await refreshCurrentPrices(true);
            maybeAutofillEntryFromTicker(false);
        });
        document.addEventListener("click", (event) => {
            if (!event.target.closest(".portfolio-search-wrapper")) {
                els.autocomplete.classList.add("hidden");
            }
        });

        els.currencySelect.addEventListener("change", () => {
            selectedCurrency = String(els.currencySelect.value || "USD").toUpperCase();
            maybeAutofillEntryFromTicker(false);
            renderPositions();
            renderSelectedPositionDetails();
        });
        els.sizingModeSelect.addEventListener("change", () => {
            const mode = String(els.sizingModeSelect.value || "shares");
            els.sizeInput.placeholder = mode === "shares" ? "Shares" : `Notional (${selectedCurrency})`;
        });

        els.addPositionBtn.addEventListener("click", addPosition);
        els.savePortfolioBtn.addEventListener("click", savePortfolio);
        els.loadPortfolioBtn.addEventListener("click", loadPortfolio);
        els.refreshPricesBtn.addEventListener("click", () => refreshCurrentPrices(true));
        els.refreshRatesBtn.addEventListener("click", loadConversionRates);
        els.deletePositionBtn.addEventListener("click", deleteSelectedPosition);

        els.positionsList.addEventListener("click", (event) => {
            const row = event.target.closest(".portfolio-position-item");
            if (!row) return;
            selectedPositionId = row.dataset.id;
            renderPositions();
            renderSelectedPositionDetails();
        });
    }

    async function initialize() {
        bindEvents();
        updateCurrencyOptions();
        renderPositions();
        renderSelectedPositionDetails();
        await loadConversionRates();

        observeAuthState(async (user) => {
            if (!user) return;
            const tickerResult = await fetchTickers(async (endpoint) => {
                const response = await guardedApiCall(endpoint);
                return response;
            });
            hasTickerDataset = Array.isArray(tickerResult) && tickerResult.length > 0;
            await loadPortfolio();
        });
    }

    initialize();
});
