import { publicApiCall } from "./api.js";
import { runAuthGuard } from "./auth-guard.js";
import { createCacheRegistry } from "./cache-registry.js";
import { renderSidebar } from "./sidebar.js";
import { getLogoUrl, onLogoError } from "./ticker.js";
import { showToast } from "./toast.js";

runAuthGuard();
renderSidebar();

const CARD_LIMIT = 12;
const WEEKDAY_COUNT = 5;
const publicCache = createCacheRegistry();
const loadedWeeks = new Map();
const loadedEntries = new Map();
const loadedEstimates = new Map();
const expandedLanes = new Set();
const currentDate = dateInNewYork();
const currentWeekStart = weekStartInNewYork(currentDate);
let selectedWeekStart = currentWeekStart;
let selectedMobileDay = preferredMobileDay(currentWeekStart);
let manifest = null;
let manifestEntry = null;
let pendingRequest = 0;
let pendingDrawerRequest = 0;
let lastDrawerTrigger = null;
let activeDrawerEvent = null;
let staleWarningShown = false;

const elements = {
    meta: document.getElementById("earningsMeta"),
    refresh: document.getElementById("earningsRefreshBtn"),
    previous: document.getElementById("earningsPreviousBtn"),
    current: document.getElementById("earningsCurrentBtn"),
    next: document.getElementById("earningsNextBtn"),
    tabs: document.getElementById("earningsDayTabs"),
    weekTitle: document.getElementById("earningsWeekTitle"),
    weekCount: document.getElementById("earningsWeekCount"),
    days: document.getElementById("earningsDays"),
    live: document.getElementById("earningsLiveStatus"),
    toast: document.getElementById("toast-container"),
    refreshLabel: document.getElementById("earningsRefreshLabel"),
    drawer: document.getElementById("earningsDrawer"),
    drawerClose: document.getElementById("earningsDrawerClose"),
    drawerLogo: document.getElementById("earningsDrawerLogo"),
    drawerTitle: document.getElementById("earningsDrawerTitle"),
    drawerName: document.getElementById("earningsDrawerName"),
    drawerDate: document.getElementById("earningsDrawerDate"),
    drawerSession: document.getElementById("earningsDrawerSession"),
    estimateState: document.getElementById("earningsEstimateState"),
    estimateGrid: document.getElementById("earningsEstimateGrid"),
    estimateRetry: document.getElementById("earningsEstimateRetry"),
    drawerFiscal: document.getElementById("earningsDrawerFiscal"),
    drawerEps: document.getElementById("earningsDrawerEps"),
    drawerRevenue: document.getElementById("earningsDrawerRevenue"),
};

const SESSION_LABELS = Object.freeze({
    before_open: "Before open",
    during_market: "During market",
    after_close: "After close",
    unknown: "Time not confirmed",
});

const SESSION_LANES = Object.freeze([
    {
        id: "before",
        label: "Before open",
        sessions: ["before_open"],
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    },
    {
        id: "middle",
        label: "Market / time TBD",
        sessions: ["during_market", "unknown"],
        icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    },
    {
        id: "after",
        label: "After close",
        sessions: ["after_close"],
        icon: '<svg viewBox="0 0 24 24"><path d="M20.5 15.2A8.5 8.5 0 0 1 8.8 3.5 9 9 0 1 0 20.5 15.2Z"/></svg>',
    },
]);

