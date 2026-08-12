import { recordRequest } from "./cache-metrics.js";

function getBackendBaseUrl() {
    const hostname = globalThis.window?.location?.hostname || "";
    const isLocalDev = hostname === "localhost" || hostname === "127.0.0.1";
    return isLocalDev ? "http://localhost:5000" : "https://dcf-backend.onrender.com";
}

function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
}

const inFlightRequests = new Map();
const TRANSIENT_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const DEFAULT_RETRY_ATTEMPTS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_TOTAL_TIMEOUT_MS = 20000;
const MAX_TOTAL_TIMEOUT_MS = 30000;
const MAX_RETRY_DELAY_MS = 5000;

function canonicalBody(body) {
    if (!body) return "";
    try { return JSON.stringify(JSON.parse(body)); } catch { return String(body); }
}

function canonicalHeaders(headers) {
    if (!headers) return "";
    try {
        const normalized = [...new Headers(headers).entries()]
            .map(([name, value]) => [name.toLowerCase(), String(value)])
            .sort(([left], [right]) => left.localeCompare(right));
        return JSON.stringify(normalized);
    } catch {
        return String(headers);
    }
}

function clampFinite(value, fallback, minimum, maximum) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, parsed));
}

function normaliseRetryAttempts(value, retryable) {
    if (!retryable) return 0;
    const fallback = DEFAULT_RETRY_ATTEMPTS;
    return Math.floor(clampFinite(value, fallback, 0, MAX_RETRY_ATTEMPTS));
}

function retryAfterMs(response) {
    const value = response?.headers?.get?.("Retry-After");
    if (!value) return null;
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return clampFinite(seconds * 1000, null, 0, MAX_RETRY_DELAY_MS);
    const date = Date.parse(value);
    return Number.isFinite(date)
        ? clampFinite(date - Date.now(), null, 0, MAX_RETRY_DELAY_MS)
        : null;
}

function retryDelayMs(attempt, response) {
    const retryAfter = response ? retryAfterMs(response) : null;
    if (retryAfter !== null) return retryAfter;
    const exponential = Math.min(MAX_RETRY_DELAY_MS, 250 * (2 ** Math.min(attempt, 6)));
    return clampFinite(exponential + Math.floor(Math.random() * 150), 250, 0, MAX_RETRY_DELAY_MS);
}

function abortReason(signal) {
    return signal?.reason || new DOMException("The request was aborted.", "AbortError");
}

function sleep(ms, signal = null) {
    const delay = clampFinite(ms, 0, 0, MAX_RETRY_DELAY_MS);
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        let timer = setTimeout(done, delay);
        const onAbort = () => {
            clearTimeout(timer);
            timer = null;
            signal?.removeEventListener("abort", onAbort);
            reject(abortReason(signal));
        };
        function done() {
            if (timer === null) return;
            timer = null;
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function createRequestController(callerSignal, timeoutMs) {
    const controller = new AbortController();
    const timeout = clampFinite(timeoutMs, DEFAULT_TOTAL_TIMEOUT_MS, 1, MAX_TOTAL_TIMEOUT_MS);
    const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
            controller.abort(new DOMException("The request timed out.", "TimeoutError"));
        }
    }, timeout);
    const onAbort = () => {
        if (!controller.signal.aborted) controller.abort(abortReason(callerSignal));
    };
    if (callerSignal?.aborted) onAbort();
    else callerSignal?.addEventListener("abort", onAbort, { once: true });
    return {
        signal: controller.signal,
        cleanup() {
            clearTimeout(timer);
            callerSignal?.removeEventListener("abort", onAbort);
        },
    };
}

function isTransientResponse(response) {
    return Boolean(response) && TRANSIENT_STATUS_CODES.has(response.status);
}

function isTransientNetworkError(error) {
    // Browser fetch reports transport failures as TypeError. Do not retry an
    // application/authentication error thrown after a response was received.
    return error?.name === "TypeError";
}

