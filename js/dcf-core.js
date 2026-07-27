const CALCULATION_LIMITS = Object.freeze({
    growthRate: Object.freeze({ min: -100, max: 1_000_000 }),
    desiredReturn: Object.freeze({ min: -99.99, max: 1_000_000 }),
    terminalValue: Object.freeze({ min: 0.000001, max: 1_000_000 }),
    metric: Object.freeze({ min: 0.000001, max: 1_000_000_000_000 }),
});

const PERMANENT_CALCULATION_ERROR_CODES = new Set([
    "invalid_calculation",
    "calculation_conflict",
]);

function optionalNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function classifyMetric(value) {
    const number = optionalNumber(value);
    if (number === null) return { state: "missing", value: null };
    if (number <= 0) return { state: "nonpositive", value: number };
    return { state: "usable", value: number };
}

function valueWithinLimits(value, limits) {
    const number = optionalNumber(value);
    return number !== null && number >= limits.min && number <= limits.max;
}

function calculateProjection({
    currentMetric,
    growthRatePercent,
    terminalValue,
    desiredReturnPercent,
    currentStockPrice = 0,
    method,
}) {
    const growthRate = Number(growthRatePercent) / 100;
    const desiredReturn = Number(desiredReturnPercent) / 100;
    const metric = Number(currentMetric);
    const target = method === "cashFlow" ? Number(terminalValue) / 100 : Number(terminalValue);
    const marketPrice = Number(currentStockPrice);
    const impliedCurrentMultiple = method === "cashFlow"
        ? (marketPrice > 0 ? metric / marketPrice : target)
        : (metric > 0 && marketPrice > 0 ? marketPrice / metric : target);
    const estimatedMetric5Yr = metric * Math.pow(1 + growthRate, 5);
    const estimatedPrice5Yr = method === "cashFlow"
        ? estimatedMetric5Yr / target
        : estimatedMetric5Yr * target;
    const returnFromToday = marketPrice > 0
        ? (Math.pow(estimatedPrice5Yr / marketPrice, 1 / 5) - 1) * 100
        : null;
    const entryPriceForDesiredReturn = estimatedPrice5Yr / Math.pow(1 + desiredReturn, 5);
    const projectedPrices = [];

    for (let year = 1; year <= 5; year += 1) {
        const futureMetric = metric * Math.pow(1 + growthRate, year);
        const interpolatedMultiple = impliedCurrentMultiple
            + (target - impliedCurrentMultiple) * (year / 5);
        projectedPrices.push(method === "cashFlow"
            ? futureMetric / interpolatedMultiple
            : futureMetric * interpolatedMultiple);
    }

    const required = [
        estimatedMetric5Yr,
        estimatedPrice5Yr,
        entryPriceForDesiredReturn,
        ...projectedPrices,
    ];
    if (!required.every(Number.isFinite)
        || (returnFromToday !== null && !Number.isFinite(returnFromToday))) {
        return { valid: false, reason: "non_finite_result" };
    }
    return {
        valid: true,
        estimatedMetric5Yr,
        estimatedPrice5Yr,
        returnFromToday,
        entryPriceForDesiredReturn,
        projectedPrices,
    };
}

function parseApiError(body, status = 0) {
    const nested = body && typeof body.error === "object" ? body.error : null;
    const stringError = typeof body?.error === "string" ? body.error : null;
    return {
        status: Number(status) || 0,
        code: String(nested?.code || body?.code || "").trim() || null,
        field: String(nested?.field || body?.field || "").trim() || null,
        detail: String(
            nested?.detail
            || body?.detail
            || stringError
            || body?.message
            || `Server rejected the operation with status ${status}.`,
        ),
    };
}

function isPermanentCalculationError(error) {
    return Boolean(error?.code) && PERMANENT_CALCULATION_ERROR_CODES.has(error.code);
}

function normalizeOutboxOperation(operation) {
    if (!operation || typeof operation !== "object") return null;
    const type = operation.type === "delete" ? "delete" : operation.type === "save" ? "save" : null;
    const calculationId = String(operation.calculationId || "").trim();
    if (!type || !calculationId) return null;
    const status = operation.status === "rejected" ? "rejected" : "pending";
    return {
        ...operation,
        type,
        calculationId,
        status,
        attemptCount: Math.max(0, Math.trunc(Number(operation.attemptCount) || 0)),
        error: status === "rejected" ? parseApiError(operation.error, operation.error?.status) : null,
        rejectedAt: status === "rejected" && typeof operation.rejectedAt === "string"
            ? operation.rejectedAt
            : null,
    };
}

