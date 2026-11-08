// Offline shell: network first (always fresh when the server is up), cache when it isn't.
const CACHE = 'nine-thousand-v14';
const SHELL = ['/', '/index.html', '/eye.html', '/monitor.html', '/base.css', '/shared.js', '/protocol.js', '/chat.js', '/uis.js', '/displays.js', '/dashboard.html', '/manifest.webmanifest', '/icons/icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache cross-origin collectors, auth redirects, or runtime telemetry configuration.
  if (url.origin !== self.location.origin || e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/qr') || url.pathname.startsWith('/auth/')) return;
  const key = url.pathname === '/eye' || url.pathname === '/monitor' ? url.pathname + '.html' : e.request;
  e.respondWith(caches.open(CACHE).then(async c => {
    try {
      const r = await fetch(e.request);
      if (r.ok) c.put(key, r.clone());
      return r;
    } catch {
      return (await c.match(key, { ignoreSearch: true })) || Response.error();
    }
  }));
});
