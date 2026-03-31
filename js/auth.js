/* ── Auth & Navigation (MUST LOAD LAST) ── */
let currentUser = null;

/* ── View System ── */
function showView(viewId) {
    ['loginView', 'userHomeView', 'savedRoutesView', 'adminView'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = (id === viewId) ? '' : 'none';
    });
}

/* ── Auth State ── */
auth.onAuthStateChanged(async (user) => {
    if (user) {
        try {
            const userDoc = await db.collection('users').doc(user.uid).get();
            if (!userDoc.exists) {
                showLoginError(t('login.errorNoAccount'));
                await auth.signOut();
                return;
            }
            const data = userDoc.data();
            currentUser = {
                uid: user.uid,
                email: data.email || user.email,
                displayName: data.displayName || user.email,
                role: data.role || 'user',
                language: data.language || 'es'
            };
            if (currentUser.language !== currentLang) {
                setLanguage(currentUser.language);
            }
            showUserHome();
        } catch (e) {
            console.error('Auth error:', e);
            showLoginError(t('login.errorInvalid'));
            await auth.signOut();
        }
    } else {
        currentUser = null;
        showView('loginView');
        applyTranslations();
    }
});

/* ── Login ── */
async function doLogin() {
    const email = document.getElementById('loginEmail').value.trim();
    const pwd   = document.getElementById('loginPassword').value;
    const btn   = document.getElementById('loginBtn');

    if (!email || !pwd) { showLoginError(t('login.errorRequired')); return; }

    btn.disabled = true;
    btn.textContent = t('login.signingIn');
    hideLoginError();

    try {
        await auth.signInWithEmailAndPassword(email, pwd);
    } catch (e) {
        console.error('Login error:', e);
        showLoginError(t('login.errorInvalid'));
        btn.disabled = false;
        btn.textContent = t('login.signIn');
    }
}

function doLogout() {
    auth.signOut();
}

function showLoginError(msg) {
    const el = document.getElementById('loginError');
    if (el) { el.textContent = msg; el.style.display = ''; }
}
function hideLoginError() {
    const el = document.getElementById('loginError');
    if (el) el.style.display = 'none';
}

/* ── User Home ── */
function showUserHome() {
    showView('userHomeView');
    // Header
    const nameEl = document.getElementById('homeUserName');
    if (nameEl) nameEl.textContent = currentUser.displayName;
    // Admin button
    const adminBtn = document.getElementById('homeAdminBtn');
    if (adminBtn) adminBtn.style.display = currentUser.role === 'admin' ? '' : 'none';
    // Init form
    initRouteForm();
    // Reset result area
    const empty = document.getElementById('resultEmpty');
    if (empty && !currentRoute) empty.style.display = '';
    applyTranslations();
}

/* ── Saved Routes View ── */
async function showSavedRoutes() {
    showView('savedRoutesView');
    await loadSavedRoutesList();
    applyTranslations();
}

function backToHome() {
    showView('userHomeView');
    applyTranslations();
}

/* ═══════════════════════════════════════
   ADMIN PANEL
   ═══════════════════════════════════════ */
let adminUsers = [];
let editingUserId = null;

function showAdminPanel() {
    if (!currentUser || currentUser.role !== 'admin') return;
    showView('adminView');
    loadAdminUsers();
    applyTranslations();
}

async function loadAdminUsers() {
    const tbody = document.getElementById('adminUsersBody');
    if (!tbody) return;
    try {
        adminUsers = await fsGetUsers();
        tbody.innerHTML = adminUsers.map(u => `<tr>
            <td>${escapeHtml(u.displayName || '')}</td>
            <td>${escapeHtml(u.email || '')}</td>
            <td><span class="role-badge role-${u.role}">${t('admin.role' + (u.role === 'admin' ? 'Admin' : 'User'))}</span></td>
            <td>${u.language || 'es'}</td>
            <td class="actions-cell">
                <button class="btn btn-sm btn-outline" onclick="showEditUser('${u.uid}')">${t('admin.editUser')}</button>
                ${u.uid !== currentUser.uid ? `<button class="btn btn-sm btn-ghost" onclick="adminDeleteUser('${u.uid}')">${t('admin.delete')}</button>` : ''}
            </td>
        </tr>`).join('');
    } catch (e) {
        console.error('Load users error:', e);
    }
}

