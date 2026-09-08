/**
 * UNIK Service Worker — PWA offline support
 *
 * Strategy:
 * - App shell (HTML, CSS, JS): stale-while-revalidate (instant from cache, update in background)
 * - Static assets (images, fonts, icons): cache-first (rarely change)
 * - API routes: network-only (always fresh data)
 * - Navigation requests: network-first, fallback to cached app shell
 */

const CACHE_VERSION = 'unik-v1';
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
