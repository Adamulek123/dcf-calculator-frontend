import {
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    sendEmailVerification,
    signOut,
    onAuthStateChanged,
    GoogleAuthProvider,
    signInWithPopup
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { auth } from "./firebase-init.js";
import { clearPrivateUserData } from "./data-store.js";

function getUserMessage(error, mode) {
    if (!error || !error.code) {
        return mode === "login" ? "Login failed." : "Registration failed.";
    }

    const authErrorMap = {
        "auth/user-not-found": "Invalid email or password.",
        "auth/wrong-password": "Invalid email or password.",
        "auth/invalid-credential": "Invalid email or password.",
        "auth/invalid-email": "Invalid email format.",
        "auth/email-already-in-use": "This email is already in use.",
        "auth/weak-password": "Password is too weak (min 6 characters)."
    };

    return authErrorMap[error.code] || error.message || (mode === "login" ? "Login failed." : "Registration failed.");
}

function isVerifiedUser(user) {
    if (!user) {
        return false;
    }

    const providerId = user.providerData?.[0]?.providerId;
    return user.emailVerified || providerId === "google.com";
}

async function loginWithEmail(email, password) {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;

    if (!isVerifiedUser(user)) {
        await signOut(auth);
        const err = new Error("Please verify your email address before logging in.");
        err.code = "auth/email-not-verified";
        throw err;
    }

    return userCredential;
}

async function registerWithEmail(email, password) {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(userCredential.user);
    return userCredential;
}

async function loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    return result;
}

async function logoutUser() {
    const uid = auth.currentUser?.uid;
    if (uid) {
        try {
            await clearPrivateUserData(uid);
        } catch (error) {
            // Ending the server-backed session remains mandatory even if browser
            // storage is unavailable. In-memory entries are cleared first by the store.
            console.warn("Unable to fully clear private browser data during logout", error);
        }
    }
    return signOut(auth);
}

function observeAuthState(callback) {
    return onAuthStateChanged(auth, callback);
}

export {
    auth,
    getUserMessage,
    isVerifiedUser,
    loginWithEmail,
    loginWithGoogle,
    registerWithEmail,
    logoutUser,
    observeAuthState
};
