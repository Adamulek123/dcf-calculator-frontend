import test from "node:test";
import assert from "node:assert/strict";
import {
    alignPeriodValueSeries,
    buildPerShareValuePairs,
    buildPeriodValuePairs,
    createChart,
    destroyChart
} from "../js/charts.js";
import { buildTickerQueryUrl, isTickerSyntaxValid } from "../js/ticker.js";

test("period series join on canonical periods instead of array positions", () => {
    const records = [
        { fiscal_year: 2024, fiscal_period: "Q1", facts: { FCF: { value: "100" }, SBC: { value: "10" }, Shares: { value: "10" } } },
        { fiscal_year: 2024, fiscal_period: "Q2", facts: { FCF: { value: "200" }, Shares: { value: "10" } } },
        { fiscal_year: 2024, fiscal_period: "Q3", facts: { FCF: { value: "300" }, SBC: { value: "30" }, Shares: { value: "10" } } }
    ];
    const aligned = alignPeriodValueSeries([
        { label: "FCF", pairs: buildPeriodValuePairs(records, "FCF") },
        { label: "SBC", pairs: buildPeriodValuePairs(records, "SBC") }
    ]);

    assert.deepEqual(aligned.labels, ["Q1 2024", "Q3 2024"]);
    assert.deepEqual(aligned.datasets.map((dataset) => dataset.data), [[100, 300], [10, 30]]);
    assert.deepEqual(buildPerShareValuePairs(records, "FCF", "Shares").map((pair) => pair.value), [10, 20, 30]);
});

test("ticker syntax and query encoding reject unsafe input", () => {
    assert.equal(isTickerSyntaxValid("brk.b"), true);
    assert.equal(isTickerSyntaxValid("AAPL&include=history"), false);
    const url = buildTickerQueryUrl("/get_market_price", "BRK.B", { include: "history" });
    assert.equal(url, "/get_market_price?ticker=BRK.B&include=history");
});

test("reduced motion disables Chart.js animation and tracked charts can be destroyed", () => {
    const previousChart = globalThis.Chart;
    const previousMatchMedia = globalThis.matchMedia;
    let destroyed = 0;
    const configs = [];
    class FakeChart {
        constructor(_context, config) {
            configs.push(config);
            this.destroy = () => { destroyed += 1; };
        }
    }
    globalThis.Chart = FakeChart;
    globalThis.matchMedia = () => ({ matches: true });
    const canvas = { getContext: () => ({}) };
    try {
        const chart = createChart(canvas, "Price", { labels: ["Q1 2024"], data: [1], type: "line" }, true);
        assert.equal(configs[0].options.animation, false);
        destroyChart(chart);
        assert.equal(destroyed, 1);
    } finally {
        globalThis.Chart = previousChart;
        globalThis.matchMedia = previousMatchMedia;
    }
});
