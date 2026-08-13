import { runAuthGuard } from "./auth-guard.js";
import { renderSidebar } from "./sidebar.js";
import "./dcf-calculator.js";

runAuthGuard();
renderSidebar();
