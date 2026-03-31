/* ── Internationalization ── */
const TRANSLATIONS = {
    es: {
        app:  { name: 'Travio', tagline: 'Tu companero de viaje', subtitle: 'Planifica, optimiza y disfruta cada kilometro' },
        login: { title: 'Iniciar Sesion', email: 'Correo electronico', password: 'Contrasena', signIn: 'Entrar', signingIn: 'Entrando...', errorRequired: 'Introduce email y contrasena', errorInvalid: 'Email o contrasena incorrectos', errorNoAccount: 'Cuenta no configurada' },
        nav:  { logout: 'Cerrar sesion', admin: 'Admin', savedRoutes: 'Mis Rutas', newRoute: 'Nueva Ruta', welcome: 'Hola' },
        form: {
            title: 'Datos del Viaje',
            startPoint: 'Punto de partida', startPointPh: 'ej: Madrid',
            endPoint: 'Punto final', endPointPh: 'ej: Madrid (viaje circular)',
            destinations: 'Destinos a visitar', destinationsHint: '(separados por comas)', destinationsPh: 'ej: Santiago, Finisterre, A Coruna',
            tripType: 'Tipo de viaje',
            family: 'Familiar', couple: 'En pareja', adventure: 'Aventura', motorcycle: 'En moto',
            duration: 'Duracion (dias)', dailyBudget: 'Presupuesto diario (EUR)',
            advancedOptions: 'Opciones avanzadas', customizeBudget: 'Personalizar presupuesto por dia', day: 'Dia',
            tollPreference: 'Preferencia de peajes', withTolls: 'Con peajes (mas rapido)', withoutTolls: 'Sin peajes (economico/escenico)',
            departureTime: 'Hora de salida',
            generate: 'Generar Ruta con IA', generating: 'Creando tu ruta perfecta...', clear: 'Limpiar',
            required: 'Completa todos los campos obligatorios'
        },
        tripTypeLabel: { familiar: 'familiar', pareja: 'en pareja', aventura: 'aventura', moto: 'en moto' },
        result: {
            title: 'Resultado', saveRoute: 'Guardar Ruta', routeSaved: 'Ruta guardada',
            emptyState: 'Completa el formulario y genera tu ruta para ver los resultados aqui',
            analyzing: 'Analizando la mejor ruta para tu viaje...', waitTime: 'Esto puede tardar 15-30 segundos',
            route: 'Ruta', days: 'dias', budget: 'Presupuesto', error: 'Error al generar la ruta'
        },
        routes: {
            title: 'Mis Rutas Guardadas', noRoutes: 'No tienes rutas guardadas',
            load: 'Ver', delete: 'Eliminar', confirmDelete: 'Eliminar esta ruta?',
            back: 'Volver'
        },
        admin: {
            title: 'Panel de Administracion', users: 'Usuarios',
            createUser: 'Crear Usuario', editUser: 'Editar Usuario',
            name: 'Nombre', email: 'Email', password: 'Contrasena', role: 'Rol',
            roleAdmin: 'Administrador', roleUser: 'Usuario', language: 'Idioma',
            save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar',
            confirmDelete: 'Eliminar este usuario?', resetPwd: 'Restablecer contrasena',
            back: 'Volver', created: 'Usuario creado', updated: 'Usuario actualizado', deleted: 'Usuario eliminado'
        },
        footer: { credit: 'Creado con amor por Travio', tagline: 'Tu companero inteligente de viajes' },
        common: { save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar', confirm: 'Confirmar', error: 'Error', success: 'Exito', loading: 'Cargando...' }
    },
    en: {
        app:  { name: 'Travio', tagline: 'Your trip mate', subtitle: 'Plan, optimize and enjoy every kilometer' },
        login: { title: 'Sign In', email: 'Email', password: 'Password', signIn: 'Sign In', signingIn: 'Signing in...', errorRequired: 'Enter email and password', errorInvalid: 'Invalid email or password', errorNoAccount: 'Account not configured' },
        nav:  { logout: 'Sign out', admin: 'Admin', savedRoutes: 'My Routes', newRoute: 'New Route', welcome: 'Hello' },
        form: {
            title: 'Travel Data',
            startPoint: 'Starting point', startPointPh: 'e.g: London',
            endPoint: 'End point', endPointPh: 'e.g: London (round trip)',
            destinations: 'Destinations to visit', destinationsHint: '(comma separated)', destinationsPh: 'e.g: Edinburgh, Glasgow, Inverness',
            tripType: 'Trip type',
            family: 'Family', couple: 'Couple', adventure: 'Adventure', motorcycle: 'Motorcycle',
            duration: 'Duration (days)', dailyBudget: 'Daily budget (EUR)',
            advancedOptions: 'Advanced options', customizeBudget: 'Customize budget per day', day: 'Day',
            tollPreference: 'Toll preference', withTolls: 'With tolls (faster)', withoutTolls: 'Without tolls (scenic/economical)',
            departureTime: 'Departure time',
            generate: 'Generate Route with AI', generating: 'Creating your perfect route...', clear: 'Clear',
            required: 'Please fill all required fields'
        },
        tripTypeLabel: { familiar: 'family', pareja: 'couple', aventura: 'adventure', moto: 'motorcycle' },
        result: {
            title: 'Result', saveRoute: 'Save Route', routeSaved: 'Route saved',
            emptyState: 'Fill out the form and generate your route to see results here',
            analyzing: 'Analyzing the best route for your trip...', waitTime: 'This may take 15-30 seconds',
            route: 'Route', days: 'days', budget: 'Budget', error: 'Error generating route'
        },
        routes: {
            title: 'My Saved Routes', noRoutes: 'You have no saved routes',
            load: 'View', delete: 'Delete', confirmDelete: 'Delete this route?',
            back: 'Back'
        },
        admin: {
            title: 'Administration Panel', users: 'Users',
            createUser: 'Create User', editUser: 'Edit User',
            name: 'Name', email: 'Email', password: 'Password', role: 'Role',
            roleAdmin: 'Administrator', roleUser: 'User', language: 'Language',
            save: 'Save', cancel: 'Cancel', delete: 'Delete',
            confirmDelete: 'Delete this user?', resetPwd: 'Reset password',
            back: 'Back', created: 'User created', updated: 'User updated', deleted: 'User deleted'
        },
        footer: { credit: 'Made with love by Travio', tagline: 'Your intelligent travel companion' },
        common: { save: 'Save', cancel: 'Cancel', delete: 'Delete', confirm: 'Confirm', error: 'Error', success: 'Success', loading: 'Loading...' }
    },
    ca: {
        app:  { name: 'Travio', tagline: 'El teu company de viatge', subtitle: 'Planifica, optimitza i gaudeix de cada quilometre' },
        login: { title: 'Iniciar Sessio', email: 'Correu electronic', password: 'Contrasenya', signIn: 'Entrar', signingIn: 'Entrant...', errorRequired: 'Introdueix email i contrasenya', errorInvalid: 'Email o contrasenya incorrectes', errorNoAccount: 'Compte no configurat' },
        nav:  { logout: 'Tancar sessio', admin: 'Admin', savedRoutes: 'Les Meves Rutes', newRoute: 'Nova Ruta', welcome: 'Hola' },
        form: {
            title: 'Dades del Viatge',
            startPoint: 'Punt de partida', startPointPh: 'ex: Barcelona',
            endPoint: 'Punt final', endPointPh: 'ex: Barcelona (viatge circular)',
            destinations: 'Destinacions a visitar', destinationsHint: '(separades per comes)', destinationsPh: 'ex: Girona, Figueres, Cadaques',
            tripType: 'Tipus de viatge',
            family: 'Familiar', couple: 'En parella', adventure: 'Aventura', motorcycle: 'En moto',
            duration: 'Durada (dies)', dailyBudget: 'Pressupost diari (EUR)',
            advancedOptions: 'Opcions avancades', customizeBudget: 'Personalitzar pressupost per dia', day: 'Dia',
            tollPreference: 'Preferencia de peatges', withTolls: 'Amb peatges (mes rapid)', withoutTolls: 'Sense peatges (economic/escenic)',
            departureTime: 'Hora de sortida',
            generate: 'Generar Ruta amb IA', generating: 'Creant la teva ruta perfecta...', clear: 'Netejar',
            required: 'Completa tots els camps obligatoris'
        },
        tripTypeLabel: { familiar: 'familiar', pareja: 'en parella', aventura: 'aventura', moto: 'en moto' },
        result: {
            title: 'Resultat', saveRoute: 'Guardar Ruta', routeSaved: 'Ruta guardada',
            emptyState: 'Completa el formulari i genera la teva ruta per veure els resultats aqui',
            analyzing: 'Analitzant la millor ruta pel teu viatge...', waitTime: 'Aixo pot trigar 15-30 segons',
            route: 'Ruta', days: 'dies', budget: 'Pressupost', error: 'Error al generar la ruta'
        },
        routes: {
            title: 'Les Meves Rutes Guardades', noRoutes: 'No tens rutes guardades',
            load: 'Veure', delete: 'Eliminar', confirmDelete: 'Eliminar aquesta ruta?',
            back: 'Tornar'
        },
        admin: {
            title: 'Panell d\'Administracio', users: 'Usuaris',
            createUser: 'Crear Usuari', editUser: 'Editar Usuari',
            name: 'Nom', email: 'Email', password: 'Contrasenya', role: 'Rol',
            roleAdmin: 'Administrador', roleUser: 'Usuari', language: 'Idioma',
            save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar',
            confirmDelete: 'Eliminar aquest usuari?', resetPwd: 'Restablir contrasenya',
            back: 'Tornar', created: 'Usuari creat', updated: 'Usuari actualitzat', deleted: 'Usuari eliminat'
        },
        footer: { credit: 'Creat amb amor per Travio', tagline: 'El teu company intelligent de viatges' },
        common: { save: 'Guardar', cancel: 'Cancelar', delete: 'Eliminar', confirm: 'Confirmar', error: 'Error', success: 'Exit', loading: 'Carregant...' }
    },
    fr: {
        app:  { name: 'Travio', tagline: 'Votre compagnon de voyage', subtitle: 'Planifiez, optimisez et profitez de chaque kilometre' },
        login: { title: 'Connexion', email: 'Email', password: 'Mot de passe', signIn: 'Se connecter', signingIn: 'Connexion...', errorRequired: 'Entrez email et mot de passe', errorInvalid: 'Email ou mot de passe invalide', errorNoAccount: 'Compte non configure' },
        nav:  { logout: 'Deconnexion', admin: 'Admin', savedRoutes: 'Mes Itineraires', newRoute: 'Nouvel Itineraire', welcome: 'Bonjour' },
        form: {
            title: 'Donnees du Voyage',
            startPoint: 'Point de depart', startPointPh: 'ex: Paris',
            endPoint: 'Point d\'arrivee', endPointPh: 'ex: Paris (voyage circulaire)',
            destinations: 'Destinations a visiter', destinationsHint: '(separees par des virgules)', destinationsPh: 'ex: Lyon, Marseille, Nice',
            tripType: 'Type de voyage',
            family: 'Famille', couple: 'Couple', adventure: 'Aventure', motorcycle: 'Moto',
            duration: 'Duree (jours)', dailyBudget: 'Budget quotidien (EUR)',
            advancedOptions: 'Options avancees', customizeBudget: 'Personnaliser le budget par jour', day: 'Jour',
            tollPreference: 'Preference de peages', withTolls: 'Avec peages (plus rapide)', withoutTolls: 'Sans peages (economique/panoramique)',
            departureTime: 'Heure de depart',
            generate: 'Generer l\'Itineraire avec IA', generating: 'Creation de votre itineraire parfait...', clear: 'Effacer',
            required: 'Remplissez tous les champs obligatoires'
        },
        tripTypeLabel: { familiar: 'famille', pareja: 'couple', aventura: 'aventure', moto: 'moto' },
        result: {
            title: 'Resultat', saveRoute: 'Sauvegarder', routeSaved: 'Itineraire sauvegarde',
            emptyState: 'Remplissez le formulaire et generez votre itineraire pour voir les resultats ici',
            analyzing: 'Analyse du meilleur itineraire pour votre voyage...', waitTime: 'Cela peut prendre 15-30 secondes',
            route: 'Itineraire', days: 'jours', budget: 'Budget', error: 'Erreur lors de la generation'
        },
        routes: {
            title: 'Mes Itineraires Sauvegardes', noRoutes: 'Vous n\'avez aucun itineraire sauvegarde',
            load: 'Voir', delete: 'Supprimer', confirmDelete: 'Supprimer cet itineraire?',
            back: 'Retour'
        },
        admin: {
            title: 'Panneau d\'Administration', users: 'Utilisateurs',
            createUser: 'Creer Utilisateur', editUser: 'Modifier Utilisateur',
            name: 'Nom', email: 'Email', password: 'Mot de passe', role: 'Role',
            roleAdmin: 'Administrateur', roleUser: 'Utilisateur', language: 'Langue',
            save: 'Sauvegarder', cancel: 'Annuler', delete: 'Supprimer',
            confirmDelete: 'Supprimer cet utilisateur?', resetPwd: 'Reinitialiser le mot de passe',
            back: 'Retour', created: 'Utilisateur cree', updated: 'Utilisateur mis a jour', deleted: 'Utilisateur supprime'
        },
        footer: { credit: 'Cree avec amour par Travio', tagline: 'Votre compagnon de voyage intelligent' },
        common: { save: 'Sauvegarder', cancel: 'Annuler', delete: 'Supprimer', confirm: 'Confirmer', error: 'Erreur', success: 'Succes', loading: 'Chargement...' }
    },
    zh: {
        app:  { name: 'Travio', tagline: '您的旅行伙伴', subtitle: '规划、优化并享受每一公里' },
        login: { title: '登录', email: '电子邮件', password: '密码', signIn: '登录', signingIn: '登录中...', errorRequired: '请输入邮箱和密码', errorInvalid: '邮箱或密码无效', errorNoAccount: '账户未配置' },
        nav:  { logout: '退出', admin: '管理', savedRoutes: '我的路线', newRoute: '新路线', welcome: '你好' },
        form: {
            title: '旅行数据',
            startPoint: '出发点', startPointPh: '例如：北京',
            endPoint: '终点', endPointPh: '例如：北京（环形旅行）',
            destinations: '要访问的目的地', destinationsHint: '（用逗号分隔）', destinationsPh: '例如：上海、杭州、苏州',
            tripType: '旅行类型',
            family: '家庭', couple: '情侣', adventure: '冒险', motorcycle: '摩托车',
            duration: '持续时间（天）', dailyBudget: '每日预算（EUR）',
            advancedOptions: '高级选项', customizeBudget: '自定义每日预算', day: '第',
            tollPreference: '收费偏好', withTolls: '使用收费公路（更快）', withoutTolls: '避免收费（经济/风景）',
            departureTime: '出发时间',
            generate: '使用AI生成路线', generating: '正在创建您的完美路线...', clear: '清除',
            required: '请填写所有必填字段'
        },
        tripTypeLabel: { familiar: '家庭', pareja: '情侣', aventura: '冒险', moto: '摩托车' },
        result: {
            title: '结果', saveRoute: '保存路线', routeSaved: '路线已保存',
            emptyState: '填写表格并生成路线以在此处查看结果',
            analyzing: '正在分析您旅行的最佳路线...', waitTime: '这可能需要15-30秒',
            route: '路线', days: '天', budget: '预算', error: '生成路线时出错'
        },
        routes: {
            title: '我的已保存路线', noRoutes: '您没有已保存的路线',
            load: '查看', delete: '删除', confirmDelete: '删除此路线？',
            back: '返回'
        },
        admin: {
            title: '管理面板', users: '用户',
            createUser: '创建用户', editUser: '编辑用户',
            name: '姓名', email: '邮箱', password: '密码', role: '角色',
            roleAdmin: '管理员', roleUser: '用户', language: '语言',
            save: '保存', cancel: '取消', delete: '删除',
            confirmDelete: '删除此用户？', resetPwd: '重置密码',
            back: '返回', created: '用户已创建', updated: '用户已更新', deleted: '用户已删除'
        },
        footer: { credit: '由Travio用心制作', tagline: '您的智能旅行伙伴' },
        common: { save: '保存', cancel: '取消', delete: '删除', confirm: '确认', error: '错误', success: '成功', loading: '加载中...' }
    }
};

let currentLang = localStorage.getItem('travio-lang') || 'es';

/** Dot-notation key lookup: t('form.startPoint') */
function t(key) {
    const parts = key.split('.');
    let val = TRANSLATIONS[currentLang];
    for (const p of parts) {
        if (!val || val[p] === undefined) {
            // Fallback to English
            val = TRANSLATIONS.en;
            for (const fp of parts) { if (val) val = val[fp]; }
            return val || key;
        }
        val = val[p];
    }
    return val || key;
}

/** Switch language, persist, and re-render */
function setLanguage(lang) {
    if (!TRANSLATIONS[lang]) return;
    currentLang = lang;
    localStorage.setItem('travio-lang', lang);
    applyTranslations();
    // Update language selector if present
    const sel = document.getElementById('langSelect');
    if (sel) sel.value = lang;
    const selLogin = document.getElementById('langSelectLogin');
    if (selLogin) selLogin.value = lang;
}

/** Re-render all [data-i18n] elements in visible DOM */
function applyTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        const translated = t(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = translated;
        } else if (el.tagName === 'OPTION') {
            el.textContent = translated;
        } else {
            el.textContent = translated;
        }
    });
}
