import { apiCall, setButtonState } from "./api.js";
import { showToast } from "./toast.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import { debounce, fetchTickers, isValidTicker, showTickerSuggestions, hideTickerSuggestions, getLogoUrl, onLogoLoad } from "./ticker.js";

window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const els = {
        form: $("positionForm"), formTitle: $("positionFormTitle"), formDescription: $("positionFormDescription"),
        ticker: $("portfolioTickerInput"), autocomplete: $("portfolioTickerAutocomplete"), tickerStatus: $("tickerPriceStatus"),
        tickerError: $("tickerError"), selectedAsset: $("selectedAssetCard"), selectedLogo: $("selectedAssetLogo"),
        selectedName: $("selectedAssetName"), selectedTicker: $("selectedAssetTicker"), sizing: $("sizingModeSelect"),
        size: $("positionSizeInput"), sizeLabel: $("positionSizeLabel"), sizeSuffix: $("positionSizeSuffix"),
        sizeError: $("positionSizeError"), entry: $("entryPriceInput"), entryPrefix: $("entryCurrencyPrefix"),
        entryError: $("entryPriceError"), leverage: $("leverageInput"), leverageError: $("leverageError"),
        advanced: $("advancedPositionOptions"), advancedValue: $("advancedSummaryValue"), submitLabel: $("positionSubmitLabel"),
        cancel: $("cancelEditBtn"), deleteBtn: $("deletePositionBtn"), refreshPrices: $("refreshPricesBtn"),
        currency: $("portfolioCurrencySelect"), refreshRates: $("refreshRatesBtn"), positions: $("positionsList"),
        count: $("positionsCountBadge"), priceStatus: $("pricesUpdatedStatus"), syncStatus: $("portfolioSaveStatus"),
        syncRetry: $("portfolioSyncRetryBtn"), summaryCount: $("summaryPositionCount"), summaryExposure: $("summaryExposure"),
        summaryPnl: $("summaryPnl"), summaryReturn: $("summaryReturn"), previewSharesLabel: $("previewSharesLabel"),
        previewShares: $("previewShares"), previewEntryLabel: $("previewEntryValueLabel"), previewEntry: $("previewEntryValue"),
        previewExposure: $("previewExposure"), dialog: $("deletePositionDialog"), dialogTitle: $("deleteDialogTitle"),
        live: $("portfolioLiveStatus"), toast: $("toast-container")
    };
    const apiDeps = { auth, handleLogout: async () => { try { await logoutUser(); } finally { location.replace("login.html"); } } };
    const QUOTE_TTL = 60000, QUOTE_KEY = "dcf_portfolio_quote_cache_v1";
    let positions = [], rates = { USD: 1 }, currency = "USD", tickerReady = false, metadata = new Map();
    let editingId = null, deletingId = null, entryDirty = false, loadState = "loading";
    let autoSave = false, revision = 0, savedRevision = 0, saveTimer = null, saving = false, saveFailed = false;
    let activeSuggestion = -1, initializedUid = null;
    const quotes = new Map(), inFlight = new Map();

    const num = (v) => Number.isFinite(Number(v)) ? Number(v) : null;
    const ticker = (v) => String(v || "").trim().toUpperCase();
    const money = (v, c = currency) => Number.isFinite(v) ? new Intl.NumberFormat("en-US", { style: "currency", currency: c, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v) : "—";
    const number = (v, digits = 4) => Number.isFinite(v) ? new Intl.NumberFormat("en-US", { maximumFractionDigits: digits }).format(v) : "—";
    const pct = (v) => Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—";
    const rate = () => Number.isFinite(rates[currency]) && rates[currency] > 0 ? rates[currency] : 1;
    const validTicker = (v) => v && (tickerReady ? isValidTicker(v) : /^[A-Z0-9.-]{1,15}$/.test(v));
    const escape = (v) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
    const quote = (v) => quotes.get(ticker(v));
    const relative = (iso) => {
        const t = Date.parse(iso || ""); if (!Number.isFinite(t)) return "";
        const s = Math.max(0, Math.round((Date.now() - t) / 1000));
        if (s < 10) return "just now"; if (s < 60) return `${s}s ago`;
        const m = Math.round(s / 60); return m < 60 ? `${m}m ago` : new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(t);
    };
    async function request(endpoint, options = {}, timeout = 30000) {
        const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
        try { return await apiCall(endpoint, { ...options, signal: controller.signal }, apiDeps); }
        catch (e) { throw new Error(e?.name === "AbortError" ? "The service took too long to respond. Please try again." : String(e?.message || e)); }
        finally { clearTimeout(timer); }
    }

    function hydrateQuoteCache() {
        try {
            const cached = JSON.parse(localStorage.getItem(QUOTE_KEY) || "{}"), now = Date.now();
            Object.entries(cached).forEach(([symbol, q]) => {
                const price = num(q?.price), at = Date.parse(q?.asOf || "");
                if (Number.isFinite(price) && Number.isFinite(at) && now - at < QUOTE_TTL) quotes.set(ticker(symbol), { price, asOf: new Date(at).toISOString(), status: "ready" });
            });
        } catch (e) { console.warn("Unable to read quote cache", e); }
    }
    function persistQuoteCache() {
        try {
            const cache = {}, now = Date.now();
            quotes.forEach((q, symbol) => { const at = Date.parse(q?.asOf || ""); if (Number.isFinite(q?.price) && Number.isFinite(at) && now - at < QUOTE_TTL) cache[symbol] = { price: q.price, asOf: q.asOf }; });
            localStorage.setItem(QUOTE_KEY, JSON.stringify(cache));
        } catch (e) { console.warn("Unable to write quote cache", e); }
    }

    function createLogo(symbol, name, sizeClass = "") {
        const shell = document.createElement("span"); shell.className = `portfolio-logo-shell ${sizeClass}`; shell.textContent = symbol.slice(0, 1);
        const img = document.createElement("img"); img.alt = `${name || symbol} logo`; img.referrerPolicy = "strict-origin-when-cross-origin";
        let fallbackTried = false;
        img.onload = async () => {
            shell.classList.add("has-image");
            const cachedLogo = await onLogoLoad(img, symbol);
            if (cachedLogo && cachedLogo.startsWith("data:") && img.src !== cachedLogo) {
                img.onload = () => shell.classList.add("has-image");
                img.src = cachedLogo;
            }
        };
        img.onerror = () => {
            if (!fallbackTried) { fallbackTried = true; img.src = `https://img.logo.dev/${symbol.toLowerCase()}.com?token=pk_RQ-JlIhmQEOm6yeZvHsSKA`; return; }
            img.remove(); shell.classList.remove("has-image");
        };
        img.src = getLogoUrl(symbol); shell.appendChild(img); return shell;
    }
    function showSelectedAsset(symbol) {
        const meta = metadata.get(symbol);
        if (!validTicker(symbol)) { els.selectedAsset.classList.add("hidden"); return; }
        els.selectedName.textContent = meta?.name || symbol;
        els.selectedTicker.textContent = [symbol, meta?.exchange].filter(Boolean).join(" · ");
        els.selectedLogo.replaceWith(createLogo(symbol, meta?.name, "portfolio-selected-logo"));
        els.selectedLogo = els.selectedAsset.querySelector(".portfolio-logo-shell");
        els.selectedAsset.classList.remove("hidden");
    }

    function metrics(p) {
        const entry = num(p.entryPriceUsd), size = num(p.sizeValue), lev = num(p.leverage) || 1, q = quote(p.ticker);
        const marketShares = p.sizingMode === "shares" ? size : entry > 0 ? size / entry * lev : 0;
        const fundedShares = lev > 0 ? marketShares / lev : 0;
        const base = p.sizingMode === "shares" ? entry * fundedShares : size;
        const exposure = p.sizingMode === "shares" ? entry * marketShares : base * lev;
        let pnl = null, returnPct = null;
        if (Number.isFinite(q?.price)) { const delta = p.side === "sell" ? entry - q.price : q.price - entry; pnl = delta * marketShares; returnPct = base > 0 ? pnl / base * 100 : null; }
        return { entry, marketShares, fundedShares, base, exposure, pnl, returnPct, q };
    }
    function performance(el, v) { el.classList.remove("positive", "negative"); if (Number.isFinite(v)) el.classList.add(v >= 0 ? "positive" : "negative"); }
    function renderSummary() {
        let exposure = 0, base = 0, pnl = 0, priced = 0;
        positions.forEach((p) => { const m = metrics(p); exposure += m.exposure || 0; if (Number.isFinite(m.pnl)) { pnl += m.pnl; base += m.base || 0; priced++; } });
        const ret = base > 0 ? pnl / base * 100 : null, r = rate();
        els.summaryCount.textContent = positions.length; els.summaryExposure.textContent = positions.length ? money(exposure * r) : "—";
        els.summaryPnl.textContent = priced ? money(pnl * r) : "—"; els.summaryReturn.textContent = priced ? pct(ret) : "—";
        performance(els.summaryPnl, priced ? pnl : null); performance(els.summaryReturn, ret);
    }
    function quoteDisplay(m) {
        if (!m.q) return ["Not loaded", "Waiting for refresh", "idle"];
        if (m.q.status === "loading" && !Number.isFinite(m.q.price)) return ["Fetching…", "Contacting price service", "loading"];
        if (Number.isFinite(m.q.price)) return [money(m.q.price * rate()), m.q.status === "loading" ? "Refreshing…" : `Updated ${relative(m.q.asOf)}`, Date.now() - Date.parse(m.q.asOf || 0) > QUOTE_TTL ? "stale" : "ready"];
        return ["Unavailable", "Try refreshing prices", "error"];
    }
    function stateMarkup(type, title, copy, action = "") {
        return `<div class="portfolio-${type}-state" role="status"><span class="portfolio-state-icon" aria-hidden="true">${type === "loading" ? '<span class="portfolio-spinner"></span>' : type === "error" ? "!" : "+"}</span><h3>${title}</h3><p>${copy}</p>${action}</div>`;
    }
    function renderPositions() {
        els.count.textContent = positions.length; els.positions.setAttribute("aria-busy", String(loadState === "loading"));
        if (loadState === "loading") { els.positions.innerHTML = stateMarkup("loading", "Loading your portfolio", "This can take a moment while the service wakes up."); return; }
        if (loadState === "error") { els.positions.innerHTML = stateMarkup("error", "We couldn't load your portfolio", "Your saved data was not changed.", '<button class="portfolio-button portfolio-button-secondary" data-action="retry-load">Try again</button>'); return; }
        if (!positions.length) { els.positions.innerHTML = stateMarkup("empty", "Start your portfolio", "Add your first investment to track exposure and performance.", '<button class="portfolio-button portfolio-button-primary" data-action="focus-builder">Add your first position</button>'); return; }
        const wrap = document.createElement("div"); wrap.className = "portfolio-table-scroll";
        const table = document.createElement("table"); table.className = "portfolio-table";
        table.innerHTML = '<thead><tr><th>Asset</th><th>Position</th><th>Entry / market</th><th>Exposure</th><th>P&amp;L</th><th><span class="sr-only">Actions</span></th></tr></thead>';
        const body = document.createElement("tbody");
        positions.forEach((p) => {
            const m = metrics(p), [latest, latestMeta, qState] = quoteDisplay(m), meta = metadata.get(p.ticker), row = document.createElement("tr");
            if (editingId === p.id) row.classList.add("is-editing");
            row.dataset.id = p.id;
            row.innerHTML = `<td data-label="Asset"><div class="portfolio-position-identity"><span class="portfolio-row-logo"></span><span><strong>${escape(p.ticker)}</strong><small>${escape(meta?.name || "Listed company")}</small><span class="portfolio-side-badge ${p.side === "sell" ? "short" : "long"}">${p.side === "sell" ? "Short" : "Long"}</span></span></div></td>
            <td data-label="Position"><strong>${p.sizingMode === "shares" ? `${number(p.sizeValue)} shares` : money(p.sizeValue * rate())}</strong><small>${number(p.leverage, 2)}× leverage · ${number(m.fundedShares)} funded shares</small></td>
            <td data-label="Entry / market"><strong>${money(m.entry * rate())} <span class="portfolio-value-arrow">→</span> ${latest}</strong><small class="portfolio-quote-cell ${qState}">${latestMeta}</small></td>
            <td data-label="Exposure"><strong>${money(m.exposure * rate())}</strong><small>Gross market exposure</small></td>
            <td data-label="P&amp;L" class="${Number.isFinite(m.pnl) ? (m.pnl >= 0 ? "positive" : "negative") : ""}"><strong>${Number.isFinite(m.pnl) ? money(m.pnl * rate()) : "—"}</strong><small>${pct(m.returnPct)}</small></td>
            <td class="portfolio-row-actions"><button type="button" data-action="edit" aria-label="Edit ${p.ticker}">Edit</button><button type="button" data-action="delete" aria-label="Delete ${p.ticker}">Delete</button></td>`;
            row.querySelector(".portfolio-row-logo").replaceWith(createLogo(p.ticker, meta?.name));
            body.appendChild(row);
        });
        table.appendChild(body); wrap.appendChild(table); els.positions.replaceChildren(wrap);
    }
    function renderPriceStatus() {
        if (loadState !== "ready") return;
        if (!positions.length) { els.priceStatus.textContent = "Add a position to begin tracking prices."; els.refreshPrices.disabled = true; return; }
        els.refreshPrices.disabled = false;
        const qs = [...new Set(positions.map((p) => p.ticker))].map(quote), loading = qs.filter((q) => q?.status === "loading").length;
        const failed = qs.filter((q) => q?.status === "error" && !Number.isFinite(q.price)).length, times = qs.map((q) => Date.parse(q?.asOf || "")).filter(Number.isFinite);
        els.priceStatus.textContent = loading ? `Updating ${loading} price${loading === 1 ? "" : "s"}…` : times.length ? `Prices updated ${relative(new Date(Math.max(...times)).toISOString())}${failed ? ` · ${failed} unavailable` : ""}` : failed ? "Prices are unavailable. Try again." : "Prices are ready to load.";
    }
    function renderSync() {
        els.syncStatus.className = "portfolio-save-status"; els.syncRetry.classList.add("hidden");
        if (loadState === "loading") { els.syncStatus.textContent = "Loading portfolio…"; els.syncStatus.classList.add("is-loading"); }
        else if (loadState === "error") { els.syncStatus.textContent = "Portfolio unavailable"; els.syncStatus.classList.add("is-error"); els.syncRetry.classList.remove("hidden"); }
        else if (saving) { els.syncStatus.textContent = "Saving changes…"; els.syncStatus.classList.add("is-loading"); }
        else if (saveFailed) { els.syncStatus.textContent = "Changes not saved"; els.syncStatus.classList.add("is-error"); els.syncRetry.classList.remove("hidden"); }
        else if (revision > savedRevision) { els.syncStatus.textContent = "Waiting to save…"; els.syncStatus.classList.add("is-loading"); }
        else { els.syncStatus.textContent = "Saved automatically"; els.syncStatus.classList.add("is-saved"); }
    }
    function render() { renderSummary(); renderPositions(); renderPriceStatus(); renderSync(); updateDraftStatus(); updatePreview(); }

    function clearErrors() {
        [[els.ticker, els.tickerError], [els.size, els.sizeError], [els.entry, els.entryError], [els.leverage, els.leverageError]].forEach(([input, error]) => { input.removeAttribute("aria-invalid"); error.textContent = ""; error.classList.add("hidden"); });
    }
    function fieldError(input, output, message) { input.setAttribute("aria-invalid", "true"); output.textContent = message; output.classList.remove("hidden"); return input; }
    function buildPosition() {
        clearErrors(); const symbol = ticker(els.ticker.value), size = num(els.size.value), entryDisplay = num(els.entry.value), lev = num(els.leverage.value), mode = els.sizing.value;
        const invalid = [];
        if (!validTicker(symbol)) invalid.push(fieldError(els.ticker, els.tickerError, "Choose a valid company from the search results."));
        if (!Number.isFinite(size) || size <= 0) invalid.push(fieldError(els.size, els.sizeError, "Enter a size greater than zero."));
        if (!Number.isFinite(entryDisplay) || entryDisplay <= 0) invalid.push(fieldError(els.entry, els.entryError, "Enter an entry price greater than zero."));
        if (!Number.isFinite(lev) || lev <= 0) { els.advanced.open = true; invalid.push(fieldError(els.leverage, els.leverageError, "Leverage must be greater than zero.")); }
        if (invalid.length) { invalid[0].focus(); throw new Error("Check the highlighted fields."); }
        const existing = positions.find((p) => p.id === editingId);
        return { id: existing?.id || `${symbol}-${Date.now()}`, ticker: symbol, side: els.form.querySelector('[name="positionSide"]:checked')?.value || "buy", sizingMode: mode, sizeValue: mode === "notional" ? size / rate() : size, entryPriceUsd: entryDisplay / rate(), leverage: lev, currency, createdAt: existing?.createdAt || new Date().toISOString() };
    }
    function updateLabels() { const shares = els.sizing.value === "shares"; els.sizeLabel.textContent = shares ? "Shares of market exposure" : "Cash amount"; els.sizeSuffix.textContent = shares ? "shares" : currency; els.entryPrefix.textContent = currency; updatePreview(); }
    function updatePreview() {
        const size = num(els.size.value), entry = num(els.entry.value), lev = num(els.leverage.value) || 1, sharesMode = els.sizing.value === "shares";
        let funded = null, capital = null, exposure = null;
        if (size > 0 && entry > 0) { if (sharesMode) { funded = size / lev; capital = funded * entry; exposure = size * entry; } else { capital = size; exposure = size * lev; funded = size / entry; } }
        els.previewShares.textContent = number(funded); els.previewEntry.textContent = money(capital); els.previewExposure.textContent = money(exposure); els.advancedValue.textContent = `${number(lev, 2)}× leverage`;
    }
    function updateDraftStatus() {
        const symbol = ticker(els.ticker.value), q = quote(symbol);
        if (!symbol) { els.tickerStatus.textContent = "Latest price will appear here."; els.tickerStatus.className = "portfolio-price-status"; return; }
        if (!q) { els.tickerStatus.textContent = "Select the ticker to load its latest price."; els.tickerStatus.className = "portfolio-price-status"; return; }
        if (q.status === "loading") { els.tickerStatus.textContent = "Fetching latest price…"; els.tickerStatus.className = "portfolio-price-status loading"; return; }
        if (Number.isFinite(q.price)) { els.tickerStatus.textContent = `Latest: ${money(q.price * rate())} · ${relative(q.asOf)}`; els.tickerStatus.className = "portfolio-price-status ready"; return; }
        els.tickerStatus.textContent = "Price unavailable. Enter it manually."; els.tickerStatus.className = "portfolio-price-status error";
    }

    function resetForm() {
        editingId = null; entryDirty = false; els.form.reset(); els.leverage.value = "1"; els.advanced.open = false;
        els.formTitle.textContent = "Add a position"; els.formDescription.textContent = "Enter an investment and preview its exposure before adding it.";
        els.submitLabel.textContent = "Add position"; els.cancel.classList.add("hidden"); els.deleteBtn.classList.add("hidden"); els.selectedAsset.classList.add("hidden");
        clearErrors(); updateLabels(); updateDraftStatus();
    }
    function editPosition(id) {
        const p = positions.find((x) => x.id === id); if (!p) return;
        editingId = id; entryDirty = true; els.ticker.value = p.ticker; els.form.querySelector(`[name="positionSide"][value="${p.side}"]`).checked = true;
        els.sizing.value = p.sizingMode; els.size.value = p.sizingMode === "notional" ? (p.sizeValue * rate()).toFixed(2) : p.sizeValue;
        els.entry.value = (p.entryPriceUsd * rate()).toFixed(4); els.leverage.value = p.leverage; els.advanced.open = Number(p.leverage) !== 1;
        els.formTitle.textContent = `Edit ${p.ticker}`; els.formDescription.textContent = "Update the details; changes save automatically after submission.";
        els.submitLabel.textContent = "Update position"; els.cancel.classList.remove("hidden"); els.deleteBtn.classList.remove("hidden"); showSelectedAsset(p.ticker); updateLabels(); renderPositions();
        els.formTitle.scrollIntoView({ behavior: "smooth", block: "start" }); els.ticker.focus({ preventScroll: true });
    }
    function askDelete(id) { const p = positions.find((x) => x.id === id); if (!p) return; deletingId = id; els.dialogTitle.textContent = `Delete ${p.ticker}?`; typeof els.dialog.showModal === "function" ? els.dialog.showModal() : confirm(`Delete ${p.ticker}?`) && deletePosition(); }
    function deletePosition() {
        const p = positions.find((x) => x.id === deletingId); if (!p) return;
        positions = positions.filter((x) => x.id !== deletingId); deletingId = null; if (editingId === p.id) resetForm();
        changed(`${p.ticker} removed.`); render(); showToast(`${p.ticker} removed.`, false, 2500, els.toast);
    }

    function changed(message = "") { revision++; saveFailed = false; if (message) els.live.textContent = message; renderSync(); scheduleSave(); }
    function scheduleSave(delay = 500) { if (!autoSave) return; clearTimeout(saveTimer); saveTimer = setTimeout(runSave, delay); }
    async function runSave() {
        if (!autoSave || saving) return; const target = revision; saving = true; saveFailed = false; renderSync();
        try {
            const response = await request("/portfolio/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ positions, baseCurrency: currency }) });
            const data = await response.json(); if (!response.ok) throw new Error(data.message || "Failed to save portfolio.");
            savedRevision = Math.max(savedRevision, target);
        } catch (e) { saveFailed = true; showToast(e.message, true, 3500, els.toast); }
        finally { saving = false; renderSync(); if (!saveFailed && revision > savedRevision) scheduleSave(0); }
    }

    async function requestQuotes(symbols, { force = false } = {}) {
        const unique = [...new Set(symbols.map(ticker).filter(Boolean))], now = Date.now(), needed = [], waiting = new Set();
        unique.forEach((s) => { if (inFlight.has(s)) waiting.add(inFlight.get(s)); else { const q = quote(s), fresh = Number.isFinite(q?.price) && now - Date.parse(q.asOf || 0) < QUOTE_TTL; if (force || !fresh) { needed.push(s); quotes.set(s, { price: q?.price ?? null, asOf: q?.asOf ?? null, status: "loading" }); } } });
        if (!needed.length) { if (waiting.size) await Promise.allSettled([...waiting]); return; } render();
        const promise = (async () => {
            try {
                const response = await request("/portfolio/current-prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: needed }) });
                const data = await response.json(); if (!response.ok) throw new Error(data.message || "Failed to refresh prices.");
                const returned = new Set();
                (data.tickers || []).forEach((raw, i) => { const s = ticker(raw), price = num((data.prices || [])[i]); returned.add(s); quotes.set(s, { price, asOf: (data.quoteTimestamps || [])[i] || data.requestedAt || new Date().toISOString(), status: Number.isFinite(price) ? "ready" : "error" }); });
                needed.filter((s) => !returned.has(s)).forEach((s) => quotes.set(s, { price: null, asOf: null, status: "error" })); persistQuoteCache();
                const draft = ticker(els.ticker.value), q = quote(draft); if (!entryDirty && needed.includes(draft) && Number.isFinite(q?.price)) els.entry.value = (q.price * rate()).toFixed(4);
            } catch (e) { needed.forEach((s) => { const old = quote(s); quotes.set(s, { price: old?.price ?? null, asOf: old?.asOf ?? null, status: "error" }); }); throw e; }
            finally { needed.forEach((s) => inFlight.delete(s)); render(); }
        })();
        needed.forEach((s) => inFlight.set(s, promise)); waiting.add(promise); await Promise.all([...waiting]);
    }
    async function loadDraft(symbol, noisy = false) { if (!validTicker(symbol)) { if (noisy) showToast("Choose a valid ticker from the list.", true, 3000, els.toast); return; } showSelectedAsset(symbol); try { await requestQuotes([symbol]); } catch (e) { if (noisy) showToast(e.message, true, 3500, els.toast); } }
    async function loadRates(noisy = false) {
        setButtonState(els.refreshRates, "…", true);
        try { const response = await request("/portfolio/conversion-rates?base=USD"), data = await response.json(); if (!response.ok) throw new Error(data.message || "Failed to load exchange rates."); rates = { ...(data.rates || {}), USD: 1 }; if (!rates[currency]) currency = "USD"; updateCurrencyOptions(); render(); if (noisy) showToast("Exchange rates updated.", false, 2500, els.toast); }
        catch (e) { if (noisy) showToast(e.message, true, 3500, els.toast); } finally { setButtonState(els.refreshRates, "↻", false); }
    }
    function updateCurrencyOptions() { const set = new Set([...Object.keys(rates), "USD", currency]); els.currency.replaceChildren(...[...set].sort().map((c) => Object.assign(document.createElement("option"), { value: c, textContent: c, selected: c === currency }))); updateLabels(); }
    async function loadPortfolio() {
        loadState = "loading"; autoSave = false; render();
        try {
            let response, data, error;
            for (let attempt = 0; attempt < 2; attempt++) { try { response = await request("/portfolio/load", {}, 45000); data = await response.json(); if (response.ok) break; error = new Error(data.message || "Failed to load portfolio."); } catch (e) { error = e; } if (attempt === 0) { els.syncStatus.textContent = "Waking up portfolio service…"; await new Promise((r) => setTimeout(r, 900)); } }
            if (!response?.ok) throw error || new Error("Failed to load portfolio.");
            positions = (Array.isArray(data.positions) ? data.positions : []).filter((p) => p?.ticker && p?.side && p?.sizingMode).map((p, i) => ({ ...p, id: String(p.id || `loaded-${i}-${Date.now()}`), ticker: ticker(p.ticker), leverage: num(p.leverage) || 1 }));
            currency = ticker(data.baseCurrency) || "USD"; updateCurrencyOptions(); revision = savedRevision = 0; saveFailed = false; loadState = "ready"; autoSave = true; resetForm(); render();
            if (positions.length) requestQuotes(positions.map((p) => p.ticker)).catch((e) => showToast(e.message, true, 3500, els.toast));
        } catch (e) { loadState = "error"; saveFailed = false; render(); showToast(e.message, true, 3500, els.toast); }
    }

    function setActiveSuggestion(index) {
        const items = [...els.autocomplete.querySelectorAll(".ticker-suggestion")]; if (!items.length) return;
        activeSuggestion = (index + items.length) % items.length; items.forEach((item, i) => { item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(i === activeSuggestion)); item.classList.toggle("is-active", i === activeSuggestion); }); items[activeSuggestion].scrollIntoView({ block: "nearest" });
    }
    function chooseSuggestion(item) { if (!item) return; const symbol = ticker(item.dataset.symbol); els.ticker.value = symbol; entryDirty = false; els.entry.value = ""; hideTickerSuggestions(els.autocomplete); els.ticker.setAttribute("aria-expanded", "false"); activeSuggestion = -1; clearErrors(); loadDraft(symbol, true); }

    const suggest = debounce(async (q) => { await showTickerSuggestions(q, els.autocomplete); els.ticker.setAttribute("aria-expanded", String(!els.autocomplete.classList.contains("hidden"))); activeSuggestion = -1; [...els.autocomplete.querySelectorAll(".ticker-suggestion")].forEach((item) => item.setAttribute("role", "option")); }, 200);
    const priceLookup = debounce((s) => loadDraft(s), 450);
    els.ticker.addEventListener("input", (e) => { entryDirty = false; els.entry.value = ""; els.selectedAsset.classList.add("hidden"); hideTickerSuggestions(els.autocomplete); suggest(e.target.value.trim()); const s = ticker(e.target.value); updateDraftStatus(); updatePreview(); if (validTicker(s)) priceLookup(s); });
    els.ticker.addEventListener("focus", () => { if (els.ticker.value.trim().length >= 2) suggest(els.ticker.value.trim()); });
    els.ticker.addEventListener("keydown", (e) => {
        const items = [...els.autocomplete.querySelectorAll(".ticker-suggestion")], open = !els.autocomplete.classList.contains("hidden");
        if (e.key === "ArrowDown" && open) { e.preventDefault(); setActiveSuggestion(activeSuggestion + 1); }
        else if (e.key === "ArrowUp" && open) { e.preventDefault(); setActiveSuggestion(activeSuggestion - 1); }
        else if (e.key === "Escape") { hideTickerSuggestions(els.autocomplete); els.ticker.setAttribute("aria-expanded", "false"); }
        else if (e.key === "Enter") { e.preventDefault(); activeSuggestion >= 0 ? chooseSuggestion(items[activeSuggestion]) : loadDraft(ticker(els.ticker.value), true); }
    });
    els.autocomplete.addEventListener("click", (e) => chooseSuggestion(e.target.closest(".ticker-suggestion")));
    document.addEventListener("click", (e) => { if (!e.target.closest(".portfolio-search-wrapper")) { hideTickerSuggestions(els.autocomplete); els.ticker.setAttribute("aria-expanded", "false"); } });
    els.entry.addEventListener("input", () => { entryDirty = true; updatePreview(); }); els.size.addEventListener("input", updatePreview); els.leverage.addEventListener("input", updatePreview); els.sizing.addEventListener("change", updateLabels);
    els.form.addEventListener("submit", (e) => { e.preventDefault(); try { const p = buildPosition(), i = positions.findIndex((x) => x.id === editingId), edited = i >= 0; edited ? positions[i] = p : positions.push(p); changed(edited ? "Position updated." : "Position added."); resetForm(); render(); showToast(edited ? "Position updated." : "Position added.", false, 2200, els.toast); requestQuotes([p.ticker]).catch((err) => showToast(err.message, true, 3500, els.toast)); } catch (err) { showToast(err.message, true, 3000, els.toast); } });
    els.cancel.addEventListener("click", resetForm); els.deleteBtn.addEventListener("click", () => askDelete(editingId)); els.dialog.addEventListener("close", () => { if (els.dialog.returnValue === "confirm") deletePosition(); });
    els.positions.addEventListener("click", (e) => { const action = e.target.closest("[data-action]")?.dataset.action, row = e.target.closest("tr"); if (action === "edit") editPosition(row?.dataset.id); else if (action === "delete") askDelete(row?.dataset.id); else if (action === "focus-builder") { els.ticker.scrollIntoView({ behavior: "smooth", block: "center" }); els.ticker.focus(); } else if (action === "retry-load") loadPortfolio(); });
    els.refreshPrices.addEventListener("click", async () => { if (!positions.length) return; setButtonState(els.refreshPrices, "Refreshing…", true); try { await requestQuotes(positions.map((p) => p.ticker), { force: true }); showToast("Prices updated.", false, 2500, els.toast); } catch (e) { showToast(e.message, true, 3500, els.toast); } finally { setButtonState(els.refreshPrices, "↻ Refresh prices", false); } });
    els.refreshRates.addEventListener("click", () => loadRates(true)); els.syncRetry.addEventListener("click", () => saveFailed ? runSave() : loadPortfolio());
    els.currency.addEventListener("change", () => { const old = rate(), entry = num(els.entry.value), size = num(els.size.value); currency = ticker(els.currency.value) || "USD"; const next = rate(); if (Number.isFinite(entry)) els.entry.value = (entry / old * next).toFixed(4); if (els.sizing.value === "notional" && Number.isFinite(size)) els.size.value = (size / old * next).toFixed(2); updateCurrencyOptions(); changed("Display currency changed."); render(); });
    window.addEventListener("beforeunload", (e) => { if (revision > savedRevision || saving || saveFailed) { e.preventDefault(); e.returnValue = ""; } });

    hydrateQuoteCache(); updateCurrencyOptions(); render();
    observeAuthState((user) => {
        if (!user) { els.syncStatus.textContent = "Sign in required"; return; }
        if (initializedUid === user.uid) return; initializedUid = user.uid;
        fetchTickers((endpoint) => request(endpoint)).then((items) => { tickerReady = Array.isArray(items) && items.length > 0; metadata = new Map((items || []).map((item) => [ticker(item.symbol), item])); render(); });
        loadRates(false); loadPortfolio();
    });
});
