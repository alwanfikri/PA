/* ============================================================
   Lumina PWA — db.js  (v2)
   IndexedDB layer — complete schema rewrite

   KEY IMPROVEMENTS over v1:
   ─────────────────────────────────────────────────────────
   1. VERSION VECTORS on every record (localVersion, serverVersion)
      Used by conflict resolver to detect true conflicts vs
      fast-forward merges.

   2. COMPOSITE INDEXES for high-performance queries
      e.g. [syncStatus, deleted] so unsynced live records are
      fetched in one index scan, not filtered in JS.

   3. PHOTOS stored as Blob (not base64 string) in the
      'photoBlobs' store → 30–40% less storage, no string
      encoding overhead, readable via URL.createObjectURL().

   4. CONFLICT STORE — dedicated 'conflicts' object store
      holds any record where localVersion > serverVersion AND
      the server has also moved forward. UI can inspect/resolve.

   5. TOMBSTONE CLEANUP — a 'tombstones' store tracks deleted
      remoteIds so the sync layer can fire deletes even after
      the main record has been purged from the store.

   6. SYNC QUEUE enriched with priority, entityType, localVer
      for smarter deduplication and ordering in sync.js.
   ============================================================ */

const DB_NAME    = 'LuminaDB';
const DB_VERSION = 2;

let _db = null;

// ══════════════════════════════════════════════════════════════
//  OPEN / UPGRADE
// ══════════════════════════════════════════════════════════════

export async function openDB() {
  if (_db) return _db;

  _db = await idb.openDB(DB_NAME, DB_VERSION, {
    upgrade(db, oldVersion, newVersion, tx) {
      console.log(`[DB] Upgrading ${oldVersion} → ${newVersion}`);
      upgradeSchema(db, oldVersion, tx);
    },
    blocked()    { console.warn('[DB] Blocked by older tab'); },
    blocking()   { _db?.close(); _db = null; },
    terminated() { _db = null; console.error('[DB] Connection terminated'); }
  });

  return _db;
}

function upgradeSchema(db, oldVersion, tx) {
  // ── diary ─────────────────────────────────────────────────
  if (!db.objectStoreNames.contains('diary')) {
    const s = db.createObjectStore('diary', { keyPath: 'id' });
    s.createIndex('date',               'date',               { unique: false });
    s.createIndex('syncStatus',         'syncStatus',         { unique: false });
    s.createIndex('deleted',            'deleted',            { unique: false });
    s.createIndex('remoteId',           'remoteId',           { unique: false });
    s.createIndex('updatedAt',          'updatedAt',          { unique: false });
    s.createIndex('syncStatus_deleted', ['syncStatus', 'deleted'], { unique: false });
  } else if (oldVersion < 2) {
    migrateDiaryV1toV2(tx);
  }

  // ── agenda ────────────────────────────────────────────────
  if (!db.objectStoreNames.contains('agenda')) {
    const s = db.createObjectStore('agenda', { keyPath: 'id' });
    s.createIndex('startTime',          'startTime',          { unique: false });
    s.createIndex('syncStatus',         'syncStatus',         { unique: false });
    s.createIndex('deleted',            'deleted',            { unique: false });
    s.createIndex('remoteId',           'remoteId',           { unique: false });
    s.createIndex('syncStatus_deleted', ['syncStatus', 'deleted'], { unique: false });
  }

  // ── photoBlobs (Blob storage — replaces base64 strings) ───
  if (!db.objectStoreNames.contains('photoBlobs')) {
    const s = db.createObjectStore('photoBlobs', { keyPath: 'id' });
    s.createIndex('entryId',    'entryId',    { unique: false });
    s.createIndex('syncStatus', 'syncStatus', { unique: false });
    s.createIndex('createdAt',  'createdAt',  { unique: false });
  }

  // ── conflicts ─────────────────────────────────────────────
  if (!db.objectStoreNames.contains('conflicts')) {
    const s = db.createObjectStore('conflicts', { keyPath: 'id' });
    s.createIndex('entityType', 'entityType', { unique: false });
    s.createIndex('resolvedAt', 'resolvedAt', { unique: false });
    s.createIndex('localId',    'localId',    { unique: false });
  }

  // ── tombstones ────────────────────────────────────────────
  if (!db.objectStoreNames.contains('tombstones')) {
    const s = db.createObjectStore('tombstones', { keyPath: 'id' });
    s.createIndex('entityType', 'entityType', { unique: false });
    s.createIndex('syncedAt',   'syncedAt',   { unique: false });
    s.createIndex('remoteId',   'remoteId',   { unique: false });
  }

  // ── syncQueue ─────────────────────────────────────────────
  if (!db.objectStoreNames.contains('syncQueue')) {
    const s = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
    s.createIndex('entityType',  'entityType',  { unique: false });
    s.createIndex('operation',   'operation',   { unique: false });
    s.createIndex('localId',     'localId',     { unique: false });
    s.createIndex('priority',    'priority',    { unique: false });
    s.createIndex('nextRetryAt', 'nextRetryAt', { unique: false });
  }

  // ── money (future feature — schema ready) ─────────────────
  if (!db.objectStoreNames.contains('money')) {
    const s = db.createObjectStore('money', { keyPath: 'id' });
    s.createIndex('date',       'date',       { unique: false });
    s.createIndex('type',       'type',       { unique: false });
    s.createIndex('category',   'category',   { unique: false });
    s.createIndex('syncStatus', 'syncStatus', { unique: false });
    s.createIndex('deleted',    'deleted',    { unique: false });
  }

  // ── settings ──────────────────────────────────────────────
  if (!db.objectStoreNames.contains('settings')) {
    db.createObjectStore('settings', { keyPath: 'key' });
  }
}