async function executeApiCall(endpoint, options = {}, {
    backendBaseUrl = getBackendBaseUrl(),
    requestIdentity = "public",
    onUnauthorized = null,
} = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const hasCallerSignal = Boolean(options.signal);
    // A caller-owned signal has different cancellation semantics for every
    // consumer. Never make those requests share one promise. Callers that
    // explicitly need a shared request can opt in with coalesce:true, but the
    // default is safe for forced cross-tab revalidation.
    const coalesce = !hasCallerSignal
        && options.coalesce !== false
        && (options.coalesce === true || method === "GET");
    const retryable = method === "GET" || options.retry === true;
    const maxAttempts = normaliseRetryAttempts(options.retryAttempts, retryable);
    const totalTimeoutMs = clampFinite(
        options.timeoutMs ?? options.deadlineMs,
        DEFAULT_TOTAL_TIMEOUT_MS,
        1,
        MAX_TOTAL_TIMEOUT_MS,
    );
    const requestOptions = { ...options };
    delete requestOptions.coalesce;
    delete requestOptions.retry;
    delete requestOptions.retryAttempts;
    delete requestOptions.timeoutMs;
    delete requestOptions.deadlineMs;
    const callerSignal = requestOptions.signal;
    delete requestOptions.signal;
    const key = [
        backendBaseUrl,
        requestIdentity,
        method,
        endpoint,
        canonicalBody(requestOptions.body),
        canonicalHeaders(requestOptions.headers),
        requestOptions.cache || "",
        requestOptions.credentials || "",
        requestOptions.mode || "",
        requestOptions.redirect || "",
        requestOptions.referrer || "",
        requestOptions.referrerPolicy || "",
        requestOptions.integrity || "",
        totalTimeoutMs,
        maxAttempts,
    ].join(":");
    const execute = async () => {
        const requestController = createRequestController(callerSignal, totalTimeoutMs);
        const fetchOptions = { ...requestOptions, signal: requestController.signal };
        try {
            for (let attempt = 0; ; attempt += 1) {
                try {
                    const startedAt = globalThis.performance?.now?.() ?? Date.now();
                    const response = await fetch(`${backendBaseUrl}${endpoint}`, fetchOptions);
                    recordRequest({
                        route: endpoint.split("?")[0],
                        method,
                        status: response.status,
                        durationMs: (globalThis.performance?.now?.() ?? Date.now()) - startedAt,
                        bytes: Number(response.headers.get("Content-Length")) || null,
                    });
                    if (response.status === 401 && typeof onUnauthorized === "function") {
                        onUnauthorized();
                        throw new Error("Session expired. Please log in again.");
                    }
                    if (!retryable || !isTransientResponse(response) || attempt >= maxAttempts) return response;
                    await sleep(retryDelayMs(attempt, response), requestController.signal);
                } catch (error) {
                    if (requestController.signal.aborted) throw error;
                    if (!retryable || !isTransientNetworkError(error) || attempt >= maxAttempts) throw error;
                    await sleep(retryDelayMs(attempt), requestController.signal);
                }
            }
        } finally {
            requestController.cleanup();
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

async function apiCall(endpoint, options = {}, dependencies = {}) {
    const { auth = globalThis.window?.auth, handleLogout = () => {}, backendBaseUrl = getBackendBaseUrl() } = dependencies;
    const user = auth?.currentUser;
    if (!user) throw new Error("No authentication token available. Please log in.");
    let idToken;
    try {
        idToken = await user.getIdToken();
    } catch (error) {
        console.error("Error getting Firebase ID token:", error);
        handleLogout();
        throw new Error("Authentication token expired or invalid. Please log in again.");
    }
    return executeApiCall(endpoint, {
        ...options,
        headers: { ...options.headers, Authorization: `Bearer ${idToken}` },
    }, {
        backendBaseUrl,
        requestIdentity: user.uid,
        onUnauthorized: handleLogout,
    });
}

async function publicApiCall(endpoint, options = {}, dependencies = {}) {
    return executeApiCall(endpoint, options, {
        backendBaseUrl: dependencies.backendBaseUrl || getBackendBaseUrl(),
        requestIdentity: "public",
    });
}

export {
    getBackendBaseUrl,
    setButtonState,
    apiCall,
    publicApiCall,
    isTransientResponse,
    canonicalHeaders,
    retryAfterMs,
    retryDelayMs,
    sleep,
    normaliseRetryAttempts,
    DEFAULT_TOTAL_TIMEOUT_MS,
    MAX_TOTAL_TIMEOUT_MS,
    MAX_RETRY_ATTEMPTS,
    MAX_RETRY_DELAY_MS,
};
