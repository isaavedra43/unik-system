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

const CACHE_VERSION = 'unik-v3';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Assets to pre-cache on install (app shell essentials)
/**
 * Sólo el cascarón y los iconos: NINGUNA página autenticada.
 *
 * `/app/areas/logistica/chofer` estaba aquí para que la PWA del chofer abriera
 * sin señal, pero el precaché se ejecuta para TODA la gente que instala la app y
 * el HTML que guarda lleva nombres de cliente, direcciones y paradas de quien
 * tenía la sesión abierta. En un teléfono compartido de bodega el siguiente
 * chofer, sin señal, recibía las paradas del anterior. La página se sigue
 * guardando en el caché de ejecución cuando SU dueño la visita, y ese caché se
 * purga al cerrar sesión (mensaje `clear-private-cache`).
 */
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
      // One by one: a URL that answers 401/404 for this session (the driver PWA
      // when the person is not signed in yet) must not drop the whole precache.
      .then((cache) => Promise.all(PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))))
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
    return;
  }
  // Cerrar sesión borra el HTML que se guardó de las páginas de esa persona:
  // en un teléfono compartido nadie debe recibir del caché las paradas, los
  // clientes ni los expedientes de quien usó el equipo antes.
  if (event.data === 'clear-private-cache') {
    event.waitUntil(caches.delete(RUNTIME_CACHE));
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

// ---------------------------------------------------------------------------
// Background Sync de los comandos operativos (cola offline de la PWA de chofer)
// ---------------------------------------------------------------------------
//
// La cola vive en IndexedDB (`unik-commands`, ver src/lib/offline-commands.ts).
// Cuando el teléfono recupera señal, el navegador dispara este sync aunque la
// pestaña esté cerrada y reenviamos los comandos al mismo endpoint de lote que
// usa la app. Cada comando lleva su `commandId`, así que repetirlo nunca aplica
// la entrega dos veces: el motor devuelve el resultado que ya había guardado.

const LOGISTICS_SYNC_TAG = 'logistics-commands';
const COMMANDS_DB_NAME = 'unik-commands';
const COMMANDS_STORE_NAME = 'commands';
const COMMANDS_BATCH_ENDPOINT = '/app/operations/api/commands/batch';
const SYNC_BATCH_SIZE = 50;
// Mismo tope que el cliente: un comando que el servidor rechaza una y otra vez
// espera a que la persona decida (reintentar o descartar).
const SYNC_MAX_FAILURES = 20;
const SYNC_FINAL_STATUSES = ['completed', 'pending_external', 'rejected'];

/**
 * MISMA versión y MISMO esquema que `src/lib/offline-commands.ts`.
 *
 * Abrir sin versión creaba la base en la 1 SIN el almacén `commands` cuando el
 * `sync` llegaba antes que el cliente (las etiquetas de Background Sync
 * sobreviven entre sesiones): después el cliente abría la 1, no disparaba
 * `onupgradeneeded`, y la cola se caía a memoria en silencio — un comando
 * encolado sin señal se perdía al cerrar la pestaña.
 */
const COMMANDS_DB_VERSION = 1;

function openCommandsDb() {
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = indexedDB.open(COMMANDS_DB_NAME, COMMANDS_DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(COMMANDS_STORE_NAME)) {
        const store = db.createObjectStore(COMMANDS_STORE_NAME, { keyPath: 'commandId' });
        store.createIndex('queuedAt', 'queuedAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB no disponible'));
    request.onblocked = () => reject(new Error('IndexedDB bloqueado'));
  });
}

function readQueuedCommands(db) {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(COMMANDS_STORE_NAME)) {
      resolve([]);
      return;
    }
    const tx = db.transaction(COMMANDS_STORE_NAME, 'readonly');
    const request = tx.objectStore(COMMANDS_STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error('No se pudo leer la cola'));
  });
}

function removeQueuedCommands(db, ids) {
  if (ids.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMANDS_STORE_NAME, 'readwrite');
    const store = tx.objectStore(COMMANDS_STORE_NAME);
    for (const id of ids) store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error || new Error('No se pudo limpiar la cola'));
    tx.onerror = () => reject(tx.error || new Error('No se pudo limpiar la cola'));
  });
}

function toWireCommand(command) {
  const wire = {
    commandId: command.commandId,
    type: command.type,
    aggregate: command.aggregate,
    payload: command.payload,
    occurredAt: command.occurredAt,
  };
  if (typeof command.expectedVersion === 'number') wire.expectedVersion = command.expectedVersion;
  return wire;
}

async function flushOperationalCommands() {
  let db;
  try {
    db = await openCommandsDb();
  } catch {
    // Sin IndexedDB no hay cola que reenviar: no tiene caso reintentar.
    return;
  }

  const queued = (await readQueuedCommands(db)).filter(
    (command) => command && command.userId && (command.failures || 0) < SYNC_MAX_FAILURES
  );
  if (queued.length === 0) return;

  // Cada comando pertenece a quien lo registró: el lote viaja por usuario y el
  // servidor responde `actor_mismatch` (sin ejecutar nada) si la sesión es de
  // otra persona, así que esos comandos se quedan esperando a su dueño.
  const byUser = new Map();
  for (const command of queued) {
    const list = byUser.get(command.userId) || [];
    list.push(command);
    byUser.set(command.userId, list);
  }

  let stillPending = 0;
  for (const [userId, commands] of byUser) {
    const ordered = commands.slice().sort((a, b) => (a.queuedAt || 0) - (b.queuedAt || 0));
    const chunk = ordered.slice(0, SYNC_BATCH_SIZE);
    const response = await fetch(COMMANDS_BATCH_ENDPOINT, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'service-worker',
        userId,
        commands: chunk.map(toWireCommand),
      }),
    });
    // Sesión expirada o de otra persona: lo resuelve la app al abrirse.
    if (response.status === 401 || response.status === 403) return;
    if (!response.ok) throw new Error(`El servidor respondió ${response.status}`);

    const body = await response.json().catch(() => null);
    const results = (body && body.results) || [];
    const done = results
      .filter(
        (result) =>
          SYNC_FINAL_STATUSES.includes(result.status) && result.errorCode !== 'actor_mismatch'
      )
      .map((result) => result.commandId);
    await removeQueuedCommands(db, done);
    stillPending += ordered.length - done.length;
  }

  // Quedan comandos: pedimos al navegador que reprograme el envío.
  if (stillPending > 0) throw new Error('Quedan comandos operativos por enviar');
}

self.addEventListener('sync', (event) => {
  if (event.tag !== LOGISTICS_SYNC_TAG) return;
  event.waitUntil(flushOperationalCommands());
});
