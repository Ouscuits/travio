/* ── Firebase Configuration ── */
const firebaseConfig = {
    apiKey: "AIzaSyDIqqHL27Y7BI5mej1NChNuRuoa0ZJQw70",
    authDomain: "travio-planner-app.firebaseapp.com",
    projectId: "travio-planner-app",
    storageBucket: "travio-planner-app.firebasestorage.app",
    messagingSenderId: "148133228704",
    appId: "1:148133228704:web:f40ccb918e670ffbed59c5"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db   = firebase.firestore();

/* Secondary auth instance for admin user creation (avoids logging out admin) */
let _secondaryApp = null;
function getSecondaryAuth() {
    if (!_secondaryApp) {
        _secondaryApp = firebase.initializeApp(firebaseConfig, 'secondary');
    }
    return _secondaryApp.auth();
}
