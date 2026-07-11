import { recordRequest } from "./cache-metrics.js";

function getBackendBaseUrl() {
    const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    return isLocalDev ? "http://localhost:5000" : "https://dcf-backend.onrender.com";
}

function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
}

const inFlightRequests = new Map();
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_ATTEMPTS = 2;

function canonicalBody(body) {
    if (!body) return "";
    try { return JSON.stringify(JSON.parse(body)); } catch { return String(body); }
}

function retryAfterMs(response) {
    const value = response.headers.get("Retry-After");
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(value);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

function retryDelayMs(attempt, response) {
    const retryAfter = response ? retryAfterMs(response) : null;
    if (retryAfter !== null) return retryAfter;
    const exponential = 250 * (2 ** attempt);
    return exponential + Math.floor(Math.random() * 150);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientResponse(response) {
    return Boolean(response) && TRANSIENT_STATUS_CODES.has(response.status);
}

function isTransientNetworkError(error) {
    // Browser fetch reports transport failures as TypeError. Do not retry an
    // application/authentication error thrown after a response was received.
    return error?.name === "TypeError";
}

async function apiCall(endpoint, options = {}, dependencies = {}) {
    const { auth = window.auth, handleLogout = () => {}, backendBaseUrl = getBackendBaseUrl() } = dependencies;
    const user = auth?.currentUser;
    let idToken = null;

    if (user) {
        try {
            idToken = await user.getIdToken();
        } catch (error) {
            console.error("Error getting Firebase ID token:", error);
            handleLogout();
            throw new Error("Authentication token expired or invalid. Please log in again.");
        }
    }

    if (idToken) {
        options.headers = { ...options.headers, Authorization: `Bearer ${idToken}` };
    } else {
        throw new Error("No authentication token available. Please log in.");
    }

    const method = String(options.method || "GET").toUpperCase();
    const coalesce = method === "GET" || options.coalesce === true;
    const retryable = method === "GET" || options.retry === true;
    const maxAttempts = retryable ? Math.max(0, Number(options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS)) : 0;
    const requestOptions = { ...options };
    delete requestOptions.coalesce;
    delete requestOptions.retry;
    delete requestOptions.retryAttempts;
    const key = `${user.uid}:${method}:${endpoint}:${canonicalBody(requestOptions.body)}`;
    const execute = async () => {
        for (let attempt = 0; ; attempt += 1) {
            try {
                const startedAt = performance.now();
                const response = await fetch(`${backendBaseUrl}${endpoint}`, requestOptions);
                recordRequest({
                    route: endpoint.split("?")[0],
                    method,
                    status: response.status,
                    durationMs: performance.now() - startedAt,
                    bytes: Number(response.headers.get("Content-Length")) || null,
                });
                if (response.status === 401) {
                    handleLogout();
                    throw new Error("Session expired. Please log in again.");
                }
                if (!retryable || !isTransientResponse(response) || attempt >= maxAttempts) return response;
                await sleep(retryDelayMs(attempt, response));
            } catch (error) {
                if (!retryable || !isTransientNetworkError(error) || attempt >= maxAttempts) throw error;
                await sleep(retryDelayMs(attempt));
            }
        }
    };
    try {
        if (!coalesce) return await execute();
        let pending = inFlightRequests.get(key);
        if (!pending) {
            pending = execute().finally(() => inFlightRequests.delete(key));
            inFlightRequests.set(key, pending);
        }
        return (await pending).clone();
    } catch (error) {
        console.error(`API call to ${endpoint} failed:`, error);
        throw error;
    }
}

export { getBackendBaseUrl, setButtonState, apiCall, isTransientResponse };
