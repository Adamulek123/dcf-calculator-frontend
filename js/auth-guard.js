// NOTE: This auth guard provides client-side UX routing only.
// It can be bypassed by disabling JavaScript.
// Real authentication enforcement is handled server-side via
// the @firebase_token_required decorator on all protected API endpoints.
import { observeAuthState, isVerifiedUser } from "./auth.js";

const PUBLIC_PAGES = new Set(["", "index.html", "login.html", "register.html"]);
const PROTECTED_PAGES = new Set(["dcf-calculator.html", "financial-data.html", "portfolio-creator.html", "dip-finder.html"]);

function getPageName() {
    const path = window.location.pathname.split("/").pop();
    return path || "index.html";
}

function runAuthGuard() {
    const page = getPageName();

    observeAuthState((user) => {
        const verified = isVerifiedUser(user);

        if (PROTECTED_PAGES.has(page) && !verified) {
            window.location.replace("login.html");
            return;
        }

        if ((page === "login.html" || page === "register.html") && verified) {
            window.location.replace("dcf-calculator.html");
            return;
        }

        if (!PUBLIC_PAGES.has(page) && !PROTECTED_PAGES.has(page) && !verified) {
            window.location.replace("login.html");
        }
    });
}

export { PUBLIC_PAGES, PROTECTED_PAGES, runAuthGuard };
