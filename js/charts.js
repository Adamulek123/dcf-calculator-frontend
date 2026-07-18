import { getLogoUrl, onLogoLoad, onLogoError } from "./ticker.js";

function createChart(canvas, title, chartData, isFullscreen = false, options = {}) {
    const ChartCtor = options.ChartCtor || globalThis.Chart;
    if (!ChartCtor) {
        throw new Error("Chart.js is required to create charts.");
    }

    const ctx = canvas.getContext("2d");
    const datasets = Array.isArray(chartData.datasets) ? chartData.datasets : [{
        label: title,
        data: chartData.data,
        backgroundColor: chartData.backgroundColor,
        borderColor: chartData.backgroundColor,
        borderWidth: chartData.type === "bar" ? 0 : 2,
        fill: chartData.type === "line",
        tension: 0.1,
        pointBackgroundColor: chartData.borderColor,
        pointHoverRadius: 5,
        pointRadius: 3
    }];

    const filteredDatasets = datasets.filter((dataset) => {
        if (!dataset.data || !Array.isArray(dataset.data)) {
            return false;
        }
        return dataset.data.some((value) => value !== null && value !== 0 && value !== undefined);
    });

    let onClickHandler = null;
    if (title.includes("Price")) {
        filteredDatasets.forEach((ds) => {
            ds.pointRadius = 0;
        });
    }
    if (title === "Projected Price Growth") {
        filteredDatasets.forEach((ds) => {
            ds.pointRadius = 3;
        });
    }

    let allValues = [];
    filteredDatasets.forEach((dataset) => {
        if (dataset.data && Array.isArray(dataset.data)) {
            allValues = allValues.concat(dataset.data.filter((v) => v !== null && v !== undefined && v !== 0));
        }
    });
    const minValue = allValues.length > 0 ? Math.min(...allValues) : 0;

    let maxValue;
    if (chartData.stacked && filteredDatasets.length > 1) {
        const numBars = filteredDatasets[0]?.data?.length || 0;
        let stackedMax = 0;
        for (let i = 0; i < numBars; i++) {
            let barSum = 0;
            filteredDatasets.forEach((ds) => {
                const val = ds.data?.[i];
                if (val !== null && val !== undefined) {
                    barSum += val;
                }
            });
            if (barSum > stackedMax) {
                stackedMax = barSum;
            }
        }
        maxValue = stackedMax;
    } else {
        maxValue = allValues.length > 0 ? Math.max(...allValues) : 0;
    }

    const yAxisMin = minValue < 0 ? minValue * 1.25 : 0;

    const calculateStepSize = (max, min) => {
        const range = Math.abs(max - min);
        if (range === 0) {
            return 1;
        }
        const magnitude = Math.pow(10, Math.floor(Math.log10(range)));
        const normalizedRange = range / magnitude;
        let stepMultiplier;
        if (normalizedRange <= 1.2) {
            stepMultiplier = 0.1;
        } else if (normalizedRange <= 2.5) {
            stepMultiplier = 0.2;
        } else if (normalizedRange <= 4) {
            stepMultiplier = 0.25;
        } else if (normalizedRange <= 6) {
            stepMultiplier = 0.5;
        } else {
            stepMultiplier = 1;
        }
        return stepMultiplier * magnitude;
    };

    const yAxisStepSize = calculateStepSize(maxValue, yAxisMin);
    const growthElements = options.growthElements;
    const chartTheme = options.theme || {};
    const interactive = Boolean(isFullscreen || options.interactive);
    const textColor = chartTheme.textColor || "#3c4145";
    const gridColor = chartTheme.gridColor || "#e9ecef";

    return new ChartCtor(ctx, {
        type: chartData.type,
        data: {
            labels: chartData.labels,
            datasets: filteredDatasets
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: isFullscreen ? {
                duration: 800,
                easing: "easeOutQuart"
            } : false,
            transitions: {
                active: { animation: { duration: isFullscreen ? 300 : 0 } },
                hide: { animation: { duration: 400, easing: "easeOutQuart" } },
                show: { animation: { duration: 400, easing: "easeOutQuart" } }
            },
            elements: {
                bar: { borderSkipped: "start", borderWidth: 0 }
            },
            plugins: {
                legend: {
                    display: isFullscreen,
                    labels: {
                        color: chartTheme.legendText || "#212529",
                        font: { size: isFullscreen ? 18 : 14, weight: "600" },
                        padding: isFullscreen ? 20 : 15,
                        boxWidth: isFullscreen ? 50 : 40,
                        boxHeight: isFullscreen ? 20 : 15
                    },
                    onClick: isFullscreen ? function onLegendClick(_e, legendItem, legend) {
                        const index = legendItem.datasetIndex;
                        const chart = legend.chart;
                        const meta = chart.getDatasetMeta(index);
                        meta.hidden = meta.hidden === null ? !chart.data.datasets[index].hidden : null;
                        chart.update();
                        updateGrowthBadgesFromChart(chart, growthElements);
                    } : undefined
                },
                tooltip: {
                    enabled: interactive,
                    animation: interactive ? { duration: 100 } : false,
                    backgroundColor: chartTheme.tooltipBackground,
                    titleColor: chartTheme.tooltipText,
                    bodyColor: chartTheme.tooltipText,
                    callbacks: {
                        label(context) {
                            let label = context.dataset.label || "";
                            if (label) {
                                label += ": ";
                            }
                            const value = context.parsed.y;
                            if (value !== null && value !== 0) {
                                const moneyCharts = ["Price", "Revenue by Product", "Revenue by Geography", "Revenue by Business", "Free Cash Flow", "Adjusted Free Cash Flow", "Net Income", "Cash & Debt", "Revenue", "Backlog (RPO)", "FCF & SBC", "SBC Adj. FCF", "FCF Per Share", "SBC Adj. FCF Per Share", "CapEx"];
                                const shareCharts = ["Shares Outstanding"];
                                if (shareCharts.some((c) => title.includes(c))) {
                                    if (Math.abs(value) >= 1000000000) {
                                        label += `${(value / 1000000000).toFixed(2)}B`;
                                    } else if (Math.abs(value) >= 1000000) {
                                        label += `${(value / 1000000).toFixed(2)}M`;
                                    } else {
                                        label += value.toLocaleString();
                                    }
                                } else if (moneyCharts.some((c) => title.includes(c))) {
                                    if (Math.abs(value) >= 1000000000) {
                                        label += `$${(value / 1000000000).toFixed(2)}B`;
                                    } else if (Math.abs(value) >= 1000000) {
                                        label += `$${(value / 1000000).toFixed(2)}M`;
                                    } else {
                                        label += `$${value.toLocaleString()}`;
                                    }
                                } else {
                                    label += value.toLocaleString();
                                }
                            }
                            return label;
                        }
                    }
                }
            },
            interaction: { mode: interactive ? "nearest" : null, intersect: true, axis: "x" },
            hover: { mode: interactive ? "nearest" : null, animationDuration: 0 },
            scales: {
                y: {
                    display: true,
                    beginAtZero: false,
                    min: yAxisMin,
                    stacked: chartData.stacked || false,
                    grid: { color: gridColor },
                    ticks: {
                        color: textColor,
                        font: { size: isFullscreen ? 14 : 11, weight: "500" },
                        stepSize: yAxisStepSize,
                        callback(value) {
                            const moneyCharts = ["Price", "Revenue by Product", "Revenue by Geography", "Revenue by Business", "Free Cash Flow", "Adjusted Free Cash Flow", "Net Income", "Cash & Debt", "Revenue", "Backlog (RPO)", "FCF & SBC", "SBC Adj. FCF", "FCF Per Share", "SBC Adj. FCF Per Share", "CapEx"];
                            const shareCharts = ["Shares Outstanding"];
                            if (shareCharts.some((c) => title.includes(c))) {
                                if (Math.abs(value) >= 1000000000) {
                                    return `${(value / 1000000000).toFixed(1)}B`;
                                }
                                if (Math.abs(value) >= 1000000) {
                                    return `${(value / 1000000).toFixed(1)}M`;
                                }
                                return value.toLocaleString();
                            }
                            if (moneyCharts.some((c) => title.includes(c))) {
                                if (Math.abs(value) >= 1000000000) {
                                    return `$${(value / 1000000000).toFixed(1)}B`;
                                }
                                if (Math.abs(value) >= 1000000) {
                                    return `$${(value / 1000000).toFixed(1)}M`;
                                }
                                return `$${value.toLocaleString()}`;
                            }
                            return value.toLocaleString();
                        }
                    }
                },
                x: {
                    stacked: chartData.stacked || false,
                    grid: { display: false },
                    ticks: {
                        color: textColor,
                        display: true,
                        font: { size: isFullscreen ? 14 : 11 },
                        maxRotation: 45,
                        minRotation: 0
                    }
                }
            },
            onClick: onClickHandler
        }
    });
}

