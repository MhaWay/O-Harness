// O-Harness service worker: offline shell for the HTML, cache-fallback for UI assets.
// Nothing from /api, /pair, /login or /health is ever cached - no credential/live state replay.
var SHELL = 'o-harness-shell-v1';
var CORE = ['/', '/m', '/assets/style.css', '/assets/app.js', '/assets/mobile.js', '/assets/client.js', '/icon.svg', '/manifest.webmanifest'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return Promise.all(CORE.map(function (u) { return c.add(u); }));
  }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== SHELL; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) { return; }
  var p = url.pathname;
  if (p.indexOf('/api') === 0 || p === '/health' || p === '/pair' || p === '/login') { return; }
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then(function (r) {
      var copy = r.clone();
      caches.open(SHELL).then(function (c) { c.put('/m', copy); });
      return r;
    }, function () { return caches.match('/m'); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) {
    return fetch(e.request).then(function (r) {
      var copy = r.clone();
      caches.open(SHELL).then(function (c) { c.put(e.request, copy); });
      return r;
    }, function () { return hit; });
  }));
});
