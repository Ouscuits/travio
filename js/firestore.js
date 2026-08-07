/* ── Firestore CRUD ── */

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

/* ── USERS ── */
async function fsGetUsers() {
    const snap = await db.collection('users').orderBy('displayName').get();
    return snap.docs.map(d => ({ uid: d.id, ...d.data() }));
}

async function fsGetUser(uid) {
    const doc = await db.collection('users').doc(uid).get();
    return doc.exists ? { uid: doc.id, ...doc.data() } : null;
}

async function fsCreateUser(email, password, displayName, role, language) {
    const secAuth = getSecondaryAuth();
    const cred = await secAuth.createUserWithEmailAndPassword(email, password);
    const uid = cred.user.uid;
    await secAuth.signOut();
    await db.collection('users').doc(uid).set({
        email, displayName, role, password, language,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        createdBy: auth.currentUser ? auth.currentUser.uid : 'setup'
    });
    return uid;
}

async function fsUpdateUser(uid, data) {
    await db.collection('users').doc(uid).update(data);
}

async function fsDeleteUser(uid) {
    await db.collection('users').doc(uid).delete();
}

function fsResetPassword(email) {
    return auth.sendPasswordResetEmail(email);
}

/* ── COUNTRY SCOPE (per user, alongside `language`) ──
   Stored on the user document as an array of lower-case ISO 3166-1 alpha-2 codes.
   ABSENT MEANS EMPTY, NEVER A GUESS: every user document written before this field
   existed has no scope, and the honest reading of that is "no country filter" — the
   behaviour those users already had. Anything else would silently narrow their next
   search. The read normalises through the geo provider, so a hand-edited document
   cannot inject a value the request builder would refuse. */
async function fsGetUserScope(uid) {
    const doc = await db.collection('users').doc(uid).get();
    const raw = doc.exists ? doc.data().countryScope : null;
    return (typeof normaliseCountries === 'function') ? normaliseCountries(raw)
        : (Array.isArray(raw) ? raw : []);
}

async function fsSetUserScope(uid, codes) {
    const clean = (typeof normaliseCountries === 'function') ? normaliseCountries(codes)
        : (Array.isArray(codes) ? codes : []);
    await db.collection('users').doc(uid).update({ countryScope: clean });
    return clean;
}

/* ── ROUTES ── */
async function fsGetUserRoutes(userId) {
    const snap = await db.collection('routes')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function fsSaveRoute(routeData) {
    const ref = await db.collection('routes').add({
        ...routeData,
        userId: currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    return ref.id;
}

async function fsDeleteRoute(routeId) {
    await db.collection('routes').doc(routeId).delete();
}

async function fsGetAllRoutes() {
    const snap = await db.collection('routes').orderBy('createdAt', 'desc').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}
