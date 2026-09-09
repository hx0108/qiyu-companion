'use strict';
const SHELL = 'qiyu-shell-v1';
const ASSETS = ['/', '/app.js', '/encrypted-session.js', '/styles.css', '/prototype-restoration.css', '/tokens.css', '/favicon.svg'];
self.addEventListener('install', (event) => event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(ASSETS))));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key))))));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/') || url.pathname.includes('media-assets')) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('栖语有一条账户通知', { body: '打开栖语后查看详情。', tag: 'qiyu-private-notice', renotify: false }));
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(clients.openWindow('/')); });
