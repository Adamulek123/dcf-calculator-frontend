import { apiCall, setButtonState } from "./api.js";
import { getCachedFinancialData, setCachedFinancialData } from "./cache.js";
import { debounce, fetchTickers, isValidTicker, showTickerSuggestions, hideTickerSuggestions, getLogoUrl, onLogoLoad, onLogoError } from "./ticker.js";
import { createChart, filterChartDataByPeriod, openFullscreen, updateGrowthBadges } from "./charts.js";
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
            const totalValue = parseFloat(dateData.Total);
            return !isNaN(totalValue) && totalValue > 0;
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
            const parsed = parseFloat(value);
            return isNaN(parsed) ? 0 : parsed;
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
                const parsed = parseFloat(value);
                return !isNaN(parsed) && parsed !== 0;
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
            const valueA = typeData[sortingDate]?.[a] ? parseFloat(typeData[sortingDate][a]) : 0;
            const valueB = typeData[sortingDate]?.[b] ? parseFloat(typeData[sortingDate][b]) : 0;
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
                const parsed = parseFloat(value);
                return isNaN(parsed) ? 0 : parsed;
            });
            return { label: segmentName, data, backgroundColor: colorPalette[index % colorPalette.length] };
        });

        return { title, data: { labels: formattedLabels, datasets, type: "bar", stacked } };
    }

    function renderPriceChart() {
        if (!storedPriceHistory || storedPriceHistory.length === 0) return;

        const isPositive = (storedYearChangePct || 0) >= 0;
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

        const labels = storedPriceHistory.map(d => d.date);
        const prices = storedPriceHistory.map(d => d.price);
        const priceChartData = {
            labels, data: prices, type: "line",
            backgroundColor: "rgba(140, 208, 126, 1)",
            borderColor: "rgba(50, 189, 24, 1)"
        };
        fullChartDataStore["Price"] = priceChartData;

        const canvas = priceChartCard.querySelector("canvas");
        const ctx = canvas.getContext("2d");
        new Chart(ctx, {
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

        priceChartCard.querySelector(".financial-chart-expand-btn").addEventListener("click", (e) => {
            e.stopPropagation();
            openFullscreen("Price", priceChartData, buildFullscreenContext());
            if (els.fcfToggleContainer) els.fcfToggleContainer.classList.add("hidden");
        });
    }

    function filterDataByPeriod(data, periodView, ttmData = null) {
        if (periodView === "quarterlyTTM") {
            if (ttmData && ttmData.length > 0) return ttmData;
            return [];
        }
        if (!data || data.length === 0) return data;
        return data.filter(item => {
            const fiscalPeriod = item.fiscal_period || "";
            if (periodView === "annually") return fiscalPeriod === "FY";
            return ["Q1", "Q2", "Q3", "Q4"].includes(fiscalPeriod);
        });
    }

    function filterSegmentDataByPeriod(segmentData, periodView, ttmSegmentData = null) {
        if (periodView === "quarterlyTTM") {
            if (!ttmSegmentData) return null;
            const transformedData = { geographic: {}, product: {}, business: {} };
            Object.keys(ttmSegmentData).forEach(periodKey => {
                const entry = ttmSegmentData[periodKey];
                if (!entry || typeof entry !== "object") return;
                if (entry.geographic && Object.keys(entry.geographic).length > 0) {
                    transformedData.geographic[periodKey] = entry.geographic;
                }
                if (entry.product && Object.keys(entry.product).length > 0) {
                    transformedData.product[periodKey] = entry.product;
                }
            });
            Object.keys(transformedData).forEach(key => {
                if (Object.keys(transformedData[key]).length === 0) delete transformedData[key];
            });
            return Object.keys(transformedData).length > 0 ? transformedData : null;
        }

        if (!segmentData) return null;

        const transformedData = { geographic: {}, product: {}, business: {} };
        const topLevelKeys = Object.keys(segmentData);
        const isAlreadyTransformed = topLevelKeys.some(key => ["geographic", "product", "business"].includes(key));

        if (isAlreadyTransformed) {
            ["geographic", "product", "business"].forEach(segmentType => {
                if (segmentData[segmentType]) {
                    transformedData[segmentType] = {};
                    Object.keys(segmentData[segmentType]).forEach(dateKey => {
                        const isQuarterly = /^Q[1-4]_\d{4}$/.test(dateKey);
                        const isAnnual = /^FY_\d{4}$/.test(dateKey);
                        if (periodView === "annually" && isAnnual) {
                            transformedData[segmentType][dateKey] = segmentData[segmentType][dateKey];
                        } else if (periodView === "quarterly" && isQuarterly) {
                            transformedData[segmentType][dateKey] = segmentData[segmentType][dateKey];
                        }
                    });
                }
            });
        } else {
            Object.keys(segmentData).forEach(periodKey => {
                const entry = segmentData[periodKey];
                if (!entry || typeof entry !== "object") return;
                let fiscalPeriod = entry.fiscal_period;
                let fiscalYear = entry.fiscal_year;
                const periodMatch = periodKey.match(/^(Q[1-4]|FY)_(\d{4})$/);
                if (periodMatch && !fiscalPeriod) {
                    fiscalPeriod = periodMatch[1];
                    fiscalYear = parseInt(periodMatch[2]);
                }
                let isQuarterlyData = true;
                if (fiscalPeriod) {
                    isQuarterlyData = fiscalPeriod.startsWith("Q");
                } else {
                    const dateMatch = periodKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
                    if (dateMatch) isQuarterlyData = parseInt(dateMatch[2]) !== 12;
                }
                const shouldInclude = (periodView === "annually" && !isQuarterlyData) ||
                    (periodView === "quarterly" && isQuarterlyData);
                if (!shouldInclude) return;
                if (entry.geographic) {
                    transformedData.geographic[periodKey] = { ...entry.geographic, _fiscal_period: fiscalPeriod, _fiscal_year: fiscalYear };
                }
                if (entry.product) {
                    transformedData.product[periodKey] = { ...entry.product, _fiscal_period: fiscalPeriod, _fiscal_year: fiscalYear };
                }
                if (entry.business) {
                    transformedData.business[periodKey] = { ...entry.business, _fiscal_period: fiscalPeriod, _fiscal_year: fiscalYear };
                }
            });
        }

        Object.keys(transformedData).forEach(key => {
            if (Object.keys(transformedData[key]).length === 0) delete transformedData[key];
        });
        return Object.keys(transformedData).length > 0 ? transformedData : null;
    }

    function updatePeriodView(newView) {
        if (currentPeriodView === newView) return;
        const scrollY = window.scrollY;
        currentPeriodView = newView;

        els.quarterlyBtn.classList.toggle("active", newView === "quarterly");
        els.quarterlyTTMBtn.classList.toggle("active", newView === "quarterlyTTM");
        els.annuallyBtn.classList.toggle("active", newView === "annually");

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

    function renderCombinedCharts(basicData, segmentData) {
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

        if (!basicData || basicData.length === 0) {
            if (!storedPriceHistory || storedPriceHistory.length === 0) {
                els.chartsGrid.innerHTML = "<p class=\"chart-message\">No financial data found.</p>";
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

        const colors = [
            "rgba(54, 162, 235, 0.8)", "rgba(255, 99, 132, 0.8)", "rgba(75, 192, 192, 0.8)",
            "rgba(255, 206, 86, 0.8)", "rgba(153, 102, 255, 0.8)", "rgba(255, 159, 64, 0.8)",
            "rgba(46, 204, 113, 0.8)", "rgba(155, 89, 182, 0.8)", "rgba(52, 152, 219, 0.8)",
            "rgba(230, 126, 34, 0.8)", "rgba(231, 76, 60, 0.8)", "rgba(149, 165, 166, 0.8)"
        ];

        const chartOrder = [];

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
            if (productChart) chartOrder.push(productChart);
            const productFull = createSegmentChart("Revenue by Product", segmentData.product, colors, true, productKeyCount);
            if (productFull) fullChartDataStore["Revenue by Product"] = productFull.data;
        }

        // Revenue by Geography
        if (segmentData && segmentData.geographic && Object.keys(segmentData.geographic).length > 0) {
            const geoSegKeyCount = Object.keys(segmentData.geographic).length;
            const geoChart = createSegmentChart("Revenue by Geography", segmentData.geographic, colors, true, maxBars);
            if (geoChart) chartOrder.push(geoChart);
            const geoFull = createSegmentChart("Revenue by Geography", segmentData.geographic, colors, true, geoSegKeyCount);
            if (geoFull) fullChartDataStore["Revenue by Geography"] = geoFull.data;
        }

        // Revenue by Business
        if (segmentData && segmentData.business && Object.keys(segmentData.business).length > 0) {
            const bizKeyCount = Object.keys(segmentData.business).length;
            const bizChart = createSegmentChart("Revenue by Business", segmentData.business, colors, true, maxBars);
            if (bizChart) chartOrder.push(bizChart);
            const bizFull = createSegmentChart("Revenue by Business", segmentData.business, colors, true, bizKeyCount);
            if (bizFull) fullChartDataStore["Revenue by Business"] = bizFull.data;
        }

        // Earnings Per Share
        const epsData = limitedData.filter(d => d.facts?.EarningsPerShareBasic || d.facts?.EarningsPerShareDiluted);
        const epsDataFull = sortedData.filter(d => d.facts?.EarningsPerShareBasic || d.facts?.EarningsPerShareDiluted);
        if (epsData.length > 0) {
            chartOrder.push({
                title: "Earnings Per Share",
                data: {
                    labels: epsData.map(formatPeriodLabel),
                    datasets: [
                        { label: "EPS Basic", data: epsData.map(d => d.facts?.EarningsPerShareBasic ? parseFloat(d.facts.EarningsPerShareBasic.value) : null), backgroundColor: "rgba(240, 206, 99, 1)" },
                        { label: "EPS Diluted", data: epsData.map(d => d.facts?.EarningsPerShareDiluted ? parseFloat(d.facts.EarningsPerShareDiluted.value) : null), backgroundColor: "rgba(255, 99, 132, 1)", hidden: true }
                    ],
                    type: "bar"
                }
            });
            fullChartDataStore["Earnings Per Share"] = {
                labels: epsDataFull.map(formatPeriodLabel),
                datasets: [
                    { label: "EPS Basic", data: epsDataFull.map(d => d.facts?.EarningsPerShareBasic ? parseFloat(d.facts.EarningsPerShareBasic.value) : null), backgroundColor: "rgba(240, 206, 99, 1)" },
                    { label: "EPS Diluted", data: epsDataFull.map(d => d.facts?.EarningsPerShareDiluted ? parseFloat(d.facts.EarningsPerShareDiluted.value) : null), backgroundColor: "rgba(255, 99, 132, 1)", hidden: true }
                ],
                type: "bar"
            };
        }

        // Net Income
        const netIncomeData = limitedData.filter(d => d.facts?.NetIncomeLoss);
        const netIncomeDataFull = sortedData.filter(d => d.facts?.NetIncomeLoss);
        if (netIncomeData.length > 0) {
            chartOrder.push({ title: "Net Income", data: { labels: netIncomeData.map(formatPeriodLabel), data: netIncomeData.map(d => parseFloat(d.facts.NetIncomeLoss.value)), type: "bar", backgroundColor: "rgba(254, 190, 125, 1)" } });
            fullChartDataStore["Net Income"] = { labels: netIncomeDataFull.map(formatPeriodLabel), data: netIncomeDataFull.map(d => parseFloat(d.facts.NetIncomeLoss.value)), type: "bar", backgroundColor: "rgba(254, 190, 125, 1)" };
        }

        // Free Cash Flow
        const fcfData = limitedData.filter(d => d.facts?.FreeCashFlow);
        const fcfDataFull = sortedData.filter(d => d.facts?.FreeCashFlow);
        if (fcfData.length > 0) {
            const fcfLimited = { labels: fcfData.map(formatPeriodLabel), data: fcfData.map(d => parseFloat(d.facts.FreeCashFlow.value)), type: "bar", backgroundColor: "rgba(243, 143, 42, 1)", borderColor: "rgba(243, 143, 42, 1)" };
            storedFullFCFData = { labels: fcfDataFull.map(formatPeriodLabel), data: fcfDataFull.map(d => parseFloat(d.facts.FreeCashFlow.value)), type: "bar", backgroundColor: "rgba(243, 143, 42, 1)", borderColor: "rgba(243, 143, 42, 1)" };
            fullChartDataStore["Free Cash Flow"] = storedFullFCFData;
            chartOrder.push({ title: "Free Cash Flow", data: fcfLimited });
        }

        // Adjusted FCF
        const adjFcfData = limitedData.filter(d => d.facts?.AdjustedFreeCashFlow);
        const adjFcfDataFull = sortedData.filter(d => d.facts?.AdjustedFreeCashFlow);
        if (adjFcfData.length > 0) {
            storedFullAdjustedFCFData = { labels: adjFcfDataFull.map(formatPeriodLabel), data: adjFcfDataFull.map(d => parseFloat(d.facts.AdjustedFreeCashFlow.value)), type: "bar", backgroundColor: "rgba(160, 203, 232, 1)", borderColor: "rgba(160, 203, 232, 1)" };
        }

        // FCF & SBC combined
        const sbcDataFull = sortedData.filter(d => d.facts?.ShareBasedCompensation);
        if (storedFullFCFData && sbcDataFull.length > 0) {
            storedFullFCFAndSBCData = {
                labels: storedFullFCFData.labels,
                datasets: [
                    { label: "FCF", data: storedFullFCFData.data, backgroundColor: "rgba(243, 143, 42, 1)" },
                    { label: "SBC", data: sbcDataFull.map(d => parseFloat(d.facts.ShareBasedCompensation.value)), backgroundColor: "rgba(160, 203, 232, 1)" }
                ],
                type: "bar"
            };
        }

        // FCF Per Share and SBC Adj. FCF Per Share
        const sharesDataForFCF = sortedData.filter(d => d.facts?.SharesOutstanding);
        if (fcfDataFull.length > 0 && sharesDataForFCF.length > 0) {
            const sharesMap = new Map();
            sharesDataForFCF.forEach(d => sharesMap.set(formatPeriodLabel(d), parseFloat(d.facts.SharesOutstanding.value)));

            const fcfPerShareValues = fcfDataFull.map(d => {
                const shares = sharesMap.get(formatPeriodLabel(d));
                return shares ? parseFloat(d.facts.FreeCashFlow.value) / shares : null;
            }).filter(v => v !== null);

            if (fcfPerShareValues.length > 0) {
                storedFullFCFPerShareData = { labels: fcfDataFull.map(formatPeriodLabel).slice(0, fcfPerShareValues.length), data: fcfPerShareValues, type: "bar", backgroundColor: "rgba(243, 143, 42, 1)", borderColor: "rgba(243, 143, 42, 1)" };
            }

            if (adjFcfDataFull.length > 0) {
                const adjFcfPerShareValues = adjFcfDataFull.map(d => {
                    const shares = sharesMap.get(formatPeriodLabel(d));
                    return shares ? parseFloat(d.facts.AdjustedFreeCashFlow.value) / shares : null;
                }).filter(v => v !== null);

                if (adjFcfPerShareValues.length > 0) {
                    storedFullSBCAdjFCFPerShareData = { labels: adjFcfDataFull.map(formatPeriodLabel).slice(0, adjFcfPerShareValues.length), data: adjFcfPerShareValues, type: "bar", backgroundColor: "rgba(160, 203, 232, 1)", borderColor: "rgba(160, 203, 232, 1)" };
                }
            }
        }

        // Cash & Debt
        const cashDebtData = limitedData.filter(d => d.facts?.CashCashEquivalentsAndShortTermInvestments || d.facts?.LongTermDebtNoncurrent);
        const cashDebtDataFull = sortedData.filter(d => d.facts?.CashCashEquivalentsAndShortTermInvestments || d.facts?.LongTermDebtNoncurrent);
        if (cashDebtData.length > 0) {
            chartOrder.push({
                title: "Cash & Debt",
                data: {
                    labels: cashDebtData.map(formatPeriodLabel),
                    datasets: [
                        { label: "Cash", data: cashDebtData.map(d => d.facts?.CashCashEquivalentsAndShortTermInvestments ? parseFloat(d.facts.CashCashEquivalentsAndShortTermInvestments.value) : null), backgroundColor: "rgba(85, 158, 56, 1)" },
                        { label: "Debt", data: cashDebtData.map(d => d.facts?.LongTermDebtNoncurrent ? parseFloat(d.facts.LongTermDebtNoncurrent.value) : null), backgroundColor: "rgb(250, 86, 78, 1)" }
                    ],
                    type: "bar"
                }
            });
            fullChartDataStore["Cash & Debt"] = {
                labels: cashDebtDataFull.map(formatPeriodLabel),
                datasets: [
                    { label: "Cash", data: cashDebtDataFull.map(d => d.facts?.CashCashEquivalentsAndShortTermInvestments ? parseFloat(d.facts.CashCashEquivalentsAndShortTermInvestments.value) : null), backgroundColor: "rgba(85, 158, 56, 1)" },
                    { label: "Debt", data: cashDebtDataFull.map(d => d.facts?.LongTermDebtNoncurrent ? parseFloat(d.facts.LongTermDebtNoncurrent.value) : null), backgroundColor: "rgb(250, 86, 78, 1)" }
                ],
                type: "bar"
            };
        }

        // CapEx
        const capexData = limitedData.filter(d => d.facts?.CapEx);
        const capexDataFull = sortedData.filter(d => d.facts?.CapEx);
        if (capexData.length > 0) {
            chartOrder.push({ title: "CapEx", data: { labels: capexData.map(formatPeriodLabel), data: capexData.map(d => parseFloat(d.facts.CapEx.value)), type: "bar", backgroundColor: "rgb(52, 152, 219, 1)", borderColor: "rgb(52, 152, 219, 1)" } });
            fullChartDataStore["CapEx"] = { labels: capexDataFull.map(formatPeriodLabel), data: capexDataFull.map(d => parseFloat(d.facts.CapEx.value)), type: "bar", backgroundColor: "rgb(52, 152, 219, 1)", borderColor: "rgb(52, 152, 219, 1)" };
        }

        // Shares Outstanding
        const sharesData = limitedData.filter(d => d.facts?.SharesOutstanding);
        const sharesDataFull = sortedData.filter(d => d.facts?.SharesOutstanding);
        if (sharesData.length > 0) {
            chartOrder.push({ title: "Shares Outstanding", data: { labels: sharesData.map(formatPeriodLabel), data: sharesData.map(d => parseFloat(d.facts.SharesOutstanding.value)), type: "bar", backgroundColor: "rgba(94, 150, 146, 1)", borderColor: "rgba(94, 150, 146, 1)" } });
            fullChartDataStore["Shares Outstanding"] = { labels: sharesDataFull.map(formatPeriodLabel), data: sharesDataFull.map(d => parseFloat(d.facts.SharesOutstanding.value)), type: "bar", backgroundColor: "rgba(94, 150, 146, 1)", borderColor: "rgba(94, 150, 146, 1)" };
        }

        // Backlog (RPO)
        const rpoData = limitedData.filter(d => d.facts?.RevenueRemainingPerformanceObligation);
        const rpoDataFull = sortedData.filter(d => d.facts?.RevenueRemainingPerformanceObligation);
        if (rpoData.length > 0) {
            chartOrder.push({ title: "Backlog (RPO)", data: { labels: rpoData.map(formatPeriodLabel), data: rpoData.map(d => parseFloat(d.facts.RevenueRemainingPerformanceObligation.value)), type: "bar", backgroundColor: "rgba(216, 81, 64, 1)", borderColor: "rgba(216, 81, 64, 1)" } });
            fullChartDataStore["Backlog (RPO)"] = { labels: rpoDataFull.map(formatPeriodLabel), data: rpoDataFull.map(d => parseFloat(d.facts.RevenueRemainingPerformanceObligation.value)), type: "bar", backgroundColor: "rgba(216, 81, 64, 1)", borderColor: "rgba(216, 81, 64, 1)" };
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
                openFullscreen(chart.title, chart.data, buildFullscreenContext());
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
    }

    async function fetchWithCache(ticker, cacheKey, endpoint, required = false) {
        const cached = await getCachedFinancialData(ticker, cacheKey);
        if (cached) return cached;
        try {
            const response = await apiCall(endpoint, {}, apiDeps);
            const data = await response.json();
            if (!response.ok) {
                if (required) throw new Error(data.error || `Failed to fetch ${cacheKey}`);
                return null;
            }
            await setCachedFinancialData(ticker, cacheKey, data);
            return data;
        } catch (error) {
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
        if (strictTickerValidation && !isValidTicker(ticker)) {
            financialLoadPending = false;
            setButtonState(els.searchBtn, "Search", false);
            showToast("Please select a valid ticker from suggestions.", true, 3000, els.toastContainer);
            return;
        }

        financialLoadPending = true;
        setButtonState(els.searchBtn, "Loading...", true);
        setStatus("Fetching financial data...");
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
                fetchWithCache(ticker, "filings_bundle", `/financial-filings?ticker=${ticker}`, true),
                fetchWithCache(ticker, "stock_info_data", `/get_stock_info_data?ticker=${ticker}`),
                fetchWithCache(ticker, "price_data", `/get_market_price?ticker=${ticker}&include=history`)
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
            storedYearChangePct = priceData?.yearChangePct || null;

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
        els.fullscreenPeriodMenu.classList.toggle("hidden");
    });

    document.addEventListener("click", (event) => {
        if (!els.fullscreenPeriodBtn.contains(event.target) && !els.fullscreenPeriodMenu.contains(event.target)) {
            els.fullscreenPeriodMenu.classList.add("hidden");
        }
    });

    els.fullscreenPeriodMenu.addEventListener("click", (event) => {
        const option = event.target.closest(".fullscreen-period-option");
        if (!option || option.classList.contains("disabled")) return;
        fullscreenState.currentFullscreenPeriod = option.dataset.period;
        els.fullscreenPeriodText.textContent = option.textContent;
        els.fullscreenPeriodMenu.querySelectorAll(".fullscreen-period-option").forEach(opt => opt.classList.toggle("active", opt === option));
        els.fullscreenPeriodMenu.classList.add("hidden");
        const filteredData = filterChartDataByPeriod(fullscreenState.currentFullscreenData, fullscreenState.currentFullscreenPeriod);
        if (fullscreenState.activeFullscreenChart) fullscreenState.activeFullscreenChart.destroy();
        updateGrowthBadges(filteredData, growthElements);
        fullscreenState.activeFullscreenChart = createChart(els.fullscreenCanvas, fullscreenState.currentFullscreenTitle, filteredData, true, { growthElements });
    });

    els.closeFullscreenBtn.addEventListener("click", () => {
        els.fullscreenModal.classList.add("hidden");
        if (fullscreenState.activeFullscreenChart) fullscreenState.activeFullscreenChart.destroy();
        fullscreenState.activeFullscreenChart = null;
        fullscreenState.currentFullscreenTitle = "";
        fullscreenState.currentFullscreenData = null;
        fullscreenState.currentFullscreenPeriod = "all";
        if (els.fcfToggleContainer) els.fcfToggleContainer.classList.add("hidden");
        currentFCFView = "fcf";
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

            if (fullscreenState.activeFullscreenChart) {
                fullscreenState.activeFullscreenChart.destroy();
                fullscreenState.activeFullscreenChart = null;
            }

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

            const filteredData = filterChartDataByPeriod(newFullData, fullscreenState.currentFullscreenPeriod);
            updateGrowthBadges(filteredData, growthElements);
            requestAnimationFrame(() => {
                fullscreenState.activeFullscreenChart = createChart(els.fullscreenCanvas, chartTitle, filteredData, true, { growthElements });
            });
        });
    }

    // Ticker search
    const debouncedSuggestions = debounce((query) => showTickerSuggestions(query, els.autocomplete), 180);
    els.tickerInput.addEventListener("input", (event) => {
        invalidateFinancialLoad({ showPrompt: true });
        hideTickerSuggestions(els.autocomplete);
        debouncedSuggestions(event.target.value.trim());
    });
    els.tickerInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            hideTickerSuggestions(els.autocomplete);
            loadFinancialData();
        } else if (event.key === "Escape") {
            hideTickerSuggestions(els.autocomplete);
        }
    });
    els.autocomplete.addEventListener("click", (event) => {
        const suggestion = event.target.closest(".ticker-suggestion");
        if (!suggestion) return;
        els.tickerInput.value = suggestion.dataset.symbol;
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