function dateInNewYork() {
    const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${values.year}-${values.month}-${values.day}`;
}

function weekStartInNewYork(value = dateInNewYork()) {
    const date = new Date(`${value}T12:00:00Z`);
    const mondayOffset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - mondayOffset);
    return date.toISOString().slice(0, 10);
}

function isoDate(value) {
    return new Date(`${value}T12:00:00Z`);
}

function addDays(value, days) {
    const date = isoDate(value);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
}

function addWeeks(value, weeks) {
    return addDays(value, weeks * 7);
}

function preferredMobileDay(weekStart) {
    const weekEnd = addDays(weekStart, WEEKDAY_COUNT - 1);
    return currentDate >= weekStart && currentDate <= weekEnd ? currentDate : weekStart;
}

function quoteEtag(value) {
    const normalized = String(value || "").replace(/^W\//, "").replace(/^"|"$/g, "");
    return normalized ? `"${normalized}"` : null;
}

function formatDateTime(value) {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return "not available";
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(date);
}

function formatWeek(start) {
    const end = isoDate(addDays(start, WEEKDAY_COUNT - 1));
    const startDate = isoDate(start);
    const sameMonth = startDate.getUTCMonth() === end.getUTCMonth();
    const startLabel = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        ...(sameMonth ? {} : { year: "numeric" }),
        timeZone: "UTC",
    }).format(startDate);
    const endLabel = sameMonth
        ? `${new Intl.DateTimeFormat(undefined, {
            day: "numeric",
            timeZone: "UTC",
        }).format(end)}, ${new Intl.DateTimeFormat(undefined, {
            year: "numeric",
            timeZone: "UTC",
        }).format(end)}`
        : new Intl.DateTimeFormat(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            timeZone: "UTC",
        }).format(end);
    return `${startLabel} – ${endLabel}`;
}

function formatDay(value) {
    return new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        month: "long",
        day: "numeric",
        timeZone: "UTC",
    }).format(isoDate(value));
}

function weekRevision(start) {
    return manifest?.weeks?.[start]?.revision || null;
}

function weekCacheKey(start, revision = weekRevision(start)) {
    if (!start || !revision) return null;
    return publicCache.key("earningsWeek", { weekStart: start, weekRevision: revision });
}

function isWithinCoverage(start) {
    if (!manifest?.coverageStart || !manifest?.coverageEnd) return false;
    return start >= manifest.coverageStart && addDays(start, 6) <= manifest.coverageEnd;
}

function setStatus(message, { error = false, loading = false } = {}) {
    elements.live.textContent = message || "";
    elements.days.setAttribute("aria-busy", loading ? "true" : "false");
    if (error && message) showToast(message, true, 4500, elements.toast);
}

function isProviderSnapshotStale(value = manifest) {
    const refreshAfter = Date.parse(value?.refreshAfter || "");
    return Number.isFinite(refreshAfter) && Date.now() > refreshAfter + (4 * 60 * 60 * 1000);
}

function renderMetadata() {
    if (!manifest) {
        elements.meta.textContent = "Calendar status is unavailable.";
        return;
    }
    const isProviderStale = isProviderSnapshotStale();
    const parts = [`Last checked ${formatDateTime(manifest.checkedAt)}`];
    if (manifest.changedAt && manifest.changedAt !== manifest.checkedAt) {
        parts.push(`calendar changed ${formatDateTime(manifest.changedAt)}`);
    }
    if (manifest.constituentVersion) parts.push(`constituents ${manifest.constituentVersion}`);
    if (isProviderStale) parts.push("provider refresh overdue");
    elements.meta.textContent = parts.join(" · ");

    if (isProviderStale && !staleWarningShown) {
        staleWarningShown = true;
        showToast(
            "The provider has not been checked on schedule. Showing the last successful calendar snapshot.",
            true,
            5500,
            elements.toast,
        );
    }
}

function renderControls() {
    elements.weekTitle.textContent = formatWeek(selectedWeekStart);
    elements.previous.disabled = !manifest || !isWithinCoverage(addWeeks(selectedWeekStart, -1));
    elements.next.disabled = !manifest || !isWithinCoverage(addWeeks(selectedWeekStart, 1));
    elements.current.disabled = selectedWeekStart === currentWeekStart;
}

function logoInitials(event) {
    const symbol = String(event.symbol || "").replace(/[^A-Z0-9]/gi, "").toUpperCase();
    if (symbol) return symbol.slice(0, 2);
    return String(event.companyName || "?").trim().slice(0, 1).toUpperCase() || "?";
}

function createCompanyLogo(event, { large = false } = {}) {
    const wrapper = document.createElement("span");
    wrapper.className = `earnings-logo${large ? " earnings-logo-large" : ""}`;

    const fallback = document.createElement("span");
    fallback.className = "earnings-logo-fallback";
    fallback.textContent = logoInitials(event);

    const symbol = String(event.symbol || "").trim().toUpperCase();
    if (!symbol) {
        wrapper.appendChild(fallback);
        return wrapper;
    }

    const image = document.createElement("img");
    image.alt = "";
    image.width = large ? 72 : 52;
    image.height = large ? 72 : 52;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "strict-origin-when-cross-origin";
    image.style.visibility = "hidden";
    image.onload = () => {
        image.style.visibility = "visible";
        fallback.classList.add("hidden");
    };
    image.onerror = () => {
        onLogoError(image, symbol);
        image.onerror = () => image.remove();
    };
    image.src = getLogoUrl(symbol);
    wrapper.append(fallback, image);
    return wrapper;
}

function formatFiscalPeriod(detail) {
    const quarter = Number(detail?.fiscalQuarter);
    const year = Number(detail?.fiscalYear);
    if (Number.isInteger(quarter) && Number.isInteger(year)) return `Q${quarter} ${year}`;
    if (Number.isInteger(year)) return String(year);
    return "Not available";
}

function formatEpsEstimate(value) {
    return value !== null && value !== "" && Number.isFinite(Number(value))
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: "USD",
            minimumFractionDigits: 2,
            maximumFractionDigits: 4,
        }).format(Number(value))
        : "Not available";
}

function formatRevenueEstimate(value) {
    return value !== null && value !== "" && Number.isFinite(Number(value))
        ? new Intl.NumberFormat(undefined, {
            style: "currency",
            currency: "USD",
            notation: "compact",
            maximumFractionDigits: 2,
        }).format(Number(value))
        : "Not available";
}

function renderEstimateState(detail = null, { loading = false, error = false } = {}) {
    elements.estimateGrid.classList.toggle("hidden", loading || error || !detail);
    elements.estimateRetry.classList.toggle("hidden", !error);
    if (loading) {
        elements.estimateState.textContent = "Loading consensus estimates…";
        elements.estimateState.classList.remove("hidden");
        return;
    }
    if (error) {
        elements.estimateState.textContent = "Consensus estimates could not be loaded.";
        elements.estimateState.classList.remove("hidden");
        return;
    }
    elements.estimateState.classList.add("hidden");
    elements.drawerFiscal.textContent = formatFiscalPeriod(detail);
    elements.drawerEps.textContent = formatEpsEstimate(detail?.epsEstimate);
    elements.drawerRevenue.textContent = formatRevenueEstimate(detail?.revenueEstimate);
}

function estimateCacheKey(event, revision) {
    return publicCache.key("earningsEstimate", {
        eventId: event?.eventId,
        weekRevision: revision,
    });
}

async function loadEventEstimates(event, { force = false } = {}) {
    const start = weekStartInNewYork(event.reportDate);
    const revision = weekRevision(start);
    if (!event.eventId || !revision) throw new Error("Estimate details are not available for this calendar event.");
    const key = estimateCacheKey(event, revision);
    let entry = loadedEstimates.get(key);
    if (!entry) {
        entry = await publicCache.get("earningsEstimate", key, { allowStale: true });
        if (entry) loadedEstimates.set(key, entry);
    }
    if (entry?.isFresh && !force) return entry.data;

    const headers = {};
    if (entry?.version && !force) headers["If-None-Match"] = entry.version;
    const endpoint = `/earnings-calendar/weeks/${encodeURIComponent(start)}/events/${encodeURIComponent(event.eventId)}/estimates?revision=${encodeURIComponent(revision)}`;
    const response = await publicApiCall(endpoint, {
        headers,
        cache: force ? "reload" : "default",
        coalesce: !force,
        retryAttempts: 0,
    });
    if (response.status === 304 && entry?.data) {
        const refreshed = await publicCache.set("earningsEstimate", key, entry.data, {
            version: entry.version,
            serverUpdatedAt: loadedWeeks.get(start)?.changedAt || null,
        }) || { ...entry, isFresh: true };
        loadedEstimates.set(key, refreshed);
        return refreshed.data;
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) {
        await loadManifest({ force: true });
        await ensureWeek(start, { force: true });
        renderWeek();
        throw new Error("The calendar changed. Reopen the company to load its latest estimates.");
    }
    if (!response.ok) throw new Error(data.message || "Unable to load consensus estimates.");
    const stored = await publicCache.set("earningsEstimate", key, data, {
        version: response.headers.get("ETag"),
        serverUpdatedAt: loadedWeeks.get(start)?.changedAt || null,
    }) || { data, isFresh: true, version: response.headers.get("ETag") };
    loadedEstimates.set(key, stored);
    return data;
}

async function populateEventEstimates(event, requestId, { force = false } = {}) {
    renderEstimateState(null, { loading: true });
    try {
        const detail = await loadEventEstimates(event, { force });
        if (requestId !== pendingDrawerRequest || activeDrawerEvent?.eventId !== event.eventId) return;
        renderEstimateState(detail);
        setStatus(`Consensus estimates loaded for ${event.symbol || "the selected company"}.`);
    } catch (error) {
        if (requestId !== pendingDrawerRequest || activeDrawerEvent?.eventId !== event.eventId) return;
        renderEstimateState(null, { error: true });
        setStatus(error.message, { error: true });
    }
}

function openEventDrawer(event, trigger) {
    const sessionValue = SESSION_LABELS[event.session] ? event.session : "unknown";
    lastDrawerTrigger = trigger;
    activeDrawerEvent = event;
    const requestId = ++pendingDrawerRequest;
    elements.drawerLogo.replaceChildren(createCompanyLogo(event, { large: true }));
    elements.drawerTitle.textContent = event.symbol || "—";
    elements.drawerName.textContent = event.companyName || "Unknown company";
    elements.drawerDate.textContent = event.reportDate ? formatDay(event.reportDate) : "Date not available";
    elements.drawerSession.textContent = SESSION_LABELS[sessionValue];
    if (typeof elements.drawer.showModal === "function") {
        elements.drawer.showModal();
    } else {
        elements.drawer.setAttribute("open", "");
    }
    populateEventEstimates(event, requestId);
}

function eventCard(event) {
    const sessionValue = SESSION_LABELS[event.session] ? event.session : "unknown";
    const button = document.createElement("button");
    button.className = "earnings-event-card";
    button.type = "button";
    button.title = event.companyName || event.symbol || "Company details";
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute(
        "aria-label",
        `${event.companyName || "Unknown company"}, ${event.symbol || "ticker unavailable"}, ${event.reportDate ? formatDay(event.reportDate) : "date unavailable"}, ${SESSION_LABELS[sessionValue]}. Open earnings details.`,
    );

    const ticker = document.createElement("strong");
    ticker.textContent = event.symbol || "—";
    button.append(createCompanyLogo(event), ticker);

    if (sessionValue === "during_market" || sessionValue === "unknown") {
        const timing = document.createElement("span");
        timing.className = `earnings-event-timing session-${sessionValue}`;
        timing.textContent = sessionValue === "during_market" ? "Market" : "TBD";
        button.appendChild(timing);
    }

    button.addEventListener("click", () => openEventDrawer(event, button));
    return button;
}

function dayHeading(date) {
    const header = document.createElement("header");
    header.className = "earnings-day-heading earnings-calendar-cell";
    header.dataset.calendarDate = date;
    header.id = `earnings-day-${date}`;
    if (date === currentDate) header.classList.add("is-today");

    const weekday = document.createElement("span");
    weekday.textContent = new Intl.DateTimeFormat(undefined, {
        weekday: "long",
        timeZone: "UTC",
    }).format(isoDate(date));

    const dateLine = document.createElement("div");
    const dayNumber = document.createElement("strong");
    dayNumber.textContent = new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        timeZone: "UTC",
    }).format(isoDate(date));
    const month = document.createElement("small");
    month.textContent = new Intl.DateTimeFormat(undefined, {
        month: "short",
        timeZone: "UTC",
    }).format(isoDate(date));
    dateLine.append(dayNumber, month);
    header.append(weekday, dateLine);

    if (date === currentDate) {
        const today = document.createElement("em");
        today.textContent = "Today";
        header.appendChild(today);
    }
    return header;
}

function laneKey(date, laneId) {
    return `${selectedWeekStart}:${date}:${laneId}`;
}

function laneCell(date, lane, events) {
    const key = laneKey(date, lane.id);
    const laneEvents = events.filter((event) => lane.sessions.includes(
        SESSION_LABELS[event.session] ? event.session : "unknown",
    ));
    const isExpanded = expandedLanes.has(key);
    const visibleEvents = isExpanded ? laneEvents : laneEvents.slice(0, CARD_LIMIT);
    const section = document.createElement("section");
    section.className = `earnings-lane earnings-lane-${lane.id} earnings-calendar-cell`;
    section.dataset.calendarDate = date;
    section.setAttribute("aria-labelledby", `earnings-day-${date} earnings-lane-${date}-${lane.id}`);

    const header = document.createElement("header");
    const titleWrap = document.createElement("div");
    const icon = document.createElement("span");
    icon.className = "earnings-lane-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = lane.icon;
    const title = document.createElement("h4");
    title.id = `earnings-lane-${date}-${lane.id}`;
    title.textContent = lane.label;
    titleWrap.append(icon, title);
    const count = document.createElement("span");
    count.className = "earnings-lane-count";
    count.textContent = String(laneEvents.length).padStart(2, "0");
    header.append(titleWrap, count);

    const body = document.createElement("div");
    body.className = "earnings-lane-events";
    if (visibleEvents.length) {
        visibleEvents.forEach((event) => body.appendChild(eventCard(event)));
    } else {
        const empty = document.createElement("p");
        empty.className = "earnings-lane-empty";
        empty.textContent = "No reports";
        body.appendChild(empty);
    }
    section.append(header, body);

    if (laneEvents.length > CARD_LIMIT) {
        const toggle = document.createElement("button");
        toggle.id = `earnings-toggle-${date}-${lane.id}`;
        toggle.className = "earnings-lane-toggle";
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(isExpanded));
        toggle.setAttribute("aria-label", `${isExpanded ? "Show fewer" : "View all"} ${lane.label} reports for ${formatDay(date)}`);
        toggle.textContent = isExpanded ? "Show less" : `View all ${laneEvents.length}`;
        toggle.addEventListener("click", () => {
            if (isExpanded) expandedLanes.delete(key);
            else expandedLanes.add(key);
            renderWeek();
            document.getElementById(`earnings-toggle-${date}-${lane.id}`)?.focus();
        });
        section.appendChild(toggle);
    }
    return section;
}

function setActiveMobileDay(date) {
    selectedMobileDay = date;
    elements.tabs.querySelectorAll('[role="tab"]').forEach((tab) => {
        const isSelected = tab.dataset.calendarDate === date;
        tab.setAttribute("aria-selected", String(isSelected));
        tab.tabIndex = isSelected ? 0 : -1;
    });
    elements.days.querySelectorAll("[data-calendar-date]").forEach((cell) => {
        cell.classList.toggle("is-mobile-hidden", cell.dataset.calendarDate !== date);
    });
    const selectedTab = elements.tabs.querySelector(`[data-calendar-date="${date}"]`);
    if (selectedTab) elements.days.setAttribute("aria-labelledby", selectedTab.id);
}

function renderMobileDayTabs(dayDates, filteredEvents) {
    elements.tabs.replaceChildren();
    if (!dayDates.includes(selectedMobileDay)) selectedMobileDay = dayDates[0];

    dayDates.forEach((date, index) => {
        const tab = document.createElement("button");
        tab.id = `earnings-tab-${date}`;
        tab.type = "button";
        tab.role = "tab";
        tab.dataset.calendarDate = date;
        tab.setAttribute("aria-controls", "earningsDays");
        tab.setAttribute("aria-selected", String(date === selectedMobileDay));
        tab.tabIndex = date === selectedMobileDay ? 0 : -1;
        if (date === currentDate) {
            tab.classList.add("is-today");
            tab.setAttribute("aria-label", `${formatDay(date)}, today`);
        }

        const weekday = document.createElement("span");
        weekday.textContent = new Intl.DateTimeFormat(undefined, {
            weekday: "short",
            timeZone: "UTC",
        }).format(isoDate(date));
        const dateNumber = document.createElement("strong");
        dateNumber.textContent = new Intl.DateTimeFormat(undefined, {
            day: "numeric",
            timeZone: "UTC",
        }).format(isoDate(date));
        const count = document.createElement("small");
        count.textContent = String(filteredEvents.filter((event) => event.reportDate === date).length);
        tab.append(weekday, dateNumber, count);
        tab.addEventListener("click", () => setActiveMobileDay(date));
        tab.addEventListener("keydown", (event) => {
            let nextIndex = null;
            if (event.key === "ArrowRight") nextIndex = (index + 1) % dayDates.length;
            if (event.key === "ArrowLeft") nextIndex = (index - 1 + dayDates.length) % dayDates.length;
            if (event.key === "Home") nextIndex = 0;
            if (event.key === "End") nextIndex = dayDates.length - 1;
            if (nextIndex === null) return;
            event.preventDefault();
            const nextDate = dayDates[nextIndex];
            setActiveMobileDay(nextDate);
            elements.tabs.querySelector(`[data-calendar-date="${nextDate}"]`)?.focus();
        });
        elements.tabs.appendChild(tab);
    });
}

function additionalDates(events, weekdayDates) {
    const weekdaySet = new Set(weekdayDates);
    const extraEvents = events.filter((event) => !weekdaySet.has(event.reportDate));
    if (!extraEvents.length) return null;

    const section = document.createElement("section");
    section.className = "earnings-additional";
    const header = document.createElement("header");
    const headerCopy = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "earnings-label";
    eyebrow.textContent = "Outside the market week";
    const title = document.createElement("h3");
    title.textContent = "Additional dates";
    headerCopy.append(eyebrow, title);
    const count = document.createElement("span");
    count.textContent = `${extraEvents.length} ${extraEvents.length === 1 ? "report" : "reports"}`;
    header.append(headerCopy, count);
    section.appendChild(header);

    const groups = new Map();
    extraEvents.forEach((event) => {
        const date = event.reportDate || "unknown";
        if (!groups.has(date)) groups.set(date, []);
        groups.get(date).push(event);
    });
    for (const [date, dateEvents] of groups) {
        const group = document.createElement("div");
        group.className = "earnings-additional-group";
        const heading = document.createElement("h4");
        heading.textContent = date === "unknown" ? "Date not available" : formatDay(date);
        const cards = document.createElement("div");
        cards.className = "earnings-additional-events";
        dateEvents.forEach((event) => cards.appendChild(eventCard(event)));
        group.append(heading, cards);
        section.appendChild(group);
    }
    return section;
}

function renderWeek() {
    renderControls();
    elements.days.replaceChildren();
    elements.tabs.replaceChildren();
    const week = loadedWeeks.get(selectedWeekStart);
    if (!week) {
        elements.weekCount.textContent = "—";
        setStatus(manifest ? "This week has not been loaded." : "Waiting for calendar metadata.", { loading: Boolean(manifest) });
        return;
    }

    const events = Array.isArray(week.events) ? week.events : [];
    const reportLabel = events.length === 1 ? "report" : "reports";
    elements.weekCount.textContent = `${events.length} ${reportLabel}`;

    const weekdayDates = Array.from({ length: WEEKDAY_COUNT }, (_, index) => addDays(selectedWeekStart, index));
    renderMobileDayTabs(weekdayDates, events);
    const eventsByDate = new Map(weekdayDates.map((date) => [date, []]));
    events.forEach((event) => {
        if (eventsByDate.has(event.reportDate)) eventsByDate.get(event.reportDate).push(event);
    });

    if (events.length) {
        const board = document.createElement("div");
        board.className = "earnings-board";
        board.setAttribute("aria-label", `Earnings calendar for ${formatWeek(selectedWeekStart)}`);
        weekdayDates.forEach((date) => {
            const column = document.createElement("article");
            column.className = "earnings-day-column earnings-calendar-cell";
            column.dataset.calendarDate = date;
            column.appendChild(dayHeading(date));
            const dateEvents = eventsByDate.get(date);
            SESSION_LANES.forEach((lane) => {
                column.appendChild(laneCell(date, lane, dateEvents));
            });
            board.appendChild(column);
        });
        elements.days.appendChild(board);
    } else {
        const empty = document.createElement("div");
        empty.className = "earnings-empty-week";
        empty.innerHTML = "<strong>No reports scheduled</strong><span>No S&amp;P 500 earnings are expected for this week.</span>";
        elements.days.appendChild(empty);
    }
    const additional = additionalDates(events, weekdayDates);
    if (additional) elements.days.appendChild(additional);
    setActiveMobileDay(selectedMobileDay);

    setStatus(events.length ? "" : "No S&P 500 earnings are expected for this week.");
}

async function readCachedWeek(start) {
    const revision = weekRevision(start);
    const key = weekCacheKey(start, revision);
    if (!key) return null;
    const entry = await publicCache.get("earningsWeek", key, { allowStale: true });
    if (!entry?.data || entry.data.weekRevision !== revision) return null;
    loadedWeeks.set(start, entry.data);
    loadedEntries.set(start, entry);
    return entry;
}

async function storeWeek(week, version = null) {
    const key = weekCacheKey(week.weekStart, week.weekRevision);
    if (!key) return null;
    const entry = await publicCache.set("earningsWeek", key, week, {
        version: version || quoteEtag(week.weekRevision),
        serverUpdatedAt: week.changedAt || null,
    });
    loadedWeeks.set(week.weekStart, week);
    loadedEntries.set(week.weekStart, entry || { data: week, isFresh: true, version: version || quoteEtag(week.weekRevision) });
    return entry;
}

async function loadManifest({ force = false } = {}) {
    const key = publicCache.key("earningsManifest");
    if (!manifestEntry) {
        manifestEntry = await publicCache.get("earningsManifest", key, { allowStale: true });
        if (manifestEntry?.data) manifest = manifestEntry.data;
    }
    if (manifestEntry?.isFresh && !force) return manifest;

    const headers = {};
    if (manifestEntry?.version && !force) headers["If-None-Match"] = manifestEntry.version;
    const response = await publicApiCall("/earnings-calendar/manifest", {
        headers,
        cache: force ? "reload" : "default",
        coalesce: !force,
        retryAttempts: 0,
    });
    if (response.status === 304 && manifestEntry?.data) {
        manifestEntry = await publicCache.set("earningsManifest", key, manifestEntry.data, {
            version: manifestEntry.version,
            serverUpdatedAt: manifestEntry.data.checkedAt || null,
        }) || { ...manifestEntry, isFresh: true };
        manifest = manifestEntry.data;
        return manifest;
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || "Unable to load calendar metadata.");
    if (Number(data.ingestionVersion || 0) < 3) {
        throw new Error("The earnings calendar is being upgraded. Please try again shortly.");
    }
    const version = response.headers.get("ETag") || quoteEtag(data.datasetRevision);
    const previousManifest = manifest;
    manifestEntry = await publicCache.set("earningsManifest", key, data, {
        version,
        serverUpdatedAt: data.checkedAt || null,
    }) || { data, isFresh: true, version };
    manifest = data;
    await discardSupersededWeeks(previousManifest, manifest);
    return manifest;
}

async function discardSupersededWeeks(previousManifest, nextManifest) {
    const previousWeeks = previousManifest?.weeks || {};
    const nextWeeks = nextManifest?.weeks || {};
    await Promise.all(Object.entries(previousWeeks).map(async ([start, previous]) => {
        if (previous?.revision && previous.revision !== nextWeeks[start]?.revision) {
            await publicCache.invalidate("earningsWeek", weekCacheKey(start, previous.revision));
            if (loadedWeeks.get(start)?.weekRevision === previous.revision) {
                loadedWeeks.delete(start);
                loadedEntries.delete(start);
            }
        }
    }));
}

function weeksMatchManifest(weeks, start, count) {
    if (weeks.length !== count) return false;
    return weeks.every((week, index) => (
        week?.weekStart === addWeeks(start, index)
        && week.weekRevision === weekRevision(week.weekStart)
    ));
}

async function fetchWeekRange(start, count, existingEntry = null, {
    cacheMode = "default",
    allowManifestReload = true,
} = {}) {
    const headers = {};
    if (count === 1 && existingEntry?.version) headers["If-None-Match"] = existingEntry.version;
    const revision = encodeURIComponent(String(manifest?.datasetRevision || ""));
    const response = await publicApiCall(`/earnings-calendar/weeks?start=${encodeURIComponent(start)}&count=${count}&revision=${revision}`, {
        headers,
        cache: cacheMode,
        coalesce: cacheMode !== "reload",
        retryAttempts: 0,
    });
    if (response.status === 304 && existingEntry?.data) {
        if (!weeksMatchManifest([existingEntry.data], start, count)) {
            if (!allowManifestReload) throw new Error("The calendar cache revision did not match its metadata.");
            return fetchWeekRange(start, count, null, { cacheMode: "reload", allowManifestReload: false });
        }
        await storeWeek(existingEntry.data, existingEntry.version);
        return [existingEntry.data];
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 409 && allowManifestReload) {
        await loadManifest({ force: true });
        return fetchWeekRange(start, count, null, { cacheMode: "reload", allowManifestReload: false });
    }
    if (!response.ok) throw new Error(data.message || "Unable to load earnings for this week.");
    const weeks = Array.isArray(data.weeks) ? data.weeks : [];
    if (!weeksMatchManifest(weeks, start, count)) {
        if (allowManifestReload) {
            await loadManifest({ force: true });
            return fetchWeekRange(start, count, null, { cacheMode: "reload", allowManifestReload: false });
        }
        throw new Error("The calendar cache revision did not match its metadata.");
    }
    for (const week of weeks) {
        const version = count === 1 ? response.headers.get("ETag") : quoteEtag(week.weekRevision);
        await storeWeek(week, version);
    }
    return weeks;
}

async function hydrateInitialCache() {
    const starts = [addWeeks(currentWeekStart, -1), currentWeekStart, addWeeks(currentWeekStart, 1)];
    await Promise.all(starts.map((start) => readCachedWeek(start)));
}

async function ensureInitialWindow({ force = false } = {}) {
    const first = addWeeks(currentWeekStart, -1);
    const starts = [first, currentWeekStart, addWeeks(currentWeekStart, 1)];
    if (!starts.every(isWithinCoverage)) return ensureWeek(currentWeekStart, { force });
    const needsRequest = force || starts.some((start) => {
        const entry = loadedEntries.get(start);
        const week = loadedWeeks.get(start);
        return !entry?.isFresh || !week || week.weekRevision !== weekRevision(start);
    });
    if (!needsRequest) return;
    const canRevalidateIndividually = !force && starts.every((start) => (
        loadedEntries.get(start)?.version
        && loadedWeeks.get(start)?.weekRevision === weekRevision(start)
    ));
    if (canRevalidateIndividually) {
        await Promise.all(starts.map((start) => ensureWeek(start)));
        return;
    }
    await fetchWeekRange(first, 3, null, { cacheMode: force ? "reload" : "default" });
}

async function ensureWeek(start, { force = false } = {}) {
    if (!isWithinCoverage(start)) throw new Error("This week is outside the available calendar range.");
    let entry = loadedEntries.get(start);
    let week = loadedWeeks.get(start);
    if (!week || week.weekRevision !== weekRevision(start)) {
        entry = await readCachedWeek(start);
        week = loadedWeeks.get(start);
    }
    if (entry?.isFresh && week && !force) return week;
    const weeks = await fetchWeekRange(start, 1, entry, { cacheMode: force ? "reload" : "default" });
    return weeks[0] || week || null;
}

async function selectWeek(start) {
    if (!manifest || !isWithinCoverage(start)) return;
    if (start !== selectedWeekStart) {
        expandedLanes.clear();
        selectedMobileDay = preferredMobileDay(start);
    }
    selectedWeekStart = start;
    renderWeek();
    if (loadedWeeks.has(start)) setStatus("");
    const requestId = ++pendingRequest;
    try {
        await ensureWeek(start);
        if (requestId !== pendingRequest) return;
        renderWeek();
    } catch (error) {
        if (requestId !== pendingRequest) return;
        if (loadedWeeks.has(start)) {
            setStatus(`Showing cached data. ${error.message}`, { error: true });
        } else {
            setStatus(error.message, { error: true });
        }
    }
}

async function refreshVisibleData() {
    const previousCheckedAt = manifest?.checkedAt || null;
    elements.refresh.disabled = true;
    elements.refreshLabel.textContent = "Refreshing…";
    try {
        await loadManifest({ force: true });
        renderMetadata();
        await hydrateInitialCache();
        await ensureWeek(selectedWeekStart, { force: true });
        renderWeek();
        if (isProviderSnapshotStale()) {
            showToast(
                "Snapshot reloaded, but the scheduled provider refresh is still overdue.",
                true,
                5500,
                elements.toast,
            );
        } else if (manifest?.checkedAt && manifest.checkedAt !== previousCheckedAt) {
            showToast("A newer calendar snapshot was loaded.", false, 2500, elements.toast);
        } else {
            showToast("The calendar snapshot is already current.", false, 2500, elements.toast);
        }
    } catch (error) {
        setStatus(loadedWeeks.has(selectedWeekStart) ? `Showing cached data. ${error.message}` : error.message, { error: true });
    } finally {
        elements.refresh.disabled = false;
        elements.refreshLabel.textContent = "Reload snapshot";
    }
}

async function initialize() {
    renderControls();
    setStatus("Loading earnings calendar…", { loading: true });
    const manifestKey = publicCache.key("earningsManifest");
    manifestEntry = await publicCache.get("earningsManifest", manifestKey, { allowStale: true });
    if (manifestEntry?.data) {
        manifest = manifestEntry.data;
        renderMetadata();
        await hydrateInitialCache();
        renderWeek();
    }
    try {
        const isLocalDevelopment = ["localhost", "127.0.0.1"].includes(window.location.hostname);
        await loadManifest({ force: isLocalDevelopment });
        renderMetadata();
        await hydrateInitialCache();
        renderWeek();
        await ensureInitialWindow();
        renderWeek();
    } catch (error) {
        renderMetadata();
        if (loadedWeeks.has(selectedWeekStart)) {
            setStatus(`Showing cached data. ${error.message}`, { error: true });
        } else {
            setStatus(error.message, { error: true });
        }
    }
}

elements.previous.addEventListener("click", () => selectWeek(addWeeks(selectedWeekStart, -1)));
elements.next.addEventListener("click", () => selectWeek(addWeeks(selectedWeekStart, 1)));
elements.current.addEventListener("click", () => selectWeek(currentWeekStart));
elements.refresh.addEventListener("click", refreshVisibleData);
elements.estimateRetry.addEventListener("click", () => {
    if (!activeDrawerEvent) return;
    const requestId = ++pendingDrawerRequest;
    populateEventEstimates(activeDrawerEvent, requestId, { force: true });
});
elements.drawerClose.addEventListener("click", () => {
    if (typeof elements.drawer.close === "function") elements.drawer.close();
    else elements.drawer.removeAttribute("open");
});
elements.drawer.addEventListener("click", (event) => {
    if (event.target !== elements.drawer) return;
    if (typeof elements.drawer.close === "function") elements.drawer.close();
    else elements.drawer.removeAttribute("open");
});
elements.drawer.addEventListener("close", () => {
    pendingDrawerRequest += 1;
    activeDrawerEvent = null;
    if (lastDrawerTrigger?.isConnected) lastDrawerTrigger.focus();
    lastDrawerTrigger = null;
});

initialize();
