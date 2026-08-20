// Beacon service worker.
//
// Strategy:
//   • Cache-first for /app/* static assets (the Vite-built SPA bundle).
//   • Network-first for /api/* with a no-cache passthrough; on offline,
//     a JSON envelope `{ offline: true }` is returned so callers can
//     detect the state without parser explosions.
//   • Navigation fallback: when the browser asks for /app/* and we're
//     offline, serve the offline.html shell so the user sees a clean
//     "reconnecting…" screen instead of a Chrome dino.
//   • Push: incoming push event renders a notification with the payload
//     we sent server-side (title/body/url/tag).
//   • Notification click: focuses an existing tab at the deep-link URL
//     or opens a new one.
//
// Cache version. Bump on every breaking SW change so old caches get
// purged on the next activate. Use a short prefix so `caches.keys()` can
// scan + delete leftovers easily.
const CACHE_PREFIX = 'beacon-';
const STATIC_CACHE = CACHE_PREFIX + 'static-v1';
const RUNTIME_CACHE = CACHE_PREFIX + 'runtime-v1';

// Minimal app-shell pre-cache. Vite-hashed assets get cached on first
// fetch via the runtime cache — pre-caching everything is wasteful when
// the bundle is content-hashed.
const APP_SHELL = [
  '/app/',
  '/offline.html',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // addAll is atomic — one missing entry fails the whole install. We
    // tolerate that (the SW just won't activate until a redeploy fixes
    // the missing asset).
    try { await cache.addAll(APP_SHELL); } catch (_) { /* tolerate */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      if (k.startsWith(CACHE_PREFIX) && k !== STATIC_CACHE && k !== RUNTIME_CACHE) {
        return caches.delete(k);
      }
      return null;
    }));
    await self.clients.claim();
  })());
});

// ── Fetch strategy ─────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Same-origin only — cross-origin (fonts, CDNs) bypasses entirely so we
  // don't accidentally cache opaque responses.
  if (url.origin !== self.location.origin) return;

  // API: network-first, never cache.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        return new Response(
          JSON.stringify({ offline: true, error: 'network unavailable' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } },
        );
      }
    })());
    return;
  }

  // Navigations to /app/* — network-first with offline fallback.
  if (req.mode === 'navigate' && url.pathname.startsWith('/app')) {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        // Cache the app shell response so subsequent loads hydrate offline.
        const cache = await caches.open(RUNTIME_CACHE);
        cache.put('/app/', fresh.clone()).catch(() => {});
        return fresh;
      } catch (_) {
        const cache = await caches.open(STATIC_CACHE);
        const cached = await cache.match('/offline.html');
        return cached || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Static assets — cache-first.
  if (
    url.pathname.startsWith('/app/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.json' ||
    /\.(?:js|css|woff2?|png|svg|ico|webp|jpg|jpeg)$/i.test(url.pathname)
  ) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) {
        // Refresh in background — keep the cache warm without blocking.
        fetch(req).then((resp) => {
          if (resp && resp.ok) {
            caches.open(RUNTIME_CACHE).then((c) => c.put(req, resp.clone())).catch(() => {});
          }
        }).catch(() => {});
        return cached;
      }
      try {
        const resp = await fetch(req);
        if (resp && resp.ok) {
          const cache = await caches.open(RUNTIME_CACHE);
          cache.put(req, resp.clone()).catch(() => {});
        }
        return resp;
      } catch (_) {
        return new Response('Offline', { status: 503 });
      }
    })());
    return;
  }
});

// ── Push notifications ─────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  // Server sends a JSON payload — title/body/url/tag/icon. If parsing
  // fails (legacy senders, empty payload), fall back to a generic alert.
  let payload = { title: 'RightAPI Forge', body: 'New activity', url: '/app/' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (_) { /* leave defaults */ }

  const options = {
    body: payload.body,
    icon: payload.icon || '/icons/icon-192.png',
    badge: payload.badge || '/icons/icon-192.png',
    tag: payload.tag,
    data: { url: payload.url || '/app/' },
    // requireInteraction keeps high-severity alerts on screen until
    // dismissed. We only set this when the server marked the payload
    // critical — opt-in to avoid being annoying on every nudge.
    requireInteraction: !!payload.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(payload.title || 'RightAPI Forge', options));
});

self.addEventListener('notificationclick', (event) => {
  const url = (event.notification.data && event.notification.data.url) || '/app/';
  event.notification.close();
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // If a Beacon tab is already focused on this app, navigate it.
      if (c.url.includes('/app') && 'focus' in c) {
        try {
          await c.focus();
          if ('navigate' in c) await c.navigate(url);
          return;
        } catch (_) { /* fall through to open */ }
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});

// Keep-alive: tear down the SW gracefully when the page asks for it.
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
