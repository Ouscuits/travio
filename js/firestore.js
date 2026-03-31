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
