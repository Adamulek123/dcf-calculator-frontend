function showToast(message, isError = false, duration = 3000, container = document.getElementById("toast-container")) {
    if (!container) {
        console.warn("Toast container not found.");
        return;
    }

    const toast = document.createElement("div");
    toast.className = `toast ${isError ? "error" : "success"}`;

    const icon = document.createElement("span");
    icon.className = "toast-icon";
    icon.innerHTML = isError ? "&#x2716;" : "&#x2714;";
    toast.appendChild(icon);

    const text = document.createElement("span");
    text.textContent = message;
    toast.appendChild(text);

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = "fadeOut 0.5s forwards";
        toast.addEventListener("animationend", () => {
            toast.remove();
        });
    }, duration);
}

export { showToast };
