import { logoutUser } from "./auth.js";

const SIDEBAR_NAV_ITEMS = [
    {
        id: "dcf-calculator",
        label: "DCF Calculator",
        href: "dcf-calculator.html",
        iconSrc: "assets/math.svg",
    },
    {
        id: "financial-data",
        label: "Financial Data",
        href: "financial-data.html",
        iconSrc: "assets/chart.svg",
    },
];

const LOGOUT_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;

const HAMBURGER_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>`;

const CLOSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function getCurrentPage() {
    return window.location.pathname.split("/").pop() || "index.html";
}

function renderSidebar() {
    const currentPage = getCurrentPage();

    const aside = document.createElement("aside");
    aside.className = "sidebar";
    aside.setAttribute("aria-label", "Main navigation");

    // Brand — just the dot
    const brand = document.createElement("a");
    brand.className = "sidebar-brand";
    brand.href = "dcf-calculator.html";
    brand.setAttribute("aria-label", "DCF Calculator home");
    brand.innerHTML = `<span class="sidebar-brand-dot" aria-hidden="true"></span>`;

    // Nav
    const nav = document.createElement("nav");
    nav.className = "sidebar-nav";

    for (const item of SIDEBAR_NAV_ITEMS) {
        const link = document.createElement("a");
        link.className = "sidebar-nav-item";
        link.href = item.href;
        link.setAttribute("data-tooltip", item.label);
        link.setAttribute("aria-label", item.label);
        if (currentPage === item.href) {
            link.classList.add("active");
            link.setAttribute("aria-current", "page");
        }
        link.innerHTML = `<span class="sidebar-nav-icon"><img src="${item.iconSrc}" alt="" width="22" height="22"></span>`;
        nav.appendChild(link);
    }

    // Bottom section with logout
    const bottom = document.createElement("div");
    bottom.className = "sidebar-bottom";

    const logoutBtn = document.createElement("button");
    logoutBtn.className = "sidebar-nav-item sidebar-logout";
    logoutBtn.type = "button";
    logoutBtn.setAttribute("data-tooltip", "Logout");
    logoutBtn.setAttribute("aria-label", "Logout");
    logoutBtn.innerHTML = `<span class="sidebar-nav-icon">${LOGOUT_ICON}</span>`;
    logoutBtn.addEventListener("click", async () => {
        logoutBtn.disabled = true;
        try {
            await logoutUser();
            window.location.href = "login.html";
        } catch {
            logoutBtn.disabled = false;
        }
    });

    bottom.appendChild(logoutBtn);

    aside.appendChild(brand);
    aside.appendChild(nav);
    aside.appendChild(bottom);

    // Mobile hamburger toggle
    const toggle = document.createElement("button");
    toggle.className = "sidebar-toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-label", "Toggle navigation");
    toggle.innerHTML = HAMBURGER_ICON;

    // Overlay for mobile
    const overlay = document.createElement("div");
    overlay.className = "sidebar-overlay";

    function openSidebar() {
        aside.classList.add("open");
        overlay.classList.add("visible");
        toggle.innerHTML = CLOSE_ICON;
        toggle.setAttribute("aria-expanded", "true");
    }

    function closeSidebar() {
        aside.classList.remove("open");
        overlay.classList.remove("visible");
        toggle.innerHTML = HAMBURGER_ICON;
        toggle.setAttribute("aria-expanded", "false");
    }

    toggle.addEventListener("click", () => {
        if (aside.classList.contains("open")) {
            closeSidebar();
        } else {
            openSidebar();
        }
    });

    overlay.addEventListener("click", closeSidebar);

    // Insert into DOM
    const appLayout = document.querySelector(".app-layout");
    if (appLayout) {
        appLayout.prepend(aside);
        document.body.prepend(toggle);
        document.body.prepend(overlay);
    }
}

export { renderSidebar };
