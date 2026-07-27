import test from "node:test";
import assert from "node:assert/strict";
import {
    CALCULATION_LIMITS,
    calculateProjection,
    classifyMetric,
    discardOutboxOperation,
    mergeRemoteCalculations,
    normalizeOutboxOperations,
    parseApiError,
    queueOutboxOperation,
    retryOutboxOperation,
    synchronizeOutboxOperations,
    valueWithinLimits,
} from "../js/dcf-core.js";

test("classifies missing, non-positive, and usable metrics without conflating zero", () => {
    assert.deepEqual(classifyMetric(null), { state: "missing", value: null });
    assert.deepEqual(classifyMetric(0), { state: "nonpositive", value: 0 });
    assert.deepEqual(classifyMetric(-1.25), { state: "nonpositive", value: -1.25 });
    assert.deepEqual(classifyMetric(2.5), { state: "usable", value: 2.5 });
});

test("matches backend calculation boundaries", () => {
    assert.equal(valueWithinLimits(-100, CALCULATION_LIMITS.growthRate), true);
    assert.equal(valueWithinLimits(-100.01, CALCULATION_LIMITS.growthRate), false);
    assert.equal(valueWithinLimits(-99.99, CALCULATION_LIMITS.desiredReturn), true);
    assert.equal(valueWithinLimits(-100, CALCULATION_LIMITS.desiredReturn), false);
    assert.equal(valueWithinLimits(0, CALCULATION_LIMITS.metric), false);
});

test("calculates finite earnings and cash-flow projections and rejects unbounded output", () => {
    const earnings = calculateProjection({
        currentMetric: 5,
        growthRatePercent: 10,
        terminalValue: 20,
        desiredReturnPercent: 10,
        currentStockPrice: 100,
        method: "earnings",
    });
    assert.equal(earnings.valid, true);
    assert.equal(earnings.projectedPrices.length, 5);

    const cashFlow = calculateProjection({
        currentMetric: 4,
        growthRatePercent: 8,
        terminalValue: 5,
        desiredReturnPercent: 12,
        currentStockPrice: 80,
        method: "cashFlow",
    });
    assert.equal(cashFlow.valid, true);

    const invalid = calculateProjection({
        currentMetric: 5,
        growthRatePercent: 10,
        terminalValue: 20,
        desiredReturnPercent: -100,
        currentStockPrice: 100,
        method: "earnings",
    });
    assert.deepEqual(invalid, { valid: false, reason: "non_finite_result" });
});

test("extracts structured backend validation details", () => {
    assert.deepEqual(parseApiError({
        message: "Invalid calculation payload.",
        error: {
            code: "invalid_calculation",
            field: "body.data.desiredReturn",
            detail: "Must be between -99.99 and 1000000.",
        },
    }, 400), {
        status: 400,
        code: "invalid_calculation",
        field: "body.data.desiredReturn",
        detail: "Must be between -99.99 and 1000000.",
    });
});

test("migrates legacy outbox entries to pending state", () => {
    const [operation] = normalizeOutboxOperations([{
        type: "save",
        calculationId: "AAPL-1",
        snapshot: { id: "AAPL-1" },
    }]);
    assert.equal(operation.status, "pending");
    assert.equal(operation.attemptCount, 0);
});

test("rejected head operation does not block a later valid operation", async () => {
    const operations = [
        { type: "save", calculationId: "AAPL-bad", snapshot: { id: "AAPL-bad" } },
        { type: "save", calculationId: "MSFT-good", snapshot: { id: "MSFT-good" } },
    ];
    const persisted = [];
    const result = await synchronizeOutboxOperations(operations, {
        send: async (operation) => operation.calculationId === "AAPL-bad"
            ? {
                ok: false,
                status: 400,
                body: {
                    error: {
                        code: "invalid_calculation",
                        field: "body.data.desiredReturn",
                        detail: "Invalid return.",
                    },
                },
            }
            : { ok: true, status: 200, body: {} },
        persist: async (items) => persisted.push(structuredClone(items)),
        now: () => "2026-07-27T12:00:00.000Z",
    });

    assert.equal(result.pendingCount, 0);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].calculationId, "AAPL-bad");
    assert.deepEqual(result.processed, [{ calculationId: "MSFT-good", type: "save" }]);
    assert.equal(persisted.length, 2);
});

test("retryable failures preserve ordering and later operations", async () => {
    const result = await synchronizeOutboxOperations([
        { type: "save", calculationId: "AAPL-1", snapshot: {} },
        { type: "save", calculationId: "MSFT-2", snapshot: {} },
    ], {
        send: async () => ({
            ok: false,
            status: 503,
            body: { code: "market_data_unavailable", error: "Retry later." },
        }),
    });

    assert.equal(result.pendingCount, 2);
    assert.equal(result.operations[0].attemptCount, 1);
    assert.deepEqual(result.processed, []);
});

test("retry, discard, delete snapshot, and tombstone merge are deterministic", () => {
    const rejected = [{
        type: "delete",
        calculationId: "AAPL-1",
        snapshot: { id: "AAPL-1", ticker: "AAPL" },
        status: "rejected",
        error: { status: 400, code: "invalid_calculation", detail: "Bad id." },
    }];
    assert.equal(retryOutboxOperation(rejected, "AAPL-1")[0].status, "pending");
    assert.deepEqual(discardOutboxOperation(rejected, "AAPL-1"), []);

    const queued = queueOutboxOperation([], {
        type: "delete",
        calculationId: "AAPL-1",
        snapshot: { id: "AAPL-1", ticker: "AAPL" },
    }, () => "2026-07-27T12:00:00.000Z");
    assert.equal(queued[0].snapshot.ticker, "AAPL");
    assert.deepEqual(
        mergeRemoteCalculations([], [
            { id: "AAPL-1", ticker: "AAPL" },
            { id: "MSFT-2", ticker: "MSFT" },
        ], queued),
        [{ id: "MSFT-2", ticker: "MSFT" }],
    );
});