async function migrateDiaryV1toV2(tx) {
  try {
    const store = tx.objectStore('diary');
    const all   = await store.getAll();
    for (const rec of all) {
      rec.localVersion  = 1;
      rec.serverVersion = rec.synced ? 1 : 0;
      rec.serverHash    = '';
      rec.syncStatus    = rec.synced ? 'synced' : 'pending';
      rec.photo_ids     = rec.photo_ids ?? [];
      delete rec.synced;
      await store.put(rec);
    }
    console.log('[DB] Migrated', all.length, 'diary records to v2');
  } catch (e) {
    console.error('[DB] Migration failed:', e);
  }
}

// ══════════════════════════════════════════════════════════════
//  GENERIC HELPERS
// ══════════════════════════════════════════════════════════════

export async function dbGet(store, key)            { return (await openDB()).get(store, key); }
export async function dbPut(store, value)          { return (await openDB()).put(store, value); }
export async function dbDelete(store, key)         { return (await openDB()).delete(store, key); }
export async function dbGetAll(store)              { return (await openDB()).getAll(store); }
export async function dbCount(store)               { return (await openDB()).count(store); }
export async function dbClear(store)               { return (await openDB()).clear(store); }

export async function dbGetAllByIndex(store, index, query) {
  return (await openDB()).getAllFromIndex(store, index, query);
}

/** Run multiple store operations in a single atomic transaction */
export async function dbTransaction(storeNames, mode, callback) {
  const db = await openDB();
  const tx = db.transaction(storeNames, mode);
  const result = await callback(tx);
  await tx.done;
  return result;
}

// ── ID generation using crypto.getRandomValues ────────────────
export function generateId(prefix = '') {
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase();
  return `${prefix}${ts}${rand}`;
}

/** Stable 12-char content hash for server diff detection */
export async function hashContent(str) {
  if (!str) return '';
  try {
    const buf  = new TextEncoder().encode(str);
    const hash = await crypto.subtle.digest('SHA-1', buf);
    return Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  } catch (_) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
    return Math.abs(h).toString(16);
  }
}

// ══════════════════════════════════════════════════════════════
//  DIARY
// ══════════════════════════════════════════════════════════════

export async function saveDiaryEntry(entry) {
  const db       = await openDB();
  const now      = new Date().toISOString();
  const existing = entry.id ? await db.get('diary', entry.id) : null;

  const record = {
    id:           entry.id || generateId('D'),
    remoteId:     entry.remoteId     ?? existing?.remoteId     ?? null,
    date:         entry.date         ?? existing?.date         ?? now.split('T')[0],
    title:        entry.title        ?? existing?.title        ?? '',
    content_html: entry.content_html ?? existing?.content_html ?? '',
    photo_ids:    entry.photo_ids    ?? existing?.photo_ids    ?? [],
    photo_urls:   entry.photo_urls   ?? existing?.photo_urls   ?? [],

    localVersion:  (existing?.localVersion  ?? 0) + 1,
    serverVersion: existing?.serverVersion  ?? 0,
    serverHash:    existing?.serverHash     ?? '',

    syncStatus: 'pending',
    deleted:    false,
    deletedAt:  null,
    createdAt:  existing?.createdAt ?? now,
    updatedAt:  now
  };

  await db.put('diary', record);
  return record;
}

