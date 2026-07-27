import { apiCall, setButtonState } from "./api.js";
import { showToast } from "./toast.js";
import { debounce, fetchTickers, getTickerMetadata, isValidTicker, showTickerSuggestions, hideTickerSuggestions, getLogoUrl, onLogoLoad, onLogoError } from "./ticker.js";
import { createChart } from "./charts.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import { CACHE_STALE_TTL, CACHE_TTL, createUserDataStore } from "./data-store.js";
import {
    CALCULATION_LIMITS,
    calculateProjection,
    classifyMetric,
    discardOutboxOperation,
    mergeRemoteCalculations,
    normalizeOutboxOperations,
    optionalNumber,
    outboxSummary,
    parseApiError,
    queueOutboxOperation,
    retryOutboxOperation,
    synchronizeOutboxOperations,
} from "./dcf-core.js";

window.addEventListener("DOMContentLoaded", async () => {
    const tickerInput = document.getElementById("tickerInput");
    const tickerAutocomplete = document.getElementById("tickerAutocomplete");
    const getCurrentDataBtn = document.getElementById("getCurrentDataBtn");
    const earningsTabBtn = document.getElementById("earningsTabBtn");
    const cashFlowTabBtn = document.getElementById("cashFlowTabBtn");
    const earningsSection = document.getElementById("earningsSection");
    const cashFlowSection = document.getElementById("cashFlowSection");
    const companyInfoDiv = document.getElementById("companyInfo");
    const companyLogo = document.getElementById("companyLogo");
    const companyName = document.getElementById("companyName");
    const companyExchange = document.getElementById("companyExchange");
    const currentStockPriceDisplay = document.getElementById("currentStockPrice");
    const currentEps = document.getElementById("currentEps");
    const currentPe = document.getElementById("currentPe");
    const epsGrowth = document.getElementById("epsGrowth");
    const epsTtmInput = document.getElementById("epsTtmInput");
    const epsTtmHelp = document.getElementById("epsTtmHelp");
    const growthRateInput = document.getElementById("growthRateInput");
    const peMultipleInput = document.getElementById("peMultipleInput");
    const currentFcfShare = document.getElementById("currentFcfShare");
    const fcfYield = document.getElementById("fcfYield");
    const sbcImpact = document.getElementById("sbcImpact");
    const fcfShareInput = document.getElementById("fcfShareInput");
    const fcfShareHelp = document.getElementById("fcfShareHelp");
    const fcfGrowthRateInput = document.getElementById("fcfGrowthRateInput");
    const fcfYieldInput = document.getElementById("fcfYieldInput");
    const desiredReturnInput = document.getElementById("desiredReturnInput");
    const calculatePriceBtn = document.getElementById("calculatePriceBtn");
    const projectionPlaceholder = document.getElementById("projectionPlaceholder");
    const projectionOutput = document.getElementById("projectionOutput");
    const returnFromTodayDisplay = document.getElementById("returnFromTodayDisplay");
    const entryPriceDisplay = document.getElementById("entryPriceDisplay");
    const desiredReturnDisplay = document.getElementById("desiredReturnDisplay");
    const priceAfter5YearsDisplay = document.getElementById("priceAfter5YearsDisplay");
    const priceChartCanvas = document.getElementById("priceChart");
    const saveCalculationBtn = document.getElementById("saveCalculationBtn");
    const clearBtn = document.getElementById("clearBtn");
    const loadCalculationsBtn = document.getElementById("loadCalculationsBtn");
    const savedCalculationsContainer = document.getElementById("savedCalculationsContainer");
    const syncIssuesPanel = document.getElementById("syncIssuesPanel");
    const syncIssuesContainer = document.getElementById("syncIssuesContainer");
    const syncIssueCount = document.getElementById("syncIssueCount");
    const toastContainer = document.getElementById("toast-container");
    const confirmationModal = document.getElementById("confirmationModal");
    const modalMessage = document.getElementById("modalMessage");
    const modalTitle = document.getElementById("modalTitle");
    const confirmYesBtn = document.getElementById("confirmYesBtn");
    const confirmNoBtn = document.getElementById("confirmNoBtn");
    const modelStatus = document.getElementById("modelStatus");
    const marketDataStatus = document.getElementById("marketDataStatus");
    const earningsSummary = document.getElementById("earningsSummary");
    const cashFlowSummary = document.getElementById("cashFlowSummary");
    const calculationMessage = document.getElementById("calculationMessage");
    const savedCalculationCount = document.getElementById("savedCalculationCount");
    const dcfLiveStatus = document.getElementById("dcfLiveStatus");
    const validationErrors = new Map([
        [epsTtmInput, document.getElementById("epsTtmError")],
        [growthRateInput, document.getElementById("growthRateError")],
        [peMultipleInput, document.getElementById("peMultipleError")],
        [fcfShareInput, document.getElementById("fcfShareError")],
        [fcfGrowthRateInput, document.getElementById("fcfGrowthError")],
        [fcfYieldInput, document.getElementById("fcfYieldError")],
        [desiredReturnInput, document.getElementById("desiredReturnError")],
    ]);
    const assumptionInputs = [
        epsTtmInput,
        growthRateInput,
        peMultipleInput,
        fcfShareInput,
        fcfGrowthRateInput,
        fcfYieldInput,
        desiredReturnInput,
    ];

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

    const SAFE_TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
    let currentStockPrice = 0;
    let currentTicker = "";
    let activeTab = "earnings";
    let dcfProjectionChart = null;
    let hasTickerDataset = false;
    let modalCallback = null;
    let calculationStore = null;
    let savedCalculations = [];
    let calculationOutbox = [];
    let syncingCalculationOutbox = false;
    let metricsLoadGeneration = 0;
    let hasValidCalculation = false;
    let modalReturnFocus = null;
    let editingCalculationId = null;

    const formatNum = (num, prefix = "", suffix = "") => (Number.isFinite(num) ? `${prefix}${num.toFixed(2)}${suffix}` : "N/A");
    const formatPercent = (num) => (Number.isFinite(num) ? `${(num * 100).toFixed(2)}%` : "N/A");

    function announce(message) {
        if (!dcfLiveStatus) return;
        dcfLiveStatus.textContent = "";
        requestAnimationFrame(() => {
            dcfLiveStatus.textContent = message;
        });
    }

    function setStatus(element, text, state) {
        if (!element) return;
        element.textContent = text;
        [...element.classList]
            .filter((className) => className.startsWith("is-"))
            .forEach((className) => element.classList.remove(className));
        if (state) element.classList.add(`is-${state}`);
    }

    function setModelState(text, state) {
        setStatus(modelStatus, text, state);
    }

    function setMarketState(text, state) {
        setStatus(marketDataStatus, text, state);
    }

    function renderCompanyExchange(ticker, fallback = "Listed") {
        if (!companyExchange) return;
        const metadata = getTickerMetadata(ticker);
        companyExchange.textContent = metadata?.exchange || fallback;
    }

    function clearValidation() {
        validationErrors.forEach((errorElement, input) => {
            input?.removeAttribute("aria-invalid");
            if (errorElement) {
                errorElement.textContent = "";
                errorElement.classList.add("hidden");
            }
        });
    }

    function invalidateCalculation(message = "Assumptions changed. Recalculate to update the model.", announceChange = false) {
        hasValidCalculation = false;
        if (saveCalculationBtn) saveCalculationBtn.disabled = true;
        projectionOutput.classList.add("hidden");
        projectionPlaceholder.classList.remove("hidden");
        if (dcfProjectionChart) {
            dcfProjectionChart.destroy();
            dcfProjectionChart = null;
        }
        if (currentTicker) {
            setModelState("Ready to calculate", currentStockPrice > 0 ? "ready" : "manual");
        } else {
            setModelState("Waiting for ticker", "idle");
        }
        if (announceChange) announce(message);
    }

    function setManualMetricEntry({ earnings = false, cashFlow = false } = {}) {
        epsTtmInput.readOnly = !earnings;
        fcfShareInput.readOnly = !cashFlow;
        epsTtmInput.dataset.metricState = earnings ? "missing" : "usable";
        fcfShareInput.dataset.metricState = cashFlow ? "missing" : "usable";
        if (epsTtmHelp) {
            epsTtmHelp.textContent = earnings
                ? "Trailing EPS is unavailable. Enter a positive value manually."
                : "Loaded from trailing earnings.";
        }
        if (fcfShareHelp) {
            fcfShareHelp.textContent = cashFlow
                ? "FCF per share is unavailable. Enter a positive value manually."
                : "Loaded from trailing free cash flow.";
        }
    }

    function resetMetricSummary() {
        currentEps.textContent = "N/A";
        currentPe.textContent = "N/A";
        epsGrowth.textContent = "N/A";
        currentFcfShare.textContent = "N/A";
        fcfYield.textContent = "N/A";
        sbcImpact.textContent = "N/A";
    }

    function configureMetricInput(input, help, metric, label) {
        input.dataset.metricState = metric.state;
        if (metric.state === "usable") {
            input.value = metric.value.toFixed(2);
            input.readOnly = true;
            help.textContent = `Loaded from trailing ${label}.`;
            return;
        }
        input.readOnly = false;
        if (metric.state === "missing") {
            input.value = "";
            help.textContent = `Trailing ${label} is unavailable. Enter a positive value manually.`;
            return;
        }
        input.value = metric.value.toFixed(2);
        help.textContent = `Reported ${label} is ${metric.value.toFixed(2)} and is not suitable for this model. Enter a positive manual override.`;
    }

    function refreshManualMetricHelp(input, help, label) {
        if (input.readOnly) return;
        const current = classifyMetric(input.value);
        if (current.state === "usable") {
            help.textContent = `Using a positive manual ${label} override.`;
        } else if (input.dataset.metricState === "nonpositive") {
            help.textContent = `The reported ${label} is non-positive. Enter a positive manual override.`;
        } else {
            help.textContent = `Trailing ${label} is unavailable. Enter a positive value manually.`;
        }
    }

    function validateCalculationInputs() {
        clearValidation();
        const fields = activeTab === "earnings"
            ? [
                [epsTtmInput, "Enter a positive current EPS.", CALCULATION_LIMITS.metric],
                [growthRateInput, "Enter EPS growth between -100% and 1,000,000%.", CALCULATION_LIMITS.growthRate],
                [peMultipleInput, "Enter a terminal P/E greater than zero.", CALCULATION_LIMITS.terminalValue],
            ]
            : [
                [fcfShareInput, "Enter positive free cash flow per share.", CALCULATION_LIMITS.metric],
                [fcfGrowthRateInput, "Enter FCF growth between -100% and 1,000,000%.", CALCULATION_LIMITS.growthRate],
                [fcfYieldInput, "Enter a terminal FCF yield greater than zero.", CALCULATION_LIMITS.terminalValue],
            ];
        fields.push([
            desiredReturnInput,
            "Enter a desired return between -99.99% and 1,000,000%.",
            CALCULATION_LIMITS.desiredReturn,
        ]);

        let firstInvalid = null;
        fields.forEach(([input, message, limits]) => {
            const value = Number.parseFloat(input.value);
            if (!Number.isFinite(value) || value < limits.min || value > limits.max) {
                input.setAttribute("aria-invalid", "true");
                const errorElement = validationErrors.get(input);
                if (errorElement) {
                    errorElement.textContent = message;
                    errorElement.classList.remove("hidden");
                }
                firstInvalid ||= input;
            }
        });

        if (firstInvalid) {
            firstInvalid.focus();
            announce("The model contains invalid assumptions. Review the highlighted fields.");
            return false;
        }
        return true;
    }

    function renderCompanyLogo(tickerRaw, nameRaw) {
        if (!companyLogo) {
            return;
        }

        const ticker = String(tickerRaw || "").trim().toUpperCase();
        const displayName = String(nameRaw || ticker || "Company").trim();

        if (!ticker) {
            companyLogo.textContent = "?";
            return;
        }

        const logoImg = document.createElement("img");
        logoImg.src = getLogoUrl(ticker);
        logoImg.alt = `${displayName} logo`;
        logoImg.referrerPolicy = "strict-origin-when-cross-origin";
        logoImg.style.width = "100%";
        logoImg.style.height = "100%";
        logoImg.style.objectFit = "contain";
        logoImg.style.borderRadius = "inherit";
        logoImg.onload = () => onLogoLoad(logoImg, ticker);
        logoImg.onerror = () => onLogoError(logoImg, ticker);

        companyLogo.textContent = "";
        companyLogo.appendChild(logoImg);
    }

    function clearAllFields() {
        clearValidation();
        tickerInput.value = "";
        hideTickerSuggestions(tickerAutocomplete);
        tickerInput.setAttribute("aria-expanded", "false");
        tickerInput.removeAttribute("aria-activedescendant");
        companyInfoDiv.classList.add("hidden-state");
        if (companyLogo) companyLogo.textContent = "";
        if (companyName) companyName.textContent = "";
        if (companyExchange) companyExchange.textContent = "—";
        if (currentStockPriceDisplay) currentStockPriceDisplay.textContent = "—";

        if (currentEps) currentEps.textContent = "N/A";
        if (currentPe) currentPe.textContent = "N/A";
        if (epsGrowth) epsGrowth.textContent = "N/A";
        if (epsTtmInput) epsTtmInput.value = "";
        if (growthRateInput) growthRateInput.value = "";
        if (peMultipleInput) peMultipleInput.value = "";

        if (currentFcfShare) currentFcfShare.textContent = "N/A";
        if (fcfYield) fcfYield.textContent = "N/A";
        if (sbcImpact) sbcImpact.textContent = "N/A";
        if (fcfShareInput) fcfShareInput.value = "";
        if (fcfGrowthRateInput) fcfGrowthRateInput.value = "";
        if (fcfYieldInput) fcfYieldInput.value = "";

        if (desiredReturnInput) desiredReturnInput.value = "";

        if (returnFromTodayDisplay) returnFromTodayDisplay.textContent = "N/A";
        if (entryPriceDisplay) entryPriceDisplay.textContent = "N/A";
        if (desiredReturnDisplay) desiredReturnDisplay.textContent = "N/A";
        if (priceAfter5YearsDisplay) priceAfter5YearsDisplay.textContent = "N/A";

        if (dcfProjectionChart) {
            dcfProjectionChart.destroy();
            dcfProjectionChart = null;
        }
        projectionOutput.classList.add("hidden");
        projectionPlaceholder.classList.remove("hidden");
        currentTicker = "";
        currentStockPrice = 0;
        hasValidCalculation = false;
        setManualMetricEntry();
        if (saveCalculationBtn) saveCalculationBtn.disabled = true;
        setModelState("Waiting for ticker", "idle");
        setMarketState("Search a ticker to load current market data.", "idle");
        announce("Valuation model cleared.");
    }

    function switchTab(tab) {
        const changed = activeTab !== tab;
        activeTab = tab;
        const earningsActive = tab === "earnings";
        earningsTabBtn.classList.toggle("active", earningsActive);
        cashFlowTabBtn.classList.toggle("active", !earningsActive);
        earningsTabBtn.setAttribute("aria-pressed", String(earningsActive));
        cashFlowTabBtn.setAttribute("aria-pressed", String(!earningsActive));
        earningsSection.classList.toggle("hidden", !earningsActive);
        cashFlowSection.classList.toggle("hidden", earningsActive);
        earningsSummary?.classList.toggle("hidden", !earningsActive);
        cashFlowSummary?.classList.toggle("hidden", earningsActive);
        clearValidation();
        if (changed) invalidateCalculation("Valuation method changed. Recalculate to update the model.", true);
    }

    async function readSavedCalculations(store = calculationStore) {
        if (!store) return [];
        const entry = await store.get(store.keys.calculations());
        return Array.isArray(entry?.data?.calculations) ? entry.data.calculations : [];
    }

    async function writeSavedCalculations(items) {
        savedCalculations = Array.isArray(items) ? items : [];
        if (!calculationStore) return;
        await calculationStore.set(calculationStore.keys.calculations(), {
            calculations: savedCalculations,
        }, {
            ttlMs: CACHE_TTL.savedCalculations,
            staleTtlMs: CACHE_STALE_TTL.savedCalculations,
        });
    }

    async function readCalculationOutbox(store = calculationStore) {
        if (!store) return [];
        const entry = await store.get(store.keys.calculationOutbox());
        const operations = normalizeOutboxOperations(entry?.data?.operations);
        if (JSON.stringify(entry?.data?.operations || []) !== JSON.stringify(operations)) {
            await writeCalculationOutbox(operations, store);
        }
        if (store === calculationStore) calculationOutbox = operations;
        return operations;
    }

    async function writeCalculationOutbox(operations, store = calculationStore) {
        if (!store) return;
        const normalized = normalizeOutboxOperations(operations);
        if (store === calculationStore) calculationOutbox = normalized;
        await store.set(store.keys.calculationOutbox(), {
            operations: normalized,
        }, {
            ttlMs: CACHE_TTL.calculationOutbox,
            staleTtlMs: CACHE_STALE_TTL.calculationOutbox,
        });
    }

    async function queueCalculationOperation(operation) {
        const operations = await readCalculationOutbox();
        await writeCalculationOutbox(queueOutboxOperation(operations, operation));
        await renderSyncIssues();
    }

    async function syncCalculationOutbox({ notifyRejected = false } = {}) {
        if (!calculationStore) return { pendingCount: 0, rejected: [], newlyRejected: [], processed: [] };
        if (syncingCalculationOutbox) {
            const summary = outboxSummary(await readCalculationOutbox());
            return { ...summary, newlyRejected: [], processed: [] };
        }
        const store = calculationStore;
        syncingCalculationOutbox = true;
        try {
            const result = await synchronizeOutboxOperations(
                await readCalculationOutbox(store),
                {
                    shouldContinue: () => calculationStore === store,
                    persist: (operations) => writeCalculationOutbox(operations, store),
                    send: async (operation) => {
                const response = operation.type === "save"
                    ? await guardedApiCall("/save_calculation", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            ticker: operation.snapshot.ticker,
                            name: operation.calculationId,
                            data: operation.snapshot,
                        }),
                    })
                    : await guardedApiCall(`/delete_calculation/${encodeURIComponent(operation.calculationId)}`, {
                        method: "DELETE",
                    });
                        if (!response) return null;
                        let body = {};
                        try {
                            body = await response.clone().json();
                        } catch {
                            // Status still determines whether the operation is retryable.
                        }
                        return { ok: response.ok, status: response.status, body };
                    },
                },
            );
            if (notifyRejected && result.newlyRejected.length) {
                const count = result.newlyRejected.length;
                showToast(
                    `${count} saved-model operation${count === 1 ? " needs" : "s need"} attention. Review Sync issues.`,
                    true,
                    5000,
                    toastContainer,
                );
                announce("Some saved-model changes need correction before they can be synchronized.");
            }
            await renderSyncIssues(result.operations);
            return result;
        } catch (error) {
            console.warn("Calculation sync is unavailable; preserving the outbox.", error);
            const summary = outboxSummary(await readCalculationOutbox(store));
            return { ...summary, newlyRejected: [], processed: [] };
        } finally {
            syncingCalculationOutbox = false;
        }
    }

    function captureCalculationData(calculationId = null) {
        return {
            id: calculationId || `${currentTicker || "UNSET"}-${Date.now()}`,
            ticker: tickerInput.value.trim().toUpperCase(),
            currentStockPrice,
            activeTab,
            earnings: {
                epsTtm: optionalNumber(epsTtmInput.value),
                growthRate: optionalNumber(growthRateInput.value),
                peMultiple: optionalNumber(peMultipleInput.value)
            },
            cashFlow: {
                fcfShare: optionalNumber(fcfShareInput.value),
                fcfGrowthRate: optionalNumber(fcfGrowthRateInput.value),
                fcfYield: optionalNumber(fcfYieldInput.value)
            },
            desiredReturn: optionalNumber(desiredReturnInput.value),
            results: {
                returnFromToday: returnFromTodayDisplay.textContent,
                entryPrice: entryPriceDisplay.textContent,
                desiredReturn: desiredReturnDisplay.textContent,
                priceAfter5Years: priceAfter5YearsDisplay.textContent
            },
            createdAt: new Date().toISOString()
        };
    }

    function renderSavedCalculations(calculations = savedCalculations) {
        if (!savedCalculationsContainer) {
            return;
        }
        if (savedCalculationCount) {
            savedCalculationCount.textContent = `${calculations.length} model${calculations.length === 1 ? "" : "s"}`;
        }
        if (!calculations.length) {
            savedCalculationsContainer.innerHTML = "<p class=\"muted\">No saved models yet. Calculate a valuation to begin your research file.</p>";
            return;
        }
        const fragment = document.createDocumentFragment();
        const rejectedSaveIds = new Set(calculationOutbox
            .filter((operation) => operation.type === "save" && operation.status === "rejected")
            .map((operation) => operation.calculationId));
        calculations
            .slice()
            .reverse()
            .forEach((calc) => {
                const article = document.createElement("article");
                article.className = "dcf-saved-item";

                const div = document.createElement("div");

                const strong = document.createElement("strong");
                strong.textContent = calc.ticker;

                const p = document.createElement("p");
                p.className = "muted";
                p.textContent = new Date(calc.createdAt).toLocaleString();

                const method = document.createElement("span");
                method.className = "dcf-saved-item-method";
                method.textContent = calc.activeTab === "cashFlow" ? "Free cash flow / Yield" : "Earnings / P/E";

                div.appendChild(strong);
                div.appendChild(p);
                div.appendChild(method);
                if (rejectedSaveIds.has(calc.id)) {
                    const badge = document.createElement("span");
                    badge.className = "dcf-sync-issue-badge";
                    badge.textContent = "Sync issue";
                    div.appendChild(badge);
                }

                const btnGroup = document.createElement("div");
                btnGroup.className = "dcf-saved-item-actions";

                const loadButton = document.createElement("button");
                loadButton.className = "load-local-btn";
                loadButton.type = "button";
                loadButton.setAttribute("data-id", calc.id);
                loadButton.textContent = "Load";

                const deleteButton = document.createElement("button");
                deleteButton.className = "delete-local-btn";
                deleteButton.type = "button";
                deleteButton.setAttribute("data-id", calc.id);
                deleteButton.textContent = "Delete";

                btnGroup.appendChild(loadButton);
                btnGroup.appendChild(deleteButton);
                article.appendChild(div);
                article.appendChild(btnGroup);
                fragment.appendChild(article);
            });
        savedCalculationsContainer.textContent = "";
        savedCalculationsContainer.appendChild(fragment);
    }

    async function renderSyncIssues(operations = null) {
        if (!syncIssuesPanel || !syncIssuesContainer) return;
        const source = operations || await readCalculationOutbox();
        const rejected = normalizeOutboxOperations(source)
            .filter((operation) => operation.status === "rejected");
        syncIssuesPanel.hidden = rejected.length === 0;
        if (syncIssueCount) {
            syncIssueCount.textContent = String(rejected.length);
        }
        syncIssuesContainer.textContent = "";
        rejected.forEach((operation) => {
            const article = document.createElement("article");
            article.className = "dcf-sync-issue";

            const heading = document.createElement("div");
            const label = document.createElement("strong");
            label.textContent = `${operation.type === "save" ? "Save" : "Delete"} · ${operation.snapshot?.ticker || operation.calculationId}`;
            const id = document.createElement("small");
            id.textContent = operation.calculationId;
            heading.append(label, id);

            const reason = document.createElement("p");
            reason.textContent = operation.error?.detail || "The server rejected this operation.";

            const actions = document.createElement("div");
            actions.className = "dcf-sync-issue-actions";
            const retry = document.createElement("button");
            retry.type = "button";
            retry.className = "retry-sync-issue";
            retry.dataset.id = operation.calculationId;
            retry.textContent = "Retry";
            actions.appendChild(retry);

            if (operation.type === "save") {
                const edit = document.createElement("button");
                edit.type = "button";
                edit.className = "edit-sync-issue";
                edit.dataset.id = operation.calculationId;
                edit.textContent = "Edit";
                const discard = document.createElement("button");
                discard.type = "button";
                discard.className = "discard-sync-issue";
                discard.dataset.id = operation.calculationId;
                discard.textContent = "Delete local";
                actions.prepend(edit);
                actions.appendChild(discard);
            } else {
                const restore = document.createElement("button");
                restore.type = "button";
                restore.className = "restore-sync-issue";
                restore.dataset.id = operation.calculationId;
                restore.textContent = "Restore";
                actions.appendChild(restore);
            }

            article.append(heading, reason, actions);
            syncIssuesContainer.appendChild(article);
        });
        renderSavedCalculations();
    }

    async function guardedApiCall(endpoint, options = {}) {
        try {
            return await apiCall(endpoint, options, apiDeps);
        } catch (error) {
            const message = String(error?.message || error);
            if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
                return null;
            }
            throw error;
        }
    }

    function isTickerValid(tickerRaw) {
        const ticker = tickerRaw.trim().toUpperCase();
        if (!SAFE_TICKER_RE.test(ticker)) {
            return false;
        }
        if (!hasTickerDataset) {
            return true;
        }
        return isValidTicker(ticker);
    }

    function invalidateMetricsLoad() {
        metricsLoadGeneration += 1;
        setButtonState(getCurrentDataBtn, "Load market data", false);
    }

    function enterManualMetricsMode(ticker, message) {
        resetMetricSummary();
        companyInfoDiv.classList.remove("hidden-state");
        renderCompanyLogo(ticker, ticker);
        companyName.textContent = ticker;
        renderCompanyExchange(ticker);
        currentStockPrice = 0;
        currentStockPriceDisplay.textContent = "Unavailable";
        currentTicker = ticker;
        epsTtmInput.value = "";
        fcfShareInput.value = "";
        setManualMetricEntry({ earnings: true, cashFlow: true });
        setModelState("Manual assumptions", "manual");
        setMarketState(message, "manual");
        announce(message);
    }

    async function fetchAndPopulateMetrics() {
        const ticker = tickerInput.value.trim().toUpperCase();
        const loadGeneration = ++metricsLoadGeneration;
        const isCurrentLoad = () => loadGeneration === metricsLoadGeneration
            && tickerInput.value.trim().toUpperCase() === ticker;
        if (!ticker) {
            setButtonState(getCurrentDataBtn, "Load market data", false);
            setMarketState("Enter a company or ticker before loading data.", "error");
            showToast("Please enter a ticker symbol.", true, 3000, toastContainer);
            tickerInput.focus();
            return;
        }

        clearValidation();
        invalidateCalculation();
        setButtonState(getCurrentDataBtn, "Loading…", true);
        setModelState("Loading market data", "loading");
        setMarketState("Connecting to the market-data service. This can take a moment.", "loading");
        announce(`Loading current market data for ${ticker}.`);
        projectionPlaceholder.classList.remove("hidden");
        projectionOutput.classList.add("hidden");
        resetMetricSummary();
        currentStockPriceDisplay.textContent = "—";
        if (dcfProjectionChart) {
            dcfProjectionChart.destroy();
            dcfProjectionChart = null;
        }

        try {
            const response = await guardedApiCall(`/get_trailing_metrics?ticker=${ticker}`);
            if (!isCurrentLoad()) return;
            if (!response) {
                enterManualMetricsMode(
                    ticker,
                    "Market data is unavailable. Enter EPS or FCF per share manually to continue.",
                );
                showToast("Backend unavailable. Enter assumptions manually.", true, 3500, toastContainer);
                return;
            }

            const data = await response.json();
            if (!isCurrentLoad()) return;
            if (!response.ok) {
                const responseError = new Error(data.error || "Failed to fetch data");
                responseError.status = response.status;
                responseError.code = data.code || null;
                throw responseError;
            }

            companyInfoDiv.classList.remove("hidden-state");
            renderCompanyLogo(ticker, data.longName || ticker);
            companyName.textContent = data.longName || ticker;
            renderCompanyExchange(ticker);
            currentStockPrice = Number.isFinite(data.regularMarketPrice) && data.regularMarketPrice > 0
                ? data.regularMarketPrice
                : 0;
            currentStockPriceDisplay.textContent = currentStockPrice > 0
                ? `$${currentStockPrice.toFixed(2)}`
                : "Unavailable";

            currentEps.textContent = formatNum(data.trailing_eps, "$");
            currentPe.textContent = formatNum(data.trailing_pe);
            epsGrowth.textContent = formatPercent(data.trailing_eps_growth);
            const epsMetric = classifyMetric(data.trailing_eps);
            configureMetricInput(epsTtmInput, epsTtmHelp, epsMetric, "EPS");

            currentFcfShare.textContent = formatNum(data.fcfShare, "$");
            fcfYield.textContent = formatPercent(data.fcfYield);
            sbcImpact.textContent = formatPercent(data.sbcImpact);
            const fcfMetric = classifyMetric(data.fcfShare);
            configureMetricInput(fcfShareInput, fcfShareHelp, fcfMetric, "FCF per share");

            currentTicker = ticker;
            const metricIssues = [
                epsMetric.state !== "usable"
                    ? `EPS is ${epsMetric.state === "missing" ? "unavailable" : "non-positive"}`
                    : null,
                fcfMetric.state !== "usable"
                    ? `FCF per share is ${fcfMetric.state === "missing" ? "unavailable" : "non-positive"}`
                    : null,
            ].filter(Boolean);
            if (metricIssues.length) {
                const partialMessage = `Market data loaded for ${data.longName || ticker}, but ${metricIssues.join(" and ")}. Enter a positive manual override for the affected method.`;
                setModelState("Manual input required", "manual");
                setMarketState(partialMessage, "manual");
                announce(partialMessage);
                showToast("Some trailing metrics are unavailable. Complete them manually.", true, 4000, toastContainer);
            } else {
                setModelState("Ready to calculate", "ready");
                setMarketState(`Current market data loaded for ${data.longName || ticker}.`, "ready");
                announce(`Current market data loaded for ${data.longName || ticker}.`);
                showToast("Current data loaded successfully!", false, 3000, toastContainer);
            }
        } catch (error) {
            if (!isCurrentLoad()) return;
            const canUseManualMode = error.code === "market_data_unavailable"
                || error.code === "market_data_rate_limited"
                || error.status === 429
                || error.status >= 500;
            if (canUseManualMode) {
                enterManualMetricsMode(
                    ticker,
                    "The market-data provider is unavailable. Enter EPS or FCF per share manually, or retry later.",
                );
                showToast(`Market data unavailable: ${error.message}`, true, 4500, toastContainer);
                return;
            }
            setModelState("Data load failed", "error");
            setMarketState(`Market data could not be loaded: ${error.message}`, "error");
            announce("Market data could not be loaded. Check the ticker and try again.");
            showToast(`Data fetch error: ${error.message}`, true, 4000, toastContainer);
        } finally {
            if (isCurrentLoad()) {
                setButtonState(getCurrentDataBtn, "Load market data", false);
            }
        }
    }

    function calculatePrice() {
        if (!validateCalculationInputs()) {
            invalidateCalculation();
            showToast("Review the highlighted assumptions.", true, 3000, toastContainer);
            return;
        }

        let currentMetric;
        let growthRate;
        let targetMultiple;
        let calculationType;

        if (activeTab === "earnings") {
            currentMetric = parseFloat(epsTtmInput.value);
            growthRate = parseFloat(growthRateInput.value);
            targetMultiple = parseFloat(peMultipleInput.value);
            calculationType = "EPS";
        } else {
            currentMetric = parseFloat(fcfShareInput.value);
            growthRate = parseFloat(fcfGrowthRateInput.value);
            targetMultiple = parseFloat(fcfYieldInput.value);
            calculationType = "FCF";
        }
        const desiredReturnPercent = parseFloat(desiredReturnInput.value);
        const projection = calculateProjection({
            currentMetric,
            growthRatePercent: growthRate,
            terminalValue: targetMultiple,
            desiredReturnPercent,
            currentStockPrice,
            method: activeTab,
        });
        if (!projection.valid) {
            invalidateCalculation();
            setModelState("Invalid calculation", "error");
            announce("The assumptions produced a result that cannot be displayed. Review the values and try again.");
            showToast("These assumptions produce an invalid or unbounded result.", true, 4000, toastContainer);
            return;
        }
        const {
            estimatedPrice5Yr,
            returnFromToday,
            entryPriceForDesiredReturn,
            projectedPrices,
        } = projection;
        const desiredReturn = desiredReturnPercent / 100;

        const hasMarketPrice = currentStockPrice > 0;
        const chartLabels = hasMarketPrice
            ? ["Today", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5"]
            : ["Year 1", "Year 2", "Year 3", "Year 4", "Year 5"];
        const chartPrices = hasMarketPrice
            ? [currentStockPrice, ...projectedPrices]
            : projectedPrices;

        try {
            if (dcfProjectionChart) {
                dcfProjectionChart.destroy();
            }
            dcfProjectionChart = createChart(priceChartCanvas, "Projected Price Growth", {
                labels: chartLabels,
                data: chartPrices,
                type: "line",
                backgroundColor: "rgba(22, 139, 120, .10)",
                borderColor: "#168b78"
            }, false, {
                interactive: true,
                theme: {
                    textColor: "#65706c",
                    gridColor: "rgba(20, 33, 31, .12)",
                    tooltipBackground: "#14211f",
                    tooltipText: "#f1eee5",
                },
            });
        } catch (error) {
            invalidateCalculation();
            setModelState("Chart unavailable", "error");
            announce("The valuation chart could not be created. The result was not saved.");
            showToast(`Chart error: ${error.message}`, true, 3000, toastContainer);
            return;
        }

        projectionPlaceholder.classList.add("hidden");
        projectionOutput.classList.remove("hidden");
        returnFromTodayDisplay.textContent = returnFromToday === null ? "N/A" : `${returnFromToday.toFixed(2)}%`;
        entryPriceDisplay.textContent = `$${entryPriceForDesiredReturn.toFixed(2)}`;
        desiredReturnDisplay.textContent = `${(desiredReturn * 100).toFixed(2)}%`;
        priceAfter5YearsDisplay.textContent = `$${estimatedPrice5Yr.toFixed(2)}`;

        hasValidCalculation = true;
        if (saveCalculationBtn) saveCalculationBtn.disabled = false;
        setModelState("Valuation calculated", "calculated");
        calculationMessage.classList.remove("is-positive", "is-negative");
        if (currentStockPrice <= 0) {
            calculationMessage.textContent = "Market price is unavailable. The model shows a year-five value and target entry price, but cannot calculate a return from today.";
        } else if (returnFromToday >= desiredReturn * 100) {
            calculationMessage.classList.add("is-positive");
            calculationMessage.textContent = `The modeled annual return of ${returnFromToday.toFixed(2)}% meets the ${(desiredReturn * 100).toFixed(2)}% hurdle rate.`;
        } else {
            calculationMessage.classList.add("is-negative");
            calculationMessage.textContent = `The modeled annual return of ${returnFromToday.toFixed(2)}% falls below the ${(desiredReturn * 100).toFixed(2)}% hurdle rate.`;
        }
        announce("Valuation calculated. Five-year projection results are now available.");
    }

    async function saveCalculation() {
        if (!currentTicker || !hasValidCalculation) {
            showToast("Search a ticker and calculate first.", true, 3000, toastContainer);
            return;
        }
        if (!calculationStore) {
            showToast("Sign in before saving calculations.", true, 3000, toastContainer);
            return;
        }
        setModelState("Saving model", "loading");
        saveCalculationBtn.disabled = true;
        try {
            const snapshot = captureCalculationData(editingCalculationId);
            const existing = savedCalculations.filter((item) => item.id !== snapshot.id);
            existing.push(snapshot);
            await writeSavedCalculations(existing);
            renderSavedCalculations(existing);
            await queueCalculationOperation({
                type: "save",
                calculationId: snapshot.id,
                snapshot,
            });
            const syncResult = await syncCalculationOutbox();
            const rejectedSave = syncResult.rejected.find((item) => item.calculationId === snapshot.id);
            if (rejectedSave) {
                setModelState("Saved locally — correction required", "error");
                announce("The model was saved locally, but the server rejected it. Review the Sync issues panel to correct it.");
                showToast(`Saved locally, but synchronization was rejected: ${rejectedSave.error?.detail}`, true, 5000, toastContainer);
                return;
            }
            editingCalculationId = null;
            setModelState("Valuation calculated", "calculated");
            const saveProcessed = syncResult.processed.some((item) => item.calculationId === snapshot.id);
            const saveMessage = saveProcessed
                ? "Model saved and synchronized."
                : "Model saved locally and waiting to synchronize.";
            announce(saveMessage);
            showToast(
                saveProcessed ? "Saved successfully." : "Saved locally; waiting to sync.",
                false,
                3000,
                toastContainer,
            );
        } catch (error) {
            setModelState("Save failed", "error");
            announce("The model could not be saved locally.");
            showToast(`Save failed: ${error.message}`, true, 4000, toastContainer);
        } finally {
            saveCalculationBtn.disabled = !hasValidCalculation;
        }
    }

    async function loadSavedCalculations() {
        if (!calculationStore) return;
        await syncCalculationOutbox({ notifyRejected: true });
        renderSavedCalculations(savedCalculations);

        const response = await guardedApiCall("/load_calculations");
        if (!response) {
            showToast("Loaded local calculations only.", false, 3000, toastContainer);
            announce("Saved models loaded from local storage. Synchronization is unavailable.");
            return;
        }
        if (!response.ok) {
            showToast("Backend load unavailable; local list shown.", true, 3000, toastContainer);
            announce("Synchronization is unavailable. Local saved models are shown.");
            return;
        }

        const backendItems = await response.json();
        if (!Array.isArray(backendItems) || backendItems.length === 0) {
            showToast("No backend calculations found.", false, 2500, toastContainer);
            announce("Synchronization complete. No remote saved models were found.");
            return;
        }

        const local = mergeRemoteCalculations(
            savedCalculations,
            backendItems.map((item) => item.data || item),
            await readCalculationOutbox(),
        );
        const added = Math.max(0, local.length - savedCalculations.length);
        if (added > 0) {
            await writeSavedCalculations(local);
            renderSavedCalculations(local);
            showToast(`Synced ${added} calculation(s) from backend.`, false, 3000, toastContainer);
            announce(`Synchronization complete. ${added} saved model${added === 1 ? " was" : "s were"} added.`);
        } else {
            showToast("All calculations already up to date.", false, 2500, toastContainer);
            announce("Synchronization complete. Saved models are up to date.");
        }
    }

    function showConfirmationModal(message, callback) {
        if (modalMessage) modalMessage.textContent = message;
        if (modalTitle) modalTitle.textContent = "Delete saved model?";
        modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (confirmationModal && !confirmationModal.open) confirmationModal.showModal();
        modalCallback = callback;
        confirmNoBtn?.focus();
    }

    function hideConfirmationModal() {
        if (confirmationModal?.open) confirmationModal.close();
        modalCallback = null;
        modalReturnFocus?.focus();
        modalReturnFocus = null;
    }

    async function deleteCalculation(calcId) {
        if (!calculationStore) return;
        const existing = [...savedCalculations];
        const removedSnapshot = existing.find((calculation) => calculation.id === calcId) || null;
        const updated = existing.filter((c) => c.id !== calcId);
        await writeSavedCalculations(updated);
        renderSavedCalculations(updated);
        await queueCalculationOperation({
            type: "delete",
            calculationId: calcId,
            snapshot: removedSnapshot,
        });
        const syncResult = await syncCalculationOutbox();
        const rejectedDelete = syncResult.rejected.find((item) => item.calculationId === calcId);
        if (rejectedDelete) {
            showToast(`Removed locally; server cleanup was rejected: ${rejectedDelete.error?.detail}`, true, 5000, toastContainer);
            announce("The model was removed locally, but server cleanup was rejected.");
            return;
        }
        const deleteProcessed = syncResult.processed.some((item) => item.calculationId === calcId);
        showToast(deleteProcessed ? "Deleted successfully." : "Deleted locally; waiting to sync.", false, 3000, toastContainer);
        announce(deleteProcessed ? "Saved model deleted and synchronized." : "Saved model deleted locally and waiting to synchronize.");
    }

    function setEditingCalculation(calculationId = null) {
        editingCalculationId = calculationId;
        if (saveCalculationBtn) {
            saveCalculationBtn.textContent = calculationId ? "Save correction" : "Save";
        }
    }

    function populateFormWithCalculationData(data, { editRejected = false } = {}) {
        setEditingCalculation(editRejected ? data.id : null);
        tickerInput.value = data.ticker || "";
        currentTicker = data.ticker || "";
        const savedMarketPrice = Number(data.currentStockPrice);
        currentStockPrice = Number.isFinite(savedMarketPrice) && savedMarketPrice > 0
            ? savedMarketPrice
            : 0;
        currentStockPriceDisplay.textContent = currentStockPrice > 0
            ? `$${currentStockPrice.toFixed(2)}`
            : "Unavailable";
        companyInfoDiv.classList.remove("hidden-state");
        renderCompanyLogo(currentTicker, currentTicker || "Saved calculation");
        companyName.textContent = currentTicker || "Saved calculation";
        renderCompanyExchange(currentTicker);
        resetMetricSummary();
        setMarketState("Saved model loaded from your research file.", "ready");

        if (data.activeTab === "cashFlow") {
            switchTab("cashFlow");
        } else {
            switchTab("earnings");
        }

        const savedEps = classifyMetric(data.earnings?.epsTtm);
        const savedFcf = classifyMetric(data.cashFlow?.fcfShare);
        currentEps.textContent = formatNum(savedEps.value, "$");
        currentFcfShare.textContent = formatNum(savedFcf.value, "$");
        configureMetricInput(epsTtmInput, epsTtmHelp, savedEps, "EPS");
        growthRateInput.value = data.earnings?.growthRate ?? "";
        peMultipleInput.value = data.earnings?.peMultiple ?? "";
        configureMetricInput(fcfShareInput, fcfShareHelp, savedFcf, "FCF per share");
        fcfGrowthRateInput.value = data.cashFlow?.fcfGrowthRate ?? "";
        fcfYieldInput.value = data.cashFlow?.fcfYield ?? "";
        desiredReturnInput.value = data.desiredReturn ?? "";

        calculatePrice();
    }

    function getTickerSuggestionOptions() {
        return [...tickerAutocomplete.querySelectorAll(".ticker-suggestion")];
    }

    function setActiveTickerSuggestion(nextIndex) {
        const suggestions = getTickerSuggestionOptions();
        if (!suggestions.length) {
            tickerInput.removeAttribute("aria-activedescendant");
            return;
        }
        const normalizedIndex = (nextIndex + suggestions.length) % suggestions.length;
        suggestions.forEach((suggestion, index) => {
            const active = index === normalizedIndex;
            suggestion.classList.toggle("is-active", active);
            suggestion.setAttribute("aria-selected", String(active));
        });
        const activeSuggestion = suggestions[normalizedIndex];
        tickerInput.setAttribute("aria-activedescendant", activeSuggestion.id);
        activeSuggestion.scrollIntoView({ block: "nearest" });
    }

    async function refreshTickerSuggestions(query) {
        await showTickerSuggestions(query, tickerAutocomplete, undefined, { variant: "terminal" });
        const suggestions = getTickerSuggestionOptions();
        suggestions.forEach((suggestion, index) => {
            suggestion.id = `dcf-ticker-option-${index}`;
            suggestion.setAttribute("role", "option");
            suggestion.setAttribute("aria-selected", "false");
        });
        const expanded = suggestions.length > 0 && !tickerAutocomplete.classList.contains("hidden");
        tickerInput.setAttribute("aria-expanded", String(expanded));
        if (!expanded) tickerInput.removeAttribute("aria-activedescendant");
    }

    const debouncedSuggestions = debounce((query) => {
        void refreshTickerSuggestions(query);
    }, 200);

    tickerInput.addEventListener("input", (event) => {
        invalidateMetricsLoad();
        currentTicker = "";
        currentStockPrice = 0;
        companyInfoDiv.classList.add("hidden-state");
        if (companyExchange) companyExchange.textContent = "—";
        currentStockPriceDisplay.textContent = "—";
        setManualMetricEntry();
        setMarketState("Ticker changed. Load market data for the new company.", "idle");
        invalidateCalculation("Ticker changed. Load market data and recalculate.", false);
        hideTickerSuggestions(tickerAutocomplete);
        tickerInput.setAttribute("aria-expanded", "false");
        tickerInput.removeAttribute("aria-activedescendant");
        debouncedSuggestions(event.target.value.trim());
    });
    tickerInput.addEventListener("focus", async () => {
        const value = tickerInput.value.trim();
        if (value.length >= 2) {
            await refreshTickerSuggestions(value);
        }
    });
    tickerInput.addEventListener("keydown", (event) => {
        const suggestions = getTickerSuggestionOptions();
        const activeIndex = suggestions.findIndex((suggestion) => suggestion.classList.contains("is-active"));
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && suggestions.length) {
            event.preventDefault();
            const nextIndex = event.key === "ArrowDown" ? activeIndex + 1 : (activeIndex < 0 ? suggestions.length - 1 : activeIndex - 1);
            setActiveTickerSuggestion(nextIndex);
            return;
        }
        if (event.key === "Escape") {
            hideTickerSuggestions(tickerAutocomplete);
            tickerInput.setAttribute("aria-expanded", "false");
            tickerInput.removeAttribute("aria-activedescendant");
            return;
        }
        if (event.key !== "Enter") {
            return;
        }
        event.preventDefault();
        const activeSuggestion = suggestions[activeIndex];
        if (activeSuggestion) tickerInput.value = activeSuggestion.dataset.symbol;
        hideTickerSuggestions(tickerAutocomplete);
        tickerInput.setAttribute("aria-expanded", "false");
        tickerInput.removeAttribute("aria-activedescendant");
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!isTickerValid(ticker)) {
            showToast("Please enter a valid ticker symbol.", true, 3000, toastContainer);
            tickerInput.focus();
            return;
        }
        fetchAndPopulateMetrics();
    });

    tickerAutocomplete.addEventListener("click", (event) => {
        const suggestion = event.target.closest(".ticker-suggestion");
        if (!suggestion) {
            return;
        }
        tickerInput.value = suggestion.dataset.symbol;
        hideTickerSuggestions(tickerAutocomplete);
        tickerInput.setAttribute("aria-expanded", "false");
        tickerInput.removeAttribute("aria-activedescendant");
        fetchAndPopulateMetrics();
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(".search-wrapper")) {
            hideTickerSuggestions(tickerAutocomplete);
            tickerInput.setAttribute("aria-expanded", "false");
            tickerInput.removeAttribute("aria-activedescendant");
        }
    });

    if (savedCalculationsContainer) {
        savedCalculationsContainer.addEventListener("click", (event) => {
            const loadBtn = event.target.closest(".load-local-btn");
            if (loadBtn) {
                const selected = savedCalculations.find((calc) => calc.id === loadBtn.dataset.id);
                if (!selected) {
                    showToast("Saved calculation not found.", true, 2500, toastContainer);
                    return;
                }
                invalidateMetricsLoad();
                populateFormWithCalculationData(selected);
                showToast("Saved calculation loaded.", false, 2500, toastContainer);
                return;
            }

            const deleteBtn = event.target.closest(".delete-local-btn");
            if (deleteBtn) {
                const calcId = deleteBtn.dataset.id;
                showConfirmationModal("This permanently removes the saved valuation from this account. If offline, the deletion will synchronize later.", () => deleteCalculation(calcId));
            }
        });
    }

    syncIssuesContainer?.addEventListener("click", async (event) => {
        const button = event.target.closest("button[data-id]");
        if (!button || !calculationStore) return;
        const calculationId = button.dataset.id;
        const operations = await readCalculationOutbox();
        const operation = operations.find((item) => item.calculationId === calculationId);
        if (!operation) {
            await renderSyncIssues(operations);
            return;
        }

        if (button.classList.contains("edit-sync-issue") && operation.snapshot) {
            invalidateMetricsLoad();
            populateFormWithCalculationData(operation.snapshot, { editRejected: true });
            document.getElementById("assumptionsTitle")?.scrollIntoView({ behavior: "smooth", block: "start" });
            showToast("Rejected model loaded. Correct it and save the correction.", false, 3500, toastContainer);
            return;
        }

        if (button.classList.contains("retry-sync-issue")) {
            await writeCalculationOutbox(retryOutboxOperation(operations, calculationId));
            await renderSyncIssues();
            const result = await syncCalculationOutbox({ notifyRejected: true });
            const succeeded = result.processed.some((item) => item.calculationId === calculationId);
            const rejectedAgain = result.rejected.some((item) => item.calculationId === calculationId);
            showToast(
                succeeded
                    ? "Operation synchronized."
                    : rejectedAgain
                        ? "The server rejected this operation again. Edit it or review the error."
                        : "Retry is still waiting for the service.",
                !succeeded,
                3500,
                toastContainer,
            );
            return;
        }

        if (button.classList.contains("restore-sync-issue") && operation.snapshot) {
            const restored = savedCalculations.filter((item) => item.id !== calculationId);
            restored.push(operation.snapshot);
            await writeSavedCalculations(restored);
            await writeCalculationOutbox(discardOutboxOperation(operations, calculationId));
            await renderSyncIssues();
            showToast("The locally deleted model was restored.", false, 3000, toastContainer);
            return;
        }

        if (button.classList.contains("discard-sync-issue")) {
            showConfirmationModal(
                "This removes the rejected local model and its synchronization issue. This cannot be undone.",
                async () => {
                    await writeSavedCalculations(savedCalculations.filter((item) => item.id !== calculationId));
                    await writeCalculationOutbox(discardOutboxOperation(await readCalculationOutbox(), calculationId));
                    await renderSyncIssues();
                    showToast("Rejected local model removed.", false, 3000, toastContainer);
                },
            );
        }
    });

    if (confirmYesBtn) {
        confirmYesBtn.addEventListener("click", () => {
            if (modalCallback) modalCallback();
            hideConfirmationModal();
        });
    }
    if (confirmNoBtn) {
        confirmNoBtn.addEventListener("click", hideConfirmationModal);
    }
    confirmationModal?.addEventListener("cancel", (event) => {
        event.preventDefault();
        hideConfirmationModal();
    });
    confirmationModal?.addEventListener("click", (event) => {
        if (event.target === confirmationModal) hideConfirmationModal();
    });

    getCurrentDataBtn.addEventListener("click", () => {
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!isTickerValid(ticker)) {
            showToast("Please enter a valid ticker symbol.", true, 3000, toastContainer);
            return;
        }
        fetchAndPopulateMetrics();
    });
    calculatePriceBtn.addEventListener("click", calculatePrice);
    assumptionInputs.forEach((input) => {
        input?.addEventListener("input", () => {
            clearValidation();
            if (input === epsTtmInput) refreshManualMetricHelp(epsTtmInput, epsTtmHelp, "EPS");
            if (input === fcfShareInput) refreshManualMetricHelp(fcfShareInput, fcfShareHelp, "FCF per share");
            invalidateCalculation("Assumptions changed. Recalculate to update the model.", false);
        });
    });
    earningsTabBtn.addEventListener("click", () => switchTab("earnings"));
    cashFlowTabBtn.addEventListener("click", () => switchTab("cashFlow"));
    saveCalculationBtn?.addEventListener("click", saveCalculation);
    clearBtn?.addEventListener("click", () => {
        invalidateMetricsLoad();
        setEditingCalculation();
        clearAllFields();
    });
    loadCalculationsBtn?.addEventListener("click", loadSavedCalculations);
    window.addEventListener("online", () => {
        void syncCalculationOutbox({ notifyRejected: true });
    });

    renderSavedCalculations();

    observeAuthState(async (user) => {
        if (!user) {
            calculationStore = null;
            savedCalculations = [];
            calculationOutbox = [];
            renderSavedCalculations([]);
            await renderSyncIssues([]);
            return;
        }
        const storeForUser = createUserDataStore(user.uid);
        calculationStore = storeForUser;
        savedCalculations = await readSavedCalculations(storeForUser);
        calculationOutbox = await readCalculationOutbox(storeForUser);
        if (calculationStore !== storeForUser) return;
        renderSavedCalculations(savedCalculations);
        await renderSyncIssues(calculationOutbox);
        await syncCalculationOutbox({ notifyRejected: true });
        if (calculationStore !== storeForUser) return;
        await loadSavedCalculations();
        if (calculationStore !== storeForUser) return;
        const tickerResult = await fetchTickers(async (endpoint) => {
            const response = await guardedApiCall(endpoint);
            if (response) {
                return response;
            }
            return {
                ok: false,
                status: 503,
                async json() {
                    return [];
                }
            };
        });
        hasTickerDataset = Array.isArray(tickerResult) && tickerResult.length > 0;
    });
});
