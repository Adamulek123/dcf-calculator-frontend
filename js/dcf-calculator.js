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
    let syncingCalculationOutbox = false;

    const formatNum = (num, prefix = "", suffix = "") => (typeof num === "number" && !Number.isNaN(num) ? `${prefix}${num.toFixed(2)}${suffix}` : "N/A");
    const formatPercent = (num) => (typeof num === "number" && !Number.isNaN(num) ? `${(num * 100).toFixed(2)}%` : "N/A");

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
        companyInfoDiv.classList.add("hidden-state");
        if (companyLogo) companyLogo.textContent = "";
        if (companyName) companyName.textContent = "";
        if (currentStockPriceDisplay) currentStockPriceDisplay.textContent = "$0.00";

        if (currentEps) currentEps.textContent = "$0.00";
        if (currentPe) currentPe.textContent = "0.00";
        if (epsGrowth) epsGrowth.textContent = "0.0%";
        if (epsTtmInput) epsTtmInput.value = "0.00";
        if (growthRateInput) growthRateInput.value = "";
        if (peMultipleInput) peMultipleInput.value = "";

        if (currentFcfShare) currentFcfShare.textContent = "$0.00";
        if (fcfYield) fcfYield.textContent = "0.0%";
        if (sbcImpact) sbcImpact.textContent = "0.0%";
        if (fcfShareInput) fcfShareInput.value = "0.00";
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
    }

    function switchTab(tab) {
        activeTab = tab;
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
        return Array.isArray(entry?.data?.operations) ? entry.data.operations : [];
    }

    async function writeCalculationOutbox(operations, store = calculationStore) {
        if (!store) return;
        await store.set(store.keys.calculationOutbox(), {
            operations: Array.isArray(operations) ? operations : [],
        }, {
            ttlMs: CACHE_TTL.calculationOutbox,
            staleTtlMs: CACHE_STALE_TTL.calculationOutbox,
        });
    }

    async function queueCalculationOperation(operation) {
        const operations = await readCalculationOutbox();
        const withoutSameCalculation = operations.filter((item) => item.calculationId !== operation.calculationId);
        withoutSameCalculation.push({ ...operation, queuedAt: new Date().toISOString() });
        await writeCalculationOutbox(withoutSameCalculation);
    }

    async function syncCalculationOutbox() {
        if (!calculationStore || syncingCalculationOutbox) return false;
        const store = calculationStore;
        syncingCalculationOutbox = true;
        try {
            let operations = await readCalculationOutbox(store);
            while (operations.length) {
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
                if (!response || !response.ok) break;
                if (calculationStore !== store) return false;
                operations = operations.slice(1);
                await writeCalculationOutbox(operations, store);
            }
            return operations.length === 0;
        } catch (error) {
            console.warn("Calculation sync is unavailable; preserving the outbox.", error);
            return false;
        } finally {
            syncingCalculationOutbox = false;
        }
    }

    function captureCalculationData() {
        return {
            id: `${currentTicker || "UNSET"}-${Date.now()}`,
            ticker: tickerInput.value.trim().toUpperCase(),
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

    function renderSavedCalculations(calculations = savedCalculations) {
        if (!savedCalculationsContainer) {
            return;
        }
        if (!calculations.length) {
            savedCalculationsContainer.innerHTML = "<p class=\"muted\">No saved calculations yet.</p>";
            return;
        }
        const fragment = document.createDocumentFragment();
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

    async function fetchAndPopulateMetrics() {
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!ticker) {
            showToast("Please enter a ticker symbol.", true, 3000, toastContainer);
            return;
        }

        setButtonState(getCurrentDataBtn, "Fetching...", true);
        projectionPlaceholder.classList.remove("hidden");
        projectionOutput.classList.add("hidden");
        if (dcfProjectionChart) {
            dcfProjectionChart.destroy();
            dcfProjectionChart = null;
        }

        try {
            const response = await guardedApiCall(`/get_trailing_metrics?ticker=${ticker}`);
            if (!response) {
                companyInfoDiv.classList.remove("hidden-state");
                renderCompanyLogo(ticker, ticker);
                companyName.textContent = ticker;
                currentStockPrice = 0;
                currentStockPriceDisplay.textContent = "Backend unavailable";
                currentTicker = ticker;
                showToast("Backend unavailable. Enter assumptions manually.", true, 3500, toastContainer);
                return;
            }

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || "Failed to fetch data");
            }

            companyInfoDiv.classList.remove("hidden-state");
            renderCompanyLogo(ticker, data.longName || ticker);
            companyName.textContent = data.longName || ticker;
            currentStockPrice = data.regularMarketPrice || 0;
            currentStockPriceDisplay.textContent = `$${currentStockPrice.toFixed(2)}`;

            currentEps.textContent = formatNum(data.trailing_eps, "$");
            currentPe.textContent = formatNum(data.trailing_pe);
            epsGrowth.textContent = formatPercent(data.trailing_eps_growth);
            epsTtmInput.value = (data.trailing_eps || 0).toFixed(2);

            currentFcfShare.textContent = formatNum(data.fcfShare, "$");
            fcfYield.textContent = formatPercent(data.fcfYield);
            sbcImpact.textContent = formatPercent(data.sbcImpact);
            fcfShareInput.value = (data.fcfShare || 0).toFixed(2);

            currentTicker = ticker;
            showToast("Current data loaded successfully!", false, 3000, toastContainer);
        } catch (error) {
            showToast(`Data fetch error: ${error.message}`, true, 4000, toastContainer);
        } finally {
            setButtonState(getCurrentDataBtn, "Search", false);
        }
    }

    function calculatePrice() {
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

        if ([currentMetric, growthRate, targetMultiple, desiredReturn].some((value) => Number.isNaN(value)) || targetMultiple <= 0) {
            showToast("Please fill all input fields with valid numbers.", true, 3000, toastContainer);
            projectionOutput.classList.add("hidden");
            projectionPlaceholder.classList.remove("hidden");
            return;
        }

        projectionPlaceholder.classList.add("hidden");
        projectionOutput.classList.remove("hidden");

        const estimatedMetric5Yr = currentMetric * Math.pow(1 + growthRate, 5);
        const estimatedPrice5Yr = calculationType === "EPS" ? estimatedMetric5Yr * targetMultiple : estimatedMetric5Yr / targetMultiple;
        const returnFromToday = currentStockPrice > 0 ? (Math.pow(estimatedPrice5Yr / currentStockPrice, 1 / 5) - 1) * 100 : 0;
        const entryPriceForDesiredReturn = estimatedPrice5Yr / Math.pow(1 + desiredReturn, 5);

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
            projectedPrices.push(futurePrice);
        }

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
    }

    async function saveCalculation() {
        if (!currentTicker) {
            showToast("Search a ticker and calculate first.", true, 3000, toastContainer);
            return;
        }
        if (!calculationStore) {
            showToast("Sign in before saving calculations.", true, 3000, toastContainer);
            return;
        }
        const snapshot = captureCalculationData();
        const existing = [...savedCalculations];
        existing.push(snapshot);
        await writeSavedCalculations(existing);
        renderSavedCalculations(existing);
        await queueCalculationOperation({
            type: "save",
            calculationId: snapshot.id,
            snapshot,
        });
        const synced = await syncCalculationOutbox();
        showToast(synced ? "Saved successfully." : "Saved locally; waiting to sync.", false, 3000, toastContainer);
    }

    async function loadSavedCalculations() {
        if (!calculationStore) return;
        await syncCalculationOutbox();
        renderSavedCalculations(savedCalculations);

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
            await writeSavedCalculations(local);
            renderSavedCalculations(local);
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
        await writeSavedCalculations(updated);
        renderSavedCalculations(updated);
        await queueCalculationOperation({ type: "delete", calculationId: calcId });
        const synced = await syncCalculationOutbox();
        showToast(synced ? "Deleted successfully." : "Deleted locally; waiting to sync.", false, 3000, toastContainer);
    }

    function populateFormWithCalculationData(data) {
        tickerInput.value = data.ticker || "";
        currentTicker = data.ticker || "";
        currentStockPrice = Number(data.currentStockPrice || 0);
        currentStockPriceDisplay.textContent = `$${currentStockPrice.toFixed(2)}`;
        companyInfoDiv.classList.remove("hidden-state");
        renderCompanyLogo(currentTicker, currentTicker || "Saved calculation");
        companyName.textContent = currentTicker || "Saved calculation";

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

    const debouncedSuggestions = debounce((query) => showTickerSuggestions(query, tickerAutocomplete), 200);

    tickerInput.addEventListener("input", (event) => {
        hideTickerSuggestions(tickerAutocomplete);
        debouncedSuggestions(event.target.value.trim());
    });
    tickerInput.addEventListener("focus", () => {
        const value = tickerInput.value.trim();
        if (value.length >= 2) {
            showTickerSuggestions(value, tickerAutocomplete);
        }
    });
    tickerInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") {
            return;
        }
        hideTickerSuggestions(tickerAutocomplete);
        const ticker = tickerInput.value.trim().toUpperCase();
        if (!isTickerValid(ticker)) {
            showToast("Please enter a valid ticker symbol.", true, 3000, toastContainer);
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
        fetchAndPopulateMetrics();
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(".search-wrapper")) {
            hideTickerSuggestions(tickerAutocomplete);
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
    clearBtn?.addEventListener("click", clearAllFields);
    loadCalculationsBtn?.addEventListener("click", loadSavedCalculations);
    window.addEventListener("online", () => { void syncCalculationOutbox(); });

    renderSavedCalculations();

    observeAuthState(async (user) => {
        if (!user) {
            calculationStore = null;
            savedCalculations = [];
            renderSavedCalculations([]);
            return;
        }
        const storeForUser = createUserDataStore(user.uid);
        calculationStore = storeForUser;
        savedCalculations = await readSavedCalculations(storeForUser);
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
