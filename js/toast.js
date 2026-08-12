function showToast(message, isError = false, duration = 3000, container = document.getElementById("toast-container")) {
    if (!container) {
        console.warn("Toast container not found.");
        return;
    }
    container.setAttribute("aria-live", "polite");
    container.setAttribute("aria-atomic", "true");

    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "error" : "success"}`;
    toast.setAttribute("role", isError ? "alert" : "status");

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = isError ? "&#x2716;" : "&#x2714;";
    toast.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    container.appendChild(toast);

    const timeout = Number(duration);
    const visibleFor = Number.isFinite(timeout) ? Math.max(0, timeout) : 3000;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

    setTimeout(() => {
        if (reducedMotion) {
            toast.remove();
            return;
        }

        toast.classList.add("is-dismissing");
        const fallbackCleanup = setTimeout(() => toast.remove(), 650);
        toast.addEventListener("animationend", () => {
            clearTimeout(fallbackCleanup);
            toast.remove();
        }, { once: true });
    }, visibleFor);
}

export { showToast };