export async function getDiaryEntries(options = {}) {
  const db = await openDB();
  let entries;
  try {
    // Composite index scan: get pending + synced + conflict, non-deleted
    const pending  = await db.getAllFromIndex('diary', 'syncStatus_deleted', IDBKeyRange.only(['pending', false]));
    const synced   = await db.getAllFromIndex('diary', 'syncStatus_deleted', IDBKeyRange.only(['synced',  false]));
    const conflict = await db.getAllFromIndex('diary', 'syncStatus_deleted', IDBKeyRange.only(['conflict',false]));
    entries = [...pending, ...synced, ...conflict];
  } catch (_) {
    entries = (await db.getAll('diary')).filter(e => !e.deleted);
  }
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
  if (options.limit) entries = entries.slice(0, options.limit);
  return entries;
}

export async function getDiaryEntry(id)        { return dbGet('diary', id); }

export async function softDeleteDiaryEntry(id) {
  const db    = await openDB();
  const entry = await db.get('diary', id);
  if (!entry) return null;
  const now = new Date().toISOString();
  Object.assign(entry, {
    deleted: true, deletedAt: now, updatedAt: now,
    syncStatus: 'pending', localVersion: (entry.localVersion ?? 0) + 1
  });
  await db.put('diary', entry);
  if (entry.remoteId) await createTombstone('diary', entry.remoteId);
  return entry;
}

export async function markDiarySynced(id, { remoteId, serverVersion, serverHash } = {}) {
  const db    = await openDB();
  const entry = await db.get('diary', id);
  if (!entry) return;
  Object.assign(entry, {
    remoteId:      remoteId      ?? entry.remoteId,
    serverVersion: serverVersion ?? entry.localVersion,
    serverHash:    serverHash    ?? entry.serverHash,
    syncStatus:    'synced'
  });
  await db.put('diary', entry);
}

// ══════════════════════════════════════════════════════════════
//  AGENDA
// ══════════════════════════════════════════════════════════════

export async function saveAgendaEvent(event) {
  const db       = await openDB();
  const now      = new Date().toISOString();
  const existing = event.id ? await db.get('agenda', event.id) : null;

  const record = {
    id:              event.id || generateId('A'),
    remoteId:        event.remoteId        ?? existing?.remoteId        ?? null,
    title:           event.title           ?? existing?.title           ?? 'Untitled',
    description:     event.description     ?? existing?.description     ?? '',
    startTime:       event.startTime       ?? existing?.startTime,
    endTime:         event.endTime         ?? existing?.endTime,
    allDay:          event.allDay          ?? existing?.allDay          ?? false,
    color:           event.color           ?? existing?.color           ?? '#c8a97e',
    reminderMinutes: event.reminderMinutes ?? existing?.reminderMinutes ?? 30,

    localVersion:  (existing?.localVersion  ?? 0) + 1,
    serverVersion: existing?.serverVersion  ?? 0,
    serverHash:    existing?.serverHash     ?? '',

    syncStatus:    'pending',
    deleted:       false,
    reminderFired: existing?.reminderFired ?? false,
    createdAt:     existing?.createdAt     ?? now,
    updatedAt:     now
  };

  await db.put('agenda', record);
  return record;
}

export async function getAgendaEvents(options = {}) {
  let events = (await dbGetAll('agenda')).filter(e => !e.deleted);
  if (options.start) events = events.filter(e => new Date(e.endTime)   >= new Date(options.start));
  if (options.end)   events = events.filter(e => new Date(e.startTime) <= new Date(options.end));
  events.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  return events;
}

export async function getAgendaEvent(id) { return dbGet('agenda', id); }

export async function softDeleteAgendaEvent(id) {
  const db    = await openDB();
  const event = await db.get('agenda', id);
  if (!event) return null;
  const now = new Date().toISOString();
  Object.assign(event, {
    deleted: true, updatedAt: now,
    syncStatus: 'pending', localVersion: (event.localVersion ?? 0) + 1
  });
  await db.put('agenda', event);
  if (event.remoteId) await createTombstone('agenda', event.remoteId);
  return event;
}

