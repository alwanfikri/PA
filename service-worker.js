/* ============================================================
   Lumina PWA — service-worker.js  (v2)

   KEY IMPROVEMENTS over v1:
   ─────────────────────────────────────────────────────────
   1. BACKGROUND SYNC that works even with NO open tabs
      — SW can directly call the Apps Script API itself
      when triggered by the SyncManager, without needing
      a live window to relay the message.

   2. STALE-WHILE-REVALIDATE for app shell
      Serves cached assets instantly, revalidates in background.
      Libraries (CDN) use cache-first (they don't change).

   3. SEPARATE CACHE BUCKETS
      - lumina-shell-v2  : HTML/CSS/JS app shell
      - lumina-cdn-v2    : external library CDN assets
      Cache-busting is per-bucket so a shell update doesn't
      evict CDN assets and vice-versa.

   4. CLEAN CACHE VERSIONING
      All caches not matching current version strings are
      deleted on activate, not just ones not matching a
      single name.

   5. NOTIFICATION ACTIONS
      Push notifications support "Open", "Snooze" actions.
      Snooze reschedules the notification in 10 min.
   ============================================================ */

const SHELL_CACHE = 'lumina-shell-v2';
const CDN_CACHE   = 'lumina-cdn-v2';
const ALL_CACHES  = [SHELL_CACHE, CDN_CACHE];
const SYNC_TAG    = 'lumina-sync';

const SHELL_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './sync.js',
  './calendar.js',
  './diary.js',
  './drive.js',
  './manifest.json'
];

const CDN_ASSETS = [
  'https://cdn.quilljs.com/1.3.7/quill.snow.css',
  'https://cdn.quilljs.com/1.3.7/quill.min.js',
  'https://cdn.jsdelivr.net/npm/fullcalendar@6.1.10/index.global.min.js',
  'https://cdn.jsdelivr.net/npm/idb@7/build/umd.js'
];

// ══════════════════════════════════════════════════════════════
//  INSTALL
// ══════════════════════════════════════════════════════════════

self.addEventListener('install', event => {
  console.log('[SW] Installing v2');
  event.waitUntil(
    Promise.all([
      // App shell — fail silently per-asset
      caches.open(SHELL_CACHE).then(async cache => {
        for (const url of SHELL_ASSETS) {
          try { await cache.add(url); }
          catch (e) { console.warn('[SW] Shell cache miss:', url); }
        }
      }),
      // CDN — fail silently per-asset
      caches.open(CDN_CACHE).then(async cache => {
        for (const url of CDN_ASSETS) {
          try { await cache.add(url); }
          catch (e) { console.warn('[SW] CDN cache miss:', url); }
        }
      })
    ]).then(() => {
      console.log('[SW] Install complete');
      self.skipWaiting();
    })
  );
});

// ══════════════════════════════════════════════════════════════
//  ACTIVATE
// ══════════════════════════════════════════════════════════════

self.addEventListener('activate', event => {
  console.log('[SW] Activating v2');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => !ALL_CACHES.includes(k))
          .map(k => { console.log('[SW] Deleting old cache:', k); return caches.delete(k); })
      )
    ).then(() => self.clients.claim())
  );
});

// ══════════════════════════════════════════════════════════════
//  FETCH STRATEGY
// ══════════════════════════════════════════════════════════════

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET, chrome extensions, devtools
  if (request.method !== 'GET')               return;
  if (url.protocol === 'chrome-extension:')   return;
  if (url.hostname === 'localhost' && url.port !== '') return;

  // ── Google API calls: network-only (never cache) ──────────
  if (url.hostname.includes('script.google.com') ||
      url.hostname.includes('googleapis.com')) {
    event.respondWith(fetchWithOfflineFallback(request));
    return;
  }

  // ── CDN assets: cache-first (they're versioned/immutable) ─
  if (CDN_ASSETS.some(a => request.url.startsWith(a.split('./index.html').slice(0, 3).join('./index.html')))) {
    event.respondWith(cacheFirst(request, CDN_CACHE));
    return;
  }

  // ── App shell: stale-while-revalidate ─────────────────────
  event.respondWith(staleWhileRevalidate(request));
});

