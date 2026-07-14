import { apiCall, setButtonState } from "./api.js";
import {
    CACHE_STALE_TTL,
    CACHE_TTL,
    createDipPerformanceResultKey,
    createUserCacheChannel,
    createUserDataStore,
} from "./data-store.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import { runAuthGuard } from "./auth-guard.js";
import { renderSidebar } from "./sidebar.js";
import { debounce, fetchTickers, hideTickerSuggestions, isValidTicker, showTickerSuggestions } from "./ticker.js";
import { showToast } from "./toast.js";

runAuthGuard();
renderSidebar();

window.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const els = {
        service: $("dipServiceStatus"), refresh: $("dipRefreshBtn"), list: $("watchlistList"),
        select: $("watchlistSelect"), create: $("createWatchlistBtn"), rename: $("renameWatchlistBtn"),
        remove: $("deleteWatchlistBtn"), title: $("activeWatchlistTitle"), meta: $("activeWatchlistMeta"),
        deepest: $("dipDeepestValue"), deepestTicker: $("dipDeepestTicker"), median: $("dipMedianValue"),
        coverage: $("dipCoverageValue"), asOf: $("dipAsOfValue"), chartState: $("dipChartState"),
        chartPanel: $("dipChartPanel"), chartWrap: $("dipChartCanvasWrap"), chart: $("dipChart"),
        chartLabel: $("dipChartLabel"), chartHint: $("dipChartHint"), tickerForm: $("addTickerForm"),
        tickerInput: $("dipTickerInput"), autocomplete: $("dipTickerAutocomplete"), chips: $("dipTickerChips"),
        table: $("dipTableBody"), metricColumn: $("dipMetricColumn"), dialog: $("watchlistDialog"),
        dialogTitle: $("watchlistDialogTitle"), dialogCopy: $("watchlistDialogCopy"),
        nameInput: $("watchlistNameInput"), nameError: $("watchlistNameError"), saveDialog: $("saveWatchlistBtn"),
        deleteDialog: $("deleteWatchlistDialog"), deleteDialogTitle: $("deleteWatchlistDialogTitle"),
        toast: $("toast-container"), live: $("dipLiveStatus")
    };

    const STORAGE_KEY = "dcf_dip_finder_watchlist_v1";
    const PERIODS = ["1W", "1M", "3M", "6M", "YTD", "1Y"];
    const apiDeps = {
        auth,
        handleLogout: async () => {
            try {
                cacheChannel?.publish("signed-out", { operation: "logout" });
                await logoutUser();
            } finally { location.replace("login.html"); }
        }
    };

    let watchlists = [];
    let selectedStorageKey = STORAGE_KEY;
    let selectedId = null;
    let performance = new Map();
    let chart = null;
    let metric = "returnPct";
    let period = "1M";
    let dialogMode = "create";
    let tickerReady = false;
    let metadata = new Map();
    let initializedUid = null;
    let dataStore = null;
    let cacheChannel = null;
    let revalidationPromise = null;
    let loadingWatchlists = false;
    let loadingPerformance = false;
    const watchlistMutationGenerations = new Map();
    const watchlistMutationCounts = new Map();
    const watchlistsNeedingReconciliation = new Set();

    const normalizeTicker = (value) => String(value || "").trim().toUpperCase();
    const currentWatchlist = () => watchlists.find((item) => item.id === selectedId) || null;
    const formatPct = (value) => Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
    const formatPrice = (value) => Number.isFinite(value)
        ? new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(value)
        : "—";
    const formatDate = (value) => {
        if (!value) return "—";
        const parsed = new Date(`${value}T00:00:00`);
        return Number.isNaN(parsed.getTime())
            ? value
            : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(parsed);
    };

    async function request(endpoint, options = {}, timeout = 45000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            return await apiCall(endpoint, { ...options, signal: controller.signal }, apiDeps);
        } catch (error) {
            if (error?.name === "AbortError") {
                throw new Error("The service took too long to respond. Try again.");
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    function setServiceStatus(text, state = "") {
        els.service.textContent = text;
        els.service.className = `dip-service-pill ${state ? `is-${state}` : ""}`.trim();
    }

    function showChartState(title, copy, actionLabel = "", action = null) {
        els.chartPanel.classList.add("hidden");
        els.chartState.classList.remove("hidden");
        els.chartState.replaceChildren();
        const pulse = document.createElement("span");
        pulse.className = "dip-pulse";
        pulse.setAttribute("aria-hidden", "true");
        const heading = document.createElement("h3");
        heading.textContent = title;
        const paragraph = document.createElement("p");
        paragraph.textContent = copy;
        els.chartState.append(pulse, heading, paragraph);
        if (actionLabel && action) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "dip-button dip-button-quiet";
            button.textContent = actionLabel;
            button.addEventListener("click", action, { once: true });
            els.chartState.appendChild(button);
        }
    }

    function renderWatchlistControls() {
        els.list.replaceChildren();
        els.select.replaceChildren();
        const selected = currentWatchlist();

        if (!watchlists.length && !loadingWatchlists) {
            const empty = document.createElement("div");
            empty.className = "dip-rail-empty";
            empty.innerHTML = "<strong>No watchlists</strong><span>Create your first market scan.</span>";
            els.list.appendChild(empty);
        }

        watchlists.forEach((watchlist, index) => {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "dip-watchlist-item";
            item.dataset.id = watchlist.id;
            item.classList.toggle("is-active", watchlist.id === selectedId);
            item.setAttribute("aria-pressed", String(watchlist.id === selectedId));

            const number = document.createElement("span");
            number.className = "dip-watchlist-number";
            number.textContent = String(index + 1).padStart(2, "0");
            const copy = document.createElement("span");
            const name = document.createElement("strong");
            name.textContent = watchlist.name;
            const count = document.createElement("small");
            count.textContent = `${watchlist.tickers.length} symbol${watchlist.tickers.length === 1 ? "" : "s"}`;
            copy.append(name, count);
            const arrow = document.createElement("span");
            arrow.className = "dip-watchlist-arrow";
            arrow.textContent = "↗";
            item.append(number, copy, arrow);
            els.list.appendChild(item);

            const option = document.createElement("option");
            option.value = watchlist.id;
            option.textContent = `${watchlist.name} (${watchlist.tickers.length})`;
            option.selected = watchlist.id === selectedId;
            els.select.appendChild(option);
        });

        els.select.disabled = !watchlists.length;
        els.rename.disabled = !selected;
        els.remove.disabled = !selected;
    }

    function renderActiveWatchlist() {
        const selected = currentWatchlist();
        if (!selected) {
            els.title.textContent = "Select a watchlist";
            els.meta.textContent = "Create a watchlist to begin tracking drawdowns.";
            els.tickerInput.disabled = true;
            els.tickerForm.querySelector("button").disabled = true;
            renderTickerChips();
            return;
        }
        els.title.textContent = selected.name;
        els.meta.textContent = `${selected.tickers.length} tracked symbol${selected.tickers.length === 1 ? "" : "s"} · sorted by deepest move`;
        els.tickerInput.disabled = false;
        els.tickerForm.querySelector("button").disabled = false;
        renderTickerChips();
    }

    function renderTickerChips() {
        els.chips.replaceChildren();
        const selected = currentWatchlist();
        if (!selected?.tickers.length) {
            const copy = document.createElement("p");
            copy.className = "dip-chip-empty";
            copy.textContent = selected ? "No symbols yet. Add one above or import your portfolio." : "Choose a watchlist to edit its roster.";
            els.chips.appendChild(copy);
            return;
        }

        selected.tickers.forEach((symbol) => {
            const chip = document.createElement("span");
            chip.className = "dip-ticker-chip";
            const label = document.createElement("span");
            label.textContent = symbol;
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.removeTicker = symbol;
            button.setAttribute("aria-label", `Remove ${symbol} from ${selected.name}`);
            button.textContent = "×";
            chip.append(label, button);
            els.chips.appendChild(chip);
        });
    }

    function metricValue(result) {
        return result?.metrics?.[period]?.[metric];
    }

    function rankedResults() {
        const selected = currentWatchlist();
        if (!selected) return [];
        return selected.tickers
            .map((symbol) => performance.get(symbol) || { ticker: symbol, status: "unavailable", metrics: {} })
            .sort((a, b) => {
                const aValue = metricValue(a);
                const bValue = metricValue(b);
                if (!Number.isFinite(aValue)) return Number.isFinite(bValue) ? 1 : a.ticker.localeCompare(b.ticker);
                if (!Number.isFinite(bValue)) return -1;
                return aValue - bValue;
            });
    }

    function renderSummary(results) {
        const selected = currentWatchlist();
        const values = results.map(metricValue).filter(Number.isFinite).sort((a, b) => a - b);
        const deepestResult = results.find((item) => Number.isFinite(metricValue(item)));
        const median = values.length
            ? values.length % 2
                ? values[(values.length - 1) / 2]
                : (values[values.length / 2 - 1] + values[values.length / 2]) / 2
            : null;
        const dates = results.map((item) => item.asOf).filter(Boolean).sort();

        els.deepest.textContent = formatPct(deepestResult ? metricValue(deepestResult) : null);
        els.deepestTicker.textContent = deepestResult?.ticker || "No data";
        els.median.textContent = formatPct(median);
        els.coverage.textContent = `${values.length} / ${selected?.tickers.length || 0}`;
        els.asOf.textContent = dates.length ? formatDate(dates[dates.length - 1]) : "—";
    }

    function renderChart(results) {
        if (chart) {
            chart.destroy();
            chart = null;
        }

        const available = results.filter((item) => Number.isFinite(metricValue(item)));
        if (!available.length) {
            const selected = currentWatchlist();
            showChartState(
                selected?.tickers.length ? "No market history returned" : "This scan is empty",
                selected?.tickers.length
                    ? "The data provider could not price these symbols. Refresh in a moment."
                    : "Add a ticker or import your portfolio to start the scan.",
                selected?.tickers.length ? "Retry scan" : "",
                selected?.tickers.length ? () => loadPerformance(true) : null
            );
            return;
        }

        els.chartState.classList.add("hidden");
        els.chartPanel.classList.remove("hidden");
        els.chartWrap.style.height = "440px";
        els.chart.style.minWidth = `${Math.max(680, available.length * 76)}px`;
        const values = available.map(metricValue);
        const axisPercentFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
        const metricName = metric === "returnPct" ? "Period return" : "Drawdown";
        els.chartLabel.textContent = `${metricName} · ${period}`;
        els.chartHint.textContent = metric === "returnPct"
            ? "Latest adjusted close compared with the period starting close."
            : "Latest adjusted close compared with the highest close inside the period.";

        if (!globalThis.Chart) {
            showChartState("Chart library unavailable", "The accessible data table below still contains every result.");
            return;
        }

        const valueLabelsPlugin = {
            id: "dipValueLabels",
            afterDraw(chartInstance) {
                const { ctx } = chartInstance;
                const bars = chartInstance.getDatasetMeta(0).data;
                ctx.save();
                ctx.font = '600 11px "IBM Plex Mono", monospace';
                ctx.textBaseline = "middle";
                values.forEach((value, index) => {
                    const bar = bars[index];
                    if (!bar) return;
                    const isNegative = value < 0;
                    ctx.fillStyle = "#14211f";
                    ctx.textAlign = "center";
                    const preferredY = bar.y + (isNegative ? 14 : -14);
                    const labelY = Math.max(chartInstance.chartArea.top + 8, Math.min(chartInstance.chartArea.bottom - 8, preferredY));
                    ctx.fillText(formatPct(value), bar.x, labelY);
                });
                ctx.restore();
            }
        };

        const zeroLinePlugin = {
            id: "dipZeroLine",
            beforeDatasetsDraw(chartInstance) {
                const { ctx, chartArea, scales } = chartInstance;
                const zeroY = scales.y.getPixelForValue(0);
                ctx.save();
                ctx.strokeStyle = "#46504d";
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(chartArea.left, zeroY);
                ctx.lineTo(chartArea.right, zeroY);
                ctx.stroke();
                ctx.restore();
            }
        };

        chart = new globalThis.Chart(els.chart, {
            type: "bar",
            data: {
                labels: available.map((item) => item.ticker),
                datasets: [{
                    data: values,
                    backgroundColor: values.map((value) => value < 0 ? "#d85b51" : "#168b78"),
                    borderColor: values.map((value) => value < 0 ? "#a73f37" : "#0d6558"),
                    borderWidth: 1,
                    borderRadius: 2,
                    maxBarThickness: 72,
                    categoryPercentage: .8,
                    barPercentage: .9
                }]
            },
            options: {
                maintainAspectRatio: false,
                animation: { duration: 420, easing: "easeOutQuart" },
                events: [],
                interaction: { mode: null },
                layout: { padding: { left: 6, right: 8 } },
                plugins: {
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                scales: {
                    x: {
                        grid: { display: false },
                        border: { display: false },
                        ticks: {
                            color: "#14211f",
                            font: { family: "IBM Plex Mono", size: 12, weight: "600" },
                            autoSkip: false,
                            padding: 8,
                            maxRotation: 0,
                            minRotation: 0
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: {
                            color: (context) => Number(context.tick.value) === 0 ? "transparent" : "rgba(20, 33, 31, .1)",
                            drawTicks: false
                        },
                        border: { display: false },
                        ticks: {
                            color: "#65706c",
                            font: { family: "IBM Plex Mono", size: 10 },
                            precision: 2,
                            callback: (value) => `${axisPercentFormatter.format(Number(value))}%`
                        }
                    }
                }
            },
            plugins: [zeroLinePlugin, valueLabelsPlugin]
        });
    }

    function renderTable(results) {
        els.table.replaceChildren();
        els.metricColumn.textContent = `${period} ${metric === "returnPct" ? "return" : "drawdown"}`;
        if (!results.length) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 6;
            cell.className = "dip-table-empty";
            cell.textContent = "No symbols loaded.";
            row.appendChild(cell);
            els.table.appendChild(row);
            return;
        }

        results.forEach((result, index) => {
            const periodMetric = result.metrics?.[period] || {};
            const value = metricValue(result);
            const row = document.createElement("tr");
            const values = [
                String(index + 1).padStart(2, "0"),
                result.ticker,
                formatPrice(result.lastClose),
                formatPct(value),
                metric === "returnPct" ? formatPrice(periodMetric.referenceClose) : formatPrice(periodMetric.periodHigh),
                result.status === "ready" ? "Ready" : result.status === "partial" ? "Partial" : "Unavailable"
            ];
            values.forEach((text, cellIndex) => {
                const cell = document.createElement("td");
                cell.textContent = text;
                if (cellIndex === 1) {
                    const meta = metadata.get(result.ticker);
                    if (meta?.name) cell.title = meta.name;
                }
                if (cellIndex === 3 && Number.isFinite(value)) {
                    cell.className = value < 0 ? "is-negative" : "is-positive";
                }
                if (cellIndex === 5) cell.className = `dip-status-cell is-${result.status || "unavailable"}`;
                row.appendChild(cell);
            });
            els.table.appendChild(row);
        });
    }

    function renderPerformance() {
        const results = rankedResults();
        renderSummary(results);
        renderChart(results);
        renderTable(results);
    }

    function renderAll() {
        renderWatchlistControls();
        renderActiveWatchlist();
        renderPerformance();
    }

    const sameCachedPayload = (entry, data, version = null) => {
        if (!entry) return false;
        if (entry.version !== null && version !== null) return entry.version === version;
        try { return JSON.stringify(entry.data) === JSON.stringify(data); } catch { return false; }
    };

    function beginWatchlistMutation(watchlistId) {
        const generation = (watchlistMutationGenerations.get(watchlistId) || 0) + 1;
        watchlistMutationGenerations.set(watchlistId, generation);
        watchlistMutationCounts.set(watchlistId, (watchlistMutationCounts.get(watchlistId) || 0) + 1);
        return Object.freeze({ watchlistId, generation });
    }

    function isCurrentWatchlistMutation(context) {
        return !context
            || watchlistMutationGenerations.get(context.watchlistId) === context.generation;
    }

    function markWatchlistForReconciliation(context) {
        if (context?.watchlistId) watchlistsNeedingReconciliation.add(context.watchlistId);
    }

    async function finishWatchlistMutation(context) {
        if (!context) return;
        const remaining = Math.max(0, (watchlistMutationCounts.get(context.watchlistId) || 1) - 1);
        if (remaining > 0) {
            watchlistMutationCounts.set(context.watchlistId, remaining);
            return;
        }
        watchlistMutationCounts.delete(context.watchlistId);
        if (!watchlistsNeedingReconciliation.delete(context.watchlistId)) return;
        await loadWatchlists(true);
    }

    function applyCanonicalWatchlist(canonical) {
        if (!canonical?.id) return;
        watchlists = watchlists.map((item) => item.id === canonical.id ? canonical : item);
        cacheWatchlistCollection({
            version: canonical.revision ?? canonical.version ?? null,
            serverUpdatedAt: canonical.updatedAt || null,
        });
        renderAll();
    }

    function applyTickerIntent(canonicalTickers, added, removed) {
        const removedSet = new Set(removed);
        const result = (canonicalTickers || []).filter((symbol) => !removedSet.has(symbol));
        const existing = new Set(result);
        added.forEach((symbol) => {
            if (!existing.has(symbol)) {
                existing.add(symbol);
                result.push(symbol);
            }
        });
        return result;
    }

    function confirmConflictReapply(action) {
        return window.confirm(
            `This watchlist changed on another device. Select OK to reapply your ${action} to the latest version, or Cancel to keep the newer server version.`
        );
    }

    function saveSelectedId() {
        if (selectedId) localStorage.setItem(selectedStorageKey, selectedId);
        else localStorage.removeItem(selectedStorageKey);
    }

    function applyWatchlists(data) {
        watchlists = Array.isArray(data?.watchlists) ? data.watchlists : [];
        if (!watchlists.some((item) => item.id === selectedId)) selectedId = watchlists[0]?.id || null;
        saveSelectedId();
        renderAll();
    }

    function watchlistSnapshot() {
        return {
            watchlists: watchlists.map((watchlist) => ({
                ...watchlist,
                tickers: [...(watchlist.tickers || [])],
            })),
        };
    }

    function cacheWatchlistCollection({ version = null, serverUpdatedAt = null } = {}) {
        if (!dataStore) return;
        void dataStore.set(dataStore.keys.watchlists(), watchlistSnapshot(), {
            ttlMs: CACHE_TTL.watchlists,
            staleTtlMs: CACHE_STALE_TTL.watchlists,
            version,
            serverUpdatedAt,
        });
    }

    async function loadWatchlists(force = false) {
        const cacheKey = dataStore?.keys.watchlists();
        const cached = cacheKey ? await dataStore.get(cacheKey) : null;
        if (cached) {
            applyWatchlists(cached.data);
            if (cached.isFresh && !force) {
                setServiceStatus("Lists ready", "ready");
                return loadPerformance();
            }
        }

        loadingWatchlists = true;
        setServiceStatus(cached ? "Refreshing lists" : "Loading lists", "loading");
        renderWatchlistControls();
        try {
            const response = await request("/watchlists");
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to load watchlists.");
            const next = { watchlists: Array.isArray(data.watchlists) ? data.watchlists : [] };
            const version = data.version || data.updatedAt || null;
            void dataStore?.set(dataStore.keys.watchlists(), next, {
                ttlMs: CACHE_TTL.watchlists,
                staleTtlMs: CACHE_STALE_TTL.watchlists,
                serverUpdatedAt: data.updatedAt || null,
                version,
            });
            if (!sameCachedPayload(cached, next, version)) applyWatchlists(next);
            setServiceStatus("Lists synced", "ready");
            await loadPerformance();
        } catch (error) {
            if (cached) {
                setServiceStatus("Saved lists", "partial");
                await loadPerformance();
                showToast("Showing saved watchlists while the service is unavailable.", true, 4000, els.toast);
                return;
            }
            setServiceStatus("Service unavailable", "error");
            showChartState("Watchlists could not load", error.message, "Retry", loadWatchlists);
            showToast(error.message, true, 4000, els.toast);
        } finally {
            loadingWatchlists = false;
            renderWatchlistControls();
        }
    }

    async function loadPerformance(force = false) {
        const selected = currentWatchlist();
        if (!selected?.tickers.length) {
            performance = new Map();
            renderPerformance();
            return;
        }

        const resultKey = createDipPerformanceResultKey(selected);
        const cacheKey = dataStore?.keys.dipPerformance(resultKey);
        let cached = cacheKey ? await dataStore.get(cacheKey) : null;
        const tickerKey = selected.tickers.map(normalizeTicker).sort().join(",");
        const cachedTickerKey = cached?.data?.tickers?.map(normalizeTicker).sort().join(",");
        if (cached && cachedTickerKey !== tickerKey) cached = null;
        if (cached) {
            performance = new Map((cached.data.results || []).map((result) => [result.ticker, result]));
            renderPerformance();
            if (cached.isFresh && !force) {
                const unavailable = (cached.data.results || []).filter((result) => result.status === "unavailable").length;
                setServiceStatus(unavailable ? `${unavailable} unavailable` : "Scan ready", unavailable ? "partial" : "ready");
                return;
            }
        } else {
            performance = new Map();
        }

        loadingPerformance = true;
        setServiceStatus(force ? "Refreshing scan" : "Scanning market", "loading");
        if (!cached) showChartState("Scanning adjusted closes", "Ranking every symbol across all six time windows.");
        setButtonState(els.refresh, "Refreshing…", true);
        try {
            const response = await request("/watchlists/performance", {
                method: "POST",
                coalesce: true,
                retry: true,
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ tickers: selected.tickers, force })
            }, 60000);
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || "Unable to load market history.");
            const next = {
                watchlistId: selected.id,
                watchlistUpdatedAt: selected.updatedAt || null,
                tickers: [...selected.tickers],
                results: data.results || [],
                asOf: data.asOf || null,
            };
            const version = data.version || data.asOf || null;
            void dataStore?.set(dataStore.keys.dipPerformance(resultKey), next, {
                ttlMs: CACHE_TTL.dipPerformance,
                staleTtlMs: CACHE_STALE_TTL.dipPerformance,
                serverUpdatedAt: data.asOf || null,
                version,
            });
            if (!sameCachedPayload(cached, next, version)) {
                performance = new Map(next.results.map((result) => [result.ticker, result]));
                renderPerformance();
            }
            const unavailable = (data.results || []).filter((result) => result.status === "unavailable").length;
            setServiceStatus(unavailable ? `${unavailable} unavailable` : "Scan current", unavailable ? "partial" : "ready");
            els.live.textContent = `${selected.name} market scan updated.`;
        } catch (error) {
            if (cached) {
                setServiceStatus("Saved scan", "partial");
                showToast("Showing saved scan results while refresh is unavailable.", true, 4000, els.toast);
                return;
            }
            setServiceStatus("Scan failed", "error");
            showChartState("Market scan failed", error.message, "Retry scan", () => loadPerformance(true));
            showToast(error.message, true, 4000, els.toast);
        } finally {
            loadingPerformance = false;
            setButtonState(els.refresh, "↻ Refresh data", false);
        }
    }

    async function selectWatchlist(id) {
        if (!watchlists.some((item) => item.id === id) || id === selectedId) return;
        selectedId = id;
        saveSelectedId();
        performance = new Map();
        renderAll();
        await loadPerformance();
    }

    function openWatchlistDialog(mode) {
        dialogMode = mode;
        const selected = currentWatchlist();
        els.nameError.textContent = "";
        els.nameError.classList.add("hidden");
        els.dialogTitle.textContent = mode === "create" ? "Create watchlist" : "Rename watchlist";
        els.dialogCopy.textContent = mode === "create"
            ? "Name a new group of symbols to scan."
            : "Change the desk label without changing its symbols.";
        els.saveDialog.textContent = mode === "create" ? "Create watchlist" : "Save name";
        els.nameInput.value = mode === "rename" ? selected?.name || "" : "";
        if (typeof els.dialog.showModal === "function") els.dialog.showModal();
        els.nameInput.focus();
        els.nameInput.select();
    }

    async function saveWatchlist(event) {
        event.preventDefault();
        const mode = dialogMode;
        const name = els.nameInput.value.trim().replace(/\s+/g, " ");
        if (!name) {
            els.nameError.textContent = "Enter a watchlist name.";
            els.nameError.classList.remove("hidden");
            els.nameInput.focus();
            return;
        }

        const selected = currentWatchlist();
        if (mode === "rename" && !selected) return;
        const mutationContext = mode === "rename" ? beginWatchlistMutation(selected.id) : null;
        const previousWatchlists = watchlistSnapshot().watchlists;
        const previousSelectedId = selectedId;
        let rollbackWatchlist = selected;
        let optimisticId = null;
        const now = new Date().toISOString();

        setButtonState(els.saveDialog, "Saving…", true);
        if (mode === "create") {
            optimisticId = `pending-${globalThis.crypto?.randomUUID?.() || Date.now()}`;
            watchlists = [{
                id: optimisticId,
                name,
                tickers: [],
                revision: 0,
                createdAt: now,
                updatedAt: now,
                syncState: "pending",
            }, ...watchlists];
            selectedId = optimisticId;
            performance = new Map();
        } else {
            watchlists = watchlists.map((item) => item.id === selected.id
                ? { ...item, name, updatedAt: now, syncState: "pending" }
                : item);
        }
        saveSelectedId();
        cacheWatchlistCollection();
        renderAll();

        try {
            let data = null;
            if (mode === "create") {
                const response = await request("/watchlists", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ name, tickers: [] }),
                });
                data = await response.json();
                if (!response.ok) throw new Error(data.message || "Unable to save watchlist.");
            } else {
                let baseRevision = Number.isInteger(selected.revision) ? selected.revision : 0;
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const response = await request(`/watchlists/${selected.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ name, baseRevision }),
                    });
                    data = await response.json();
                    if (!isCurrentWatchlistMutation(mutationContext)) {
                        if (response.ok) markWatchlistForReconciliation(mutationContext);
                        return;
                    }
                    if (response.status === 409 && data.code === "REVISION_CONFLICT" && data.watchlist) {
                        rollbackWatchlist = data.watchlist;
                        applyCanonicalWatchlist(data.watchlist);
                        if (attempt === 1 || !confirmConflictReapply("rename")) {
                            els.dialog.close();
                            showToast("Loaded the newer watchlist version.", true, 3200, els.toast);
                            return;
                        }
                        baseRevision = data.watchlist.revision;
                        watchlists = watchlists.map((item) => item.id === selected.id
                            ? { ...data.watchlist, name, syncState: "pending" }
                            : item);
                        cacheWatchlistCollection();
                        renderAll();
                        continue;
                    }
                    if (!response.ok) throw new Error(data.message || "Unable to save watchlist.");
                    break;
                }
            }

            if (!isCurrentWatchlistMutation(mutationContext)) return;
            if (mode === "create") {
                watchlists = watchlists.map((item) => item.id === optimisticId ? data : item);
                selectedId = data.id;
                saveSelectedId();
                performance = new Map();
            } else {
                watchlists = watchlists.map((item) => item.id === data.id ? data : item);
            }
            cacheWatchlistCollection({
                version: data.revision ?? data.version ?? null,
                serverUpdatedAt: data.updatedAt || null,
            });
            cacheChannel?.publish("watchlist-updated", {
                entityId: data.id,
                operation: mode,
                version: data.revision ?? data.version ?? null,
            });
            els.dialog.close();
            renderAll();
            showToast(mode === "create" ? "Watchlist created." : "Watchlist renamed.", false, 2500, els.toast);
        } catch (error) {
            if (!isCurrentWatchlistMutation(mutationContext)) return;
            if (mode === "create") {
                watchlists = previousWatchlists;
                selectedId = previousSelectedId;
            } else {
                watchlists = watchlists.map((item) => item.id === selected.id ? rollbackWatchlist : item);
            }
            saveSelectedId();
            cacheWatchlistCollection();
            renderAll();
            els.nameError.textContent = error.message;
            els.nameError.classList.remove("hidden");
        } finally {
            setButtonState(els.saveDialog, mode === "create" ? "Create watchlist" : "Save name", false);
            await finishWatchlistMutation(mutationContext);
        }
    }

    async function deleteSelectedWatchlist() {
        const selected = currentWatchlist();
        if (!selected) return;
        const previousWatchlists = watchlistSnapshot().watchlists;
        const previousSelectedId = selectedId;
        const previousPerformance = performance;
        const performanceResultKey = createDipPerformanceResultKey(selected);
        watchlists = watchlists.filter((item) => item.id !== selected.id);
        selectedId = watchlists[0]?.id || null;
        performance = new Map();
        saveSelectedId();
        cacheWatchlistCollection();
        renderAll();
        try {
            const response = await request(`/watchlists/${selected.id}`, { method: "DELETE" });
            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.message || "Unable to delete watchlist.");
            }
            void dataStore?.remove(dataStore.keys.dipPerformance(performanceResultKey));
            cacheChannel?.publish("watchlist-updated", {
                entityId: selected.id,
                operation: "delete",
            });
            await loadPerformance();
            showToast(`${selected.name} deleted.`, false, 2500, els.toast);
        } catch (error) {
            watchlists = previousWatchlists;
            selectedId = previousSelectedId;
            performance = previousPerformance;
            saveSelectedId();
            cacheWatchlistCollection();
            renderAll();
            showToast(error.message, true, 4000, els.toast);
        }
    }

    async function updateTickers(nextTickers, message) {
        const selected = currentWatchlist();
        if (!selected) return;

        const originalWatchlist = { ...selected, tickers: [...selected.tickers] };
        const previousPerformance = performance;
        const previousPerformanceResultKey = createDipPerformanceResultKey(selected);
        const mutationContext = beginWatchlistMutation(selected.id);
        const originalSet = new Set(selected.tickers);
        const nextSet = new Set(nextTickers);
        const added = nextTickers.filter((symbol) => !originalSet.has(symbol));
        const removed = selected.tickers.filter((symbol) => !nextSet.has(symbol));
        const additiveOnly = added.length > 0 && removed.length === 0;
        let desiredTickers = [...nextTickers];
        let rollbackWatchlist = originalWatchlist;

        watchlists = watchlists.map((item) => item.id === selected.id
            ? {
                ...item,
                tickers: desiredTickers,
                updatedAt: new Date().toISOString(),
                syncState: "pending",
            }
            : item);
        performance = new Map();
        cacheWatchlistCollection();
        renderAll();

        try {
            let canonical = null;
            if (additiveOnly) {
                const response = await request(`/watchlists/${selected.id}/tickers`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ tickers: added }),
                });
                const payload = await response.json();
                if (!isCurrentWatchlistMutation(mutationContext)) {
                    if (response.ok) markWatchlistForReconciliation(mutationContext);
                    return;
                }
                if (!response.ok) throw new Error(payload.message || "Unable to update watchlist.");
                canonical = payload.watchlist;
            } else {
                let baseRevision = Number.isInteger(selected.revision) ? selected.revision : 0;
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    const response = await request(`/watchlists/${selected.id}`, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ tickers: desiredTickers, baseRevision }),
                    });
                    const payload = await response.json();
                    if (!isCurrentWatchlistMutation(mutationContext)) {
                        if (response.ok) markWatchlistForReconciliation(mutationContext);
                        return;
                    }
                    if (response.status === 409 && payload.code === "REVISION_CONFLICT" && payload.watchlist) {
                        rollbackWatchlist = payload.watchlist;
                        applyCanonicalWatchlist(payload.watchlist);
                        if (attempt === 1 || !confirmConflictReapply("ticker change")) {
                            showToast("Loaded the newer watchlist version.", true, 3200, els.toast);
                            await loadPerformance();
                            return;
                        }
                        desiredTickers = applyTickerIntent(payload.watchlist.tickers, added, removed);
                        baseRevision = payload.watchlist.revision;
                        watchlists = watchlists.map((item) => item.id === selected.id
                            ? {
                                ...payload.watchlist,
                                tickers: desiredTickers,
                                syncState: "pending",
                            }
                            : item);
                        cacheWatchlistCollection();
                        renderAll();
                        continue;
                    }
                    if (!response.ok) throw new Error(payload.message || "Unable to update watchlist.");
                    canonical = payload;
                    break;
                }
            }

            if (!canonical?.id || !isCurrentWatchlistMutation(mutationContext)) return;
            applyCanonicalWatchlist(canonical);
            void dataStore?.remove(dataStore.keys.dipPerformance(previousPerformanceResultKey));
            cacheChannel?.publish("watchlist-updated", {
                entityId: canonical.id,
                operation: additiveOnly ? "ticker-merge" : "tickers",
                version: canonical.revision ?? canonical.version ?? null,
            });
            showToast(message, false, 2400, els.toast);
            await loadPerformance();
        } catch (error) {
            if (!isCurrentWatchlistMutation(mutationContext)) return;
            watchlists = watchlists.map((item) => item.id === selected.id ? rollbackWatchlist : item);
            performance = rollbackWatchlist === originalWatchlist ? previousPerformance : new Map();
            cacheWatchlistCollection();
            renderAll();
            showToast(error.message, true, 4000, els.toast);
            if (rollbackWatchlist !== originalWatchlist) await loadPerformance();
        } finally {
            await finishWatchlistMutation(mutationContext);
        }
    }

    async function addTicker(rawSymbol) {
        const selected = currentWatchlist();
        const symbol = normalizeTicker(rawSymbol);
        const valid = tickerReady ? isValidTicker(symbol) : /^[A-Z0-9.-]{1,15}$/.test(symbol);
        if (!selected || !valid) {
            showToast("Choose a valid ticker from the results.", true, 3000, els.toast);
            return;
        }
        if (selected.tickers.includes(symbol)) {
            showToast(`${symbol} is already in this watchlist.`, true, 2800, els.toast);
            return;
        }
        els.tickerInput.value = "";
        hideTickerSuggestions(els.autocomplete);
        els.tickerInput.setAttribute("aria-expanded", "false");
        await updateTickers([...selected.tickers, symbol], `${symbol} added.`);
    }

    const suggestTickers = debounce(async (query) => {
        await showTickerSuggestions(query, els.autocomplete);
        els.tickerInput.setAttribute("aria-expanded", String(!els.autocomplete.classList.contains("hidden")));
    }, 180);

    els.list.addEventListener("click", (event) => selectWatchlist(event.target.closest("[data-id]")?.dataset.id));
    els.select.addEventListener("change", () => selectWatchlist(els.select.value));
    els.create.addEventListener("click", () => openWatchlistDialog("create"));
    els.rename.addEventListener("click", () => openWatchlistDialog("rename"));
    els.remove.addEventListener("click", () => {
        const selected = currentWatchlist();
        if (!selected) return;
        els.deleteDialogTitle.textContent = `Delete “${selected.name}”?`;
        if (typeof els.deleteDialog.showModal === "function") els.deleteDialog.showModal();
    });
    els.dialog.querySelector("[data-close-dialog]").addEventListener("click", () => els.dialog.close());
    els.dialog.addEventListener("close", () => {
        els.nameError.textContent = "";
        els.nameError.classList.add("hidden");
    });
    els.watchlistForm = $("watchlistForm");
    els.watchlistForm.addEventListener("submit", saveWatchlist);
    els.deleteDialog.addEventListener("close", () => {
        if (els.deleteDialog.returnValue === "confirm") deleteSelectedWatchlist();
    });

    document.querySelectorAll("[data-metric]").forEach((button) => {
        button.addEventListener("click", () => {
            metric = button.dataset.metric;
            document.querySelectorAll("[data-metric]").forEach((item) => {
                const active = item === button;
                item.classList.toggle("is-active", active);
                item.setAttribute("aria-pressed", String(active));
            });
            renderPerformance();
        });
    });
    document.querySelectorAll("[data-period]").forEach((button) => {
        button.addEventListener("click", () => {
            period = button.dataset.period;
            document.querySelectorAll("[data-period]").forEach((item) => item.classList.toggle("is-active", item === button));
            renderPerformance();
        });
    });

    els.refresh.addEventListener("click", () => {
        if (!loadingPerformance) loadPerformance(true);
    });
    els.tickerForm.addEventListener("submit", (event) => {
        event.preventDefault();
        addTicker(els.tickerInput.value);
    });
    els.tickerInput.addEventListener("input", () => {
        const query = els.tickerInput.value.trim();
        if (query.length >= 2) suggestTickers(query);
        else {
            hideTickerSuggestions(els.autocomplete);
            els.tickerInput.setAttribute("aria-expanded", "false");
        }
    });
    els.autocomplete.addEventListener("click", (event) => {
        const suggestion = event.target.closest(".ticker-suggestion");
        if (suggestion) addTicker(suggestion.dataset.symbol);
    });
    els.chips.addEventListener("click", (event) => {
        const symbol = event.target.closest("[data-remove-ticker]")?.dataset.removeTicker;
        const selected = currentWatchlist();
        if (symbol && selected) updateTickers(selected.tickers.filter((item) => item !== symbol), `${symbol} removed.`);
    });
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".dip-ticker-search")) {
            hideTickerSuggestions(els.autocomplete);
            els.tickerInput.setAttribute("aria-expanded", "false");
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.target.matches("input, select, textarea") || document.querySelector("dialog[open]")) return;
        if (event.key.toLowerCase() === "r") {
            event.preventDefault();
            loadPerformance(true);
        }
        const index = Number(event.key) - 1;
        if (index >= 0 && index < PERIODS.length) {
            document.querySelector(`[data-period="${PERIODS[index]}"]`)?.click();
        }
    });

    function revalidateStaleData() {
        if (!dataStore || document.visibilityState === "hidden") return;
        if (revalidationPromise) return revalidationPromise;
        revalidationPromise = loadWatchlists(false)
            .finally(() => { revalidationPromise = null; });
        return revalidationPromise;
    }

    function handleCrossTabCacheMessage(message) {
        if (message.type === "signed-out") {
            location.replace("login.html");
            return;
        }
        if (message.type === "watchlist-updated") void loadWatchlists(true);
    }

    window.addEventListener("pageshow", () => { void revalidateStaleData(); });
    window.addEventListener("focus", () => { void revalidateStaleData(); });
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void revalidateStaleData();
    });

    renderAll();
    observeAuthState((user) => {
        if (!user || initializedUid === user.uid) return;
        initializedUid = user.uid;
        dataStore = createUserDataStore(user.uid);
        cacheChannel?.close();
        cacheChannel = createUserCacheChannel(user.uid, handleCrossTabCacheMessage);
        selectedStorageKey = `${STORAGE_KEY}:${user.uid}`;
        selectedId = localStorage.getItem(selectedStorageKey);
        fetchTickers((endpoint) => request(endpoint))
            .then((items) => {
                tickerReady = Array.isArray(items) && items.length > 0;
                metadata = new Map((items || []).map((item) => [normalizeTicker(item.symbol), item]));
                renderTable(rankedResults());
            })
            .catch(() => { tickerReady = false; });
        void loadWatchlists();
    });
});
