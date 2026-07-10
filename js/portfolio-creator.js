import { apiCall } from "./api.js";
import { CACHE_TTL, createUserDataStore } from "./data-store.js";
import { showToast } from "./toast.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import { runAuthGuard } from "./auth-guard.js";
import { renderSidebar } from "./sidebar.js";
import {
    debounce,
    fetchTickers,
    getLogoUrl,
    hideTickerSuggestions,
    isValidTicker,
    onLogoLoad,
    showTickerSuggestions,
} from "./ticker.js";

runAuthGuard();
renderSidebar();

window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const els = {
        picker: $("portfolioPicker"), pickerSummary: $("portfolioPickerSummary"),
        portfolioOptions: $("portfolioOptions"), createPortfolioForm: $("createPortfolioForm"),
        newPortfolioName: $("newPortfolioName"), createPortfolioBtn: $("createPortfolioBtn"),
        portfolioMenuError: $("portfolioMenuError"), syncStatus: $("portfolioSaveStatus"),
        syncRetry: $("portfolioSyncRetryBtn"), currency: $("portfolioCurrencySelect"),
        refreshRates: $("refreshRatesBtn"), refreshPrices: $("refreshPricesBtn"),
        summaryCount: $("summaryPositionCount"), summaryExposure: $("summaryExposure"),
        summaryPnl: $("summaryPnl"), summaryReturn: $("summaryReturn"),
        ticket: $("positionTicket"), form: $("positionForm"), formEyebrow: $("positionFormEyebrow"),
        formTitle: $("positionFormTitle"), formDescription: $("positionFormDescription"),
        ticker: $("portfolioTickerInput"), autocomplete: $("portfolioTickerAutocomplete"),
        tickerStatus: $("tickerPriceStatus"), tickerError: $("tickerError"),
        sizing: $("sizingModeSelect"), size: $("positionSizeInput"),
        sizeLabel: $("positionSizeLabel"), sizeSuffix: $("positionSizeSuffix"),
        sizeError: $("positionSizeError"), entry: $("entryPriceInput"),
        entryPrefix: $("entryCurrencyPrefix"), entryError: $("entryPriceError"),
        leverage: $("leverageInput"), leverageError: $("leverageError"),
        previewSharesLabel: $("previewSharesLabel"), previewShares: $("previewShares"),
        previewEntryLabel: $("previewEntryValueLabel"), previewEntry: $("previewEntryValue"),
        previewExposure: $("previewExposure"), previewLeverage: $("previewLeverage"),
        submit: $("addPositionBtn"), submitLabel: $("positionSubmitLabel"),
        cancelEdit: $("cancelEditBtn"), deletePositionBtn: $("deletePositionBtn"),
        filter: $("positionsFilter"), newPosition: $("newPositionBtn"),
        positions: $("positionsList"), positionsEyebrow: $("positionsEyebrow"),
        breakdown: $("positionBreakdown"), priceStatus: $("pricesUpdatedStatus"),
        sectorAllocation: $("sectorAllocation"), riskLargest: $("riskLargestWeight"),
        riskLeverage: $("riskGrossLeverage"), riskWinners: $("riskWinners"),
        riskWorst: $("riskWorstReturn"), concentration: $("concentrationSignal"),
        live: $("portfolioLiveStatus"), toast: $("toast-container"),
        deleteDialog: $("deletePositionDialog"), deleteDialogTitle: $("deleteDialogTitle"),
        watchlistBtn: $("portfolioWatchlistBtn"), watchlistDialog: $("portfolioWatchlistDialog"),
        watchlistForm: $("portfolioWatchlistForm"), watchlistSummary: $("portfolioWatchlistSummary"),
        watchlistName: $("portfolioWatchlistName"), watchlistSelect: $("portfolioWatchlistSelect"),
        watchlistNewField: $("portfolioWatchlistNewField"),
        watchlistExistingField: $("portfolioWatchlistExistingField"),
        watchlistError: $("portfolioWatchlistError"),
        watchlistCancel: $("cancelPortfolioWatchlistBtn"), watchlistSave: $("savePortfolioWatchlistBtn"),
        renameDialog: $("renamePortfolioDialog"), renameForm: $("renamePortfolioForm"),
        renameInput: $("renamePortfolioInput"), renameError: $("renamePortfolioError"),
        renameCancel: $("cancelRenamePortfolioBtn"), renameSave: $("saveRenamePortfolioBtn"),
        portfolioDeleteDialog: $("deletePortfolioDialog"),
        portfolioDeleteTitle: $("deletePortfolioTitle"),
        portfolioDeleteDescription: $("deletePortfolioDescription"),
    };

    const apiDeps = {
        auth,
        handleLogout: async () => {
            try { await logoutUser(); } finally { location.replace("login.html"); }
        },
    };
    const QUOTE_TTL = 60000;
    const QUOTE_KEY = "dcf_portfolio_quote_cache_v2";
    let portfolios = [];
    let activePortfolioId = null;
    let activePortfolioName = "Core portfolio";
    let positions = [];
    let rates = { USD: 1 };
    let currency = "USD";
    let metadata = new Map();
    let tickerReady = false;
    let loadState = "loading";
    let filterSide = "all";
    let editingId = null;
    let deletingId = null;
    let managingPortfolioId = null;
    let entryDirty = false;
    let autoSave = false;
    let revision = 0;
    let savedRevision = 0;
    let saveTimer = null;
    let savePromise = null;
    let saveFailed = false;
    let activeSuggestion = -1;
    let logoRefreshNonce = Date.now();
    let initializedUid = null;
    let dataStore = null;
    let availableWatchlists = [];
    const quotes = new Map();
    const inFlight = new Map();

    const num = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
    const ticker = (value) => String(value || "").trim().toUpperCase();
    const number = (value, digits = 4) => Number.isFinite(value)
        ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(value)
        : "—";
    const money = (value, code = currency) => Number.isFinite(value)
        ? new Intl.NumberFormat("en-US", {
            style: "currency", currency: code, minimumFractionDigits: 2, maximumFractionDigits: 2,
        }).format(value)
        : "—";
    const pct = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
    const rate = () => Number.isFinite(rates[currency]) && rates[currency] > 0 ? rates[currency] : 1;
    const validTicker = (value) => value && (
        tickerReady ? isValidTicker(value) : /^[A-Z0-9.-]{1,15}$/.test(value)
    );
    const escapeHtml = (value) => String(value ?? "")
        .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    const quote = (value) => quotes.get(ticker(value));

    function relative(iso) {
        const time = Date.parse(iso || "");
        if (!Number.isFinite(time)) return "";
        const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
        if (seconds < 10) return "just now";
        if (seconds < 60) return `${seconds}s ago`;
        const minutes = Math.round(seconds / 60);
        return minutes < 60
            ? `${minutes}m ago`
            : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(time);
    }

    async function request(endpoint, options = {}, timeout = 30000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            return await apiCall(endpoint, { ...options, signal: controller.signal }, apiDeps);
        } catch (error) {
            throw new Error(error?.name === "AbortError"
                ? "The service took too long to respond. Please try again."
                : String(error?.message || error));
        } finally {
            clearTimeout(timer);
        }
    }

    function setBusy(button, busy, label) {
        if (!button) return;
        if (busy) {
            button.dataset.idleLabel ||= button.textContent;
            button.textContent = label;
            button.disabled = true;
        } else {
            button.textContent = button.dataset.idleLabel || button.textContent;
            button.disabled = false;
            delete button.dataset.idleLabel;
        }
    }

    function setMenuError(message = "") {
        els.portfolioMenuError.textContent = message;
        els.portfolioMenuError.classList.toggle("hidden", !message);
    }

    function hydrateQuoteCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(QUOTE_KEY) || "{}");
            const now = Date.now();
            Object.entries(cached).forEach(([symbol, item]) => {
                const price = num(item?.price);
                const at = Date.parse(item?.asOf || "");
                if (Number.isFinite(price) && Number.isFinite(at) && now - at < QUOTE_TTL) {
                    quotes.set(ticker(symbol), { price, asOf: item.asOf, status: "ready" });
                }
            });
        } catch (error) {
            console.warn("Unable to read portfolio quote cache", error);
        }
    }

    function persistQuoteCache() {
        try {
            const cache = {};
            const now = Date.now();
            quotes.forEach((item, symbol) => {
                const at = Date.parse(item?.asOf || "");
                if (Number.isFinite(item?.price) && Number.isFinite(at) && now - at < QUOTE_TTL) {
                    cache[symbol] = { price: item.price, asOf: item.asOf };
                }
            });
            localStorage.setItem(QUOTE_KEY, JSON.stringify(cache));
        } catch (error) {
            console.warn("Unable to write portfolio quote cache", error);
        }
    }

    function createLogo(symbol, name) {
        const shell = document.createElement("span");
        shell.className = "pt-asset-mark";
        shell.textContent = symbol.slice(0, 2);
        const image = document.createElement("img");
        image.alt = `${name || symbol} logo`;
        image.referrerPolicy = "strict-origin-when-cross-origin";
        let fallbackTried = false;
        image.onload = async () => {
            const cached = await onLogoLoad(image, symbol);
            if (cached?.startsWith("data:") && image.src !== cached) image.src = cached;
        };
        image.onerror = () => {
            if (!fallbackTried) {
                fallbackTried = true;
                image.src = `https://img.logo.dev/${symbol.toLowerCase()}.com?token=pk_RQ-JlIhmQEOm6yeZvHsSKA`;
                return;
            }
            image.remove();
        };
        image.src = `https://img.logo.dev/ticker/${encodeURIComponent(symbol)}?token=pk_RQ-JlIhmQEOm6yeZvHsSKA&refresh=${logoRefreshNonce}`;
        shell.appendChild(image);
        return shell;
    }

    function metrics(position) {
        const entry = num(position.entryPriceUsd);
        const size = num(position.sizeValue);
        const leverage = num(position.leverage) || 1;
        const currentQuote = quote(position.ticker);
        const marketShares = position.sizingMode === "shares"
            ? size
            : entry > 0 ? size / entry * leverage : 0;
        const fundedShares = leverage > 0 ? marketShares / leverage : 0;
        const base = position.sizingMode === "shares" ? entry * fundedShares : size;
        const entryExposure = position.sizingMode === "shares" ? entry * marketShares : base * leverage;
        const mark = Number.isFinite(currentQuote?.price) ? currentQuote.price : entry;
        const currentExposure = Number.isFinite(mark) ? Math.abs(mark * marketShares) : entryExposure;
        let pnl = null;
        let returnPct = null;
        if (Number.isFinite(currentQuote?.price)) {
            const delta = position.side === "sell" ? entry - currentQuote.price : currentQuote.price - entry;
            pnl = delta * marketShares;
            returnPct = base > 0 ? pnl / base * 100 : null;
        }
        return {
            entry, marketShares, fundedShares, base, entryExposure,
            currentExposure, pnl, returnPct, quote: currentQuote,
        };
    }

    function performance(element, value) {
        element.classList.remove("positive", "negative");
        if (Number.isFinite(value)) element.classList.add(value >= 0 ? "positive" : "negative");
    }

    function analytics() {
        let exposure = 0;
        let configuredExposure = 0;
        let funded = 0;
        let pnl = 0;
        let pricedCapital = 0;
        let priced = 0;
        let winners = 0;
        let worst = null;
        let largest = 0;
        const sectors = new Map();
        positions.forEach((position) => {
            const item = metrics(position);
            exposure += item.currentExposure || 0;
            configuredExposure += item.entryExposure || 0;
            funded += item.base || 0;
            largest = Math.max(largest, item.currentExposure || 0);
            if (Number.isFinite(item.pnl)) {
                pnl += item.pnl;
                pricedCapital += item.base || 0;
                priced += 1;
                if (item.pnl >= 0) winners += 1;
                if (Number.isFinite(item.returnPct)) worst = worst === null
                    ? item.returnPct : Math.min(worst, item.returnPct);
            }
            const sector = metadata.get(position.ticker)?.sector || "Unknown";
            sectors.set(sector, (sectors.get(sector) || 0) + (item.currentExposure || 0));
        });
        return {
            exposure, configuredExposure, funded, pnl, pricedCapital, priced, winners, worst, largest,
            returnPct: pricedCapital > 0 ? pnl / pricedCapital * 100 : null,
            grossLeverage: funded > 0 ? configuredExposure / funded : null,
            sectors: [...sectors.entries()].sort((a, b) => b[1] - a[1]),
        };
    }

    function renderSummary() {
        const data = analytics();
        els.summaryCount.textContent = positions.length;
        els.summaryExposure.textContent = positions.length ? money(data.exposure * rate()) : "—";
        els.summaryPnl.textContent = data.priced ? money(data.pnl * rate()) : "—";
        els.summaryReturn.textContent = data.priced ? pct(data.returnPct) : "—";
        performance(els.summaryPnl, data.priced ? data.pnl : null);
        performance(els.summaryReturn, data.returnPct);
    }

    function renderAnalytics() {
        const data = analytics();
        els.sectorAllocation.replaceChildren();
        if (!positions.length || data.exposure <= 0) {
            const copy = document.createElement("p");
            copy.className = "pt-muted-copy";
            copy.textContent = "Add positions to see sector allocation.";
            els.sectorAllocation.appendChild(copy);
        } else {
            data.sectors.forEach(([sector, value]) => {
                const share = value / data.exposure * 100;
                const row = document.createElement("div");
                row.className = "pt-allocation-row";
                const label = document.createElement("span");
                label.className = "pt-allocation-label";
                const name = document.createElement("span");
                name.textContent = sector;
                const percent = document.createElement("b");
                percent.textContent = `${share.toFixed(1)}%`;
                label.append(name, percent);
                const bar = document.createElement("span");
                bar.className = "pt-allocation-bar";
                const fill = document.createElement("span");
                fill.style.width = `${Math.min(100, share)}%`;
                bar.appendChild(fill);
                row.append(label, bar);
                els.sectorAllocation.appendChild(row);
            });
        }

        els.riskLargest.textContent = data.exposure > 0 ? `${(data.largest / data.exposure * 100).toFixed(1)}%` : "—";
        els.riskLeverage.textContent = Number.isFinite(data.grossLeverage) ? `${data.grossLeverage.toFixed(2)}×` : "—";
        els.riskWinners.textContent = data.priced ? `${data.winners} / ${data.priced}` : "—";
        els.riskWorst.textContent = Number.isFinite(data.worst) ? pct(data.worst) : "—";
        performance(els.riskWorst, data.worst);

        const top = data.sectors[0];
        const topShare = top && data.exposure > 0 ? top[1] / data.exposure * 100 : 0;
        els.concentration.classList.toggle("is-balanced", Boolean(positions.length) && topShare < 40);
        if (!positions.length) {
            els.concentration.innerHTML = "<strong>Waiting for positions</strong><p>Allocation signals appear after positions are added.</p>";
        } else if (topShare >= 40) {
            els.concentration.innerHTML = `<strong>High ${escapeHtml(top[0])} exposure</strong><p>${topShare.toFixed(1)}% of gross exposure is allocated to this sector.</p>`;
        } else {
            els.concentration.innerHTML = `<strong>Balanced sector mix</strong><p>No sector exceeds 40% of gross exposure.</p>`;
        }
    }

    function quoteDisplay(item) {
        if (!item.quote) return ["Not loaded", "Waiting for refresh", "idle"];
        if (item.quote.status === "loading" && !Number.isFinite(item.quote.price)) {
            return ["Fetching…", "Contacting price service", "loading"];
        }
        if (Number.isFinite(item.quote.price)) {
            const stale = Date.now() - Date.parse(item.quote.asOf || 0) > QUOTE_TTL;
            return [
                money(item.quote.price * rate()),
                item.quote.status === "loading" ? "Refreshing…" : `Updated ${relative(item.quote.asOf)}`,
                stale ? "stale" : "ready",
            ];
        }
        return ["Unavailable", "Try refreshing", "error"];
    }

    function stateMarkup(type, title, copy, action = "") {
        const icon = type === "loading" ? '<span class="pt-spinner"></span>' : type === "error" ? "!" : "+";
        return `<div class="pt-state" role="status"><span class="pt-state-mark" aria-hidden="true">${icon}</span><h3>${title}</h3><p>${copy}</p>${action}</div>`;
    }

    function renderPositions() {
        els.positions.setAttribute("aria-busy", String(loadState === "loading"));
        els.positionsEyebrow.textContent = `${positions.length} open position${positions.length === 1 ? "" : "s"}`;
        const longs = positions.filter((item) => item.side !== "sell").length;
        const shorts = positions.length - longs;
        els.breakdown.textContent = `${longs} long · ${shorts} short`;
        if (loadState === "loading") {
            els.positions.innerHTML = stateMarkup("loading", "Loading your portfolio", "This can take a moment while the service wakes up.");
            return;
        }
        if (loadState === "error") {
            els.positions.innerHTML = stateMarkup("error", "Portfolio unavailable", "Your saved data was not changed.", '<button class="pt-square-control" data-action="retry-load">Try again</button>');
            return;
        }
        if (!positions.length) {
            els.positions.innerHTML = stateMarkup("empty", "Start your portfolio", "Add your first investment to track exposure and performance.", '<button class="pt-dark-button" data-action="focus-ticket">Add first position</button>');
            return;
        }
        const visible = filterSide === "all" ? positions : positions.filter((item) => item.side === filterSide);
        if (!visible.length) {
            els.positions.innerHTML = stateMarkup("empty", "No matching positions", "Choose another filter to see your holdings.", '<button class="pt-square-control" data-action="clear-filter">Show all positions</button>');
            return;
        }

        const wrap = document.createElement("div");
        wrap.className = "pt-table-wrap";
        const table = document.createElement("table");
        table.className = "pt-table";
        table.innerHTML = '<caption class="sr-only">Current portfolio holdings and performance</caption><thead><tr><th>Instrument</th><th>Side</th><th>Quantity</th><th>Entry</th><th>Last</th><th>Market value</th><th>P&amp;L</th><th>Return</th><th>Status</th><th><span class="sr-only">Actions</span></th></tr></thead>';
        const body = document.createElement("tbody");
        visible.forEach((position) => {
            const item = metrics(position);
            const [last, lastMeta, quoteState] = quoteDisplay(item);
            const meta = metadata.get(position.ticker) || {};
            const row = document.createElement("tr");
            row.dataset.id = position.id;
            if (editingId === position.id) row.classList.add("is-editing");
            const statusLabel = quoteState === "ready" ? "Live" : quoteState === "stale" ? "Stale" : quoteState === "loading" ? "Loading" : quoteState === "error" ? "Unavailable" : "Pending";
            const statusClass = quoteState === "ready" ? "positive" : quoteState === "error" ? "negative" : "amber";
            row.innerHTML = `
                <td data-label="Instrument"><span class="pt-asset"><span class="pt-row-logo"></span><span><strong>${escapeHtml(position.ticker)}</strong><small>${escapeHtml(meta.name || "Listed instrument")} · ${escapeHtml(meta.exchange || "Exchange")}</small></span></span></td>
                <td data-label="Side"><span class="pt-side-tag ${position.side === "sell" ? "short" : "long"}">${position.side === "sell" ? "▼ Short" : "▲ Long"}</span></td>
                <td data-label="Quantity">${number(item.marketShares)}</td>
                <td data-label="Entry">${money(item.entry * rate())}</td>
                <td data-label="Last" title="${escapeHtml(lastMeta)}">${last}</td>
                <td data-label="Market value"><strong>${money(item.currentExposure * rate())}</strong></td>
                <td data-label="P&amp;L" class="${Number.isFinite(item.pnl) ? (item.pnl >= 0 ? "positive" : "negative") : ""}">${Number.isFinite(item.pnl) ? money(item.pnl * rate()) : "—"}</td>
                <td data-label="Return" class="${Number.isFinite(item.returnPct) ? (item.returnPct >= 0 ? "positive" : "negative") : ""}">${pct(item.returnPct)}</td>
                <td data-label="Status"><span class="pt-status-tag ${statusClass}">${statusLabel}</span></td>
                <td data-label="Actions"><details class="pt-row-menu"><summary aria-label="Actions for ${escapeHtml(position.ticker)}">•••</summary><div class="pt-row-menu-popover"><button type="button" data-action="edit">Edit</button><button type="button" data-action="delete">Delete</button></div></details></td>`;
            row.querySelector(".pt-row-logo").replaceWith(createLogo(position.ticker, meta.name));
            body.appendChild(row);
        });
        table.appendChild(body);
        wrap.appendChild(table);
        els.positions.replaceChildren(wrap);
    }

    function renderPriceStatus() {
        if (loadState !== "ready") return;
        if (!positions.length) {
            els.priceStatus.textContent = "Add a position to begin tracking prices.";
            els.refreshPrices.disabled = true;
            return;
        }
        els.refreshPrices.disabled = false;
        const uniqueQuotes = [...new Set(positions.map((item) => item.ticker))].map(quote);
        const loading = uniqueQuotes.filter((item) => item?.status === "loading").length;
        const failed = uniqueQuotes.filter((item) => item?.status === "error" && !Number.isFinite(item.price)).length;
        const times = uniqueQuotes.map((item) => Date.parse(item?.asOf || "")).filter(Number.isFinite);
        els.priceStatus.textContent = loading
            ? `Updating ${loading} price${loading === 1 ? "" : "s"}…`
            : times.length
                ? `Prices updated ${relative(new Date(Math.max(...times)).toISOString())}${failed ? ` · ${failed} unavailable` : ""}`
                : failed ? "Prices unavailable. Try again." : "Prices are ready to load.";
    }

    function renderSync() {
        els.syncStatus.className = "pt-market-status";
        els.syncRetry.classList.add("hidden");
        if (loadState === "loading") {
            els.syncStatus.textContent = "Loading portfolio…";
            els.syncStatus.classList.add("is-loading");
        } else if (loadState === "error") {
            els.syncStatus.textContent = "Portfolio unavailable";
            els.syncStatus.classList.add("is-error");
            els.syncRetry.classList.remove("hidden");
        } else if (savePromise) {
            els.syncStatus.textContent = "Saving changes…";
            els.syncStatus.classList.add("is-loading");
        } else if (saveFailed) {
            els.syncStatus.textContent = "Changes not saved";
            els.syncStatus.classList.add("is-error");
            els.syncRetry.classList.remove("hidden");
        } else if (revision > savedRevision) {
            els.syncStatus.textContent = "Waiting to save…";
            els.syncStatus.classList.add("is-loading");
        } else {
            els.syncStatus.textContent = "Saved automatically";
        }
    }

    function renderPicker() {
        const active = portfolios.find((item) => item.id === activePortfolioId);
        els.pickerSummary.textContent = active
            ? `${active.name} · ${active.positionCount} position${active.positionCount === 1 ? "" : "s"}`
            : "Portfolio";
        els.portfolioOptions.replaceChildren();
        portfolios.forEach((portfolio) => {
            const row = document.createElement("div");
            row.className = `pt-portfolio-option${portfolio.id === activePortfolioId ? " is-active" : ""}`;
            row.dataset.id = portfolio.id;
            const select = document.createElement("button");
            select.className = "pt-portfolio-select";
            select.type = "button";
            select.dataset.portfolioAction = "switch";
            select.setAttribute("role", "option");
            select.setAttribute("aria-selected", String(portfolio.id === activePortfolioId));
            const name = document.createElement("span");
            name.textContent = portfolio.name;
            const count = document.createElement("small");
            count.textContent = `${portfolio.positionCount} position${portfolio.positionCount === 1 ? "" : "s"} · ${portfolio.baseCurrency || "USD"}`;
            select.append(name, count);
            const actions = document.createElement("span");
            actions.className = "pt-portfolio-actions";
            const rename = document.createElement("button");
            rename.type = "button";
            rename.dataset.portfolioAction = "rename";
            rename.setAttribute("aria-label", `Rename ${portfolio.name}`);
            rename.textContent = "✎";
            const remove = document.createElement("button");
            remove.type = "button";
            remove.dataset.portfolioAction = "delete";
            remove.setAttribute("aria-label", `Delete ${portfolio.name}`);
            remove.textContent = "⌫";
            remove.disabled = portfolios.length <= 1;
            actions.append(rename, remove);
            row.append(select, actions);
            els.portfolioOptions.appendChild(row);
        });
    }

    function render() {
        renderPicker();
        renderSummary();
        renderPositions();
        renderAnalytics();
        renderPriceStatus();
        renderSync();
        updateDraftStatus();
        updatePreview();
        els.watchlistBtn.disabled = loadState !== "ready" || positions.length === 0;
    }

    function updateActivePortfolioSummary() {
        const active = portfolios.find((item) => item.id === activePortfolioId);
        if (active) {
            active.positionCount = positions.length;
            active.baseCurrency = currency;
            active.name = activePortfolioName;
        }
    }

    function clearErrors() {
        [[els.ticker, els.tickerError], [els.size, els.sizeError], [els.entry, els.entryError], [els.leverage, els.leverageError]]
            .forEach(([input, output]) => {
                input.removeAttribute("aria-invalid");
                output.textContent = "";
                output.classList.add("hidden");
            });
    }

    function fieldError(input, output, message) {
        input.setAttribute("aria-invalid", "true");
        output.textContent = message;
        output.classList.remove("hidden");
        return input;
    }

    function buildPosition() {
        clearErrors();
        const symbol = ticker(els.ticker.value);
        const size = num(els.size.value);
        const entryDisplay = num(els.entry.value);
        const leverage = num(els.leverage.value);
        const mode = els.sizing.value;
        const invalid = [];
        if (!validTicker(symbol)) invalid.push(fieldError(els.ticker, els.tickerError, "Choose a valid company from the results."));
        if (!Number.isFinite(size) || size <= 0) invalid.push(fieldError(els.size, els.sizeError, "Enter a size greater than zero."));
        if (!Number.isFinite(entryDisplay) || entryDisplay <= 0) invalid.push(fieldError(els.entry, els.entryError, "Enter an entry price greater than zero."));
        if (!Number.isFinite(leverage) || leverage <= 0) invalid.push(fieldError(els.leverage, els.leverageError, "Leverage must be greater than zero."));
        if (invalid.length) {
            invalid[0].focus();
            throw new Error("Check the highlighted fields.");
        }
        const existing = positions.find((item) => item.id === editingId);
        return {
            id: existing?.id || `${symbol}-${Date.now()}`,
            ticker: symbol,
            side: els.form.querySelector('[name="positionSide"]:checked')?.value || "buy",
            sizingMode: mode,
            sizeValue: mode === "notional" ? size / rate() : size,
            entryPriceUsd: entryDisplay / rate(),
            leverage,
            currency,
            createdAt: existing?.createdAt || new Date().toISOString(),
        };
    }

    function updateLabels() {
        const shares = els.sizing.value === "shares";
        els.sizeLabel.textContent = shares ? "Position size" : "Cash amount";
        els.sizeSuffix.textContent = shares ? "shares" : currency;
        els.entryPrefix.textContent = currency;
        updatePreview();
    }

    function updatePreview() {
        const size = num(els.size.value);
        const entry = num(els.entry.value);
        const leverage = num(els.leverage.value) || 1;
        const sharesMode = els.sizing.value === "shares";
        let fundedShares = null;
        let capital = null;
        let exposure = null;
        if (size > 0 && entry > 0) {
            if (sharesMode) {
                fundedShares = size / leverage;
                capital = fundedShares * entry;
                exposure = size * entry;
            } else {
                capital = size;
                exposure = size * leverage;
                fundedShares = size / entry;
            }
        }
        els.previewShares.textContent = number(fundedShares);
        els.previewEntry.textContent = money(capital);
        els.previewExposure.textContent = money(exposure);
        els.previewLeverage.textContent = `${number(leverage, 2)}× leverage`;
    }

    function updateDraftStatus() {
        const symbol = ticker(els.ticker.value);
        const currentQuote = quote(symbol);
        const meta = metadata.get(symbol);
        if (!symbol) {
            els.tickerStatus.textContent = "Select a result to load its latest price.";
            els.tickerStatus.className = "pt-field-note";
        } else if (!currentQuote) {
            els.tickerStatus.textContent = meta
                ? `${meta.name || symbol} · ${meta.exchange || "Listed"}`
                : "Select this ticker to load its latest price.";
            els.tickerStatus.className = "pt-field-note";
        } else if (currentQuote.status === "loading") {
            els.tickerStatus.textContent = "Fetching latest price…";
            els.tickerStatus.className = "pt-field-note amber";
        } else if (Number.isFinite(currentQuote.price)) {
            els.tickerStatus.textContent = `${meta?.name || symbol} · Latest ${money(currentQuote.price * rate())} · ${relative(currentQuote.asOf)}`;
            els.tickerStatus.className = "pt-field-note positive";
        } else {
            els.tickerStatus.textContent = "Price unavailable. Enter it manually.";
            els.tickerStatus.className = "pt-field-note negative";
        }
    }

    function resetForm({ focus = false } = {}) {
        editingId = null;
        entryDirty = false;
        if (focus) logoRefreshNonce = Date.now();
        els.form.reset();
        els.leverage.value = "1";
        els.formEyebrow.textContent = "New position";
        els.formTitle.textContent = "Add position";
        els.formDescription.textContent = "Search an instrument, define the position, and review its exposure.";
        els.submitLabel.textContent = "Add position";
        els.cancelEdit.classList.add("hidden");
        els.deletePositionBtn.classList.add("hidden");
        clearErrors();
        updateLabels();
        updateDraftStatus();
        renderPositions();
        if (focus) {
            els.ticket.scrollIntoView({ behavior: "smooth", block: "start" });
            setTimeout(() => els.ticker.focus({ preventScroll: true }), 350);
        }
    }

    function editPosition(id) {
        const position = positions.find((item) => item.id === id);
        if (!position) return;
        editingId = id;
        entryDirty = true;
        els.ticker.value = position.ticker;
        const side = els.form.querySelector(`[name="positionSide"][value="${position.side}"]`);
        if (side) side.checked = true;
        els.sizing.value = position.sizingMode;
        els.size.value = position.sizingMode === "notional"
            ? (position.sizeValue * rate()).toFixed(2) : position.sizeValue;
        els.entry.value = (position.entryPriceUsd * rate()).toFixed(4);
        els.leverage.value = position.leverage;
        els.formEyebrow.textContent = "Editing position";
        els.formTitle.textContent = `Edit ${position.ticker}`;
        els.formDescription.textContent = "Update the details; changes save automatically after submission.";
        els.submitLabel.textContent = "Update position";
        els.cancelEdit.classList.remove("hidden");
        els.deletePositionBtn.classList.remove("hidden");
        updateLabels();
        renderPositions();
        els.ticket.scrollIntoView({ behavior: "smooth", block: "start" });
        setTimeout(() => els.ticker.focus({ preventScroll: true }), 350);
    }

    function askDeletePosition(id) {
        const position = positions.find((item) => item.id === id);
        if (!position) return;
        deletingId = id;
        els.deleteDialogTitle.textContent = `Delete ${position.ticker}?`;
        if (typeof els.deleteDialog.showModal === "function") els.deleteDialog.showModal();
        else if (confirm(`Delete ${position.ticker}?`)) deletePosition();
    }

    function deletePosition() {
        const position = positions.find((item) => item.id === deletingId);
        if (!position) return;
        positions = positions.filter((item) => item.id !== deletingId);
        deletingId = null;
        if (editingId === position.id) resetForm();
        changed(`${position.ticker} removed.`);
        render();
        showToast(`${position.ticker} removed.`, false, 2500, els.toast);
    }

    function changed(message = "") {
        revision += 1;
        saveFailed = false;
        updateActivePortfolioSummary();
        if (message) els.live.textContent = message;
        render();
        scheduleSave();
    }

    function scheduleSave(delay = 500) {
        if (!autoSave || !activePortfolioId) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(runSave, delay);
    }

    async function runSave() {
        if (!autoSave || !activePortfolioId) return false;
        if (savePromise) return savePromise;
        const targetRevision = revision;
        saveFailed = false;
        savePromise = (async () => {
            renderSync();
            try {
                const response = await request("/portfolio/save", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        portfolioId: activePortfolioId,
                        positions,
                        baseCurrency: currency,
                    }),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || "Failed to save portfolio.");
                savedRevision = Math.max(savedRevision, targetRevision);
                return true;
            } catch (error) {
                saveFailed = true;
                showToast(error.message, true, 3500, els.toast);
                return false;
            } finally {
                savePromise = null;
                renderSync();
                if (!saveFailed && revision > savedRevision) scheduleSave(0);
            }
        })();
        return savePromise;
    }

    async function flushSave() {
        clearTimeout(saveTimer);
        if (savePromise) {
            const result = await savePromise;
            if (!result) return false;
        }
        if (revision > savedRevision || saveFailed) return runSave();
        return true;
    }

    async function requestQuotes(symbols, { force = false } = {}) {
        const unique = [...new Set(symbols.map(ticker).filter(Boolean))];
        const now = Date.now();
        const needed = [];
        const waiting = new Set();
        unique.forEach((symbol) => {
            if (inFlight.has(symbol)) {
                waiting.add(inFlight.get(symbol));
                return;
            }
            const current = quote(symbol);
            const fresh = Number.isFinite(current?.price)
                && now - Date.parse(current.asOf || 0) < QUOTE_TTL;
            if (force || !fresh) {
                needed.push(symbol);
                quotes.set(symbol, {
                    price: current?.price ?? null,
                    asOf: current?.asOf ?? null,
                    status: "loading",
                });
            }
        });
        if (!needed.length) {
            if (waiting.size) await Promise.allSettled([...waiting]);
            return;
        }
        render();
        const promise = (async () => {
            try {
                const response = await request("/portfolio/current-prices", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tickers: needed }),
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.message || "Failed to refresh prices.");
                const returned = new Set();
                (data.tickers || []).forEach((raw, index) => {
                    const symbol = ticker(raw);
                    const price = num((data.prices || [])[index]);
                    returned.add(symbol);
                    quotes.set(symbol, {
                        price,
                        asOf: (data.quoteTimestamps || [])[index] || data.requestedAt || new Date().toISOString(),
                        status: Number.isFinite(price) ? "ready" : "error",
                    });
                });
                needed.filter((symbol) => !returned.has(symbol)).forEach((symbol) => {
                    quotes.set(symbol, { price: null, asOf: null, status: "error" });
                });
                persistQuoteCache();
                const draft = ticker(els.ticker.value);
                const draftQuote = quote(draft);
                if (!entryDirty && needed.includes(draft) && Number.isFinite(draftQuote?.price)) {
                    els.entry.value = (draftQuote.price * rate()).toFixed(4);
                }
            } catch (error) {
                needed.forEach((symbol) => {
                    const old = quote(symbol);
                    quotes.set(symbol, {
                        price: old?.price ?? null, asOf: old?.asOf ?? null, status: "error",
                    });
                });
                throw error;
            } finally {
                needed.forEach((symbol) => inFlight.delete(symbol));
                render();
            }
        })();
        needed.forEach((symbol) => inFlight.set(symbol, promise));
        waiting.add(promise);
        await Promise.all([...waiting]);
    }

    async function loadDraft(symbol, noisy = false) {
        if (!validTicker(symbol)) {
            if (noisy) showToast("Choose a valid ticker from the list.", true, 3000, els.toast);
            return;
        }
        try {
            await requestQuotes([symbol]);
            const currentQuote = quote(symbol);
            if (!entryDirty && ticker(els.ticker.value) === symbol && Number.isFinite(currentQuote?.price)) {
                els.entry.value = (currentQuote.price * rate()).toFixed(4);
                updatePreview();
            }
        } catch (error) {
            if (noisy) showToast(error.message, true, 3500, els.toast);
        }
    }

    function currencyName(code) {
        try {
            return new Intl.DisplayNames(["en"], { type: "currency" }).of(code) || code;
        } catch {
            return code;
        }
    }

    function updateCurrencyOptions() {
        const codes = [...new Set([...Object.keys(rates), "USD", currency])].sort();
        els.currency.replaceChildren(...codes.map((code) => Object.assign(document.createElement("option"), {
            value: code,
            textContent: `${code} · ${currencyName(code)}`,
            selected: code === currency,
        })));
        updateLabels();
    }

    async function loadRates(noisy = false) {
        setBusy(els.refreshRates, true, "Loading…");
        try {
            const response = await request("/portfolio/conversion-rates?base=USD");
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Failed to load exchange rates.");
            rates = { ...(data.rates || {}), USD: 1 };
            void dataStore?.set(dataStore.keys.fxRates("USD"), data, {
                ttlMs: CACHE_TTL.fxRates,
                serverUpdatedAt: data.date || data.fetchedAt || null,
                version: data.version || null,
            });
            if (!rates[currency]) currency = "USD";
            updateCurrencyOptions();
            render();
            if (noisy) showToast("Exchange rates updated.", false, 2500, els.toast);
        } catch (error) {
            if (noisy) showToast(error.message, true, 3500, els.toast);
        } finally {
            setBusy(els.refreshRates, false);
        }
    }

    async function loadPortfolio(portfolioId = null) {
        loadState = "loading";
        autoSave = false;
        positions = [];
        render();
        try {
            let response;
            let data;
            let lastError;
            const query = portfolioId ? `?portfolioId=${encodeURIComponent(portfolioId)}` : "";
            for (let attempt = 0; attempt < 2; attempt += 1) {
                try {
                    response = await request(`/portfolio/load${query}`, {}, 45000);
                    data = await response.json();
                    if (response.ok) break;
                    lastError = new Error(data.message || "Failed to load portfolio.");
                } catch (error) {
                    lastError = error;
                }
                if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 900));
            }
            if (!response?.ok) throw lastError || new Error("Failed to load portfolio.");
            activePortfolioId = data.portfolioId;
            activePortfolioName = data.name || "Core portfolio";
            positions = (Array.isArray(data.positions) ? data.positions : [])
                .filter((item) => item?.ticker && item?.side && item?.sizingMode)
                .map((item, index) => ({
                    ...item,
                    id: String(item.id || `loaded-${index}-${Date.now()}`),
                    ticker: ticker(item.ticker),
                    leverage: num(item.leverage) || 1,
                }));
            Object.entries(data.tickerMetadata || {}).forEach(([symbol, item]) => {
                metadata.set(ticker(symbol), { ...(metadata.get(ticker(symbol)) || {}), ...item });
            });
            currency = ticker(data.baseCurrency) || "USD";
            void dataStore?.set(dataStore.keys.portfolio(data.portfolioId), {
                ...data,
                positions,
                baseCurrency: currency,
            }, {
                ttlMs: CACHE_TTL.portfolioDetail,
                serverUpdatedAt: data.updatedAt || null,
                version: data.version || data.revision || null,
            });
            const active = portfolios.find((item) => item.id === activePortfolioId);
            if (active) {
                active.name = activePortfolioName;
                active.positionCount = positions.length;
                active.baseCurrency = currency;
            }
            revision = 0;
            savedRevision = 0;
            saveFailed = false;
            loadState = "ready";
            autoSave = true;
            updateCurrencyOptions();
            resetForm();
            render();
            if (positions.length) {
                requestQuotes(positions.map((item) => item.ticker))
                    .catch((error) => showToast(error.message, true, 3500, els.toast));
            }
            return true;
        } catch (error) {
            loadState = "error";
            saveFailed = false;
            render();
            showToast(error.message, true, 3500, els.toast);
            return false;
        }
    }

    async function loadPortfolioIndex() {
        try {
            const response = await request("/portfolios", {}, 45000);
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to load portfolios.");
            portfolios = Array.isArray(data.portfolios) ? data.portfolios : [];
            activePortfolioId = data.activePortfolioId || portfolios[0]?.id || null;
            void dataStore?.set(dataStore.keys.portfolioIndex(), {
                portfolios,
                activePortfolioId,
            }, {
                ttlMs: CACHE_TTL.portfolioIndex,
                serverUpdatedAt: data.updatedAt || null,
                version: data.version || null,
            });
            renderPicker();
            return loadPortfolio(activePortfolioId);
        } catch (error) {
            loadState = "error";
            render();
            showToast(error.message, true, 3500, els.toast);
            return false;
        }
    }

    async function switchPortfolio(portfolioId) {
        if (!portfolioId || portfolioId === activePortfolioId || loadState === "loading") {
            els.picker.open = false;
            return;
        }
        const saved = await flushSave();
        if (!saved) {
            setMenuError("Save the current portfolio before switching.");
            return;
        }
        setMenuError();
        try {
            const response = await request(`/portfolios/${encodeURIComponent(portfolioId)}/activate`, { method: "POST" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to switch portfolios.");
            els.picker.open = false;
            activePortfolioId = data.activePortfolioId || portfolioId;
            await loadPortfolio(activePortfolioId);
        } catch (error) {
            setMenuError(error.message);
        }
    }

    function openRenamePortfolio(portfolioId) {
        const portfolio = portfolios.find((item) => item.id === portfolioId);
        if (!portfolio) return;
        managingPortfolioId = portfolioId;
        els.renameInput.value = portfolio.name;
        els.renameError.textContent = "";
        els.renameError.classList.add("hidden");
        els.picker.open = false;
        els.renameDialog.showModal();
        els.renameInput.focus();
        els.renameInput.select();
    }

    function openDeletePortfolio(portfolioId) {
        const portfolio = portfolios.find((item) => item.id === portfolioId);
        if (!portfolio || portfolios.length <= 1) return;
        managingPortfolioId = portfolioId;
        els.portfolioDeleteTitle.textContent = `Delete ${portfolio.name}?`;
        els.portfolioDeleteDescription.textContent = `This permanently removes ${portfolio.positionCount} position${portfolio.positionCount === 1 ? "" : "s"} and cannot be undone.`;
        els.picker.open = false;
        els.portfolioDeleteDialog.showModal();
    }

    async function createPortfolio(event) {
        event.preventDefault();
        const name = els.newPortfolioName.value.trim().replace(/\s+/g, " ");
        if (!name) {
            setMenuError("Enter a portfolio name.");
            els.newPortfolioName.focus();
            return;
        }
        const saved = await flushSave();
        if (!saved) {
            setMenuError("Save the current portfolio before creating another.");
            return;
        }
        setMenuError();
        setBusy(els.createPortfolioBtn, true, "Adding…");
        try {
            const response = await request("/portfolios", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to create portfolio.");
            portfolios.push(data.portfolio);
            els.newPortfolioName.value = "";
            els.picker.open = false;
            activePortfolioId = data.activePortfolioId || data.portfolio.id;
            await loadPortfolio(activePortfolioId);
            showToast(`${data.portfolio.name} created.`, false, 2500, els.toast);
        } catch (error) {
            setMenuError(error.message);
        } finally {
            setBusy(els.createPortfolioBtn, false);
        }
    }

    async function renamePortfolio(event) {
        event.preventDefault();
        const name = els.renameInput.value.trim().replace(/\s+/g, " ");
        if (!name) {
            els.renameError.textContent = "Enter a portfolio name.";
            els.renameError.classList.remove("hidden");
            return;
        }
        setBusy(els.renameSave, true, "Saving…");
        try {
            const response = await request(`/portfolios/${encodeURIComponent(managingPortfolioId)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to rename portfolio.");
            const portfolio = portfolios.find((item) => item.id === managingPortfolioId);
            if (portfolio) Object.assign(portfolio, data);
            if (managingPortfolioId === activePortfolioId) activePortfolioName = data.name;
            els.renameDialog.close();
            renderPicker();
            showToast("Portfolio renamed.", false, 2500, els.toast);
        } catch (error) {
            els.renameError.textContent = error.message;
            els.renameError.classList.remove("hidden");
        } finally {
            setBusy(els.renameSave, false);
        }
    }

    async function deletePortfolio() {
        const portfolioId = managingPortfolioId;
        if (!portfolioId) return;
        const saved = portfolioId === activePortfolioId ? await flushSave() : true;
        if (!saved) {
            showToast("Save the portfolio before deleting it.", true, 3000, els.toast);
            return;
        }
        try {
            const response = await request(`/portfolios/${encodeURIComponent(portfolioId)}`, { method: "DELETE" });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to delete portfolio.");
            portfolios = portfolios.filter((item) => item.id !== portfolioId);
            managingPortfolioId = null;
            activePortfolioId = data.activePortfolioId;
            await loadPortfolio(activePortfolioId);
            showToast("Portfolio deleted.", false, 2500, els.toast);
        } catch (error) {
            showToast(error.message, true, 3500, els.toast);
        }
    }

    function uniquePortfolioTickers() {
        return [...new Set(positions.map((item) => ticker(item.ticker)).filter(Boolean))];
    }

    function renderWatchlistDestination() {
        const mode = els.watchlistForm.querySelector('[name="watchlistMode"]:checked')?.value || "new";
        const existing = mode === "existing";
        els.watchlistNewField.classList.toggle("hidden", existing);
        els.watchlistExistingField.classList.toggle("hidden", !existing);
        els.watchlistSave.textContent = existing ? "Add to watchlist" : "Create watchlist";
        els.watchlistSave.disabled = existing && !availableWatchlists.length;
    }

    async function openWatchlistDialog() {
        const symbols = uniquePortfolioTickers();
        if (!symbols.length) return;
        const duplicates = positions.length - symbols.length;
        els.watchlistSummary.textContent = `${positions.length} position${positions.length === 1 ? "" : "s"} → ${symbols.length} unique ticker${symbols.length === 1 ? "" : "s"}${duplicates ? ` · ${duplicates} duplicate${duplicates === 1 ? "" : "s"} removed` : ""}.`;
        els.watchlistError.textContent = "";
        els.watchlistError.classList.add("hidden");
        els.watchlistName.value = `${activePortfolioName} watch`.slice(0, 60);
        availableWatchlists = [];
        els.watchlistSelect.replaceChildren(Object.assign(document.createElement("option"), {
            textContent: "Loading watchlists…", value: "",
        }));
        renderWatchlistDestination();
        els.watchlistDialog.showModal();
        try {
            const response = await request("/watchlists");
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to load watchlists.");
            availableWatchlists = Array.isArray(data.watchlists) ? data.watchlists : [];
            void dataStore?.set(dataStore.keys.watchlists(), { watchlists: availableWatchlists }, {
                ttlMs: CACHE_TTL.watchlists,
                serverUpdatedAt: data.updatedAt || null,
                version: data.version || null,
            });
            els.watchlistSelect.replaceChildren(...availableWatchlists.map((watchlist) => Object.assign(document.createElement("option"), {
                value: watchlist.id,
                textContent: `${watchlist.name} (${watchlist.tickers.length})`,
            })));
            renderWatchlistDestination();
        } catch (error) {
            els.watchlistSelect.replaceChildren(Object.assign(document.createElement("option"), {
                textContent: "Watchlists unavailable", value: "",
            }));
            els.watchlistError.textContent = error.message;
            els.watchlistError.classList.remove("hidden");
            renderWatchlistDestination();
        }
    }

    async function savePortfolioWatchlist(event) {
        event.preventDefault();
        const symbols = uniquePortfolioTickers();
        const mode = els.watchlistForm.querySelector('[name="watchlistMode"]:checked')?.value || "new";
        if (!symbols.length) return;
        let endpoint = "/watchlists";
        let body;
        if (mode === "new") {
            const name = els.watchlistName.value.trim().replace(/\s+/g, " ");
            if (!name) {
                els.watchlistError.textContent = "Enter a watchlist name.";
                els.watchlistError.classList.remove("hidden");
                els.watchlistName.focus();
                return;
            }
            body = { name, tickers: symbols };
        } else {
            const watchlistId = els.watchlistSelect.value;
            if (!watchlistId) {
                els.watchlistError.textContent = "Choose an existing watchlist.";
                els.watchlistError.classList.remove("hidden");
                return;
            }
            endpoint = `/watchlists/${watchlistId}/tickers`;
            body = { tickers: symbols };
        }
        els.watchlistError.classList.add("hidden");
        setBusy(els.watchlistSave, true, mode === "new" ? "Creating…" : "Adding…");
        try {
            const response = await request(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to update watchlist.");
            els.watchlistDialog.close();
            const message = mode === "new"
                ? `${symbols.length} ticker${symbols.length === 1 ? "" : "s"} added to the new watchlist.`
                : `${data.addedCount} added · ${data.skippedCount} already present.`;
            showToast(message, false, 3500, els.toast);
            els.live.textContent = message;
        } catch (error) {
            els.watchlistError.textContent = error.message;
            els.watchlistError.classList.remove("hidden");
        } finally {
            setBusy(els.watchlistSave, false);
            renderWatchlistDestination();
        }
    }

    function setActiveSuggestion(index) {
        const items = [...els.autocomplete.querySelectorAll(".ticker-suggestion")];
        if (!items.length) return;
        activeSuggestion = (index + items.length) % items.length;
        items.forEach((item, itemIndex) => {
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(itemIndex === activeSuggestion));
            item.classList.toggle("is-active", itemIndex === activeSuggestion);
        });
        items[activeSuggestion].scrollIntoView({ block: "nearest" });
    }

    function chooseSuggestion(item) {
        if (!item) return;
        const symbol = ticker(item.dataset.symbol);
        els.ticker.value = symbol;
        entryDirty = false;
        els.entry.value = "";
        hideTickerSuggestions(els.autocomplete);
        els.ticker.setAttribute("aria-expanded", "false");
        activeSuggestion = -1;
        clearErrors();
        updateDraftStatus();
        loadDraft(symbol, true);
    }

    const suggest = debounce(async (query) => {
        await showTickerSuggestions(query, els.autocomplete, undefined, { variant: "terminal" });
        const open = !els.autocomplete.classList.contains("hidden");
        els.ticker.setAttribute("aria-expanded", String(open));
        activeSuggestion = -1;
        [...els.autocomplete.querySelectorAll(".ticker-suggestion")]
            .forEach((item) => item.setAttribute("role", "option"));
    }, 180);
    const priceLookup = debounce((symbol) => loadDraft(symbol), 450);

    els.ticker.addEventListener("input", (event) => {
        entryDirty = false;
        els.entry.value = "";
        hideTickerSuggestions(els.autocomplete);
        suggest(event.target.value.trim());
        const symbol = ticker(event.target.value);
        updateDraftStatus();
        updatePreview();
        if (validTicker(symbol)) priceLookup(symbol);
    });
    els.ticker.addEventListener("focus", () => {
        if (els.ticker.value.trim().length >= 2) suggest(els.ticker.value.trim());
    });
    els.ticker.addEventListener("keydown", (event) => {
        const items = [...els.autocomplete.querySelectorAll(".ticker-suggestion")];
        const open = !els.autocomplete.classList.contains("hidden");
        if (event.key === "ArrowDown" && open) {
            event.preventDefault();
            setActiveSuggestion(activeSuggestion + 1);
        } else if (event.key === "ArrowUp" && open) {
            event.preventDefault();
            setActiveSuggestion(activeSuggestion - 1);
        } else if (event.key === "Escape") {
            hideTickerSuggestions(els.autocomplete);
            els.ticker.setAttribute("aria-expanded", "false");
        } else if (event.key === "Enter" && open) {
            event.preventDefault();
            if (activeSuggestion >= 0) chooseSuggestion(items[activeSuggestion]);
        }
    });
    els.autocomplete.addEventListener("click", (event) => chooseSuggestion(event.target.closest(".ticker-suggestion")));
    function positionRowMenu(menu) {
        if (!menu?.open) return;
        const summary = menu.querySelector("summary");
        const popover = menu.querySelector(".pt-row-menu-popover");
        if (!summary || !popover) return;
        const anchor = summary.getBoundingClientRect();
        const width = Math.max(105, popover.offsetWidth);
        const height = popover.offsetHeight;
        const left = Math.min(window.innerWidth - width - 8, Math.max(8, anchor.right - width));
        const below = anchor.bottom + 4;
        const top = below + height <= window.innerHeight - 8
            ? below
            : Math.max(8, anchor.top - height - 4);
        popover.style.left = left + "px";
        popover.style.top = top + "px";
    }
    document.addEventListener("toggle", (event) => {
        const menu = event.target.closest?.(".pt-row-menu");
        if (!menu?.open) return;
        document.querySelectorAll(".pt-row-menu[open]").forEach((other) => {
            if (other !== menu) other.removeAttribute("open");
        });
        requestAnimationFrame(() => positionRowMenu(menu));
    }, true);
    window.addEventListener("resize", () => {
        document.querySelectorAll(".pt-row-menu[open]").forEach(positionRowMenu);
    });
    document.addEventListener("scroll", () => {
        document.querySelectorAll(".pt-row-menu[open]").forEach(positionRowMenu);
    }, true);
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".pt-ticker-field")) {
            hideTickerSuggestions(els.autocomplete);
            els.ticker.setAttribute("aria-expanded", "false");
        }
        if (!event.target.closest(".pt-row-menu")) {
            document.querySelectorAll(".pt-row-menu[open]").forEach((menu) => menu.removeAttribute("open"));
        }
    });

    els.entry.addEventListener("input", () => { entryDirty = true; updatePreview(); });
    els.size.addEventListener("input", updatePreview);
    els.leverage.addEventListener("input", updatePreview);
    els.sizing.addEventListener("change", updateLabels);
    els.form.addEventListener("submit", (event) => {
        event.preventDefault();
        try {
            const position = buildPosition();
            const index = positions.findIndex((item) => item.id === editingId);
            const edited = index >= 0;
            if (edited) positions[index] = position;
            else positions.push(position);
            changed(edited ? "Position updated." : "Position added.");
            resetForm();
            render();
            showToast(edited ? "Position updated." : "Position added.", false, 2200, els.toast);
            requestQuotes([position.ticker]).catch((error) => showToast(error.message, true, 3500, els.toast));
        } catch (error) {
            showToast(error.message, true, 3000, els.toast);
        }
    });
    els.cancelEdit.addEventListener("click", () => resetForm());
    els.deletePositionBtn.addEventListener("click", () => askDeletePosition(editingId));
    els.deleteDialog.addEventListener("close", () => {
        if (els.deleteDialog.returnValue === "confirm") deletePosition();
    });

    els.positions.addEventListener("click", (event) => {
        const action = event.target.closest("[data-action]")?.dataset.action;
        const row = event.target.closest("tr");
        if (action === "edit") editPosition(row?.dataset.id);
        else if (action === "delete") askDeletePosition(row?.dataset.id);
        else if (action === "focus-ticket") resetForm({ focus: true });
        else if (action === "retry-load") loadPortfolio(activePortfolioId);
        else if (action === "clear-filter") {
            filterSide = "all";
            els.filter.value = "all";
            renderPositions();
        }
    });
    els.filter.addEventListener("change", () => {
        filterSide = els.filter.value;
        renderPositions();
    });
    els.newPosition.addEventListener("click", () => resetForm({ focus: true }));
    els.refreshPrices.addEventListener("click", async () => {
        if (!positions.length) return;
        setBusy(els.refreshPrices, true, "Refreshing…");
        try {
            await requestQuotes(positions.map((item) => item.ticker), { force: true });
            showToast("Prices updated.", false, 2500, els.toast);
        } catch (error) {
            showToast(error.message, true, 3500, els.toast);
        } finally {
            setBusy(els.refreshPrices, false);
        }
    });
    els.refreshRates.addEventListener("click", () => loadRates(true));
    els.syncRetry.addEventListener("click", () => saveFailed ? runSave() : loadPortfolio(activePortfolioId));
    els.currency.addEventListener("change", () => {
        const oldRate = rate();
        const entry = num(els.entry.value);
        const size = num(els.size.value);
        currency = ticker(els.currency.value) || "USD";
        const nextRate = rate();
        if (Number.isFinite(entry)) els.entry.value = (entry / oldRate * nextRate).toFixed(4);
        if (els.sizing.value === "notional" && Number.isFinite(size)) {
            els.size.value = (size / oldRate * nextRate).toFixed(2);
        }
        updateCurrencyOptions();
        changed("Display currency changed.");
    });

    els.portfolioOptions.addEventListener("click", (event) => {
        const button = event.target.closest("[data-portfolio-action]");
        const row = event.target.closest(".pt-portfolio-option");
        if (!button || !row) return;
        const action = button.dataset.portfolioAction;
        if (action === "switch") switchPortfolio(row.dataset.id);
        else if (action === "rename") openRenamePortfolio(row.dataset.id);
        else if (action === "delete") openDeletePortfolio(row.dataset.id);
    });
    els.createPortfolioForm.addEventListener("submit", createPortfolio);
    els.renameForm.addEventListener("submit", renamePortfolio);
    els.renameCancel.addEventListener("click", () => els.renameDialog.close());
    els.portfolioDeleteDialog.addEventListener("close", () => {
        if (els.portfolioDeleteDialog.returnValue === "confirm") deletePortfolio();
    });

    els.watchlistBtn.addEventListener("click", openWatchlistDialog);
    els.watchlistForm.addEventListener("submit", savePortfolioWatchlist);
    els.watchlistCancel.addEventListener("click", () => els.watchlistDialog.close());
    els.watchlistForm.querySelectorAll('[name="watchlistMode"]')
        .forEach((radio) => radio.addEventListener("change", renderWatchlistDestination));

    window.addEventListener("beforeunload", (event) => {
        if (revision > savedRevision || savePromise || saveFailed) {
            event.preventDefault();
            event.returnValue = "";
        }
    });

    hydrateQuoteCache();
    updateCurrencyOptions();
    render();
    observeAuthState((user) => {
        if (!user) {
            els.syncStatus.textContent = "Sign in required";
            return;
        }
        if (initializedUid === user.uid) return;
        initializedUid = user.uid;
        dataStore = createUserDataStore(user.uid);
        fetchTickers((endpoint) => request(endpoint)).then((items) => {
            tickerReady = Array.isArray(items) && items.length > 0;
            metadata = new Map((items || []).map((item) => [ticker(item.symbol), item]));
            render();
        });
        loadRates(false);
        loadPortfolioIndex();
    });
});