async function fetchWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch (_) {
    return new Response(
      JSON.stringify({ error: 'offline', message: 'You are offline.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res   = await fetch(request);
    const cache = await caches.open(cacheName);
    if (res.ok) cache.put(request, res.clone());
    return res;
  } catch (_) {
    return new Response('Offline — resource not cached', { status: 503 });
  }
}

async function staleWhileRevalidate(request) {
  const cache  = await caches.open(SHELL_CACHE);
  const cached = await cache.match(request);

  const fetchAndStore = fetch(request).then(res => {
    if (res && res.status === 200 && res.type !== 'opaque') {
      cache.put(request, res.clone());
    }
    return res;
  }).catch(() => null);

  if (cached) {
    // Revalidate in background without blocking
    fetchAndStore;
    return cached;
  }

  // Not cached — must wait for network
  const res = await fetchAndStore;
  if (res) return res;

  // Navigation fallback
  if (request.mode === 'navigate') {
    const fallback = await cache.match('/index.html');
    if (fallback) return fallback;
  }

  return new Response('Offline — resource unavailable', { status: 503 });
}

// ══════════════════════════════════════════════════════════════
//  BACKGROUND SYNC
//  Fires when browser regains connectivity and SyncManager
//  triggers the registered tag — even if app window is closed.
// ══════════════════════════════════════════════════════════════

self.addEventListener('sync', event => {
  console.log('[SW] Sync event:', event.tag);
  if (event.tag === SYNC_TAG) {
    event.waitUntil(_runBackgroundSync());
  }
});

async function _runBackgroundSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });

  if (clients.length > 0) {
    // App is open — delegate to the app's sync engine (has full IDB access + UI updates)
    clients.forEach(c => c.postMessage({ type: 'SW_BACKGROUND_SYNC' }));
    console.log('[SW] Delegated sync to', clients.length, 'client(s)');
    return;
  }

  // ── No window open — SW performs sync directly ─────────────
  // This path runs when sync fires in the background
  console.log('[SW] No clients — running headless sync');
  try {
    const apiUrl = await _getStoredApiUrl();
    if (!apiUrl) { console.log('[SW] No API URL, skipping headless sync'); return; }

    const queue = await _getQueueFromIDB();
    if (!queue.length) { console.log('[SW] Queue empty'); return; }

    let synced = 0;
    for (const item of queue) {
      try {
        await _headlessSyncItem(item, apiUrl);
        synced++;
      } catch (e) {
        console.error('[SW] Headless sync item failed:', e.message);
      }
    }
    console.log('[SW] Headless sync complete:', synced, 'items');
  } catch (err) {
    console.error('[SW] Headless sync error:', err);
    throw err; // Tell SyncManager to retry
  }
}

/** Direct IDB reads for headless sync (no idb library — raw API) */
async function _getStoredApiUrl() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('LuminaDB');
    req.onerror = () => resolve(null);
    req.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('settings')) { db.close(); resolve(null); return; }
      const tx  = db.transaction('settings', 'readonly');
      const get = tx.objectStore('settings').get('apiUrl');
      get.onsuccess = e2 => { db.close(); resolve(e2.target.result?.value ?? null); };
      get.onerror   = ()  => { db.close(); resolve(null); };
    };
  });
}

async function _getQueueFromIDB() {
  return new Promise((resolve) => {
    const req = indexedDB.open('LuminaDB');
    req.onerror   = () => resolve([]);
    req.onsuccess = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('syncQueue')) { db.close(); resolve([]); return; }
      const tx    = db.transaction('syncQueue', 'readonly');
      const getAll = tx.objectStore('syncQueue').getAll();
      getAll.onsuccess = e2 => { db.close(); resolve(e2.target.result ?? []); };
      getAll.onerror   = () => { db.close(); resolve([]); };
    };
  });
}

