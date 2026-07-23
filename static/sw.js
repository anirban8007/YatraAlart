// YatraAlart Service Worker
// Keeps the app alive in background for GPS tracking

const CACHE_NAME = 'yatraalart-v1';
const STATIC_ASSETS = [
    '/',
    '/static/app.js',
    '/static/style.css',
    '/static/tracking.js',
    '/static/offline.js'
];

// ── Install: cache static assets ──────────────────────────────
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => {
            console.log('SW: caching app shell');
            return cache.addAll(STATIC_ASSETS).catch(err => {
                // Non-fatal — app still works without cache
                console.warn('SW: cache addAll failed:', err);
            });
        })
    );
    self.skipWaiting();
});

// ── Activate: clean old caches ─────────────────────────────────
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            )
        )
    );
    self.clients.claim();
});

// ── Fetch: network first, cache fallback ───────────────────────
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // Always go network-first for API calls
    if (url.pathname.startsWith('/check') ||
        url.pathname.startsWith('/directions') ||
        url.pathname.startsWith('/sos') ||
        url.pathname.startsWith('/suggestions') ||
        url.pathname.startsWith('/track')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Network first, fall back to cache for static assets
    event.respondWith(
        fetch(event.request)
            .then(response => {
                // Cache successful GET responses
                if (event.request.method === 'GET' && response.status === 200) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});

// ── Background sync message from main thread ───────────────────
self.addEventListener('message', event => {
    if (event.data === 'KEEP_ALIVE') {
        // Respond to keep-alive ping from main thread
        event.ports[0]?.postMessage('ALIVE');
    }
});