function calculateYoYGrowth(chartData, yearsBack, useCAGR = false) {
    if (!chartData || !chartData.labels || !chartData.datasets || chartData.datasets.length === 0) {
        return null;
    }

    const labels = chartData.labels;
    const values = chartData.datasets[0].data;
    if (labels.length < 2) {
        return null;
    }

    const latestIdx = labels.length - 1;
    const latestLabel = labels[latestIdx];
    const latestValue = values[latestIdx];
    if (latestValue === null || latestValue === undefined) {
        return null;
    }

    const quarterMatch = latestLabel.match(/Q(\d)\s+(\d{4})/);
    if (!quarterMatch) {
        return null;
    }

    const latestQuarter = parseInt(quarterMatch[1], 10);
    const latestYear = parseInt(quarterMatch[2], 10);
    const targetYear = latestYear - yearsBack;
    const targetLabel = `Q${latestQuarter} ${targetYear}`;
    const targetIdx = labels.indexOf(targetLabel);
    if (targetIdx === -1) {
        return null;
    }

    const targetValue = values[targetIdx];
    if (targetValue === null || targetValue === undefined || targetValue === 0) {
        return null;
    }

    if (useCAGR && yearsBack > 1) {
        if (targetValue < 0 && latestValue < 0) {
            const cagr = (Math.pow(Math.abs(latestValue) / Math.abs(targetValue), 1 / yearsBack) - 1) * 100;
            return latestValue > targetValue ? cagr : -cagr;
        }
        if (targetValue < 0 || latestValue < 0) {
            const simpleGrowth = ((latestValue - targetValue) / Math.abs(targetValue)) * 100;
            return simpleGrowth / yearsBack;
        }
        return (Math.pow(latestValue / targetValue, 1 / yearsBack) - 1) * 100;
    }

    return ((latestValue - targetValue) / Math.abs(targetValue)) * 100;
}

