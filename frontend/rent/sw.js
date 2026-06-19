/**
 * PWA előkészítés – offline cache váz (nem telepíthető alkalmazás még).
 * Későbbi Operatív Navigator mobil használathoz.
 */
var CACHE_NAME = 'opnav-rent-v7';
var PRECACHE = [
  '/rent/public',
  '/rent/admin',
  '/rent/booking_storage.js',
  '/rent/manifest.webmanifest'
];

function isRentAppRequest(url) {
  return /\.(html|js|webmanifest)$/.test(url.pathname)
    || url.pathname === '/rent/public'
    || url.pathname === '/rent/admin'
    || url.pathname.endsWith('/');
}

function cacheableResponse(response) {
  return response && response.ok && response.type === 'basic';
}

function putInCache(request, response) {
  if (!cacheableResponse(response)) return;
  try {
    return caches.open(CACHE_NAME).then(function (cache) {
      return cache.put(request, response.clone());
    });
  } catch (e) {
    return Promise.resolve();
  }
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE).catch(function () { /* hálózat nélkül is települ */ });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE_NAME; }).map(function (k) {
        return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);

  if (url.pathname.indexOf('/api/') === 0) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (isRentAppRequest(url)) {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          event.waitUntil(putInCache(event.request, response));
          return response;
        })
        .catch(function () {
          return caches.match(event.request);
        })
    );
    return;
  }

  event.respondWith(fetch(event.request));
});
