import { registerWithEmail, getUserMessage } from "./auth.js";
import { runAuthGuard } from "./auth-guard.js";

runAuthGuard();

const registerForm = document.getElementById("registerForm");
const registerBtn = document.getElementById("registerBtn");
const messageEl = document.getElementById("registerMessage");

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

const emailField = createField("registerEmail", "registerEmailError", (input) => {
    const value = input.value.trim();
    if (!value) return "Enter your email address.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return "Enter a valid email address, such as name@example.com.";
    }
    return "";
});

const passwordField = createField("registerPassword", "registerPasswordError", (input) => {
    if (!input.value) return "Create a password to continue.";
    if (input.value.length < 6) return "Use at least 6 characters for your password.";
    return "";
});

function resetValidation() {
    [emailField, passwordField].forEach((field) => {
        field.touched = false;
        field.input.setAttribute("aria-invalid", "false");
        field.error.textContent = "";
        field.error.hidden = true;
    });
}

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

registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setMessage("");

    if (!validateForm()) return;

    const email = emailField.input.value.trim();
    const password = passwordField.input.value;
    registerBtn.disabled = true;
    registerBtn.setAttribute("aria-busy", "true");
    registerBtn.textContent = "Creating account…";

    try {
        await registerWithEmail(email, password);
        setMessage("Registration successful. Verify your email, then sign in.");
        registerForm.reset();
        resetValidation();
    } catch (error) {
        setMessage(`Registration failed: ${getUserMessage(error, "register")}`, true);
    } finally {
        registerBtn.disabled = false;
        registerBtn.removeAttribute("aria-busy");
        registerBtn.textContent = "Create account";
    }
});