function filterChartDataByPeriod(chartData, period) {
    if (!chartData || !chartData.labels || period === "all") {
        return chartData;
    }

    const periodYears = { "1y": 1, "2y": 2, "5y": 5, "10y": 10 };
    const years = periodYears[period];
    if (!years) {
        return chartData;
    }

    const quartersToShow = years * 4 + 1;
    const totalLabels = chartData.labels.length;
    const startIdx = Math.max(0, totalLabels - quartersToShow);

    if (chartData.datasets) {
        return {
            ...chartData,
            labels: chartData.labels.slice(startIdx),
            datasets: chartData.datasets.map((ds) => ({
                ...ds,
                data: ds.data.slice(startIdx),
                backgroundColor: Array.isArray(ds.backgroundColor) ? ds.backgroundColor.slice(startIdx) : ds.backgroundColor
            }))
        };
    }

    return {
        ...chartData,
        labels: chartData.labels.slice(startIdx),
        data: chartData.data.slice(startIdx)
    };
}

function getAvailablePeriods(chartData) {
    if (!chartData || !chartData.labels) {
        return ["all"];
    }

    const totalQuarters = chartData.labels.length;
    const available = ["all"];
    if (totalQuarters >= 5) {
        available.push("1y");
    }
    if (totalQuarters >= 9) {
        available.push("2y");
    }
    if (totalQuarters >= 21) {
        available.push("5y");
    }
    if (totalQuarters >= 41) {
        available.push("10y");
    }
    return available;
}

