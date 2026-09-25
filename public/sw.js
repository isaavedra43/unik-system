/**
 * UNIK Service Worker — PWA offline support
 *
 * Strategy:
 * - Static assets (images, fonts, icons): cache-first (rarely change)
 * - API routes, auth and every authenticated page: network-only
 * - HTML navigations are NEVER cached: /app pages contain private data and a
 *   cached copy would outlive logout on a shared device. Offline navigations
 *   get a generic offline screen instead of stale private HTML.
 * - RSC/data fetches under /app: network-only for the same reason.
 * - Web Push: shows the OS notification and opens/focuses the app on tap
 */

const CACHE_VERSION = 'unik-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Authenticated surface — never written to any cache.
const PRIVATE_PREFIX = '/app';

// Assets to pre-cache on install (public statics only — no HTML).
const PRECACHE_URLS = [
  '/icon-192.png',
  '/icon-256.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/manifest.webmanifest',
];

const OFFLINE_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sin conexión — UNIK</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;background:#f6f7f9;color:#111318}div{text-align:center;max-width:320px;padding:2rem}h1{font-size:1.25rem;margin:0 0 .5rem}p{color:#4b5563;font-size:.9375rem;margin:0}</style></head><body><div><h1>Sin conexión</h1><p>UNIK necesita internet. Revisa tu conexión y vuelve a intentar.</p></div></body></html>`;

// Routes that should always hit the network (API calls, auth, etc.)
const NETWORK_ONLY_PATTERNS = [
  /\/api\//,
  /\/actions/,
  /\/login/,
];

// Static asset extensions (cache-first)
const STATIC_EXTENSIONS = /\.(png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|eot|css|js|map)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => {
        // If precache fails, continue anyway — don't block install
      })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => !name.startsWith(CACHE_VERSION))
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Skip cross-origin requests (Zoho, Azure OpenAI, etc.)
  if (url.origin !== self.location.origin) return;

  // Network-only for API routes and auth
  if (NETWORK_ONLY_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return;
  }

  // Navigation requests (HTML pages): network-only — authenticated HTML must
  // never sit in a cache where it outlives the session. Offline → generic page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_HTML, {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          })
      )
    );
    return;
  }

  // Static assets: cache-first, then network
  if (STATIC_EXTENSIONS.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          const clone = response.clone();
          caches.open(STATIC_CACHE).then((cache) => cache.put(request, clone));
          return response;
        });
      })
    );
    return;
  }

  // Authenticated RSC/data fetches (client-side navigations hit page paths
  // with ?_rsc=): never cached, same rule as navigations.
  if (url.pathname.startsWith(PRIVATE_PREFIX)) {
    return;
  }

  // Everything else: stale-while-revalidate
  event.respondWith(
    caches.match(request).then((cached) => {
      const fetchPromise = fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// Allow page to take control immediately on updates
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
});

// ---------------------------------------------------------------------------
// Web Push
// ---------------------------------------------------------------------------

const DEFAULT_ICON = '/icon-192.png';
const DEFAULT_BADGE = '/icon-192.png';

function parsePushPayload(event) {
  if (!event.data) return { title: 'UNIK', body: 'Tienes una notificación nueva.' };
  try {
    return event.data.json();
  } catch {
    return { title: 'UNIK', body: event.data.text() };
  }
}

self.addEventListener('push', (event) => {
  const payload = parsePushPayload(event);
  const title = payload.title || 'UNIK';
  const url = payload.url || '/app/notifications';
  const options = {
    body: payload.body || '',
    icon: payload.icon || DEFAULT_ICON,
    badge: payload.badge || DEFAULT_BADGE,
    tag: payload.tag || undefined,
    renotify: Boolean(payload.renotify),
    requireInteraction: Boolean(payload.requireInteraction),
    timestamp: Date.now(),
    data: {
      url,
      notificationId: payload.notificationId || null,
      category: payload.category || null,
      ...(payload.data || {}),
    },
  };
  // Vibration pattern is ignored where unsupported (iOS) — harmless.
  if (payload.category === 'call_incoming') options.vibrate = [300, 100, 300, 100, 300];

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // Let open tabs refresh their badge/list without waiting for SSE.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        client.postMessage({ type: 'unik:push', payload });
      }
    })()
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const targetPath = data.url || '/app/notifications';
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    (async () => {
      // Mark as read in the background (best effort; cookies travel with the SW fetch).
      if (data.notificationId) {
        fetch('/app/notifications/api/read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: data.notificationId }),
          credentials: 'include',
        }).catch(() => {});
      }
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // Reuse an existing app window (installed PWA or tab) and navigate it.
      for (const client of windows) {
        if ('focus' in client) {
          try {
            await client.focus();
            if ('navigate' in client) await client.navigate(targetUrl);
            else client.postMessage({ type: 'unik:navigate', url: targetPath });
            return;
          } catch {
            // fall through to openWindow
          }
        }
      }
      if (self.clients.openWindow) await self.clients.openWindow(targetUrl);
    })()
  );
});

// Browsers may rotate the subscription; re-register it with the server.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const res = await fetch('/app/notifications/api/push', { credentials: 'include' });
        if (!res.ok) return;
        const { publicKey } = await res.json();
        if (!publicKey) return;
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
        await fetch('/app/notifications/api/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ subscription: sub.toJSON(), userAgent: self.navigator.userAgent }),
        });
      } catch {
        // the settings screen re-subscribes on next visit
      }
    })()
  );
});
