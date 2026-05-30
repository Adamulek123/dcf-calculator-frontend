import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, connectAuthEmulator } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";

// Firebase client config is intentionally public — it is NOT a secret.
// Per Firebase documentation, these values identify the app to Firebase services
// and are safe to include in client-side code. Security is enforced via
// Firebase Security Rules and server-side token verification.
const firebaseConfig = {
    apiKey: "AIzaSyAuu1xiRsjARyIGNZyjHna9HsCqhrbPb74",
    authDomain: "dcf123-b6cb1.firebaseapp.com",
    projectId: "dcf123-b6cb1",
    storageBucket: "dcf123-b6cb1.firebasestorage.app",
    messagingSenderId: "274138479558",
    appId: "1:274138479558:web:403e8f3f3c44bd754ed0c7",
    measurementId: "G-FTJT1KSKL4"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

const isLocalHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
if (isLocalHost && !auth.emulatorConfig) {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
}

export { firebaseApp, auth, firebaseConfig };