function updatePeriodDropdown(chartData, fullscreenPeriodMenu = document.getElementById("fullscreen-period-menu"), currentFullscreenPeriod = "all") {
    if (!fullscreenPeriodMenu) {
        return;
    }

    const available = getAvailablePeriods(chartData);
    const options = fullscreenPeriodMenu.querySelectorAll(".fullscreen-period-option");
    options.forEach((option) => {
        const period = option.dataset.period;
        if (available.includes(period)) {
            option.classList.remove("disabled");
        } else {
            option.classList.add("disabled");
        }
        option.classList.toggle("active", period === currentFullscreenPeriod);
    });
}

function updateGrowthBadges(chartData, growthElements = {}) {
    const {
        growth1y = document.getElementById("fullscreen-growth-1y"),
        growth2y = document.getElementById("fullscreen-growth-2y"),
        growth5y = document.getElementById("fullscreen-growth-5y"),
        growth10y = document.getElementById("fullscreen-growth-10y")
    } = growthElements;

    let normalizedData;
    if (chartData?.datasets?.length > 0) {
        if (chartData.stacked) {
            const summedData = chartData.labels.map((_, idx) => chartData.datasets.reduce((sum, ds) => {
                if (!ds.data || idx >= ds.data.length) {
                    return sum;
                }
                const val = ds.data[idx];
                return sum + (val !== null && val !== undefined ? val : 0);
            }, 0));
            normalizedData = { labels: chartData.labels, datasets: [{ data: summedData }] };
        } else {
            const firstDataset = chartData.datasets[0];
            normalizedData = firstDataset?.data ? { labels: chartData.labels, datasets: [{ data: firstDataset.data }] } : null;
        }
    } else if (chartData?.data) {
        normalizedData = { labels: chartData.labels, datasets: [{ data: chartData.data }] };
    } else {
        normalizedData = null;
    }

    const growth1 = normalizedData ? calculateYoYGrowth(normalizedData, 1, false) : null;
    const growth2 = normalizedData ? calculateYoYGrowth(normalizedData, 2, true) : null;
    const growth5 = normalizedData ? calculateYoYGrowth(normalizedData, 5, true) : null;
    const growth10 = normalizedData ? calculateYoYGrowth(normalizedData, 10, true) : null;

    const updateBadge = (element, label, value) => {
        if (!element) {
            return;
        }
        if (value !== null) {
            const sign = value >= 0 ? "+" : "";
            element.textContent = `${label}: ${sign}${value.toFixed(2)}%`;
            element.classList.toggle("negative", value < 0);
            element.style.display = "inline-flex";
        } else {
            element.style.display = "none";
        }
    };

    updateBadge(growth1y, "1Y", growth1);
    updateBadge(growth2y, "2Y", growth2);
    updateBadge(growth5y, "5Y", growth5);
    updateBadge(growth10y, "10Y", growth10);
}

function updateGrowthBadgesFromChart(chart, growthElements = {}) {
    if (!chart || !chart.data) {
        return;
    }

    const {
        growth1y = document.getElementById("fullscreen-growth-1y"),
        growth2y = document.getElementById("fullscreen-growth-2y"),
        growth5y = document.getElementById("fullscreen-growth-5y"),
        growth10y = document.getElementById("fullscreen-growth-10y")
    } = growthElements;

    const labels = chart.data.labels;
    const datasets = chart.data.datasets;
    if (!labels || !datasets) {
        return;
    }

    const isStacked = chart.options.scales?.y?.stacked || false;
    const visibleDatasets = datasets.filter((ds, idx) => {
        const meta = chart.getDatasetMeta(idx);
        return !meta.hidden && ds.data && ds.data.length > 0;
    });

    if (visibleDatasets.length === 0) {
        [growth1y, growth2y, growth5y, growth10y].forEach((el) => {
            if (el) {
                el.style.display = "none";
            }
        });
        return;
    }

    const normalizedData = (isStacked || visibleDatasets.length > 1)
        ? {
            labels,
            datasets: [{
                data: labels.map((_, idx) => visibleDatasets.reduce((sum, ds) => {
                    if (!ds.data || idx >= ds.data.length) {
                        return sum;
                    }
                    const val = ds.data[idx];
                    return sum + (val !== null && val !== undefined ? val : 0);
                }, 0))
            }]
        }
        : { labels, datasets: [{ data: visibleDatasets[0].data }] };

    const g1 = calculateYoYGrowth(normalizedData, 1, false);
    const g2 = calculateYoYGrowth(normalizedData, 2, true);
    const g5 = calculateYoYGrowth(normalizedData, 5, true);
    const g10 = calculateYoYGrowth(normalizedData, 10, true);

    const updateBadge = (element, label, value) => {
        if (!element) {
            return;
        }
        if (value !== null) {
            const sign = value >= 0 ? "+" : "";
            element.textContent = `${label}: ${sign}${value.toFixed(2)}%`;
            element.classList.toggle("negative", value < 0);
            element.style.display = "inline-flex";
        } else {
            element.style.display = "none";
        }
    };

    updateBadge(growth1y, "1Y", g1);
    updateBadge(growth2y, "2Y", g2);
    updateBadge(growth5y, "5Y", g5);
    updateBadge(growth10y, "10Y", g10);
}

