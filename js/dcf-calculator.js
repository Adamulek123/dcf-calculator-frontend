import { apiCall, setButtonState } from "./api.js";
import { showToast } from "./toast.js";
import { debounce, fetchTickers, isValidTicker, showTickerSuggestions, hideTickerSuggestions, getLogoUrl, onLogoLoad, onLogoError } from "./ticker.js";
import { createChart } from "./charts.js";
import { auth, logoutUser, observeAuthState } from "./auth.js";
import { CACHE_STALE_TTL, CACHE_TTL, createUserDataStore } from "./data-store.js";

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
    const currentStockPriceDisplay = document.getElementById("currentStockPrice");
    const currentEps = document.getElementById("currentEps");
    const currentPe = document.getElementById("currentPe");
    const epsGrowth = document.getElementById("epsGrowth");
    const epsTtmInput = document.getElementById("epsTtmInput");
    const growthRateInput = document.getElementById("growthRateInput");
    const peMultipleInput = document.getElementById("peMultipleInput");
    const currentFcfShare = document.getElementById("currentFcfShare");
    const fcfYield = document.getElementById("fcfYield");
    const sbcImpact = document.getElementById("sbcImpact");
    const fcfShareInput = document.getElementById("fcfShareInput");
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
    const dcfValidationMessage = document.getElementById("dcfValidationMessage");
    const toastContainer = document.getElementById("toast-container");
    const confirmationModal = document.getElementById("confirmationModal");
    const modalMessage = document.getElementById("modalMessage");
    const modalTitle = document.getElementById("modalTitle");
    const confirmYesBtn = document.getElementById("confirmYesBtn");
    const confirmNoBtn = document.getElementById("confirmNoBtn");

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
    let deadLetterCalculations = [];
    let syncingCalculationOutbox = false;
    let metricsLoadGeneration = 0;
    let loadedTicker = "";
    let lastCalculation = null;
    let activeTickerSuggestion = -1;

    const DCF_LIMITS = Object.freeze({
        metricMin: 0.000001,
        metricMax: 10000000,
        growthMin: -99.9,
        growthMax: 200,
        peMin: 0.1,
        peMax: 200,
        fcfYieldMin: 0.1,
        fcfYieldMax: 100,
        desiredReturnMin: -99.9,
        desiredReturnMax: 200,
        priceMax: 1000000000,
    });

    const formatNum = (num, prefix = "", suffix = "") => (typeof num === "number" && Number.isFinite(num) ? `${prefix}${num.toFixed(2)}${suffix}` : "N/A");
    const formatPercent = (num) => (typeof num === "number" && Number.isFinite(num) ? `${(num * 100).toFixed(2)}%` : "N/A");
    const finiteNumber = (value) => {
        if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    };

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

    function normalizeTicker(value) {
        return String(value || "").trim().toUpperCase();
    }

    function setValidationMessage(message = "", input = null) {
        if (dcfValidationMessage) dcfValidationMessage.textContent = message;
        const inputs = [
            epsTtmInput,
            growthRateInput,
            peMultipleInput,
            fcfShareInput,
            fcfGrowthRateInput,
            fcfYieldInput,
            desiredReturnInput,
        ];
        inputs.forEach((field) => {
            if (!field || field === input) return;
            field.setCustomValidity("");
            field.removeAttribute("aria-invalid");
        });
        if (input) {
            input.setCustomValidity(message);
            input.toggleAttribute("aria-invalid", Boolean(message));
        }
    }

    function clearValidation() {
        setValidationMessage("");
    }

    function resetLoadedState({ resetInputs = true } = {}) {
        loadedTicker = "";
        currentTicker = "";
        currentStockPrice = 0;
        lastCalculation = null;
        companyInfoDiv.classList.add("hidden-state");
        if (companyLogo) companyLogo.textContent = "";
        if (companyName) companyName.textContent = "";
        if (currentStockPriceDisplay) currentStockPriceDisplay.textContent = "$0.00";
        if (currentEps) currentEps.textContent = "$0.00";
        if (currentPe) currentPe.textContent = "0.00";
        if (epsGrowth) epsGrowth.textContent = "0.0%";
        if (currentFcfShare) currentFcfShare.textContent = "$0.00";
        if (fcfYield) fcfYield.textContent = "0.0%";
        if (sbcImpact) sbcImpact.textContent = "0.0%";
        if (resetInputs) {
            if (epsTtmInput) epsTtmInput.value = "0.00";
            if (growthRateInput) growthRateInput.value = "";
            if (peMultipleInput) peMultipleInput.value = "";
            if (fcfShareInput) fcfShareInput.value = "0.00";
            if (fcfGrowthRateInput) fcfGrowthRateInput.value = "";
            if (fcfYieldInput) fcfYieldInput.value = "";
            if (desiredReturnInput) desiredReturnInput.value = "";
        }
        if (dcfProjectionChart) {
            dcfProjectionChart.destroy();
            dcfProjectionChart = null;
        }
        projectionOutput.classList.add("hidden");
        projectionPlaceholder.classList.remove("hidden");
        if (returnFromTodayDisplay) returnFromTodayDisplay.textContent = "N/A";
        if (entryPriceDisplay) entryPriceDisplay.textContent = "N/A";
        if (desiredReturnDisplay) desiredReturnDisplay.textContent = "N/A";
        if (priceAfter5YearsDisplay) priceAfter5YearsDisplay.textContent = "N/A";
        clearValidation();
    }

    function clearAllFields() {
        if (tickerInput) tickerInput.value = "";
        resetLoadedState({ resetInputs: true });
    }

    function dcfInputFields() {
        return activeTab === "earnings"
            ? [
                { input: epsTtmInput, label: "EPS (TTM)", min: DCF_LIMITS.metricMin, max: DCF_LIMITS.metricMax, positive: true },
                { input: growthRateInput, label: "EPS growth rate", min: DCF_LIMITS.growthMin, max: DCF_LIMITS.growthMax },
                { input: peMultipleInput, label: "PE multiple", min: DCF_LIMITS.peMin, max: DCF_LIMITS.peMax, positive: true },
            ]
            : [
                { input: fcfShareInput, label: "FCF/share (TTM)", min: DCF_LIMITS.metricMin, max: DCF_LIMITS.metricMax, positive: true },
                { input: fcfGrowthRateInput, label: "FCF growth rate", min: DCF_LIMITS.growthMin, max: DCF_LIMITS.growthMax },
                { input: fcfYieldInput, label: "FCF yield", min: DCF_LIMITS.fcfYieldMin, max: DCF_LIMITS.fcfYieldMax, positive: true },
            ];
    }

    function validateCalculationInputs() {
        clearValidation();
        const ticker = normalizeTicker(tickerInput.value);
        if (!ticker || !loadedTicker || ticker !== loadedTicker || currentTicker !== ticker) {
            return { ok: false, message: "Load current data for this ticker before calculating." };
        }
        if (!Number.isFinite(currentStockPrice) || currentStockPrice <= 0 || currentStockPrice > DCF_LIMITS.priceMax) {
            return { ok: false, message: "The loaded stock price is unavailable. Search again before calculating." };
        }
        for (const field of dcfInputFields()) {
            if (!field.input || String(field.input.value || "").trim() === "") {
                return { ok: false, message: `${field.label} is required and must be a finite number.`, input: field.input };
            }
            const value = Number(field.input?.value);
            if (!field.input || !Number.isFinite(value)) {
                return { ok: false, message: `${field.label} is required and must be a finite number.`, input: field.input };
            }
            if (value < field.min || value > field.max || (field.positive && value <= 0)) {
                return {
                    ok: false,
                    message: `${field.label} must be between ${field.min} and ${field.max}.`,
                    input: field.input,
                };
            }
        }
        if (String(desiredReturnInput?.value || "").trim() === "") {
            return { ok: false, message: "Desired return is required and must be a finite number.", input: desiredReturnInput };
        }
        const desiredReturn = Number(desiredReturnInput?.value);
        if (!Number.isFinite(desiredReturn)) {
            return { ok: false, message: "Desired return is required and must be a finite number.", input: desiredReturnInput };
        }
        if (desiredReturn < DCF_LIMITS.desiredReturnMin || desiredReturn > DCF_LIMITS.desiredReturnMax) {
            return {
                ok: false,
                message: `Desired return must be between ${DCF_LIMITS.desiredReturnMin}% and ${DCF_LIMITS.desiredReturnMax}%.`,
                input: desiredReturnInput,
            };
        }
        return { ok: true };
    }

    function calculationInputSignature() {
        return JSON.stringify({
            ticker: normalizeTicker(tickerInput.value),
            activeTab,
            currentStockPrice,
            epsTtm: epsTtmInput.value,
            growthRate: growthRateInput.value,
            peMultiple: peMultipleInput.value,
            fcfShare: fcfShareInput.value,
            fcfGrowthRate: fcfGrowthRateInput.value,
            fcfYield: fcfYieldInput.value,
            desiredReturn: desiredReturnInput.value,
        });
    }

    function switchTab(tab) {
        activeTab = tab;
        lastCalculation = null;
        clearValidation();
        projectionOutput.classList.add("hidden");
        projectionPlaceholder.classList.remove("hidden");
        if (dcfProjectionChart) {
            dcfProjectionChart.destroy();
            dcfProjectionChart = null;
        }
        const earningsActive = tab === "earnings";
        earningsTabBtn.classList.toggle("active", earningsActive);
        cashFlowTabBtn.classList.toggle("active", !earningsActive);
        earningsSection.classList.toggle("hidden", !earningsActive);
        cashFlowSection.classList.toggle("hidden", earningsActive);
    }

    async function readSavedCalculations(store = calculationStore) {
        if (!store) return [];
        const entry = await store.get(store.keys.calculations());
        return Array.isArray(entry?.data?.calculations) ? entry.data.calculations : [];
    }

    async function writeSavedCalculations(items) {
        const next = Array.isArray(items) ? items : [];
        if (!calculationStore) return { persisted: false, error: new Error("Sign in before saving calculations.") };
        const result = await calculationStore.set(calculationStore.keys.calculations(), {
            calculations: next,
        }, {
            ttlMs: CACHE_TTL.savedCalculations,
            staleTtlMs: CACHE_STALE_TTL.savedCalculations,
        });
        if (result?.persisted === false) {
            return result;
        }
        savedCalculations = next;
        return result;
    }

    async function readCalculationOutbox(store = calculationStore) {
        if (!store) return [];
        const entry = await store.get(store.keys.calculationOutbox());
        return Array.isArray(entry?.data?.operations) ? entry.data.operations : [];
    }

    async function writeCalculationOutbox(operations, store = calculationStore) {
        if (!store) return { persisted: false, error: new Error("Sign in before syncing calculations.") };
        return store.set(store.keys.calculationOutbox(), {
            operations: Array.isArray(operations) ? operations : [],
        }, {
            ttlMs: CACHE_TTL.calculationOutbox,
            staleTtlMs: CACHE_STALE_TTL.calculationOutbox,
            durable: true,
        });
    }

    async function readCalculationDeadLetters(store = calculationStore) {
        if (!store || !store.keys.calculationDeadLetters) return [];
        const entry = await store.get(store.keys.calculationDeadLetters());
        return Array.isArray(entry?.data?.operations) ? entry.data.operations : [];
    }

    async function writeCalculationDeadLetters(operations, store = calculationStore) {
        if (!store || !store.keys.calculationDeadLetters) {
            return { persisted: false, error: new Error("Sign in before managing failed calculations.") };
        }
        return store.set(store.keys.calculationDeadLetters(), {
            operations: Array.isArray(operations) ? operations : [],
        }, {
            ttlMs: CACHE_TTL.calculationDeadLetters,
            staleTtlMs: CACHE_STALE_TTL.calculationDeadLetters,
            durable: true,
        });
    }

    function permanentOutboxStatus(status) {
        return Number.isInteger(status)
            && status >= 400
            && status < 500
            && status !== 408
            && status !== 429;
    }

    async function deadLetterOperation(operation, response, store) {
        const existing = await readCalculationDeadLetters(store);
        const deadLetter = {
            ...operation,
            failedAt: new Date().toISOString(),
            status: response?.status ?? null,
            error: `The server rejected this ${operation.type} operation (${response?.status ?? "unknown"}).`,
        };
        const withoutSame = existing.filter((item) => item.calculationId !== operation.calculationId);
        const result = await writeCalculationDeadLetters([...withoutSame, deadLetter], store);
        if (result?.persisted === false) throw new Error("Could not persist the rejected calculation for review.");
        return deadLetter;
    }

    async function queueCalculationOperation(operation) {
        if (!operation || !["save", "delete"].includes(operation.type) || !operation.calculationId) {
            throw new TypeError("Invalid calculation sync operation.");
        }
        if (operation.type === "save") {
            const snapshot = operation.snapshot;
            const ticker = normalizeTicker(snapshot?.ticker);
            const activeInputs = snapshot?.activeTab === "cashFlow"
                ? [snapshot?.cashFlow?.fcfShare, snapshot?.cashFlow?.fcfGrowthRate, snapshot?.cashFlow?.fcfYield]
                : [snapshot?.earnings?.epsTtm, snapshot?.earnings?.growthRate, snapshot?.earnings?.peMultiple];
            const numbers = [...activeInputs, snapshot?.desiredReturn, snapshot?.currentStockPrice];
            const [metric, growth, multipleOrYield, desiredReturn, stockPrice] = numbers;
            const multipleValid = snapshot?.activeTab === "cashFlow"
                ? multipleOrYield >= DCF_LIMITS.fcfYieldMin && multipleOrYield <= DCF_LIMITS.fcfYieldMax
                : multipleOrYield >= DCF_LIMITS.peMin && multipleOrYield <= DCF_LIMITS.peMax;
            if (!SAFE_TICKER_RE.test(ticker)
                || numbers.some((value) => typeof value !== "number" || !Number.isFinite(value))
                || metric < DCF_LIMITS.metricMin
                || metric > DCF_LIMITS.metricMax
                || growth < DCF_LIMITS.growthMin
                || growth > DCF_LIMITS.growthMax
                || !multipleValid
                || desiredReturn < DCF_LIMITS.desiredReturnMin
                || desiredReturn > DCF_LIMITS.desiredReturnMax
                || stockPrice <= 0
                || stockPrice > DCF_LIMITS.priceMax) {
                throw new TypeError("A calculation must contain finite values before it can be queued.");
            }
            if (!snapshot?.results || Object.values(snapshot.results).some((value) => !value || /N\/A|Infinity|NaN/.test(String(value)))) {
                throw new TypeError("Calculate a valid projection before saving it.");
            }
        }
        const operations = await readCalculationOutbox();
        const withoutSameCalculation = operations.filter((item) => item.calculationId !== operation.calculationId);
        withoutSameCalculation.push({ ...operation, queuedAt: new Date().toISOString() });
        const result = await writeCalculationOutbox(withoutSameCalculation);
        if (result?.persisted === false) throw new Error("Calculation sync is memory-only; browser storage is unavailable.");
        return result;
    }

    async function syncCalculationOutbox() {
        if (!calculationStore || syncingCalculationOutbox) return false;
        const store = calculationStore;
        syncingCalculationOutbox = true;
        try {
            let operations = await readCalculationOutbox(store);
            while (operations.length) {
                if (calculationStore !== store) return false;
                const operation = operations[0];
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
                if (!response) break;
                if (!response.ok) {
                    if (!permanentOutboxStatus(response.status)) break;
                    if (calculationStore !== store) return false;
                    const deadLetter = await deadLetterOperation(operation, response, store);
                    deadLetterCalculations = await readCalculationDeadLetters(store);
                    operations = operations.slice(1);
                    const remaining = await writeCalculationOutbox(operations, store);
                    if (remaining?.persisted === false) throw new Error("Could not remove the rejected calculation from the durable outbox.");
                    showToast(
                        `${deadLetter.type === "save" ? "Save" : "Delete"} rejected (${deadLetter.status}). Review the failed item below; later changes can still sync.`,
                        true,
                        5500,
                        toastContainer,
                    );
                    continue;
                }
                if (calculationStore !== store) return false;
                operations = operations.slice(1);
                const result = await writeCalculationOutbox(operations, store);
                if (result?.persisted === false) throw new Error("Could not persist calculation sync progress.");
            }
            return operations.length === 0;
        } catch (error) {
            console.warn("Calculation sync is unavailable; preserving the outbox.", error);
            return false;
        } finally {
            syncingCalculationOutbox = false;
        }
    }

    function captureCalculationData({ id = null } = {}) {
        return {
            id: id || `${loadedTicker || "UNSET"}-${Date.now()}`,
            ticker: loadedTicker,
            currentStockPrice,
            activeTab,
            earnings: {
                epsTtm: parseFloat(epsTtmInput.value),
                growthRate: parseFloat(growthRateInput.value),
                peMultiple: parseFloat(peMultipleInput.value)
            },
            cashFlow: {
                fcfShare: parseFloat(fcfShareInput.value),
                fcfGrowthRate: parseFloat(fcfGrowthRateInput.value),
                fcfYield: parseFloat(fcfYieldInput.value)
            },
            desiredReturn: parseFloat(desiredReturnInput.value),
            results: {
                returnFromToday: returnFromTodayDisplay.textContent,
                entryPrice: entryPriceDisplay.textContent,
                desiredReturn: desiredReturnDisplay.textContent,
                priceAfter5Years: priceAfter5YearsDisplay.textContent
            },
            createdAt: new Date().toISOString()
        };
    }

    function renderSavedCalculations(calculations = savedCalculations, deadLetters = deadLetterCalculations) {
        if (!savedCalculationsContainer) {
            return;
        }
        if (!calculations.length && !deadLetters.length) {
            savedCalculationsContainer.innerHTML = "<p class=\"muted\">No saved calculations yet.</p>";
            return;
        }
        const fragment = document.createDocumentFragment();
        deadLetters.forEach((failed) => {
            const article = document.createElement("article");
            article.className = "saved-item";
            const div = document.createElement("div");
            const strong = document.createElement("strong");
            strong.textContent = `${failed.type === "save" ? "Save" : "Delete"} needs correction`;
            const p = document.createElement("p");
            p.className = "muted";
            p.textContent = failed.type === "save"
                ? `${failed.snapshot?.ticker || "Unknown ticker"}: ${failed.error || "The server rejected this calculation."}`
                : `${failed.calculationId}: ${failed.error || "The server rejected this deletion."}`;
            const hint = document.createElement("p");
            hint.className = "muted";
            hint.textContent = failed.type === "save"
                ? "Load it, correct the assumptions, calculate again, then save a new snapshot."
                : "Remove this failed operation once you have confirmed the server state.";
            div.append(strong, p, hint);
            const btnGroup = document.createElement("div");
            btnGroup.className = "saved-item-actions";
            if (failed.type === "save" && failed.snapshot?.id) {
                const loadButton = document.createElement("button");
                loadButton.className = "btn btn-ghost load-local-btn";
                loadButton.type = "button";
                loadButton.dataset.id = failed.snapshot.id;
                loadButton.textContent = "Load";
                btnGroup.appendChild(loadButton);
            }
            const discardButton = document.createElement("button");
            discardButton.className = "btn btn-danger remove-dead-letter-btn";
            discardButton.type = "button";
            discardButton.dataset.id = failed.calculationId;
            discardButton.textContent = "Remove";
            btnGroup.appendChild(discardButton);
            article.append(div, btnGroup);
            fragment.appendChild(article);
        });
        calculations
            .slice()
            .reverse()
            .forEach((calc) => {
                const article = document.createElement("article");
                article.className = "saved-item";

                const div = document.createElement("div");

                const strong = document.createElement("strong");
                strong.textContent = calc.ticker;

                const p = document.createElement("p");
                p.className = "muted";
                p.textContent = new Date(calc.createdAt).toLocaleString();

                div.appendChild(strong);
                div.appendChild(p);

                const btnGroup = document.createElement("div");
                btnGroup.className = "saved-item-actions";

                const loadButton = document.createElement("button");
                loadButton.className = "btn btn-ghost load-local-btn";
                loadButton.type = "button";
                loadButton.setAttribute("data-id", calc.id);
                loadButton.textContent = "Load";

                const deleteButton = document.createElement("button");
                deleteButton.className = "btn btn-danger delete-local-btn";
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

    async function removeDeadLetter(calculationId) {
        if (!calculationStore) return;
        const removed = deadLetterCalculations.find((item) => item.calculationId === calculationId);
        const next = deadLetterCalculations.filter((item) => item.calculationId !== calculationId);
        const result = await writeCalculationDeadLetters(next);
        if (result?.persisted === false) {
            showToast("Could not remove the failed operation because browser storage is unavailable.", true, 4000, toastContainer);
            return;
        }
        deadLetterCalculations = next;
        if (removed?.type === "save") {
            const saved = savedCalculations.find((item) => item.id === calculationId);
            if (saved) {
                const savedResult = await writeSavedCalculations(savedCalculations.filter((item) => item.id !== calculationId));
                if (savedResult?.persisted === false) {
                    showToast("The failed item remains because browser storage is unavailable.", true, 4000, toastContainer);
                    return;
                }
            }
        }
        renderSavedCalculations();
        showToast("Failed sync item removed.", false, 2500, toastContainer);
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
        resetLoadedState({ resetInputs: true });
        setButtonState(getCurrentDataBtn, "Search", false);
    }

    async function fetchAndPopulateMetrics() {
        const ticker = normalizeTicker(tickerInput.value);
        const loadGeneration = ++metricsLoadGeneration;
        const isCurrentLoad = () => loadGeneration === metricsLoadGeneration
            && tickerInput.value.trim().toUpperCase() === ticker;
        if (!ticker) {
            setButtonState(getCurrentDataBtn, "Search", false);
            showToast("Please enter a ticker symbol.", true, 3000, toastContainer);
            return;
        }

        resetLoadedState({ resetInputs: true });
        setButtonState(getCurrentDataBtn, "Fetching...", true);

        try {
            const response = await guardedApiCall(`/get_trailing_metrics?ticker=${encodeURIComponent(ticker)}`, {
                coalesce: false,
            });
            if (!isCurrentLoad()) return;
            if (!response) {
                resetLoadedState({ resetInputs: true });
                showToast("Backend unavailable. Search again when the service is available.", true, 3500, toastContainer);
                return;
            }

            const data = await response.json();
            if (!isCurrentLoad()) return;
            if (!response.ok) {
                throw new Error(data.error || "Failed to fetch data");
            }

            const stockPrice = finiteNumber(data.regularMarketPrice);
            const trailingEps = finiteNumber(data.trailing_eps);
            const trailingPe = finiteNumber(data.trailing_pe);
            const trailingEpsGrowth = finiteNumber(data.trailing_eps_growth);
            const fcfShareValue = finiteNumber(data.fcfShare);
            const fcfYieldValue = finiteNumber(data.fcfYield);
            const sbcImpactValue = finiteNumber(data.sbcImpact);

            companyInfoDiv.classList.remove("hidden-state");
            renderCompanyLogo(ticker, data.longName || ticker);
            companyName.textContent = data.longName || ticker;
            currentStockPrice = stockPrice ?? 0;
            currentStockPriceDisplay.textContent = stockPrice !== null ? `$${stockPrice.toFixed(2)}` : "N/A";

            currentEps.textContent = formatNum(trailingEps, "$");
            currentPe.textContent = formatNum(trailingPe);
            epsGrowth.textContent = formatPercent(trailingEpsGrowth);
            epsTtmInput.value = trailingEps !== null ? trailingEps.toFixed(2) : "";

            currentFcfShare.textContent = formatNum(fcfShareValue, "$");
            fcfYield.textContent = formatPercent(fcfYieldValue);
            sbcImpact.textContent = formatPercent(sbcImpactValue);
            fcfShareInput.value = fcfShareValue !== null ? fcfShareValue.toFixed(2) : "";

            loadedTicker = ticker;
            currentTicker = ticker;
            lastCalculation = null;
            clearValidation();
            showToast("Current data loaded successfully!", false, 3000, toastContainer);
        } catch (error) {
            if (!isCurrentLoad()) return;
            resetLoadedState({ resetInputs: true });
            showToast(`Data fetch error: ${error.message}`, true, 4000, toastContainer);
        } finally {
            if (isCurrentLoad()) {
                setButtonState(getCurrentDataBtn, "Search", false);
            }
        }
    }

    function calculatePrice() {
        const validation = validateCalculationInputs();
        if (!validation.ok) {
            setValidationMessage(validation.message, validation.input || null);
            showToast(validation.message, true, 3500, toastContainer);
            projectionOutput.classList.add("hidden");
            projectionPlaceholder.classList.remove("hidden");
            lastCalculation = null;
            return false;
        }

        let currentMetric;
        let growthRate;
        let targetMultiple;
        let calculationType;
        let impliedCurrentMultiple;

        if (activeTab === "earnings") {
            currentMetric = parseFloat(epsTtmInput.value);
            growthRate = parseFloat(growthRateInput.value) / 100;
            targetMultiple = parseFloat(peMultipleInput.value);
            calculationType = "EPS";
            impliedCurrentMultiple = currentMetric > 0 ? currentStockPrice / currentMetric : targetMultiple;
        } else {
            currentMetric = parseFloat(fcfShareInput.value);
            growthRate = parseFloat(fcfGrowthRateInput.value) / 100;
            targetMultiple = parseFloat(fcfYieldInput.value) / 100;
            calculationType = "FCF";
            impliedCurrentMultiple = currentStockPrice > 0 ? currentMetric / currentStockPrice : targetMultiple;
        }
        const desiredReturn = parseFloat(desiredReturnInput.value) / 100;

        projectionPlaceholder.classList.add("hidden");
        projectionOutput.classList.remove("hidden");

        const estimatedMetric5Yr = currentMetric * Math.pow(1 + growthRate, 5);
        const estimatedPrice5Yr = calculationType === "EPS" ? estimatedMetric5Yr * targetMultiple : estimatedMetric5Yr / targetMultiple;
        const returnFromToday = (Math.pow(estimatedPrice5Yr / currentStockPrice, 1 / 5) - 1) * 100;
        const entryPriceForDesiredReturn = estimatedPrice5Yr / Math.pow(1 + desiredReturn, 5);

        if (![estimatedMetric5Yr, estimatedPrice5Yr, returnFromToday, entryPriceForDesiredReturn].every(Number.isFinite)
            || estimatedPrice5Yr <= 0
            || entryPriceForDesiredReturn <= 0
            || Math.abs(returnFromToday) > 100000) {
            setValidationMessage("These assumptions produce an unsafe or non-finite valuation. Use smaller values.");
            showToast("These assumptions produce an unsafe valuation.", true, 3500, toastContainer);
            projectionOutput.classList.add("hidden");
            projectionPlaceholder.classList.remove("hidden");
            lastCalculation = null;
            return false;
        }

        returnFromTodayDisplay.textContent = `${returnFromToday.toFixed(2)}%`;
        entryPriceDisplay.textContent = `$${entryPriceForDesiredReturn.toFixed(2)}`;
        desiredReturnDisplay.textContent = `${(desiredReturn * 100).toFixed(2)}%`;
        priceAfter5YearsDisplay.textContent = `$${estimatedPrice5Yr.toFixed(2)}`;

        const projectedPrices = [];
        for (let i = 1; i <= 5; i += 1) {
            const futureMetric = currentMetric * Math.pow(1 + growthRate, i);
            const interpolatedMultiple = impliedCurrentMultiple + (targetMultiple - impliedCurrentMultiple) * (i / 5);
            const futurePrice = calculationType === "EPS"
                ? futureMetric * interpolatedMultiple
                : (interpolatedMultiple > 0 ? futureMetric / interpolatedMultiple : 0);
            if (!Number.isFinite(futurePrice) || futurePrice <= 0) {
                setValidationMessage("These assumptions produce an unsafe projected price.");
                showToast("These assumptions produce an unsafe valuation.", true, 3500, toastContainer);
                projectionOutput.classList.add("hidden");
                projectionPlaceholder.classList.remove("hidden");
                lastCalculation = null;
                return false;
            }
            projectedPrices.push(futurePrice);
        }

        lastCalculation = {
            ticker: loadedTicker,
            generation: metricsLoadGeneration,
            signature: calculationInputSignature(),
        };
        clearValidation();

        try {
            if (dcfProjectionChart) {
                dcfProjectionChart.destroy();
            }
            dcfProjectionChart = createChart(priceChartCanvas, "Projected Price Growth", {
                labels: ["Today", "Year 1", "Year 2", "Year 3", "Year 4", "Year 5"],
                data: [currentStockPrice, ...projectedPrices],
                type: "line",
                backgroundColor: "rgba(40,167,69,0.1)",
                borderColor: "rgba(40,167,69,1)"
            });
        } catch (error) {
            showToast(`Chart error: ${error.message}`, true, 3000, toastContainer);
        }
        return true;
    }

    async function saveCalculation() {
        const ticker = normalizeTicker(tickerInput.value);
        if (!currentTicker || !loadedTicker || currentTicker !== ticker || loadedTicker !== ticker) {
            showToast("Load current data for this ticker before saving.", true, 3000, toastContainer);
            return;
        }
        if (!calculationStore) {
            showToast("Sign in before saving calculations.", true, 3000, toastContainer);
            return;
        }
        const validation = validateCalculationInputs();
        if (!validation.ok) {
            setValidationMessage(validation.message, validation.input || null);
            showToast(validation.message, true, 3500, toastContainer);
            return;
        }
        if (!lastCalculation
            || lastCalculation.ticker !== ticker
            || lastCalculation.generation !== metricsLoadGeneration
            || lastCalculation.signature !== calculationInputSignature()) {
            const message = "Calculate again after changing any ticker or assumption before saving.";
            setValidationMessage(message);
            showToast(message, true, 3500, toastContainer);
            return;
        }
        const snapshot = captureCalculationData({ id: `${ticker}-${Date.now()}` });
        const existing = [...savedCalculations];
        let savedResult;
        try {
            savedResult = await writeSavedCalculations([...existing, snapshot]);
        } catch (error) {
            showToast(`Could not save locally: ${error.message}`, true, 4000, toastContainer);
            return;
        }
        if (savedResult?.persisted === false) {
            showToast("Browser storage is unavailable. Nothing was saved durably.", true, 4500, toastContainer);
            return;
        }
        renderSavedCalculations();
        try {
            await queueCalculationOperation({
                type: "save",
                calculationId: snapshot.id,
                snapshot,
            });
        } catch (error) {
            await writeSavedCalculations(existing);
            renderSavedCalculations();
            showToast(`Could not queue the save durably: ${error.message}`, true, 4500, toastContainer);
            return;
        }
        const beforeDeadLetters = new Map(deadLetterCalculations.map((item) => [item.calculationId, item.failedAt]));
        const synced = await syncCalculationOutbox();
        deadLetterCalculations = await readCalculationDeadLetters();
        if (deadLetterCalculations.some((item) => beforeDeadLetters.get(item.calculationId) !== item.failedAt)) {
            renderSavedCalculations();
            return;
        }
        showToast(synced ? "Saved successfully." : "Saved durably on this device; waiting to sync.", false, 3500, toastContainer);
    }

    async function loadSavedCalculations() {
        if (!calculationStore) return;
        await syncCalculationOutbox();
        deadLetterCalculations = await readCalculationDeadLetters();
        renderSavedCalculations();

        const response = await guardedApiCall("/load_calculations");
        if (!response) {
            showToast("Loaded local calculations only.", false, 3000, toastContainer);
            return;
        }
        if (!response.ok) {
            showToast("Backend load unavailable; local list shown.", true, 3000, toastContainer);
            return;
        }

        const backendItems = await response.json();
        if (!Array.isArray(backendItems) || backendItems.length === 0) {
            showToast("No backend calculations found.", false, 2500, toastContainer);
            return;
        }

        const local = [...savedCalculations];
        const localIds = new Set(local.map((c) => c.id));
        const pendingDeletes = new Set((await readCalculationOutbox())
            .filter((operation) => operation.type === "delete")
            .map((operation) => operation.calculationId));
        let added = 0;
        backendItems.forEach((item) => {
            if (item.data && !pendingDeletes.has(item.data.id) && !localIds.has(item.data.id)) {
                local.push(item.data);
                added++;
            }
        });
        if (added > 0) {
            const result = await writeSavedCalculations(local);
            if (result?.persisted === false) {
                savedCalculations = local;
                renderSavedCalculations();
                showToast("Backend calculations loaded for this session only; browser storage is unavailable.", true, 4000, toastContainer);
                return;
            }
            renderSavedCalculations();
            showToast(`Synced ${added} calculation(s) from backend.`, false, 3000, toastContainer);
        } else {
            showToast("All calculations already up to date.", false, 2500, toastContainer);
        }
    }

    function showConfirmationModal(message, callback) {
        if (modalMessage) modalMessage.textContent = message;
        if (modalTitle) modalTitle.textContent = "Confirm Deletion";
        if (confirmationModal) confirmationModal.classList.remove("hidden");
        modalCallback = callback;
    }

    function hideConfirmationModal() {
        if (confirmationModal) confirmationModal.classList.add("hidden");
        modalCallback = null;
    }

    async function deleteCalculation(calcId) {
        if (!calculationStore) return;
        const existing = [...savedCalculations];
        const updated = existing.filter((c) => c.id !== calcId);
        const savedResult = await writeSavedCalculations(updated);
        if (savedResult?.persisted === false) {
            showToast("Browser storage is unavailable. The calculation was not deleted.", true, 4000, toastContainer);
            return;
        }
        renderSavedCalculations();
        try {
            await queueCalculationOperation({ type: "delete", calculationId: calcId });
        } catch (error) {
            await writeSavedCalculations(existing);
            renderSavedCalculations();
            showToast(`Could not queue the delete durably: ${error.message}`, true, 4500, toastContainer);
            return;
        }
        const beforeDeadLetters = new Map(deadLetterCalculations.map((item) => [item.calculationId, item.failedAt]));
        const synced = await syncCalculationOutbox();
        deadLetterCalculations = await readCalculationDeadLetters();
        if (deadLetterCalculations.some((item) => beforeDeadLetters.get(item.calculationId) !== item.failedAt)) {
            renderSavedCalculations();
            return;
        }
        showToast(synced ? "Deleted successfully." : "Deleted durably on this device; waiting to sync.", false, 3500, toastContainer);
    }

    function populateFormWithCalculationData(data) {
        const ticker = normalizeTicker(data?.ticker);
        if (!SAFE_TICKER_RE.test(ticker)) {
            showToast("This saved calculation has an invalid ticker and cannot be loaded.", true, 3500, toastContainer);
            return;
        }
        invalidateMetricsLoad();
        tickerInput.value = ticker;
        loadedTicker = ticker;
        currentTicker = ticker;
        const savedPrice = finiteNumber(data.currentStockPrice);
        currentStockPrice = savedPrice ?? 0;
        currentStockPriceDisplay.textContent = savedPrice !== null ? `$${savedPrice.toFixed(2)}` : "N/A";
        companyInfoDiv.classList.remove("hidden-state");
        renderCompanyLogo(ticker, ticker || "Saved calculation");
        companyName.textContent = ticker || "Saved calculation";

        if (data.activeTab === "cashFlow") {
            switchTab("cashFlow");
        } else {
            switchTab("earnings");
        }

        epsTtmInput.value = Number(data.earnings?.epsTtm || 0).toFixed(2);
        growthRateInput.value = data.earnings?.growthRate ?? "";
        peMultipleInput.value = data.earnings?.peMultiple ?? "";
        fcfShareInput.value = Number(data.cashFlow?.fcfShare || 0).toFixed(2);
        fcfGrowthRateInput.value = data.cashFlow?.fcfGrowthRate ?? "";
        fcfYieldInput.value = data.cashFlow?.fcfYield ?? "";
        desiredReturnInput.value = data.desiredReturn ?? "";

        calculatePrice();
    }

    function setActiveTickerSuggestion(index) {
        const items = [...tickerAutocomplete.querySelectorAll(".ticker-suggestion")];
        if (!items.length) {
            activeTickerSuggestion = -1;
            tickerInput.removeAttribute("aria-activedescendant");
            return;
        }
        activeTickerSuggestion = (index + items.length) % items.length;
        items.forEach((item, itemIndex) => {
            const selected = itemIndex === activeTickerSuggestion;
            item.classList.toggle("is-active", selected);
            item.setAttribute("aria-selected", String(selected));
        });
        const activeItem = items[activeTickerSuggestion];
        tickerInput.setAttribute("aria-activedescendant", activeItem.id);
        activeItem.scrollIntoView?.({ block: "nearest" });
    }

    const debouncedSuggestions = debounce(async (query) => {
        await showTickerSuggestions(query, tickerAutocomplete);
        activeTickerSuggestion = -1;
        tickerInput.removeAttribute("aria-activedescendant");
        tickerInput.setAttribute("aria-expanded", String(!tickerAutocomplete.classList.contains("hidden")));
    }, 200);

    tickerInput.addEventListener("input", (event) => {
        invalidateMetricsLoad();
        activeTickerSuggestion = -1;
        hideTickerSuggestions(tickerAutocomplete);
        debouncedSuggestions(event.target.value.trim());
    });
    [
        growthRateInput,
        peMultipleInput,
        fcfGrowthRateInput,
        fcfYieldInput,
        desiredReturnInput,
    ].forEach((input) => {
        input?.addEventListener("input", () => {
            lastCalculation = null;
            input.setCustomValidity("");
            input.removeAttribute("aria-invalid");
            if (dcfValidationMessage) dcfValidationMessage.textContent = "";
            projectionOutput.classList.add("hidden");
            projectionPlaceholder.classList.remove("hidden");
            if (dcfProjectionChart) {
                dcfProjectionChart.destroy();
                dcfProjectionChart = null;
            }
        });
    });
    tickerInput.addEventListener("focus", () => {
        const value = tickerInput.value.trim();
        if (value.length >= 2) {
            void showTickerSuggestions(value, tickerAutocomplete).then(() => {
                activeTickerSuggestion = -1;
                tickerInput.removeAttribute("aria-activedescendant");
                tickerInput.setAttribute("aria-expanded", String(!tickerAutocomplete.classList.contains("hidden")));
            });
        }
    });
    tickerInput.addEventListener("keydown", (event) => {
        const items = [...tickerAutocomplete.querySelectorAll(".ticker-suggestion")];
        const suggestionsOpen = !tickerAutocomplete.classList.contains("hidden") && items.length > 0;
        if (event.key === "ArrowDown" && suggestionsOpen) {
            event.preventDefault();
            setActiveTickerSuggestion(activeTickerSuggestion + 1);
        } else if (event.key === "ArrowUp" && suggestionsOpen) {
            event.preventDefault();
            setActiveTickerSuggestion(
                activeTickerSuggestion < 0 ? items.length - 1 : activeTickerSuggestion - 1,
            );
        } else if (event.key === "Enter" && suggestionsOpen && activeTickerSuggestion >= 0) {
            event.preventDefault();
            tickerInput.value = items[activeTickerSuggestion].dataset.symbol || "";
            activeTickerSuggestion = -1;
            hideTickerSuggestions(tickerAutocomplete);
            fetchAndPopulateMetrics();
        } else if (event.key === "Enter") {
            hideTickerSuggestions(tickerAutocomplete);
            const ticker = tickerInput.value.trim().toUpperCase();
            if (!isTickerValid(ticker)) {
                showToast("Please enter a valid ticker symbol.", true, 3000, toastContainer);
                return;
            }
            fetchAndPopulateMetrics();
        } else if (event.key === "Escape") {
            activeTickerSuggestion = -1;
            hideTickerSuggestions(tickerAutocomplete);
        }
    });

    tickerAutocomplete.addEventListener("click", (event) => {
        const suggestion = event.target.closest(".ticker-suggestion");
        if (!suggestion) {
            return;
        }
        tickerInput.value = suggestion.dataset.symbol;
        activeTickerSuggestion = -1;
        hideTickerSuggestions(tickerAutocomplete);
        fetchAndPopulateMetrics();
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(".search-wrapper")) {
            hideTickerSuggestions(tickerAutocomplete);
        }
    });

    if (savedCalculationsContainer) {
        savedCalculationsContainer.addEventListener("click", (event) => {
            const removeDeadLetterBtn = event.target.closest(".remove-dead-letter-btn");
            if (removeDeadLetterBtn) {
                void removeDeadLetter(removeDeadLetterBtn.dataset.id);
                return;
            }
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
                showConfirmationModal(`Are you sure you want to delete "${calcId}"?`, () => deleteCalculation(calcId));
            }
        });
    }

    if (confirmYesBtn) {
        confirmYesBtn.addEventListener("click", () => {
            if (modalCallback) modalCallback();
            hideConfirmationModal();
        });
    }
    if (confirmNoBtn) {
        confirmNoBtn.addEventListener("click", hideConfirmationModal);
    }

    getCurrentDataBtn.addEventListener("click", () => {
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!isTickerValid(ticker)) {
            showToast("Please enter a valid ticker symbol.", true, 3000, toastContainer);
            return;
        }
        fetchAndPopulateMetrics();
    });
    calculatePriceBtn.addEventListener("click", calculatePrice);
    earningsTabBtn.addEventListener("click", () => switchTab("earnings"));
    cashFlowTabBtn.addEventListener("click", () => switchTab("cashFlow"));
    saveCalculationBtn?.addEventListener("click", saveCalculation);
    clearBtn?.addEventListener("click", () => {
        invalidateMetricsLoad();
        clearAllFields();
    });
    loadCalculationsBtn?.addEventListener("click", loadSavedCalculations);
    window.addEventListener("online", () => { void syncCalculationOutbox(); });

    renderSavedCalculations();

    observeAuthState(async (user) => {
        if (!user) {
            calculationStore = null;
            savedCalculations = [];
            deadLetterCalculations = [];
            renderSavedCalculations([]);
            return;
        }
        const storeForUser = createUserDataStore(user.uid);
        calculationStore = storeForUser;
        savedCalculations = await readSavedCalculations(storeForUser);
        deadLetterCalculations = await readCalculationDeadLetters(storeForUser);
        if (calculationStore !== storeForUser) return;
        renderSavedCalculations(savedCalculations);
        await syncCalculationOutbox();
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
