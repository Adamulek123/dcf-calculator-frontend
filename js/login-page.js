import { loginWithEmail, loginWithGoogle, getUserMessage } from "./auth.js";
import { runAuthGuard } from "./auth-guard.js";

runAuthGuard();

const loginForm = document.getElementById("loginForm");
const loginBtn = document.getElementById("loginBtn");
const googleLoginBtn = document.getElementById("googleLoginBtn");
const googleLoginLabel = document.getElementById("googleLoginLabel");
const messageEl = document.getElementById("loginMessage");

function setMessage(message, isError = false) {
    messageEl.textContent = message;
    messageEl.classList.toggle("error", isError);
    messageEl.classList.toggle("success", !isError && Boolean(message));
}

function createField(inputId, errorId, validate) {
    const input = document.getElementById(inputId);
    const error = document.getElementById(errorId);
    const field = { input, error, validate, touched: false };

    function update() {
        const message = validate(input);
        input.setAttribute("aria-invalid", String(Boolean(message)));
        error.textContent = message;
        error.hidden = !message;
        return !message;
    }

    input.addEventListener("blur", () => {
        field.touched = true;
        update();
    });
    input.addEventListener("input", () => {
        if (field.touched) update();
    });

    return { ...field, update };
}

const emailField = createField("loginEmail", "loginEmailError", (input) => {
    const value = input.value.trim();
    if (!value) return "Enter your email address.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return "Enter a valid email address, such as name@example.com.";
    }
    return "";
});

const passwordField = createField("loginPassword", "loginPasswordError", (input) => (
    input.value ? "" : "Enter your password."
));

function validateForm() {
    const fields = [emailField, passwordField];
    fields.forEach((field) => { field.touched = true; });
    const firstInvalid = fields.find((field) => !field.update());
    if (firstInvalid) {
        firstInvalid.input.focus();
        return false;
    }
    return true;
}

googleLoginBtn.addEventListener("click", async () => {
    setMessage("");
    googleLoginBtn.disabled = true;
    googleLoginBtn.setAttribute("aria-busy", "true");
    googleLoginLabel.textContent = "Signing in with Google…";
    try {
        await loginWithGoogle();
        setMessage("Signed in with Google. Redirecting…");
        window.location.href = "dcf-calculator.html";
    } catch (error) {
        const code = error?.code || "";
        const msg = code === "auth/popup-closed-by-user" ? "Sign-in window closed."
            : code === "auth/cancelled-popup-request" ? "Sign-in cancelled."
            : error?.message || "Google Sign-In failed. Try again.";
        setMessage(`Google Sign-In failed: ${msg}`, true);
    } finally {
        googleLoginBtn.disabled = false;
        googleLoginBtn.removeAttribute("aria-busy");
        googleLoginLabel.textContent = "Sign in with Google";
    }
});

loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("");

    if (!validateForm()) return;

    const email = emailField.input.value.trim();
    const password = passwordField.input.value;
    loginBtn.disabled = true;
    loginBtn.setAttribute("aria-busy", "true");
    loginBtn.textContent = "Logging in…";

    try {
        await loginWithEmail(email, password);
        setMessage("Login successful. Redirecting…");
        window.location.href = "dcf-calculator.html";
    } catch (error) {
        setMessage(`Login failed: ${getUserMessage(error, "login")}`, true);
    } finally {
        loginBtn.disabled = false;
        loginBtn.removeAttribute("aria-busy");
        loginBtn.textContent = "Login";
    }
});