function openFullscreen(title, chartData, context = {}) {
    const {
        state = {},
        dataStore = {},
        periodView = "quarterly",
        financialTickerInput = document.getElementById("financialTickerInput"),
        fullscreenModal = document.getElementById("fullscreen-chart-modal"),
        fullscreenCanvas = document.getElementById("fullscreen-canvas"),
        fullscreenCompanyLogo = document.getElementById("fullscreen-company-logo"),
        fullscreenChartTitle = document.getElementById("fullscreen-chart-title"),
        fullscreenPeriodText = document.getElementById("fullscreen-period-text"),
        fullscreenPeriodMenu = document.getElementById("fullscreen-period-menu"),
        growthElements = {}
    } = context;

    if (!fullscreenModal || !fullscreenCanvas) {
        return null;
    }

    fullscreenModal.classList.remove("hidden");

    if (state.activeFullscreenChart) {
        state.activeFullscreenChart.destroy();
        state.activeFullscreenChart = null;
    }

    state.currentFullscreenTitle = title;
    state.currentFullscreenPeriod = "all";

    const fullData = dataStore[title] || chartData;
    state.currentFullscreenData = fullData;

    const ticker = financialTickerInput?.value?.trim().toUpperCase() || "";
    if (fullscreenCompanyLogo && ticker) {
        fullscreenCompanyLogo.src = getLogoUrl(ticker, "pk_RQ-JlIhmQEOm6yeZvHsSKA");
        fullscreenCompanyLogo.alt = `${ticker} logo`;
        fullscreenCompanyLogo.onload = () => onLogoLoad(fullscreenCompanyLogo, ticker);
        fullscreenCompanyLogo.onerror = () => onLogoError(fullscreenCompanyLogo, ticker, "pk_RQ-JlIhmQEOm6yeZvHsSKA");
    }

    let displayTitle = title;
    if (periodView === "quarterlyTTM") {
        displayTitle = `${title} (TTM)`;
    } else if (periodView === "annually") {
        displayTitle = `${title} (Annual)`;
    }
    if (fullscreenChartTitle) {
        fullscreenChartTitle.textContent = ticker ? `${displayTitle} - ${ticker}` : displayTitle;
    }

    if (fullscreenPeriodText) {
        fullscreenPeriodText.textContent = "All";
    }
    if (fullscreenPeriodMenu) {
        fullscreenPeriodMenu.classList.add("hidden");
    }
    updatePeriodDropdown(fullData, fullscreenPeriodMenu, state.currentFullscreenPeriod);
    updateGrowthBadges(fullData, growthElements);

    requestAnimationFrame(() => {
        state.activeFullscreenChart = createChart(fullscreenCanvas, title, fullData, true, { growthElements });
    });

    return state;
}

export {
    createChart,
    calculateYoYGrowth,
    filterChartDataByPeriod,
    getAvailablePeriods,
    updatePeriodDropdown,
    updateGrowthBadges,
    updateGrowthBadgesFromChart,
    openFullscreen
};
