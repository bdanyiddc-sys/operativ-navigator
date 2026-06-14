/* Operativ Navigator Driver PWA – /driver/ scope */
var CACHE_NAME = 'opnav-driver-v4';
var LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
var LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

var APP_SHELL = [
    './',
    './index.html',
    './manifest.json',
    './kn_engine.html',
    './service-worker.js',
    '../opnav-config.js',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
    LEAFLET_CSS,
    LEAFLET_JS
];

function shellUrl(path) {
    return new URL(path, self.location.href).href;
}

function isAppShellRequest(url) {
    var href = url.href;
    return APP_SHELL.some(function (entry) {
        return shellUrl(entry) === href;
    });
}

function cachePut(request, response) {
    if (!response || !response.ok) return;
    caches.open(CACHE_NAME).then(function (cache) {
        cache.put(request, response.clone());
    });
}

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) {
                return Promise.all(
                    APP_SHELL.map(function (entry) {
                        return cache.add(entry).catch(function (err) {
                            console.warn('[OpNav SW] cache skip:', entry, err);
                        });
                    })
                );
            })
            .then(function () { return self.skipWaiting(); })
    );
});

self.addEventListener('activate', function (event) {
    event.waitUntil(
        caches.keys()
            .then(function (keys) {
                return Promise.all(
                    keys.filter(function (k) { return k !== CACHE_NAME; })
                        .map(function (k) { return caches.delete(k); })
                );
            })
            .then(function () { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', function (event) {
    if (event.request.method !== 'GET') return;

    var url = new URL(event.request.url);

    if (event.request.mode === 'navigate') {
        event.respondWith(
            fetch(event.request)
                .then(function (response) {
                    cachePut(event.request, response);
                    return response;
                })
                .catch(function () {
                    return caches.match('./index.html')
                        || caches.match('./')
                        || caches.match('/driver/index.html');
                })
        );
        return;
    }

    if (url.href.indexOf('unpkg.com/leaflet@1.9.4/dist/') >= 0) {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                return cached || fetch(event.request).then(function (response) {
                    cachePut(event.request, response);
                    return response;
                });
            })
        );
        return;
    }

    if (url.origin !== self.location.origin) return;

    if (isAppShellRequest(url)) {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                var networkFetch = fetch(event.request)
                    .then(function (response) {
                        cachePut(event.request, response);
                        return response;
                    })
                    .catch(function () { return cached; });
                return cached || networkFetch;
            })
        );
        return;
    }

    if (
        url.pathname.indexOf('/driver/') >= 0 && (
            url.pathname.endsWith('.geojson') ||
            url.pathname.endsWith('.json') ||
            url.pathname.endsWith('.png') ||
            url.pathname.endsWith('.mp3') ||
            url.pathname.endsWith('.html')
        )
    ) {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                return fetch(event.request)
                    .then(function (response) {
                        cachePut(event.request, response);
                        return response;
                    })
                    .catch(function () { return cached; });
            })
        );
    }
});
