/* Operativ Navigator Driver PWA – /driver/ scope */
var CACHE_NAME = 'opnav-driver-v1';
var LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
var LEAFLET_JS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

var APP_SHELL = [
    '/driver/',
    '/driver/index.html',
    '/driver/kn_engine.html',
    '/manifest.json',
    '/driver/icons/icon-192.png',
    '/driver/icons/icon-512.png',
    LEAFLET_CSS,
    LEAFLET_JS
];

function shellUrl(path) {
    return new URL(path, self.location.origin).href;
}

function isAppShellRequest(url) {
    var href = url.href;
    return APP_SHELL.some(function (entry) {
        return shellUrl(entry) === href;
    });
}

self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(function (cache) { return cache.addAll(APP_SHELL); })
            .then(function () { return self.skipWaiting(); })
            .catch(function (err) { console.warn('[OpNav SW] install failed', err); })
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

    if (event.request.mode === 'navigate' && url.pathname.indexOf('/driver') === 0) {
        event.respondWith(
            fetch(event.request)
                .then(function (response) {
                    if (response && response.ok) {
                        caches.open(CACHE_NAME).then(function (cache) {
                            cache.put('/driver/index.html', response.clone());
                        });
                    }
                    return response;
                })
                .catch(function () {
                    return caches.match('/driver/index.html');
                })
        );
        return;
    }

    if (isAppShellRequest(url) || url.href.indexOf('unpkg.com/leaflet@1.9.4/dist/') >= 0) {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                var networkFetch = fetch(event.request)
                    .then(function (response) {
                        if (response && response.ok) {
                            caches.open(CACHE_NAME).then(function (cache) {
                                cache.put(event.request, response.clone());
                            });
                        }
                        return response;
                    })
                    .catch(function () { return cached; });
                return cached || networkFetch;
            })
        );
        return;
    }

    if (url.pathname.indexOf('/driver/') === 0 && (
        url.pathname.endsWith('.geojson') ||
        url.pathname.endsWith('.json') ||
        url.pathname.endsWith('.png') ||
        url.pathname.endsWith('.mp3')
    )) {
        event.respondWith(
            caches.match(event.request).then(function (cached) {
                return fetch(event.request)
                    .then(function (response) {
                        if (response && response.ok) {
                            caches.open(CACHE_NAME).then(function (cache) {
                                cache.put(event.request, response.clone());
                            });
                        }
                        return response;
                    })
                    .catch(function () { return cached; });
            })
        );
    }
});