export async function markAgendaSynced(id, { remoteId, serverVersion, serverHash } = {}) {
  const db    = await openDB();
  const event = await db.get('agenda', id);
  if (!event) return;
  Object.assign(event, {
    remoteId:      remoteId      ?? event.remoteId,
    serverVersion: serverVersion ?? event.localVersion,
    serverHash:    serverHash    ?? event.serverHash,
    syncStatus:    'synced'
  });
  await db.put('agenda', event);
}

// ══════════════════════════════════════════════════════════════
//  PHOTOS (Blob storage)
// ══════════════════════════════════════════════════════════════

export async function savePhotoBlob({ blob, thumbnail, name, mimeType, width, height, entryId = null }) {
  const record = {
    id:         generateId('P'),
    entryId,
    blob,
    thumbnail:  thumbnail ?? null,
    name:       sanitizeFilename(name),
    mimeType:   mimeType   ?? 'image/jpeg',
    width:      width      ?? 0,
    height:     height     ?? 0,
    sizeBytes:  blob.size,
    driveUrl:   null,
    driveId:    null,
    syncStatus: 'pending',
    errorMsg:   null,
    createdAt:  new Date().toISOString()
  };
  await dbPut('photoBlobs', record);
  return record;
}

export async function getPhotoBlob(id)           { return dbGet('photoBlobs', id); }
export async function getPhotosByEntry(entryId)  { return dbGetAllByIndex('photoBlobs', 'entryId', entryId); }
export async function getPendingPhotos()         { return dbGetAllByIndex('photoBlobs', 'syncStatus', 'pending'); }

export async function markPhotoSynced(id, { driveUrl, driveId }) {
  const db    = await openDB();
  const photo = await db.get('photoBlobs', id);
  if (!photo) return;
  Object.assign(photo, { driveUrl, driveId, syncStatus: 'synced', blob: null, thumbnail: null });
  await db.put('photoBlobs', photo);
  return photo;
}

export async function markPhotoError(id, msg) {
  const db    = await openDB();
  const photo = await db.get('photoBlobs', id);
  if (!photo) return;
  Object.assign(photo, { syncStatus: 'error', errorMsg: msg });
  await db.put('photoBlobs', photo);
}

// ══════════════════════════════════════════════════════════════
//  CONFLICTS
// ══════════════════════════════════════════════════════════════

export async function saveConflict({ entityType, localId, remoteId, localRecord, remoteRecord }) {
  const record = {
    id: generateId('C'), entityType, localId, remoteId,
    localRecord, remoteRecord,
    detectedAt: new Date().toISOString(),
    resolvedAt: null, resolution: null
  };
  await dbPut('conflicts', record);
  console.warn('[DB] Conflict stored:', entityType, localId);
  return record;
}

export async function getUnresolvedConflicts() {
  return (await dbGetAll('conflicts')).filter(c => !c.resolvedAt);
}

export async function resolveConflict(conflictId, resolution, mergedRecord = null) {
  const db       = await openDB();
  const conflict = await db.get('conflicts', conflictId);
  if (!conflict) return;

  conflict.resolvedAt = new Date().toISOString();
  conflict.resolution = resolution;
  await db.put('conflicts', conflict);

  const store = conflict.entityType;
  if      (resolution === 'remote_wins') await db.put(store, { ...conflict.remoteRecord, syncStatus: 'synced' });
  else if (resolution === 'local_wins')  await db.put(store, { ...conflict.localRecord,  syncStatus: 'pending' });
  else if (resolution === 'merged' && mergedRecord) await db.put(store, { ...mergedRecord, syncStatus: 'pending' });

  return conflict;
}

// ══════════════════════════════════════════════════════════════
//  TOMBSTONES
// ══════════════════════════════════════════════════════════════

export async function createTombstone(entityType, remoteId) {
  const record = {
    id: generateId('T'), entityType, remoteId,
    deletedAt: new Date().toISOString(), syncedAt: null
  };
  await dbPut('tombstones', record);
  return record;
}

export async function getPendingTombstones() {
  // All tombstones where syncedAt is null (not yet sent to server)
  return (await dbGetAll('tombstones')).filter(t => !t.syncedAt);
}

export async function markTombstoneSynced(id) {
  const db  = await openDB();
  const rec = await db.get('tombstones', id);
  if (!rec) return;
  rec.syncedAt = new Date().toISOString();
  await db.put('tombstones', rec);
}

