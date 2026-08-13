import { apiCall, setButtonState } from "./api.js";
import { getCachedFinancialData, setCachedFinancialData } from "./cache.js";
import { debounce, fetchTickers, isValidTicker, isTickerSyntaxValid, buildTickerQueryUrl, showTickerSuggestions, hideTickerSuggestions, getLogoUrl, onLogoLoad, onLogoError } from "./ticker.js";
import {
    createChart,
    filterChartDataByPeriod,
    openFullscreen,
    updateGrowthBadges,
    parseFiniteNumber,
    formatCanonicalPeriod,
    buildPeriodValuePairs,
    buildPerShareValuePairs,
    alignPeriodValueSeries,
    registerChartInstance,
    destroyChart,
    destroyChartsWithin,
    cancelFullscreenRender,
    scheduleFullscreenChartRender
} from "./charts.js";
import { showToast } from "./toast.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";

window.addEventListener("DOMContentLoaded", async () => {
    const els = {
        tickerInput: document.getElementById("financialTickerInput"),
        searchBtn: document.getElementById("getFinancialDataBtn"),
        autocomplete: document.getElementById("tickerAutocomplete"),
        companyInfo: document.getElementById("financialCompanyInfo"),
        logo: document.getElementById("financialCompanyLogo"),
        companyName: document.getElementById("financialCompanyName"),
        companyTicker: document.getElementById("financialCompanyTicker"),
        companyPrice: document.getElementById("financialCompanyPrice"),
        companyChange: document.getElementById("financialPriceChange"),
        metricsSection: document.getElementById("financialMetricsSection"),
        chartsGrid: document.getElementById("chartsGrid"),
        fullscreenModal: document.getElementById("fullscreen-chart-modal"),
        fullscreenCanvas: document.getElementById("fullscreen-canvas"),
        closeFullscreenBtn: document.getElementById("close-fullscreen-btn"),
        fullscreenCompanyLogo: document.getElementById("fullscreen-company-logo"),
        fullscreenChartTitle: document.getElementById("fullscreen-chart-title"),
        fullscreenPeriodBtn: document.getElementById("fullscreen-period-btn"),
        fullscreenPeriodMenu: document.getElementById("fullscreen-period-menu"),
        fullscreenPeriodText: document.getElementById("fullscreen-period-text"),
        fullscreenGrowth1y: document.getElementById("fullscreen-growth-1y"),
        fullscreenGrowth2y: document.getElementById("fullscreen-growth-2y"),
        fullscreenGrowth5y: document.getElementById("fullscreen-growth-5y"),
        fullscreenGrowth10y: document.getElementById("fullscreen-growth-10y"),
        toastContainer: document.getElementById("toast-container"),
        quarterlyBtn: document.getElementById("quarterlyBtn"),
        quarterlyTTMBtn: document.getElementById("quarterlyTTMBtn"),
        annuallyBtn: document.getElementById("annuallyBtn"),
        fcfToggleContainer: document.getElementById("fcf-toggle-container"),
        periodToggle: document.getElementById("financialPeriodToggle")
    };

    const growthElements = {
        growth1y: els.fullscreenGrowth1y,
        growth2y: els.fullscreenGrowth2y,
        growth5y: els.fullscreenGrowth5y,
        growth10y: els.fullscreenGrowth10y
    };
    const fullscreenState = {
        activeFullscreenChart: null,
        currentFullscreenTitle: "",
        currentFullscreenData: null,
        currentFullscreenPeriod: "all"
    };
    const fullChartDataStore = {};

    let strictTickerValidation = false;
    let companyNameForFullscreen = "";

    function setStatus(_message, _isError = false) {
        // Status feedback is handled by showToast; this is a no-op stub.
    }

    // Period view and cached data state
    let currentPeriodView = "quarterly";
    let cachedBasicData = null;
    let cachedSegmentData = null;
    let cachedTTMData = null;
    let cachedTTMSegmentData = null;

    // Price and FCF stored data for charts and toggle
    let storedPriceHistory = null;
    let storedYearChangePct = null;
    let storedFullFCFData = null;
    let storedFullAdjustedFCFData = null;
    let storedFullFCFAndSBCData = null;
    let storedFullFCFPerShareData = null;
    let storedFullSBCAdjFCFPerShareData = null;
    let currentFCFView = "fcf";
    let financialLoadGeneration = 0;
    let financialLoadPending = false;
    let activeTickerSuggestion = -1;

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

    function safePercent(value) {
        return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "-";
    }

    function safeMoney(value) {
        if (!Number.isFinite(value)) return "-";
        const abs = Math.abs(value);
        if (abs >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
        if (abs >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
        if (abs >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
        if (abs >= 1e3) return `$${(value / 1e3).toFixed(2)}K`;
        return `$${value.toFixed(2)}`;
    }

    function safeNumber(value) {
        return Number.isFinite(value) ? value.toFixed(2) : "-";
    }

    function fillMetric(id, value) {
        const node = document.getElementById(id);
        if (node) node.textContent = value;
    }

    function renderMetrics(info = {}) {
        fillMetric("metricMarketCap", safeMoney(info.marketCap));
        fillMetric("metricPE", `${safeNumber(info.trailingPE)} | ${safeNumber(info.forwardPE)}`);
        fillMetric("metricPriceToSales", safeNumber(info.priceToSales));
        fillMetric("metricEvToEbitda", safeNumber(info.evToEbitda));
        fillMetric("metricPriceToBook", safeNumber(info.priceToBook));
        fillMetric("metricFcfYield", safePercent(info.freeCashFlowYield));
        fillMetric("metricSbcAdjFcfYield", safePercent(info.sbcAdjFreeCashFlowYield));
        fillMetric("metricSbcImpact", Number.isFinite(info.sbcImpact) ? `-${Math.abs(info.sbcImpact * 100).toFixed(2)}%` : "-");
        fillMetric("metricProfitMargin", safePercent(info.profitMargin));
        fillMetric("metricOperatingMargin", safePercent(info.operatingMargin));
        fillMetric("metricEarningsGrowth", safePercent(info.earningsQuarterlyGrowth));
        fillMetric("metricRevenueGrowth", safePercent(info.revenueGrowth));
        fillMetric("metricCash", safeMoney(info.totalCash));
        fillMetric("metricDebt", safeMoney(info.totalDebt));
        fillMetric("metricNet", Number.isFinite(info.net) ? safeMoney(info.net) : "-");
        fillMetric("metricDividendYield", safePercent(info.dividendYield));
        fillMetric("metricPayoutRatio", safePercent(info.payoutRatio));
        fillMetric("metricPayoutDate", info.payoutDate ? new Date(info.payoutDate).toLocaleDateString("en-US") : "-");
    }

    // ---- Chart helpers (ported from LOCAL_index.html) ----

    function createRevenueChart(geoData, maxBars) {
        const allDates = Object.keys(geoData).sort((a, b) => {
            const parseKey = (key) => {
                const ttmMatch = key.match(/^(Q[1-4])_(\d{4})_TTM$/);
                if (ttmMatch) {
                    const periodOrder = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
                    return { type: "period", year: parseInt(ttmMatch[2]), order: periodOrder[ttmMatch[1]] || 0 };
                }
                const periodMatch = key.match(/^(Q[1-4]|FY)_(\d{4})$/);
                if (periodMatch) {
                    const periodOrder = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 5 };
                    return { type: "period", year: parseInt(periodMatch[2]), order: periodOrder[periodMatch[1]] || 0 };
                }
                const dateMatch = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (dateMatch) return { type: "date", date: new Date(key) };
                return { type: "unknown" };
            };
            const aParsed = parseKey(a);
            const bParsed = parseKey(b);
            if (aParsed.type === "period" && bParsed.type === "period") {
                if (aParsed.year !== bParsed.year) return aParsed.year - bParsed.year;
                return aParsed.order - bParsed.order;
            }
            if (aParsed.type === "date" && bParsed.type === "date") return aParsed.date - bParsed.date;
            return 0;
        });

        const datesWithTotal = allDates.filter(date => {
            const dateData = geoData[date];
            if (!dateData || dateData.Total === undefined || dateData.Total === null) return false;
            const totalValue = parseFiniteNumber(dateData.Total);
            return totalValue !== null && totalValue > 0;
        });

        if (datesWithTotal.length === 0) return null;

        const limitedDates = datesWithTotal.slice(-maxBars);

        const labels = limitedDates.map(date => {
            const ttmMatch = date.match(/^(Q[1-4])_(\d{4})_TTM$/);
            if (ttmMatch) return `${ttmMatch[1]} ${ttmMatch[2]}`;
            const periodMatch = date.match(/^(Q[1-4]|FY)_(\d{4})$/);
            if (periodMatch) {
                if (periodMatch[1] === "FY") return periodMatch[2];
                return `${periodMatch[1]} ${periodMatch[2]}`;
            }
            const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (dateMatch) {
                const segmentInfo = geoData[date];
                if (segmentInfo && segmentInfo._fiscal_period && segmentInfo._fiscal_year) {
                    const period = segmentInfo._fiscal_period;
                    const year = segmentInfo._fiscal_year;
                    if (period === "FY") return year.toString();
                    return `${period} ${year}`;
                }
                const year = dateMatch[1];
                const month = parseInt(dateMatch[2]);
                const quarterMap = { 3: "Q1", 6: "Q2", 9: "Q3", 12: "Q4" };
                return `${quarterMap[month] || `M${month}`} ${year}`;
            }
            return date;
        });

        const data = limitedDates.map(date => {
            const value = geoData[date]?.Total;
            if (value === undefined || value === null) return 0;
            const parsed = parseFiniteNumber(value);
            return parsed ?? 0;
        });

        return {
            title: "Revenue",
            data: { labels, data, type: "bar", backgroundColor: "rgba(230, 174, 85, 1)", borderColor: "rgba(230, 174, 85, 1)" }
        };
    }

    function createSegmentChart(title, typeData, colors, stacked, maxBars = 16) {
        const allDates = Object.keys(typeData).sort((a, b) => {
            const parseKey = (key) => {
                const ttmMatch = key.match(/^(Q[1-4])_(\d{4})_TTM$/);
                if (ttmMatch) {
                    const periodOrder = { Q1: 1, Q2: 2, Q3: 3, Q4: 4 };
                    return { type: "period", year: parseInt(ttmMatch[2]), order: periodOrder[ttmMatch[1]] || 0 };
                }
                const periodMatch = key.match(/^(Q[1-4]|FY)_(\d{4})$/);
                if (periodMatch) {
                    const periodOrder = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 5 };
                    return { type: "period", year: parseInt(periodMatch[2]), order: periodOrder[periodMatch[1]] || 0 };
                }
                const dateMatch = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                if (dateMatch) return { type: "date", date: new Date(key) };
                return { type: "unknown" };
            };
            const aParsed = parseKey(a);
            const bParsed = parseKey(b);
            if (aParsed.type === "period" && bParsed.type === "period") {
                if (aParsed.year !== bParsed.year) return aParsed.year - bParsed.year;
                return aParsed.order - bParsed.order;
            }
            if (aParsed.type === "date" && bParsed.type === "date") return aParsed.date - bParsed.date;
            return 0;
        });

        const filteredDates = allDates.filter(date => {
            const dateData = typeData[date];
            if (!dateData) return false;
            return Object.keys(dateData).some(key => {
                if (key === "Total" || key.startsWith("_")) return false;
                const value = dateData[key];
                if (value === undefined || value === null) return false;
                const parsed = parseFiniteNumber(value);
                return parsed !== null && parsed !== 0;
            });
        });

        const dates = filteredDates.slice(-maxBars);
        if (dates.length === 0) return { title, data: { labels: [], datasets: [], type: "bar", stacked } };

        const formattedLabels = dates.map(date => {
            const ttmMatch = date.match(/^(Q[1-4])_(\d{4})_TTM$/);
            if (ttmMatch) return `${ttmMatch[1]} ${ttmMatch[2]}`;
            const periodMatch = date.match(/^(Q[1-4]|FY)_(\d{4})$/);
            if (periodMatch) {
                if (periodMatch[1] === "FY") return periodMatch[2];
                return `${periodMatch[1]} ${periodMatch[2]}`;
            }
            const dateMatch = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (dateMatch) {
                const segmentInfo = typeData[date];
                if (segmentInfo && segmentInfo._fiscal_period && segmentInfo._fiscal_year) {
                    const period = segmentInfo._fiscal_period;
                    const year = segmentInfo._fiscal_year;
                    if (period === "FY") return year.toString();
                    return `${period} ${year}`;
                }
                const year = dateMatch[1];
                const month = parseInt(dateMatch[2]);
                const quarterMap = { 3: "Q1", 6: "Q2", 9: "Q3", 12: "Q4" };
                return `${quarterMap[month] || `M${month}`} ${year}`;
            }
            return date;
        });

        const allSegmentNames = new Set();
        dates.forEach(date => {
            Object.keys(typeData[date]).forEach(name => {
                if (name !== "Total" && !name.startsWith("_")) allSegmentNames.add(name);
            });
        });

        let sortingDate = dates[0];
        let maxSegsFound = 0;
        for (const date of dates) {
            const segsInDate = Object.keys(typeData[date]).filter(s => s !== "Total" && !s.startsWith("_") && allSegmentNames.has(s));
            if (segsInDate.length > maxSegsFound) {
                maxSegsFound = segsInDate.length;
                sortingDate = date;
                if (segsInDate.length === allSegmentNames.size) break;
            }
        }

        const sortedSegmentNames = Array.from(allSegmentNames).sort((a, b) => {
            const valueA = parseFiniteNumber(typeData[sortingDate]?.[a]) ?? 0;
            const valueB = parseFiniteNumber(typeData[sortingDate]?.[b]) ?? 0;
            return valueB - valueA;
        });

        const colorPalette = [
            "rgba(223, 114, 66, 1)",
            "rgba(232, 162, 113, 1)",
            "rgba(236, 217, 177, 1)",
            "rgba(145, 175, 166, 1)",
            "rgba(74, 143, 153, 1)",
            "rgba(47, 88, 149, 1)"
        ];

        const datasets = sortedSegmentNames.map((segmentName, index) => {
            const data = dates.map(date => {
                const value = typeData[date]?.[segmentName];
                if (value === undefined || value === null) return 0;
                const parsed = parseFiniteNumber(value);
                return parsed ?? 0;
            });
            return { label: segmentName, data, backgroundColor: colorPalette[index % colorPalette.length] };
        });

        return { title, data: { labels: formattedLabels, datasets, type: "bar", stacked } };
    }

    function renderPriceChart() {
        const priceRows = (Array.isArray(storedPriceHistory) ? storedPriceHistory : [])
            .map((row) => ({ date: String(row?.date || ""), price: parseFiniteNumber(row?.price) }))
            .filter((row) => row.date && row.price !== null);
        if (priceRows.length === 0) return;

        const isPositive = (storedYearChangePct === null ? 0 : storedYearChangePct) >= 0;
        const changeIcon = isPositive ? "↑" : "↓";
        const changeClass = isPositive ? "" : "negative";
        const changePctDisplay = storedYearChangePct !== null ? `${storedYearChangePct.toFixed(2)}%` : "";

        const priceChartCard = document.createElement("div");
        priceChartCard.className = "price-chart-card";
        priceChartCard.innerHTML = `
            <div class="price-chart-card-header">
                <div class="price-chart-header-left">
                    <span class="price-chart-title">Price</span>
                    <span class="price-chart-change-badge ${changeClass}">${changeIcon} ${changePctDisplay}</span>
                </div>
                <button class="financial-chart-expand-btn" title="Expand chart">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                    </svg>
                </button>
            </div>
            <div class="price-chart-body"><canvas></canvas></div>
        `;
        els.chartsGrid.appendChild(priceChartCard);

        const labels = priceRows.map((row) => row.date);
        const prices = priceRows.map((row) => row.price);
        const priceChartData = {
            labels, data: prices, type: "line",
            backgroundColor: "rgba(140, 208, 126, 1)",
            borderColor: "rgba(50, 189, 24, 1)"
        };
        fullChartDataStore["Price"] = priceChartData;

        const canvas = priceChartCard.querySelector("canvas");
        const ctx = canvas.getContext("2d");
        const priceChart = new Chart(ctx, {
            type: "line",
            data: {
                labels,
                datasets: [{
                    label: "Price", data: prices,
                    borderColor: "rgba(50, 189, 24, 1)",
                    backgroundColor: "rgba(140, 208, 126, 0.2)",
                    borderWidth: 2, fill: true, tension: 0.1, pointRadius: 0, pointHoverRadius: 4
                }]
            },
            options: {
                responsive: true, maintainAspectRatio: false, animation: false,
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                interaction: { mode: null, intersect: false },
                scales: {
                    y: {
                        display: true,
                        grid: { color: "rgba(34, 197, 94, 0.1)" },
                        ticks: { color: "#3c4145", font: { size: 11, weight: "500" }, callback: value => "$" + value.toLocaleString() }
                    },
                    x: {
                        display: true, grid: { display: false },
                        ticks: { color: "#3c4145", font: { size: 11 }, maxRotation: 40, minRotation: 40, maxTicksLimit: 12 }
                    }
                }
            }
        });
        priceChart.__financialCanvas = canvas;
        registerChartInstance(priceChart);

        priceChartCard.querySelector(".financial-chart-expand-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            openFinancialFullscreen("Price", priceChartData, e.currentTarget);
            if (els.fcfToggleContainer) els.fcfToggleContainer.classList.add("hidden");
        });
    }

    function filterDataByPeriod(data, periodView, ttmData = null) {
        if (periodView === "quarterlyTTM") {
            if (Array.isArray(ttmData) && ttmData.length > 0) return ttmData;
            return [];
        }
        if (!Array.isArray(data) || data.length === 0) return Array.isArray(data) ? data : [];
        return data.filter(item => {
            let fiscalPeriod = String(item.fiscal_period || "").trim().toUpperCase();
            const periodKey = String(item.period || item.period_key || "");
            const keyMatch = periodKey.match(/^(Q[1-4]|FY)_\d{4}$/i);
            if (!fiscalPeriod && keyMatch) fiscalPeriod = keyMatch[1].toUpperCase();
            if (!fiscalPeriod) {
                const dateValue = item.end || item.period_end || item.date;
                const dateMatch = String(dateValue || "").match(/^\d{4}-(\d{2})-\d{2}$/);
                if (dateMatch) {
                    const month = Number.parseInt(dateMatch[1], 10);
                    fiscalPeriod = month === 12 ? "FY" : `Q${Math.min(4, Math.max(1, Math.ceil(month / 3)))}`;
                }
            }
            if (periodView === "annually") return fiscalPeriod === "FY";
            return ["Q1", "Q2", "Q3", "Q4"].includes(fiscalPeriod);
        });
    }

    function inferSegmentPeriod(periodKey, entry = {}) {
        const explicitPeriod = String(entry.fiscal_period || entry._fiscal_period || "").trim().toUpperCase();
        const explicitYear = Number.parseInt(entry.fiscal_year || entry._fiscal_year, 10);
        const keyMatch = String(periodKey || "").match(/^(Q[1-4]|FY)_(\d{4})(?:_TTM)?$/i);
        if (keyMatch) {
            return { period: explicitPeriod || keyMatch[1].toUpperCase(), year: explicitYear || Number.parseInt(keyMatch[2], 10) };
        }
        if (explicitPeriod && Number.isInteger(explicitYear)) {
            return { period: explicitPeriod, year: explicitYear };
        }
        const dateMatch = String(periodKey || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!dateMatch) return { period: explicitPeriod, year: explicitYear };
        const month = Number.parseInt(dateMatch[2], 10);
        const quarter = Math.min(4, Math.max(1, Math.ceil(month / 3)));
        return { period: month === 12 ? "FY" : `Q${quarter}`, year: Number.parseInt(dateMatch[1], 10) };
    }

    function cleanSegmentValues(values) {
        if (!values || typeof values !== "object") return null;
        const cleaned = {};
        Object.entries(values).forEach(([name, value]) => {
            if (name.startsWith("_") || name === "fiscal_period" || name === "fiscal_year") return;
            const parsed = parseFiniteNumber(value);
            if (parsed !== null) cleaned[name] = parsed;
        });
        return Object.keys(cleaned).length > 0 ? cleaned : null;
    }

    function filterSegmentDataByPeriod(segmentData, periodView, ttmSegmentData = null) {
        const source = periodView === "quarterlyTTM" ? ttmSegmentData : segmentData;
        if (!source || typeof source !== "object") return null;

        const segmentTypes = ["geographic", "product", "business"];
        const transformedData = Object.fromEntries(segmentTypes.map((type) => [type, {}]));
        const hasTopLevelTypes = segmentTypes.some((type) => source[type] && typeof source[type] === "object");

        const includePeriod = (period) => periodView === "quarterlyTTM"
            || (periodView === "annually" ? period === "FY" : ["Q1", "Q2", "Q3", "Q4"].includes(period));

        const addEntry = (segmentType, periodKey, values, metadata = {}) => {
            const cleaned = cleanSegmentValues(values);
            if (!cleaned) return;
            transformedData[segmentType][periodKey] = {
                ...cleaned,
                _fiscal_period: metadata.period || undefined,
                _fiscal_year: metadata.year || undefined
            };
        };

        if (hasTopLevelTypes) {
            segmentTypes.forEach((segmentType) => {
                const entries = source[segmentType];
                if (!entries || typeof entries !== "object") return;
                Object.entries(entries).forEach(([periodKey, values]) => {
                    const metadata = inferSegmentPeriod(periodKey, values);
                    if (includePeriod(metadata.period)) addEntry(segmentType, periodKey, values, metadata);
                });
            });
        } else {
            Object.entries(source).forEach(([periodKey, entry]) => {
                if (!entry || typeof entry !== "object") return;
                const metadata = inferSegmentPeriod(periodKey, entry);
                if (!includePeriod(metadata.period)) return;
                segmentTypes.forEach((segmentType) => {
                    if (entry[segmentType]) addEntry(segmentType, periodKey, entry[segmentType], metadata);
                });
            });
        }

        const availableTypes = Object.fromEntries(
            segmentTypes
                .filter((type) => Object.keys(transformedData[type]).length > 0)
                .map((type) => [type, transformedData[type]])
        );
        return Object.keys(availableTypes).length > 0 ? availableTypes : null;
    }

    function updatePeriodView(newView) {
        if (currentPeriodView === newView) return;
        const scrollY = window.scrollY;
        currentPeriodView = newView;

        els.quarterlyBtn.classList.toggle("active", newView === "quarterly");
        els.quarterlyTTMBtn.classList.toggle("active", newView === "quarterlyTTM");
        els.annuallyBtn.classList.toggle("active", newView === "annually");
        els.quarterlyBtn.setAttribute("aria-pressed", String(newView === "quarterly"));
        els.quarterlyTTMBtn.setAttribute("aria-pressed", String(newView === "quarterlyTTM"));
        els.annuallyBtn.setAttribute("aria-pressed", String(newView === "annually"));

        if (cachedBasicData || cachedTTMData) {
            renderCombinedCharts(
                filterDataByPeriod(cachedBasicData, currentPeriodView, cachedTTMData),
                filterSegmentDataByPeriod(cachedSegmentData, currentPeriodView, cachedTTMSegmentData)
            );
            requestAnimationFrame(() => window.scrollTo(0, scrollY));
        }
    }

    function buildFullscreenContext() {
        return {
            state: fullscreenState,
            dataStore: fullChartDataStore,
            periodView: currentPeriodView,
            financialTickerInput: els.tickerInput,
            fullscreenModal: els.fullscreenModal,
            fullscreenCanvas: els.fullscreenCanvas,
            fullscreenCompanyLogo: els.fullscreenCompanyLogo,
            fullscreenChartTitle: els.fullscreenChartTitle,
            fullscreenPeriodText: els.fullscreenPeriodText,
            fullscreenPeriodMenu: els.fullscreenPeriodMenu,
            growthElements
        };
    }

    function focusableFullscreenElements() {
        return [...els.fullscreenModal.querySelectorAll(
            "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex=\"-1\"])"
        )].filter((element) => !element.closest(".hidden") && element.getAttribute("aria-hidden") !== "true");
    }

    function openFinancialFullscreen(title, chartData, trigger) {
        fullscreenState.lastFocusedElement = trigger || document.activeElement;
        fullscreenState.fullscreenModal = els.fullscreenModal;
        openFullscreen(title, chartData, buildFullscreenContext());
        els.fullscreenModal.setAttribute("aria-hidden", "false");
        els.closeFullscreenBtn.focus();
    }

    function closeFinancialFullscreen() {
        if (els.fullscreenModal.classList.contains("hidden")) return;
        els.fullscreenModal.classList.add("hidden");
        els.fullscreenModal.setAttribute("aria-hidden", "true");
        cancelFullscreenRender(fullscreenState);
        destroyChart(fullscreenState.activeFullscreenChart);
        fullscreenState.activeFullscreenChart = null;
        fullscreenState.currentFullscreenTitle = "";
        fullscreenState.currentFullscreenData = null;
        fullscreenState.currentFullscreenPeriod = "all";
        if (els.fcfToggleContainer) els.fcfToggleContainer.classList.add("hidden");
        currentFCFView = "fcf";
        const restoreTarget = fullscreenState.lastFocusedElement;
        fullscreenState.lastFocusedElement = null;
        if (restoreTarget?.isConnected && typeof restoreTarget.focus === "function") restoreTarget.focus();
    }

    function renderCombinedCharts(basicData, segmentData) {
        destroyChartsWithin(els.chartsGrid);
        els.chartsGrid.innerHTML = "";

        // Reset all stored FCF data and full chart data store
        storedFullFCFData = null;
        storedFullAdjustedFCFData = null;
        storedFullFCFAndSBCData = null;
        storedFullFCFPerShareData = null;
        storedFullSBCAdjFCFPerShareData = null;
        Object.keys(fullChartDataStore).forEach(key => delete fullChartDataStore[key]);

        // Price chart renders first using separately-stored history
        if (storedPriceHistory && storedPriceHistory.length > 0) {
            renderPriceChart();
        }

        if (!Array.isArray(basicData) || basicData.length === 0) {
            if (!storedPriceHistory || storedPriceHistory.length === 0) {
                els.chartsGrid.innerHTML = "<p class=\"chart-message chart-empty-state\">No chartable financial data is available for this period.</p>";
            } else {
                els.chartsGrid.insertAdjacentHTML("beforeend", "<p class=\"chart-message chart-empty-state\">No financial statement data is available for this period.</p>");
            }
            return;
        }

        const sortedData = [...basicData].sort((a, b) => {
            const yearA = parseInt(a.fiscal_year) || 0;
            const yearB = parseInt(b.fiscal_year) || 0;
            if (yearA !== yearB) return yearA - yearB;
            const periodOrder = { Q1: 1, Q2: 2, Q3: 3, Q4: 4, FY: 5 };
            return (periodOrder[a.fiscal_period] || 0) - (periodOrder[b.fiscal_period] || 0);
        });

        const formatPeriodLabel = (d) => {
            const period = d.fiscal_period || "";
            const year = d.fiscal_year || "";
            if (period === "FY") return year.toString();
            return `${period} ${year}`;
        };

        const maxBars = currentPeriodView === "annually" ? 10 : 16;
        const limitedData = sortedData.slice(-maxBars);
        const hasFiniteFact = (record, factName) => parseFiniteNumber(record?.facts?.[factName]?.value) !== null;

        const colors = [
            "rgba(54, 162, 235, 0.8)", "rgba(255, 99, 132, 0.8)", "rgba(75, 192, 192, 0.8)",
            "rgba(255, 206, 86, 0.8)", "rgba(153, 102, 255, 0.8)", "rgba(255, 159, 64, 0.8)",
            "rgba(46, 204, 113, 0.8)", "rgba(155, 89, 182, 0.8)", "rgba(52, 152, 219, 0.8)",
            "rgba(230, 126, 34, 0.8)", "rgba(231, 76, 60, 0.8)", "rgba(149, 165, 166, 0.8)"
        ];

        const chartOrder = [];
        const hasChartSeries = (chart) => Boolean(
            chart?.data?.labels?.length
            && (chart.data.datasets?.length || chart.data.data?.length)
        );

        // Revenue (from geographic Total)
        if (segmentData && segmentData.geographic && Object.keys(segmentData.geographic).length > 0) {
            const geoKeyCount = Object.keys(segmentData.geographic).length;
            const revenueChart = createRevenueChart(segmentData.geographic, maxBars);
            const revenueChartFull = createRevenueChart(segmentData.geographic, geoKeyCount);
            if (revenueChart) {
                chartOrder.push(revenueChart);
                if (revenueChartFull) fullChartDataStore["Revenue"] = revenueChartFull.data;
            }
        }

        // Revenue by Product
        if (segmentData && segmentData.product && Object.keys(segmentData.product).length > 0) {
            const productKeyCount = Object.keys(segmentData.product).length;
            const productChart = createSegmentChart("Revenue by Product", segmentData.product, colors, true, maxBars);
            if (hasChartSeries(productChart)) chartOrder.push(productChart);
            const productFull = createSegmentChart("Revenue by Product", segmentData.product, colors, true, productKeyCount);
            if (hasChartSeries(productFull)) fullChartDataStore["Revenue by Product"] = productFull.data;
        }

        // Revenue by Geography
        if (segmentData && segmentData.geographic && Object.keys(segmentData.geographic).length > 0) {
            const geoSegKeyCount = Object.keys(segmentData.geographic).length;
            const geoChart = createSegmentChart("Revenue by Geography", segmentData.geographic, colors, true, maxBars);
            if (hasChartSeries(geoChart)) chartOrder.push(geoChart);
            const geoFull = createSegmentChart("Revenue by Geography", segmentData.geographic, colors, true, geoSegKeyCount);
            if (hasChartSeries(geoFull)) fullChartDataStore["Revenue by Geography"] = geoFull.data;
        }

        // Revenue by Business
        if (segmentData && segmentData.business && Object.keys(segmentData.business).length > 0) {
            const bizKeyCount = Object.keys(segmentData.business).length;
            const bizChart = createSegmentChart("Revenue by Business", segmentData.business, colors, true, maxBars);
            if (hasChartSeries(bizChart)) chartOrder.push(bizChart);
            const bizFull = createSegmentChart("Revenue by Business", segmentData.business, colors, true, bizKeyCount);
            if (hasChartSeries(bizFull)) fullChartDataStore["Revenue by Business"] = bizFull.data;
        }

        // Earnings Per Share
        const epsData = limitedData.filter(d => hasFiniteFact(d, "EarningsPerShareBasic") || hasFiniteFact(d, "EarningsPerShareDiluted"));
        const epsDataFull = sortedData.filter(d => hasFiniteFact(d, "EarningsPerShareBasic") || hasFiniteFact(d, "EarningsPerShareDiluted"));
        if (epsData.length > 0) {
            chartOrder.push({
                title: "Earnings Per Share",
                data: {
                    labels: epsData.map(formatPeriodLabel),
                    datasets: [
                        { label: "EPS Basic", data: epsData.map(d => d.facts?.EarningsPerShareBasic ? parseFiniteNumber(d.facts.EarningsPerShareBasic.value) : null), backgroundColor: "rgba(240, 206, 99, 1)" },
                        { label: "EPS Diluted", data: epsData.map(d => d.facts?.EarningsPerShareDiluted ? parseFiniteNumber(d.facts.EarningsPerShareDiluted.value) : null), backgroundColor: "rgba(255, 99, 132, 1)", hidden: true }
                    ],
                    type: "bar"
                }
            });
            fullChartDataStore["Earnings Per Share"] = {
                labels: epsDataFull.map(formatPeriodLabel),
                datasets: [
                    { label: "EPS Basic", data: epsDataFull.map(d => d.facts?.EarningsPerShareBasic ? parseFiniteNumber(d.facts.EarningsPerShareBasic.value) : null), backgroundColor: "rgba(240, 206, 99, 1)" },
                    { label: "EPS Diluted", data: epsDataFull.map(d => d.facts?.EarningsPerShareDiluted ? parseFiniteNumber(d.facts.EarningsPerShareDiluted.value) : null), backgroundColor: "rgba(255, 99, 132, 1)", hidden: true }
                ],
                type: "bar"
            };
        }

        // Net Income
        const netIncomeData = limitedData.filter(d => hasFiniteFact(d, "NetIncomeLoss"));
        const netIncomeDataFull = sortedData.filter(d => hasFiniteFact(d, "NetIncomeLoss"));
        if (netIncomeData.length > 0) {
            chartOrder.push({ title: "Net Income", data: { labels: netIncomeData.map(formatPeriodLabel), data: netIncomeData.map(d => parseFiniteNumber(d.facts.NetIncomeLoss.value)), type: "bar", backgroundColor: "rgba(254, 190, 125, 1)" } });
            fullChartDataStore["Net Income"] = { labels: netIncomeDataFull.map(formatPeriodLabel), data: netIncomeDataFull.map(d => parseFiniteNumber(d.facts.NetIncomeLoss.value)), type: "bar", backgroundColor: "rgba(254, 190, 125, 1)" };
        }

        const periodPairsToChart = (pairs, style) => ({
            labels: pairs.map((pair) => formatCanonicalPeriod(pair.period)),
            data: pairs.map((pair) => pair.value),
            type: "bar",
            ...style
        });

        // Free Cash Flow, adjusted FCF, and related series are keyed by the
        // canonical fiscal period so a missing fact cannot shift later values.
        const fcfPairs = buildPeriodValuePairs(sortedData, "FreeCashFlow");
        if (fcfPairs.length > 0) {
            const fcfStyle = { backgroundColor: "rgba(243, 143, 42, 1)", borderColor: "rgba(243, 143, 42, 1)" };
            const fcfLimited = periodPairsToChart(fcfPairs.slice(-maxBars), fcfStyle);
            storedFullFCFData = periodPairsToChart(fcfPairs, fcfStyle);
            fullChartDataStore["Free Cash Flow"] = storedFullFCFData;
            chartOrder.push({ title: "Free Cash Flow", data: fcfLimited });
        }

        const adjustedFcfPairs = buildPeriodValuePairs(sortedData, "AdjustedFreeCashFlow");
        if (adjustedFcfPairs.length > 0) {
            storedFullAdjustedFCFData = periodPairsToChart(adjustedFcfPairs, {
                backgroundColor: "rgba(160, 203, 232, 1)",
                borderColor: "rgba(160, 203, 232, 1)"
            });
        }

        const alignedFcfAndSbc = alignPeriodValueSeries([
            { label: "FCF", pairs: fcfPairs, style: { backgroundColor: "rgba(243, 143, 42, 1)" } },
            { label: "SBC", pairs: buildPeriodValuePairs(sortedData, "ShareBasedCompensation"), style: { backgroundColor: "rgba(160, 203, 232, 1)" } }
        ]);
        if (alignedFcfAndSbc.periods.length > 0) {
            storedFullFCFAndSBCData = { labels: alignedFcfAndSbc.labels, datasets: alignedFcfAndSbc.datasets, type: "bar" };
        }

        const fcfPerSharePairs = buildPerShareValuePairs(sortedData, "FreeCashFlow");
        if (fcfPerSharePairs.length > 0) {
            storedFullFCFPerShareData = periodPairsToChart(fcfPerSharePairs, {
                backgroundColor: "rgba(243, 143, 42, 1)",
                borderColor: "rgba(243, 143, 42, 1)"
            });
        }
        const adjustedFcfPerSharePairs = buildPerShareValuePairs(sortedData, "AdjustedFreeCashFlow");
        if (adjustedFcfPerSharePairs.length > 0) {
            storedFullSBCAdjFCFPerShareData = periodPairsToChart(adjustedFcfPerSharePairs, {
                backgroundColor: "rgba(160, 203, 232, 1)",
                borderColor: "rgba(160, 203, 232, 1)"
            });
        }

        // Cash & Debt
        const cashDebtData = limitedData.filter(d => hasFiniteFact(d, "CashCashEquivalentsAndShortTermInvestments") || hasFiniteFact(d, "LongTermDebtNoncurrent"));
        const cashDebtDataFull = sortedData.filter(d => hasFiniteFact(d, "CashCashEquivalentsAndShortTermInvestments") || hasFiniteFact(d, "LongTermDebtNoncurrent"));
        if (cashDebtData.length > 0) {
            chartOrder.push({
                title: "Cash & Debt",
                data: {
                    labels: cashDebtData.map(formatPeriodLabel),
                    datasets: [
                        { label: "Cash", data: cashDebtData.map(d => d.facts?.CashCashEquivalentsAndShortTermInvestments ? parseFiniteNumber(d.facts.CashCashEquivalentsAndShortTermInvestments.value) : null), backgroundColor: "rgba(85, 158, 56, 1)" },
                        { label: "Debt", data: cashDebtData.map(d => d.facts?.LongTermDebtNoncurrent ? parseFiniteNumber(d.facts.LongTermDebtNoncurrent.value) : null), backgroundColor: "rgb(250, 86, 78, 1)" }
                    ],
                    type: "bar"
                }
            });
            fullChartDataStore["Cash & Debt"] = {
                labels: cashDebtDataFull.map(formatPeriodLabel),
                datasets: [
                    { label: "Cash", data: cashDebtDataFull.map(d => d.facts?.CashCashEquivalentsAndShortTermInvestments ? parseFiniteNumber(d.facts.CashCashEquivalentsAndShortTermInvestments.value) : null), backgroundColor: "rgba(85, 158, 56, 1)" },
                    { label: "Debt", data: cashDebtDataFull.map(d => d.facts?.LongTermDebtNoncurrent ? parseFiniteNumber(d.facts.LongTermDebtNoncurrent.value) : null), backgroundColor: "rgb(250, 86, 78, 1)" }
                ],
                type: "bar"
            };
        }

        // CapEx
        const capexData = limitedData.filter(d => hasFiniteFact(d, "CapEx"));
        const capexDataFull = sortedData.filter(d => hasFiniteFact(d, "CapEx"));
        if (capexData.length > 0) {
            chartOrder.push({ title: "CapEx", data: { labels: capexData.map(formatPeriodLabel), data: capexData.map(d => parseFiniteNumber(d.facts.CapEx.value)), type: "bar", backgroundColor: "rgb(52, 152, 219, 1)", borderColor: "rgb(52, 152, 219, 1)" } });
            fullChartDataStore["CapEx"] = { labels: capexDataFull.map(formatPeriodLabel), data: capexDataFull.map(d => parseFiniteNumber(d.facts.CapEx.value)), type: "bar", backgroundColor: "rgb(52, 152, 219, 1)", borderColor: "rgb(52, 152, 219, 1)" };
        }

        // Shares Outstanding
        const sharesData = limitedData.filter(d => hasFiniteFact(d, "SharesOutstanding"));
        const sharesDataFull = sortedData.filter(d => hasFiniteFact(d, "SharesOutstanding"));
        if (sharesData.length > 0) {
            chartOrder.push({ title: "Shares Outstanding", data: { labels: sharesData.map(formatPeriodLabel), data: sharesData.map(d => parseFiniteNumber(d.facts.SharesOutstanding.value)), type: "bar", backgroundColor: "rgba(94, 150, 146, 1)", borderColor: "rgba(94, 150, 146, 1)" } });
            fullChartDataStore["Shares Outstanding"] = { labels: sharesDataFull.map(formatPeriodLabel), data: sharesDataFull.map(d => parseFiniteNumber(d.facts.SharesOutstanding.value)), type: "bar", backgroundColor: "rgba(94, 150, 146, 1)", borderColor: "rgba(94, 150, 146, 1)" };
        }

        // Backlog (RPO)
        const rpoData = limitedData.filter(d => hasFiniteFact(d, "RevenueRemainingPerformanceObligation"));
        const rpoDataFull = sortedData.filter(d => hasFiniteFact(d, "RevenueRemainingPerformanceObligation"));
        if (rpoData.length > 0) {
            chartOrder.push({ title: "Backlog (RPO)", data: { labels: rpoData.map(formatPeriodLabel), data: rpoData.map(d => parseFiniteNumber(d.facts.RevenueRemainingPerformanceObligation.value)), type: "bar", backgroundColor: "rgba(216, 81, 64, 1)", borderColor: "rgba(216, 81, 64, 1)" } });
            fullChartDataStore["Backlog (RPO)"] = { labels: rpoDataFull.map(formatPeriodLabel), data: rpoDataFull.map(d => parseFiniteNumber(d.facts.RevenueRemainingPerformanceObligation.value)), type: "bar", backgroundColor: "rgba(216, 81, 64, 1)", borderColor: "rgba(216, 81, 64, 1)" };
        }

        // Render all chart cards
        chartOrder.forEach(chart => {
            const chartCard = document.createElement("div");
            chartCard.className = "financial-chart-card";
            chartCard.innerHTML = `
                <div class="financial-chart-card-header">
                    <h3 class="financial-chart-card-title">${chart.title}</h3>
                    <button class="financial-chart-expand-btn" title="Expand chart">
                        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" />
                        </svg>
                    </button>
                </div>
                <div class="financial-chart-body"><canvas></canvas></div>
            `;
            els.chartsGrid.appendChild(chartCard);
            createChart(chartCard.querySelector("canvas"), chart.title, chart.data, false);

            chartCard.querySelector(".financial-chart-expand-btn").addEventListener("click", (e) => {
                e.stopPropagation();
                openFinancialFullscreen(chart.title, chart.data, e.currentTarget);
                if (els.fcfToggleContainer) {
                    if (chart.title === "Free Cash Flow") {
                        els.fcfToggleContainer.classList.remove("hidden");
                        currentFCFView = "fcf";
                        els.fcfToggleContainer.querySelectorAll(".fcf-toggle-btn").forEach(btn => {
                            btn.classList.toggle("active", btn.dataset.fcfView === "fcf");
                        });
                    } else {
                        els.fcfToggleContainer.classList.add("hidden");
                    }
                }
            });
        });

        if (chartOrder.length === 0) {
            els.chartsGrid.insertAdjacentHTML(
                "beforeend",
                "<p class=\"chart-message chart-empty-state\">No chartable financial data is available for this period.</p>"
            );
        }
    }

    async function fetchWithCache(ticker, cacheKey, endpoint, required = false) {
        const cached = await getCachedFinancialData(ticker, cacheKey);
        const cachedData = cached?.data ?? null;
        if (cached?.isFresh) return cachedData;
        try {
            const response = await apiCall(endpoint, {}, apiDeps);
            const data = await response.json();
            if (!response.ok) {
                if (required) throw new Error(data.error || `Failed to fetch ${cacheKey}`);
                return cachedData;
            }
            await setCachedFinancialData(ticker, cacheKey, data);
            return data;
        } catch (error) {
            if (cachedData !== null) return cachedData;
            if (!required) return null;
            const detail = error instanceof TypeError
                ? "Backend is unavailable right now. Please try again later."
                : (error?.message || "Failed to load required data.");
            throw new Error(detail);
        }
    }

    function renderCompanyHeader(ticker, basicData, priceData) {
        const companyName = basicData?.[0]?.company_name || ticker;
        companyNameForFullscreen = companyName;

        els.logo.src = getLogoUrl(ticker);
        els.logo.alt = `${companyName} logo`;
        els.logo.onload = () => onLogoLoad(els.logo, ticker);
        els.logo.onerror = () => onLogoError(els.logo, ticker);
        els.companyName.textContent = companyName;
        els.companyTicker.textContent = `${ticker} | ${priceData?.exchange || "N/A"}`;
        els.companyPrice.textContent = Number.isFinite(priceData?.price) ? `$${priceData.price.toFixed(2)}` : "N/A";

        if (Number.isFinite(priceData?.change) && Number.isFinite(priceData?.pctChange)) {
            const isPositive = priceData.change >= 0;
            els.companyChange.className = `financial-price-change ${isPositive ? "positive" : "negative"}`;
            els.companyChange.textContent = `${isPositive ? "+" : ""}$${priceData.change.toFixed(2)} | ${isPositive ? "+" : ""}${priceData.pctChange.toFixed(2)}%`;
        } else {
            els.companyChange.className = "financial-price-change";
            els.companyChange.textContent = "";
        }
    }

    function invalidateFinancialLoad({ showPrompt = false } = {}) {
        financialLoadGeneration += 1;
        if (!financialLoadPending) return;
        financialLoadPending = false;
        setButtonState(els.searchBtn, "Search", false);
        if (showPrompt) {
            setStatus("");
            destroyChartsWithin(els.chartsGrid);
            els.chartsGrid.innerHTML = "<p class=\"chart-message\">Search to load financial data.</p>";
            els.chartsGrid.classList.add("visible");
        }
    }

    async function loadFinancialData() {
        const ticker = els.tickerInput.value.trim().toUpperCase();
        const loadGeneration = ++financialLoadGeneration;
        const isCurrentLoad = () => loadGeneration === financialLoadGeneration
            && els.tickerInput.value.trim().toUpperCase() === ticker;
        if (!ticker) {
            financialLoadPending = false;
            setButtonState(els.searchBtn, "Search", false);
            showToast("Please enter a ticker symbol.", true, 3000, els.toastContainer);
            return;
        }
        if (!isTickerSyntaxValid(ticker)) {
            financialLoadPending = false;
            setButtonState(els.searchBtn, "Search", false);
            showToast("Please enter a valid ticker symbol.", true, 3000, els.toastContainer);
            return;
        }
        if (strictTickerValidation && !isValidTicker(ticker)) {
            financialLoadPending = false;
            setButtonState(els.searchBtn, "Search", false);
            showToast("Please select a valid ticker from suggestions.", true, 3000, els.toastContainer);
            return;
        }

        financialLoadPending = true;
        setButtonState(els.searchBtn, "Loading...", true);
        setStatus("Fetching financial data...");
        destroyChartsWithin(els.chartsGrid);
        els.chartsGrid.innerHTML = "<p class=\"chart-message\">Loading financial data\u2026</p>";

        // Reset animated sections before loading new data
        els.companyInfo.classList.remove("visible");
        els.companyInfo.classList.add("hidden");
        els.metricsSection.classList.remove("visible");
        els.metricsSection.classList.add("hidden");
        if (els.periodToggle) els.periodToggle.classList.remove("visible");
        els.chartsGrid.classList.remove("visible");

        try {
            const [filings, stockInfoData, priceData] = await Promise.all([
                fetchWithCache(ticker, "filings_bundle", buildTickerQueryUrl("/financial-filings", ticker), true),
                fetchWithCache(ticker, "stock_info_data", buildTickerQueryUrl("/get_stock_info_data", ticker)),
                fetchWithCache(ticker, "price_data", buildTickerQueryUrl("/get_market_price", ticker, { include: "history" }))
            ]);
            if (!isCurrentLoad()) return;
            const basicData = filings?.sections?.basic?.data;
            const segmentData = filings?.sections?.segment?.data || null;
            const ttmData = filings?.sections?.ttm?.data || null;
            const ttmSegmentData = filings?.sections?.ttmSegment?.data || null;
            await Promise.all([
                setCachedFinancialData(ticker, "basic_data", basicData),
                setCachedFinancialData(ticker, "segment_data", segmentData),
                setCachedFinancialData(ticker, "ttm_data", ttmData),
                setCachedFinancialData(ticker, "ttm_segment_data", ttmSegmentData),
            ]);
            if (!isCurrentLoad()) return;

            // Cache all data for period toggle re-rendering
            cachedBasicData = basicData;
            cachedSegmentData = segmentData;
            cachedTTMData = ttmData;
            cachedTTMSegmentData = ttmSegmentData;
            storedPriceHistory = priceData?.history || null;
            storedYearChangePct = Number.isFinite(priceData?.yearChangePct)
                ? priceData.yearChangePct
                : null;

            renderCompanyHeader(ticker, basicData, priceData);
            renderMetrics(stockInfoData || {});
            renderCombinedCharts(
                filterDataByPeriod(basicData, currentPeriodView, ttmData),
                filterSegmentDataByPeriod(segmentData, currentPeriodView, ttmSegmentData)
            );

            setStatus("Data loaded.");
            showToast("Financial data loaded.", false, 2000, els.toastContainer);

            // Sequential reveal animation
            els.companyInfo.classList.remove("hidden");
            els.companyInfo.offsetHeight; // trigger reflow for transition
            els.companyInfo.classList.add("visible");

            setTimeout(() => {
                if (!isCurrentLoad()) return;
                els.metricsSection.classList.remove("hidden");
                els.metricsSection.offsetHeight;
                els.metricsSection.classList.add("visible");

                setTimeout(() => {
                    if (!isCurrentLoad()) return;
                    if (els.periodToggle) els.periodToggle.classList.add("visible");

                    setTimeout(() => {
                        if (!isCurrentLoad()) return;
                        els.chartsGrid.classList.add("visible");
                    }, 300);
                }, 400);
            }, 400);

        } catch (error) {
            if (!isCurrentLoad()) return;
            const message = error?.message || "Failed to load financial data.";
            setStatus(message, true);
            destroyChartsWithin(els.chartsGrid);
            els.chartsGrid.innerHTML = "<p class=\"chart-message error\">Unable to load data from backend.</p>";
            showToast(message, true, 4500, els.toastContainer);
            els.chartsGrid.classList.add("visible");
        } finally {
            if (isCurrentLoad()) {
                financialLoadPending = false;
                setButtonState(els.searchBtn, "Search", false);
            }
        }
    }

    // --- Event listeners ---

    els.fullscreenPeriodBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        const isHidden = els.fullscreenPeriodMenu.classList.toggle("hidden");
        els.fullscreenPeriodBtn.setAttribute("aria-expanded", String(!isHidden));
    });

    document.addEventListener("click", (event) => {
        if (!els.fullscreenPeriodBtn.contains(event.target) && !els.fullscreenPeriodMenu.contains(event.target)) {
            els.fullscreenPeriodMenu.classList.add("hidden");
            els.fullscreenPeriodBtn.setAttribute("aria-expanded", "false");
        }
    });

    els.fullscreenPeriodMenu.addEventListener("click", (event) => {
        const option = event.target.closest(".fullscreen-period-option");
        if (!option || option.classList.contains("disabled") || option.disabled) return;
        fullscreenState.currentFullscreenPeriod = option.dataset.period;
        els.fullscreenPeriodText.textContent = option.textContent;
        els.fullscreenPeriodMenu.querySelectorAll(".fullscreen-period-option").forEach((opt) => {
            const selected = opt === option;
            opt.classList.toggle("active", selected);
            opt.setAttribute("aria-selected", String(selected));
        });
        els.fullscreenPeriodMenu.classList.add("hidden");
        els.fullscreenPeriodBtn.setAttribute("aria-expanded", "false");
        const filteredData = filterChartDataByPeriod(fullscreenState.currentFullscreenData, fullscreenState.currentFullscreenPeriod);
        updateGrowthBadges(filteredData, growthElements);
        scheduleFullscreenChartRender(
            fullscreenState,
            els.fullscreenCanvas,
            fullscreenState.currentFullscreenTitle,
            filteredData,
            { growthElements }
        );
    });

    els.closeFullscreenBtn.addEventListener("click", closeFinancialFullscreen);
    els.fullscreenModal.addEventListener("click", (event) => {
        if (event.target === els.fullscreenModal) closeFinancialFullscreen();
    });
    document.addEventListener("keydown", (event) => {
        if (els.fullscreenModal.classList.contains("hidden")) return;
        if (event.key === "Escape") {
            event.preventDefault();
            closeFinancialFullscreen();
            return;
        }
        if (event.key !== "Tab") return;
        const focusable = focusableFullscreenElements();
        if (!focusable.length) {
            event.preventDefault();
            els.fullscreenModal.focus();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        } else if (!els.fullscreenModal.contains(document.activeElement)) {
            event.preventDefault();
            first.focus();
        }
    });

    // Period toggle buttons
    if (els.quarterlyBtn) els.quarterlyBtn.addEventListener("click", () => updatePeriodView("quarterly"));
    if (els.quarterlyTTMBtn) els.quarterlyTTMBtn.addEventListener("click", () => updatePeriodView("quarterlyTTM"));
    if (els.annuallyBtn) els.annuallyBtn.addEventListener("click", () => updatePeriodView("annually"));

    // FCF toggle group
    if (els.fcfToggleContainer) {
        els.fcfToggleContainer.addEventListener("click", (e) => {
            const btn = e.target.closest(".fcf-toggle-btn");
            if (!btn) return;
            const newView = btn.dataset.fcfView;
            if (newView === currentFCFView) return;
            currentFCFView = newView;
            els.fcfToggleContainer.querySelectorAll(".fcf-toggle-btn").forEach(b => b.classList.toggle("active", b === btn));

            destroyChart(fullscreenState.activeFullscreenChart);
            fullscreenState.activeFullscreenChart = null;

            let newFullData;
            let chartTitle;
            switch (newView) {
                case "fcf":          newFullData = storedFullFCFData;                       chartTitle = "Free Cash Flow"; break;
                case "fcf-sbc":      newFullData = storedFullFCFAndSBCData || storedFullFCFData;   chartTitle = "FCF & SBC"; break;
                case "sbc-adj-fcf":  newFullData = storedFullAdjustedFCFData || storedFullFCFData; chartTitle = "SBC Adj. FCF"; break;
                case "fcf-per-share": newFullData = storedFullFCFPerShareData || storedFullFCFData; chartTitle = "FCF Per Share"; break;
                case "sbc-adj-fcf-per-share": newFullData = storedFullSBCAdjFCFPerShareData || storedFullFCFData; chartTitle = "SBC Adj. FCF Per Share"; break;
                default:             newFullData = storedFullFCFData;                       chartTitle = "Free Cash Flow";
            }

            fullscreenState.currentFullscreenData = newFullData;
            fullscreenState.currentFullscreenTitle = chartTitle;

            const ticker = els.tickerInput.value.trim().toUpperCase();
            let displayTitle = chartTitle;
            if (currentPeriodView === "quarterlyTTM") displayTitle = `${chartTitle} (TTM)`;
            else if (currentPeriodView === "annually") displayTitle = `${chartTitle} (Annual)`;
            if (els.fullscreenChartTitle) els.fullscreenChartTitle.textContent = `${displayTitle} - ${ticker}`;

            if (!newFullData) return;
            const filteredData = filterChartDataByPeriod(newFullData, fullscreenState.currentFullscreenPeriod);
            updateGrowthBadges(filteredData, growthElements);
            scheduleFullscreenChartRender(
                fullscreenState,
                els.fullscreenCanvas,
                chartTitle,
                filteredData,
                { growthElements }
            );
        });
    }

    // Ticker search
    function setActiveTickerSuggestion(index) {
        const items = [...els.autocomplete.querySelectorAll(".ticker-suggestion")];
        if (!items.length) {
            activeTickerSuggestion = -1;
            els.tickerInput.removeAttribute("aria-activedescendant");
            return;
        }
        activeTickerSuggestion = (index + items.length) % items.length;
        items.forEach((item, itemIndex) => {
            const selected = itemIndex === activeTickerSuggestion;
            item.classList.toggle("is-active", selected);
            item.setAttribute("aria-selected", String(selected));
        });
        const activeItem = items[activeTickerSuggestion];
        els.tickerInput.setAttribute("aria-activedescendant", activeItem.id);
        activeItem.scrollIntoView?.({ block: "nearest" });
    }

    const debouncedSuggestions = debounce(async (query) => {
        await showTickerSuggestions(query, els.autocomplete);
        activeTickerSuggestion = -1;
        els.tickerInput.removeAttribute("aria-activedescendant");
        els.tickerInput.setAttribute("aria-expanded", String(!els.autocomplete.classList.contains("hidden")));
    }, 180);
    els.tickerInput.addEventListener("input", (event) => {
        invalidateFinancialLoad({ showPrompt: true });
        activeTickerSuggestion = -1;
        hideTickerSuggestions(els.autocomplete);
        debouncedSuggestions(event.target.value.trim());
    });
    els.tickerInput.addEventListener("keydown", (event) => {
        const items = [...els.autocomplete.querySelectorAll(".ticker-suggestion")];
        const suggestionsOpen = !els.autocomplete.classList.contains("hidden") && items.length > 0;
        if (event.key === "ArrowDown" && suggestionsOpen) {
            event.preventDefault();
            setActiveTickerSuggestion(activeTickerSuggestion + 1);
        } else if (event.key === "ArrowUp" && suggestionsOpen) {
            event.preventDefault();
            setActiveTickerSuggestion(activeTickerSuggestion - 1);
        } else if (event.key === "Enter" && suggestionsOpen && activeTickerSuggestion >= 0) {
            event.preventDefault();
            els.tickerInput.value = items[activeTickerSuggestion].dataset.symbol || "";
            activeTickerSuggestion = -1;
            hideTickerSuggestions(els.autocomplete);
            loadFinancialData();
        } else if (event.key === "Enter") {
            hideTickerSuggestions(els.autocomplete);
            loadFinancialData();
        } else if (event.key === "Escape") {
            activeTickerSuggestion = -1;
            hideTickerSuggestions(els.autocomplete);
        }
    });
    els.autocomplete.addEventListener("click", (event) => {
        const suggestion = event.target.closest(".ticker-suggestion");
        if (!suggestion) return;
        els.tickerInput.value = suggestion.dataset.symbol;
        activeTickerSuggestion = -1;
        hideTickerSuggestions(els.autocomplete);
        loadFinancialData();
    });
    document.addEventListener("click", (event) => {
        if (!event.target.closest(".financial-search-wrapper")) {
            hideTickerSuggestions(els.autocomplete);
        }
    });
    els.searchBtn.addEventListener("click", loadFinancialData);

    // Show initial placeholder with charts grid visible
    els.chartsGrid.classList.add("visible");

    observeAuthState(async (user) => {
        if (!user) return;
        try {
            const tickers = await fetchTickers((endpoint) => apiCall(endpoint, {}, apiDeps));
            strictTickerValidation = Array.isArray(tickers) && tickers.length > 0;
            if (!strictTickerValidation) {
                setStatus("Ticker directory unavailable. You can still search manually.");
            } else {
                setStatus("");
            }
        } catch (_error) {
            strictTickerValidation = false;
            setStatus("Backend unavailable for ticker suggestions. Manual ticker search remains enabled.", true);
            showToast("Ticker suggestions unavailable. Backend may be offline.", true, 3500, els.toastContainer);
        }
    });
});
