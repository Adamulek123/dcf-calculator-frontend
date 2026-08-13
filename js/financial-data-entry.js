import { runAuthGuard } from "./auth-guard.js";
import { renderSidebar } from "./sidebar.js";
import "./financial-data.js";

runAuthGuard();
renderSidebar();
