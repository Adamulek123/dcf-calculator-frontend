function getBackendBaseUrl() {
    const isLocalDev = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
    return isLocalDev ? "http://localhost:5000" : "https://dcf-backend.onrender.com";
}

function setButtonState(button, text, disabled) {
    button.textContent = text;
    button.disabled = disabled;
}

const inFlightRequests = new Map();

function canonicalBody(body) {
    if (!body) return "";
    try { return JSON.stringify(JSON.parse(body)); } catch { return String(body); }
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

    const method = String(options.method || "GET").toUpperCase();
    const coalesce = method === "GET" || options.coalesce === true;
    const requestOptions = { ...options };
    delete requestOptions.coalesce;
    const key = `${user.uid}:${method}:${endpoint}:${canonicalBody(requestOptions.body)}`;
    const execute = async () => {
        const response = await fetch(`${backendBaseUrl}${endpoint}`, requestOptions);
        if (response.status === 401) {
            handleLogout();
            throw new Error("Session expired. Please log in again.");
        }
        return response;
    };
    try {
        if (!coalesce) return await execute();
        let pending = inFlightRequests.get(key);
        if (!pending) {
            pending = execute().finally(() => inFlightRequests.delete(key));
            inFlightRequests.set(key, pending);
        }
        return (await pending).clone();
    } catch (error) {
        console.error(`API call to ${endpoint} failed:`, error);
        throw error;
    }
}

export { getBackendBaseUrl, setButtonState, apiCall };