async function _headlessSyncItem(item, apiUrl) {
  if (item.entityType === 'photo') return; // photos need Blob, skip in headless mode

  const rec = await _getRecordFromIDB(item.entityType, item.localId);
  if (!rec || rec.deleted) return;

  const action = item.entityType === 'diary'  ? 'saveDiaryEntry'
               : item.entityType === 'agenda' ? 'saveCalendarEvent'
               : null;
  if (!action) return;

  const payload = item.entityType === 'diary' ? {
    id: rec.remoteId, date: rec.date, title: rec.title,
    content_html: rec.content_html, photo_urls: rec.photo_urls ?? []
  } : {
    id: rec.remoteId, title: rec.title, description: rec.description,
    startTime: rec.startTime, endTime: rec.endTime, reminderMinutes: rec.reminderMinutes
  };

  const res  = await fetch(apiUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body:    JSON.stringify({ action, ...payload })
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  // Mark synced in IDB directly
  if (rec) {
    await _putRecordToIDB(item.entityType, {
      ...rec,
      remoteId:      data.id    ?? rec.remoteId,
      serverVersion: data.version ?? rec.localVersion,
      syncStatus:    'synced'
    });
    await _deleteFromIDB('syncQueue', item.id);
  }
}

async function _getRecordFromIDB(storeName, key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('LuminaDB');
    req.onsuccess = e => {
      const db = e.target.result;
      const tx  = db.transaction(storeName, 'readonly');
      const get = tx.objectStore(storeName).get(key);
      get.onsuccess = e2 => { db.close(); resolve(e2.target.result); };
      get.onerror   = ()  => { db.close(); resolve(null); };
    };
    req.onerror = () => resolve(null);
  });
}

async function _putRecordToIDB(storeName, record) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('LuminaDB');
    req.onsuccess = e => {
      const db  = e.target.result;
      const tx  = db.transaction(storeName, 'readwrite');
      const put = tx.objectStore(storeName).put(record);
      put.onsuccess = () => { db.close(); resolve(); };
      put.onerror   = err => { db.close(); reject(err); };
    };
    req.onerror = reject;
  });
}

async function _deleteFromIDB(storeName, key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('LuminaDB');
    req.onsuccess = e => {
      const db  = e.target.result;
      const tx  = db.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror    = ()  => { db.close(); resolve(); };
    };
    req.onerror = () => resolve();
  });
}

// ══════════════════════════════════════════════════════════════
//  PERIODIC SYNC (reminder check)
// ══════════════════════════════════════════════════════════════

self.addEventListener('periodicsync', event => {
  if (event.tag === 'check-reminders') {
    event.waitUntil(
      self.clients.matchAll().then(clients =>
        clients.forEach(c => c.postMessage({ type: 'CHECK_REMINDERS' }))
      )
    );
  }
});

// ══════════════════════════════════════════════════════════════
//  PUSH NOTIFICATIONS
// ══════════════════════════════════════════════════════════════

self.addEventListener('push', event => {
  const defaults = { title: 'Lumina', body: 'You have a reminder', icon: '/icons/icon-192.png' };
  const data = event.data ? { ...defaults, ...event.data.json() } : defaults;

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon,
      badge:   '/icons/icon-72.png',
      vibrate: [200, 100, 200],
      tag:     data.tag ?? 'lumina-reminder',
      data,
      actions: [
        { action: 'open',   title: 'Open'        },
        { action: 'snooze', title: 'Snooze 10m'  },
        { action: 'dismiss',title: 'Dismiss'      }
      ]
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'snooze') {
    const { title, body } = event.notification.data ?? {};
    setTimeout(() => {
      self.registration.showNotification(title ?? 'Lumina', {
        body: body ?? 'Snoozed reminder',
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-72.png'
      });
    }, 10 * 60 * 1000);
    return;
  }

  if (event.action === 'dismiss') return;

  // 'open' or any click — focus or open window
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});

// ══════════════════════════════════════════════════════════════
//  MESSAGE HANDLER
// ══════════════════════════════════════════════════════════════

self.addEventListener('message', event => {
  const { type, title, body, delay } = event.data ?? {};

  if (type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (type === 'SCHEDULE_NOTIFICATION' && title && delay > 0) {
    setTimeout(() => {
      self.registration.showNotification(title, {
        body,
        icon:    '/icons/icon-192.png',
        badge:   '/icons/icon-72.png',
        vibrate: [200, 100, 200]
      });
    }, delay);
  }
});
