import assert from "node:assert/strict";
import test from "node:test";

import { isAdvertisedWeek, visibleWeekdayDates } from "../js/earnings-calendar-coverage.mjs";

test("an advertised partial final week is navigable", () => {
    const manifest = {
        coverageStart: "2026-07-06",
        coverageEnd: "2026-09-02",
        weeks: {
            "2026-08-24": { revision: "one" },
            "2026-08-31": { revision: "partial" },
        },
    };
    assert.equal(isAdvertisedWeek(manifest, "2026-08-31"), true);
    assert.equal(isAdvertisedWeek(manifest, "2026-09-07"), false);
    assert.deepEqual(
        visibleWeekdayDates("2026-08-31", "2026-09-02"),
        ["2026-08-31", "2026-09-01", "2026-09-02"],
    );
});
