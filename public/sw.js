/**
 * UNIK Service Worker — PWA offline support
 *
 * Strategy:
 * - App shell (HTML, CSS, JS): stale-while-revalidate (instant from cache, update in background)
 * - Static assets (images, fonts, icons): cache-first (rarely change)
 * - API routes: network-only (always fresh data)
 * - Navigation requests: network-first, fallback to cached app shell
 * - Web Push: shows the OS notification and opens/focuses the app on tap
 */

const CACHE_VERSION = 'unik-v2';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Assets to pre-cache on install (app shell essentials)
const PRECACHE_URLS = [
  '/',
  '/app',
  '/icon-192.png',
  '/icon-256.png',
  '/icon-512.png',
  '/icon-512-maskable.png',
  '/apple-touch-icon.png',
  '/favicon-32.png',
  '/manifest.webmanifest',
];

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

  // Navigation requests (HTML pages): network-first, fallback to cache
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/app'))
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
