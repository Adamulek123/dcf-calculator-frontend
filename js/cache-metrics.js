const counters = new Map();
const requestSamples = [];
const MAX_REQUEST_SAMPLES = 100;

function increment(name, amount = 1) {
    counters.set(name, (counters.get(name) || 0) + amount);
}

function recordCacheEvent(scope, outcome) {
    increment(`cache.${scope}.${outcome}`);
}

function recordRequest({ route, method, status, durationMs, bytes = null }) {
    increment("request.count");
    if (Number.isFinite(status)) increment(`request.status.${status}`);
    requestSamples.push({ route, method, status, durationMs: Math.round(durationMs), bytes });
    if (requestSamples.length > MAX_REQUEST_SAMPLES) requestSamples.shift();
}

function clientCacheMetrics() {
    return Object.freeze({ counters: Object.fromEntries(counters), requests: [...requestSamples] });
}

export { clientCacheMetrics, recordCacheEvent, recordRequest };
