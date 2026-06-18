/* Resume service worker — makes the app installable + bootable offline.
   Strategy:
   - HTML navigations: network-first (so new deploys are never stale), falling
     back to the cached shell when offline.
   - Same-origin assets (icons, manifest): cache-first.
   - CDN libraries (React / Babel / Supabase JS): stale-while-revalidate so the
     app can boot without a network after the first load.
   - Supabase API / realtime: never intercepted — always hits the network. */
const CACHE = 'resume-v2';
const SHELL = [
  '/', '/index.html', '/manifest.webmanifest',
  '/icon-192.png', '/icon-512.png', '/icon-512-maskable.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }

  // Never touch Supabase (data + realtime) — always go straight to the network.
  if (url.hostname.endsWith('supabase.co')) return;

  // HTML navigations → network-first.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/index.html', copy)); return res; })
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // Same-origin static files → cache-first.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
      }))
    );
    return;
  }

  // CDN libraries → stale-while-revalidate (boot offline after first load).
  if (/cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
