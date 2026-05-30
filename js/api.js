function getBackendBaseUrl() {
    const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    return isLocalDev ? "http://localhost:5000" : "https://dcf-backend.onrender.com";
}

function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
}

async function apiCall(endpoint, options = {}, dependencies = {}) {
    const { auth = window.auth, handleLogout = () => {}, backendBaseUrl = getBackendBaseUrl() } = dependencies;
    const user = auth?.currentUser;
    let idToken = null;

    if (user) {
        try {
            idToken = await user.getIdToken();
        } catch (error) {
            console.error("Error getting Firebase ID token:", error);
            handleLogout();
            throw new Error("Authentication token expired or invalid. Please log in again.");
        }
    }

    if (idToken) {
        options.headers = { ...options.headers, Authorization: `Bearer ${idToken}` };
    } else {
        throw new Error("No authentication token available. Please log in.");
    }

    try {
        const response = await fetch(`${backendBaseUrl}${endpoint}`, options);
        if (response.status === 401) {
            handleLogout();
            throw new Error("Session expired. Please log in again.");
        }
        return response;
    } catch (error) {
        console.error(`API call to ${endpoint} failed:`, error);
        throw error;
    }
}

export { getBackendBaseUrl, setButtonState, apiCall };
