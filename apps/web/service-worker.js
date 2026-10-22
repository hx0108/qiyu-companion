'use strict';
const SHELL = 'qiyu-shell-v32-apricot';
const ASSETS = ['/character-appearance.js', '/assets/portraits/male-01.png', '/assets/portraits/male-02.png', '/assets/portraits/male-03.png', '/assets/portraits/female-01.png', '/assets/portraits/female-02.png', '/assets/portraits/female-03.png', '/', '/app.js', '/call-client.js', '/realtime-call-client.js', '/encrypted-session.js', '/media-input.js', '/styles.css', '/prototype-restoration.css', '/tokens.css', '/favicon.svg', '/assets/player-play-filled.svg', '/assets/player-pause-filled.svg'];
ASSETS.push('/realtime-call-client.js?v=20261021-polish-v25', '/apricot-ui.js?v=20261021-chat-menu-v32', '/apricot.css?v=20261021-chat-menu-v32', '/memory-panel.js', '/companion-cards.js', '/assets/apricot-reference.png?v=20261020-ui-v23');
self.addEventListener('install', (event) => event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', (event) => event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== SHELL).map((key) => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/internal/') || url.pathname.includes('media-assets')) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) caches.open(SHELL).then((cache) => cache.put(event.request, response.clone()));
    return response;
  }).catch(() => caches.match(event.request)));
});
self.addEventListener('push', (event) => {
  event.waitUntil(self.registration.showNotification('栖语有一条账户通知', { body: '打开栖语后查看详情。', tag: 'qiyu-private-notice', renotify: false }));
});
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(clients.openWindow('/')); });
