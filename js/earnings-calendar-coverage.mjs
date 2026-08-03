function addDays(value, days) {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

export function isAdvertisedWeek(manifest, start) {
    if (!manifest?.coverageStart || !manifest?.coverageEnd || !start) return false;
    if (start < manifest.coverageStart || start > manifest.coverageEnd) return false;
    const weeks = manifest.weeks;
    if (weeks && typeof weeks === "object" && Object.keys(weeks).length) {
        return Object.prototype.hasOwnProperty.call(weeks, start);
    }
    return addDays(start, 6) <= manifest.coverageEnd;
}

export function visibleWeekdayDates(start, weekEnd, weekdayCount = 5) {
    const returnedDays = weekEnd
        ? Math.floor((new Date(`${weekEnd}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000) + 1
        : weekdayCount;
    const count = Math.max(1, Math.min(weekdayCount, returnedDays));
    return Array.from({ length: count }, (_, index) => addDays(start, index));
}