// ══════════════════════════════════════════════════════════════
//  SYNC QUEUE
// ══════════════════════════════════════════════════════════════

/**
 * Add to queue — atomically removes any stale entry for same entity first.
 * priority: 1=high (data saves), 3=medium (photos), 5=low
 */
export async function enqueueSync({ entityType, operation, localId, remoteId = null, localVersion = 0, priority = 1 }) {
  const db = await openDB();

  // Remove existing queue items for this local entity to avoid duplicates
  const tx = db.transaction('syncQueue', 'readwrite');
  const allItems = await tx.store.index('localId').getAll(localId);
  for (const item of allItems) {
    if (item.entityType === entityType) await tx.store.delete(item.id);
  }
  await tx.done;

  const record = {
    entityType, operation, localId, remoteId, localVersion, priority,
    retries:     0,
    nextRetryAt: new Date().toISOString(),
    lastError:   null,
    createdAt:   new Date().toISOString()
  };
  return (await openDB()).add('syncQueue', record);
}

export async function getSyncQueue() {
  const now   = new Date();
  const items = await dbGetAll('syncQueue');
  return items
    .filter(i => new Date(i.nextRetryAt) <= now)
    .sort((a, b) => (a.priority - b.priority) || a.id - b.id);
}

export async function removeSyncItem(id)   { return dbDelete('syncQueue', id); }
export async function updateSyncItem(item) { return dbPut('syncQueue', item); }
export async function clearSyncQueue()     { return dbClear('syncQueue'); }

// ══════════════════════════════════════════════════════════════
//  MONEY (Future)
// ══════════════════════════════════════════════════════════════

export async function saveMoneyTransaction(tx) {
  const db = await openDB(), now = new Date().toISOString();
  const existing = tx.id ? await db.get('money', tx.id) : null;
  const record = {
    id: tx.id || generateId('M'), remoteId: tx.remoteId ?? null,
    date: tx.date ?? now.split('T')[0], type: tx.type ?? 'expense',
    category: tx.category ?? 'General', amount: parseFloat(tx.amount) || 0,
    notes: tx.notes ?? '',
    localVersion:  (existing?.localVersion  ?? 0) + 1,
    serverVersion: existing?.serverVersion  ?? 0,
    syncStatus: 'pending', deleted: false,
    createdAt: existing?.createdAt ?? now, updatedAt: now
  };
  await db.put('money', record);
  return record;
}

export async function getMoneyTransactions(opts = {}) {
  let txs = (await dbGetAll('money')).filter(t => !t.deleted);
  if (opts.type)      txs = txs.filter(t => t.type === opts.type);
  if (opts.startDate) txs = txs.filter(t => t.date >= opts.startDate);
  if (opts.endDate)   txs = txs.filter(t => t.date <= opts.endDate);
  return txs.sort((a, b) => b.date.localeCompare(a.date));
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════

export async function getSetting(key, def = null) {
  const rec = await dbGet('settings', key);
  return rec ? rec.value : def;
}
export async function setSetting(key, value) { return dbPut('settings', { key, value }); }

// ══════════════════════════════════════════════════════════════
//  STATS
// ══════════════════════════════════════════════════════════════

export async function getSyncStats() {
  const db = await openDB();
  const [diaryPend, agendaPend, photosPend, queueAll, conflictsAll] = await Promise.all([
    db.getAllFromIndex('diary',      'syncStatus', 'pending'),
    db.getAllFromIndex('agenda',     'syncStatus', 'pending'),
    db.getAllFromIndex('photoBlobs', 'syncStatus', 'pending'),
    db.getAll('syncQueue'),
    db.getAll('conflicts')
  ]);
  return {
    diary:     diaryPend.filter(e => !e.deleted).length,
    agenda:    agendaPend.filter(e => !e.deleted).length,
    photos:    photosPend.length,
    queue:     queueAll.length,
    conflicts: conflictsAll.filter(c => !c.resolvedAt).length
  };
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════

function sanitizeFilename(name) {
  return (name || 'photo.jpg').replace(/[^a-zA-Z0-9._\-]/g, '_').slice(0, 100);
}

export function blobToObjectURL(blob) {
  return blob ? URL.createObjectURL(blob) : null;
}

console.log('[DB] v2 module loaded');