function normalizeOutboxOperations(operations) {
    return (Array.isArray(operations) ? operations : [])
        .map(normalizeOutboxOperation)
        .filter(Boolean);
}

function queueOutboxOperation(operations, operation, now = () => new Date().toISOString()) {
    const normalized = normalizeOutboxOperations(operations)
        .filter((item) => item.calculationId !== operation.calculationId);
    normalized.push(normalizeOutboxOperation({
        ...operation,
        status: "pending",
        attemptCount: 0,
        error: null,
        rejectedAt: null,
        queuedAt: now(),
    }));
    return normalized;
}

function retryOutboxOperation(operations, calculationId) {
    return normalizeOutboxOperations(operations).map((operation) => (
        operation.calculationId === calculationId
            ? {
                ...operation,
                status: "pending",
                attemptCount: 0,
                error: null,
                rejectedAt: null,
            }
            : operation
    ));
}

function discardOutboxOperation(operations, calculationId) {
    return normalizeOutboxOperations(operations)
        .filter((operation) => operation.calculationId !== calculationId);
}

function outboxSummary(operations) {
    const normalized = normalizeOutboxOperations(operations);
    return {
        pendingCount: normalized.filter((operation) => operation.status === "pending").length,
        rejected: normalized.filter((operation) => operation.status === "rejected"),
    };
}

async function synchronizeOutboxOperations(operations, {
    send,
    persist = async () => {},
    shouldContinue = () => true,
    now = () => new Date().toISOString(),
} = {}) {
    let current = normalizeOutboxOperations(operations);
    const processed = [];
    const newlyRejected = [];

    while (shouldContinue()) {
        const pendingIndex = current.findIndex((operation) => operation.status === "pending");
        if (pendingIndex < 0) break;
        const operation = current[pendingIndex];
        let result;
        try {
            result = await send(operation);
        } catch {
            break;
        }
        if (!result || !shouldContinue()) break;
        if (result.ok) {
            processed.push({ calculationId: operation.calculationId, type: operation.type });
            current.splice(pendingIndex, 1);
            await persist(current);
            continue;
        }

        const error = parseApiError(result.body, result.status);
        if (isPermanentCalculationError(error)) {
            const rejected = {
                ...operation,
                status: "rejected",
                attemptCount: operation.attemptCount + 1,
                rejectedAt: now(),
                error,
            };
            current[pendingIndex] = rejected;
            newlyRejected.push(rejected);
            await persist(current);
            continue;
        }

        current[pendingIndex] = {
            ...operation,
            attemptCount: operation.attemptCount + 1,
        };
        await persist(current);
        break;
    }

    const summary = outboxSummary(current);
    return {
        operations: current,
        pendingCount: summary.pendingCount,
        rejected: summary.rejected,
        newlyRejected,
        processed,
    };
}

function mergeRemoteCalculations(localItems, remoteItems, operations) {
    const tombstones = new Set(normalizeOutboxOperations(operations)
        .filter((operation) => operation.type === "delete")
        .map((operation) => operation.calculationId));
    const merged = (Array.isArray(localItems) ? localItems : [])
        .filter((item) => !tombstones.has(item?.id));
    const known = new Set(merged.map((item) => item?.id).filter(Boolean));
    (Array.isArray(remoteItems) ? remoteItems : []).forEach((item) => {
        if (!item?.id || known.has(item.id) || tombstones.has(item.id)) return;
        merged.push(item);
        known.add(item.id);
    });
    return merged;
}

export {
    CALCULATION_LIMITS,
    calculateProjection,
    classifyMetric,
    discardOutboxOperation,
    isPermanentCalculationError,
    mergeRemoteCalculations,
    normalizeOutboxOperations,
    optionalNumber,
    outboxSummary,
    parseApiError,
    queueOutboxOperation,
    retryOutboxOperation,
    synchronizeOutboxOperations,
    valueWithinLimits,
};
