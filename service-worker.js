// Service Worker for Travio PWA
const CACHE_NAME = 'travio-v2';
const urlsToCache = [
    './',
    'index.html',
    'manifest.json',
    'fonts/fonts.css',
    'vendor/firebase-app-compat.js',
    'vendor/firebase-auth-compat.js',
    'vendor/firebase-firestore-compat.js',
    'js/firebase-config.js',
    'js/i18n.js',
    'js/firestore.js',
    'js/route-form.js',
    'js/auth.js',
    'icon-192.png'
];

// Install
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(urlsToCache))
    );
});

// Activate — clear old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
        )
    );
});

// Fetch — Network First, fallback to cache
self.addEventListener('fetch', (event) => {
    // Skip non-GET and external API calls
    if (event.request.method !== 'GET') return;
    const url = event.request.url;
    if (url.includes('firestore.googleapis.com') ||
        url.includes('identitytoolkit.googleapis.com') ||
        url.includes('workers.dev')) return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                if (response && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
