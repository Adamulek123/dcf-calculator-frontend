import { logoutUser } from "./auth.js";

const BRAND_ICON = '<svg viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12.5" stroke="currentColor" stroke-width="1.4"/><path d="m8.2 11 5 5 3.4-3.4 6.2 6.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M22.8 13.8v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const SIDEBAR_NAV_ITEMS = [
    {
        id: "dcf-calculator",
        label: "DCF Calculator",
        description: "Intrinsic value model",
        href: "dcf-calculator.html",
        shortcut: "01",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 8h3M8.5 6.5v3M14 7h3M7 15l3 3m0-3-3 3M14 15h3m-3 3h3"/></svg>',
    },
    {
        id: "financial-data",
        label: "Financial Data",
        description: "Statements & trends",
        href: "financial-data.html",
        shortcut: "02",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 20V10m5 10V5m6 15v-8m5 8V3"/></svg>',
    },
    {
        id: "portfolio-creator",
        label: "Portfolio Creator",
        description: "Positions & allocation",
        href: "portfolio-creator.html",
        shortcut: "03",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16v13H4zM8 7V4h8v3M4 12h16M10 12v2h4v-2"/></svg>',
    },
    {
        id: "dip-finder",
        label: "Dip Finder",
        description: "Drawdown scanner",
        href: "dip-finder.html",
        shortcut: "04",
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 5v14h18M5.5 8.5l4 4 3-3 5 5M17.5 10.5v4h-4"/></svg>',
    },
];

const LOGOUT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>';
const HAMBURGER_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
const CLOSE_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg>';

function getCurrentPage() {
    return window.location.pathname.split("/").pop() || "index.html";
}

function createSidebar() {
    const aside = document.createElement("aside");
    aside.id = "appSidebar";
    aside.className = "sidebar";
    aside.setAttribute("aria-label", "Main navigation");

    const brand = document.createElement("a");
    brand.className = "sidebar-brand";
    brand.href = "dcf-calculator.html";
    brand.setAttribute("aria-label", "Stock Desk home");
    brand.innerHTML = '<span class="sidebar-brand-mark" aria-hidden="true">' + BRAND_ICON + '</span>'
        + '<span class="sidebar-brand-copy"><strong>Stock Desk</strong><small>Value instruments</small></span>';

    const nav = document.createElement("nav");
    nav.className = "sidebar-nav";

    for (const item of SIDEBAR_NAV_ITEMS) {
        const link = document.createElement("a");
        link.className = "sidebar-nav-item";
        link.href = item.href;
        link.setAttribute("aria-label", item.label);
        link.innerHTML = '<span class="sidebar-nav-icon" aria-hidden="true">' + item.icon + '</span>'
            + '<span class="sidebar-nav-copy"><strong>' + item.label + '</strong><small>' + item.description + '</small></span>'
            + '<span class="sidebar-shortcut">' + item.shortcut + '</span>';
        nav.appendChild(link);
    }

    const bottom = document.createElement("div");
    bottom.className = "sidebar-bottom";

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "sidebar-nav-item sidebar-logout";
    logoutBtn.type = "button";
    logoutBtn.setAttribute("data-sidebar-logout", "");
    logoutBtn.setAttribute("aria-label", "Log out");
    logoutBtn.innerHTML = '<span class="sidebar-nav-icon" aria-hidden="true">' + LOGOUT_ICON + '</span>'
        + '<span class="sidebar-nav-copy"><strong>Log out</strong><small>End this session</small></span>';

    bottom.appendChild(logoutBtn);
    aside.append(brand, nav, bottom);
    return aside;
}

function renderSidebar() {
    const appLayout = document.querySelector(".app-layout");
    if (!appLayout) return;

    let aside = appLayout.querySelector(".sidebar");
    if (!aside) {
        aside = createSidebar();
        appLayout.prepend(aside);
    }

    if (aside.dataset.sidebarInitialized === "true") return;
    aside.dataset.sidebarInitialized = "true";
    aside.id ||= "appSidebar";

    const currentPage = getCurrentPage();
    aside.querySelectorAll(".sidebar-nav-item[href]").forEach((link) => {
        const isCurrent = link.getAttribute("href") === currentPage;
        link.classList.toggle("active", isCurrent);
        if (isCurrent) {
            link.setAttribute("aria-current", "page");
        } else {
            link.removeAttribute("aria-current");
        }
    });

    const logoutBtn = aside.querySelector("[data-sidebar-logout], .sidebar-logout");
    if (logoutBtn) {
        logoutBtn.addEventListener("click", async () => {
            logoutBtn.disabled = true;
            try {
                await logoutUser();
                window.location.href = "login.html";
            } catch {
                logoutBtn.disabled = false;
            }
        });
    }

    const toggle = document.createElement("button");
    toggle.className = "sidebar-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Toggle navigation");
    toggle.setAttribute("aria-controls", aside.id);
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = HAMBURGER_ICON;

    const overlay = document.createElement("div");
    overlay.className = "sidebar-overlay";

    function closeSidebar() {
        aside.classList.remove("open");
        overlay.classList.remove("visible");
        toggle.innerHTML = HAMBURGER_ICON;
        toggle.setAttribute("aria-expanded", "false");
    }

    function openSidebar() {
        aside.classList.add("open");
        overlay.classList.add("visible");
        toggle.innerHTML = CLOSE_ICON;
        toggle.setAttribute("aria-expanded", "true");
    }

    toggle.addEventListener("click", () => {
        if (aside.classList.contains("open")) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });
    overlay.addEventListener("click", closeSidebar);
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") closeSidebar();
    });

    document.body.prepend(toggle);
    document.body.prepend(overlay);
}

export { renderSidebar };