function showCreateUserForm() {
    editingUserId = null;
    document.getElementById('userFormTitle').textContent = t('admin.createUser');
    document.getElementById('ufName').value = '';
    document.getElementById('ufEmail').value = '';
    document.getElementById('ufPassword').value = '';
    document.getElementById('ufPassword').disabled = false;
    document.getElementById('ufRole').value = 'user';
    document.getElementById('ufLanguage').value = 'es';
    document.getElementById('userFormModal').style.display = '';
    document.getElementById('userFormMsg').style.display = 'none';
}

function showEditUser(uid) {
    const u = adminUsers.find(x => x.uid === uid);
    if (!u) return;
    editingUserId = uid;
    document.getElementById('userFormTitle').textContent = t('admin.editUser');
    document.getElementById('ufName').value = u.displayName || '';
    document.getElementById('ufEmail').value = u.email || '';
    document.getElementById('ufPassword').value = '';
    document.getElementById('ufPassword').disabled = true;
    document.getElementById('ufRole').value = u.role || 'user';
    document.getElementById('ufLanguage').value = u.language || 'es';
    document.getElementById('userFormModal').style.display = '';
    document.getElementById('userFormMsg').style.display = 'none';
}

function hideUserForm() {
    document.getElementById('userFormModal').style.display = 'none';
    editingUserId = null;
}

async function saveUserForm() {
    const name  = document.getElementById('ufName').value.trim();
    const email = document.getElementById('ufEmail').value.trim();
    const pwd   = document.getElementById('ufPassword').value;
    const role  = document.getElementById('ufRole').value;
    const lang  = document.getElementById('ufLanguage').value;
    const msgEl = document.getElementById('userFormMsg');

    if (!name || !email) {
        msgEl.textContent = t('login.errorRequired');
        msgEl.className = 'form-msg err';
        msgEl.style.display = '';
        return;
    }

    try {
        if (editingUserId) {
            await fsUpdateUser(editingUserId, { displayName: name, role, language: lang });
            msgEl.textContent = t('admin.updated');
        } else {
            if (!pwd || pwd.length < 6) {
                msgEl.textContent = t('login.errorRequired');
                msgEl.className = 'form-msg err';
                msgEl.style.display = '';
                return;
            }
            await fsCreateUser(email, pwd, name, role, lang);
            msgEl.textContent = t('admin.created');
        }
        msgEl.className = 'form-msg ok';
        msgEl.style.display = '';
        await loadAdminUsers();
        setTimeout(hideUserForm, 1200);
    } catch (e) {
        console.error('Save user error:', e);
        msgEl.textContent = e.message;
        msgEl.className = 'form-msg err';
        msgEl.style.display = '';
    }
}

async function adminDeleteUser(uid) {
    if (!confirm(t('admin.confirmDelete'))) return;
    try {
        await fsDeleteUser(uid);
        await loadAdminUsers();
    } catch (e) {
        console.error('Delete user error:', e);
    }
}

async function adminResetPwd(email) {
    try {
        await fsResetPassword(email);
        alert(t('admin.resetPwd') + ' OK');
    } catch (e) {
        console.error('Reset pwd error:', e);
    }
}

function adminBack() {
    showView('userHomeView');
    applyTranslations();
}

/* ── Enter key on login fields ── */
document.addEventListener('DOMContentLoaded', () => {
    const pwdField = document.getElementById('loginPassword');
    if (pwdField) {
        pwdField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });
    }
    const emailField = document.getElementById('loginEmail');
    if (emailField) {
        emailField.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') doLogin();
        });
    }
});
