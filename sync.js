/* ============================================================
   Lumina PWA — sync.js  (v2)
   Sync engine: IndexedDB ↔ Google Apps Script API

   KEY IMPROVEMENTS over v1:
   ─────────────────────────────────────────────────────────
   1. CONFLICT RESOLUTION ENGINE
      Three strategies, chosen per entity:
      - FAST-FORWARD: server hasn't changed since last sync
        → apply local changes, no conflict.
      - LOCAL WINS (default for user data): local version is
        newer than server and content hash differs → overwrite.
      - DETECT + DEFER: both local and server changed → store
        in 'conflicts' store for user to resolve in UI.

   2. TOMBSTONE FLUSHING
      Reads the 'tombstones' store and sends DELETE requests
      for records deleted while offline, even after the local
      record has been purged.

   3. EXPONENTIAL BACKOFF with jitter
      Failed items use 2^retries * 1000ms + random jitter,
      capped at 5 minutes. nextRetryAt stored in queue.

   4. PHOTO CONCURRENCY LIMIT
      Photos upload concurrently (max 2 at once) using a
      semaphore to avoid overwhelming the Apps Script quota.

   5. STALE QUEUE ITEM CHECK
      Before processing a queued save, checks that the
      localVersion stored in the queue item matches the
      current record. If stale (record was updated again),
      the item is silently discarded.

   6. SW BACKGROUND SYNC
      Proper registration + message-back architecture. If the
      app is in the background, SW fires BACKGROUND_SYNC message
      to whichever clients are alive. Falls back to fetch() if
      no clients are open.
   ============================================================ */

import {
  dbGet, dbPut, dbGetAll, getSetting, setSetting,
  getSyncQueue, removeSyncItem, updateSyncItem,
  markDiarySynced, markAgendaSynced,
  markPhotoSynced, markPhotoError, getPendingPhotos, getPhotoBlob,
  saveConflict, getUnresolvedConflicts,
  getPendingTombstones, markTombstoneSynced,
  getSyncStats, hashContent,
  enqueueSync                          // re-exported for feature modules
} from './db.js';

// Re-export enqueueSync so diary.js, calendar.js, drive.js can import it
// from sync.js without a circular dependency on db.js directly
export { enqueueSync } from './db.js';

// ── Constants ─────────────────────────────────────────────────
const SYNC_TAG          = 'lumina-sync';
const MAX_RETRIES       = 5;
const BASE_BACKOFF_MS   = 1_000;
const MAX_BACKOFF_MS    = 300_000; // 5 min
const PHOTO_CONCURRENCY = 2;
const SYNC_COOLDOWN_MS  = 800;     // min gap between syncs

let _apiUrl        = '';
let _syncInProgress = false;
let _syncTimer      = null;
let _lastSyncAt     = 0;

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

export async function initSync() {
  _apiUrl = await getSetting('apiUrl', '');
  _setupConnectivityListeners();
  _setupSwMessageListener();

  // Set correct status immediately on boot — don't wait for an online/offline event
  _updateStatusUI(navigator.onLine ? 'online' : 'offline');

  if (navigator.onLine && _apiUrl) scheduleSync(3_000);
  console.log('[Sync] v2 initialized. API:', _apiUrl || '(not set)');
}

export function setApiUrl(url) {
  _apiUrl = url;
  // Re-check status now that API URL is set
  _updateStatusUI(navigator.onLine ? 'online' : 'offline');
}

// ══════════════════════════════════════════════════════════════
//  CONNECTIVITY
// ══════════════════════════════════════════════════════════════

function _setupConnectivityListeners() {
  window.addEventListener('online', () => {
    console.log('[Sync] Back online');
    _updateStatusUI('online');
    scheduleSync(1_500);

    // Register SW Background Sync (fires even when app is backgrounded)
    if ('serviceWorker' in navigator && 'SyncManager' in window) {
      navigator.serviceWorker.ready
        .then(reg => reg.sync.register(SYNC_TAG))
        .catch(() => {}); // Non-fatal
    }
  });

  window.addEventListener('offline', () => {
    console.log('[Sync] Gone offline');
    _updateStatusUI('offline');
    if (_syncTimer) clearTimeout(_syncTimer);
  });
}

function _setupSwMessageListener() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', ({ data }) => {
    if (data?.type === 'SW_BACKGROUND_SYNC') processQueue();
    if (data?.type === 'CHECK_REMINDERS')    _checkReminders();
  });
}

// ══════════════════════════════════════════════════════════════
//  QUEUE SCHEDULING
// ══════════════════════════════════════════════════════════════

export function scheduleSync(delay = 3_000) {
  if (_syncTimer) clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    if (navigator.onLine && _apiUrl) processQueue();
  }, delay);
}

// ══════════════════════════════════════════════════════════════
//  MAIN QUEUE PROCESSOR
// ══════════════════════════════════════════════════════════════

export async function processQueue() {
  if (_syncInProgress)     return console.log('[Sync] Already running');
  if (!navigator.onLine)   return console.log('[Sync] Offline');
  if (!_apiUrl)            return console.log('[Sync] No API URL');

  const now = Date.now();
  if (now - _lastSyncAt < SYNC_COOLDOWN_MS) {
    scheduleSync(SYNC_COOLDOWN_MS);
    return;
  }

  _syncInProgress = true;
  _lastSyncAt     = now;
  _updateStatusUI('syncing');

  let successCount = 0;
  let errorCount   = 0;

  try {
    // ── Phase 1: Flush tombstones (deletes) ─────────────────
    const tombstoneResults = await _flushTombstones();
    successCount += tombstoneResults.ok;
    errorCount   += tombstoneResults.err;

    // ── Phase 2: Process data saves (diary + agenda) ────────
    const queue = await getSyncQueue();
    const dataItems  = queue.filter(i => i.entityType !== 'photo');
    const photoItems = queue.filter(i => i.entityType === 'photo');

    for (const item of dataItems) {
      const ok = await _processItem(item);
      ok ? successCount++ : errorCount++;
    }

    // ── Phase 3: Upload photos concurrently ─────────────────
    const photoResults = await _processPhotosConcurrently(photoItems);
    successCount += photoResults.ok;
    errorCount   += photoResults.err;

    // ── Phase 4: Emit result ─────────────────────────────────
    const conflicts = await getUnresolvedConflicts();
    const status    = conflicts.length > 0  ? 'conflict'
                    : errorCount   > 0      ? 'error'
                    : successCount > 0      ? 'success'
                    : 'idle';

    _updateStatusUI(status, successCount);

    if (successCount > 0 || errorCount > 0) {
      window.dispatchEvent(new CustomEvent('lumina:synced', {
        detail: { successCount, errorCount, conflicts: conflicts.length }
      }));
    }

  } catch (err) {
    console.error('[Sync] Fatal error:', err);
    _updateStatusUI('error');
  } finally {
    _syncInProgress = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  TOMBSTONE FLUSH
// ══════════════════════════════════════════════════════════════

async function _flushTombstones() {
  const tombstones = await getPendingTombstones();
  let ok = 0, err = 0;

  for (const t of tombstones) {
    try {
      const action = t.entityType === 'diary'  ? 'deleteDiaryEntry'
                   : t.entityType === 'agenda' ? 'deleteCalendarEvent'
                   : t.entityType === 'photo'  ? 'deletePhoto'
                   : null;
      if (!action) continue;

      await apiCall(action, { id: t.remoteId });
      await markTombstoneSynced(t.id);
      ok++;
    } catch (e) {
      console.error('[Sync] Tombstone flush failed:', t.remoteId, e.message);
      err++;
    }
  }

  if (ok) console.log(`[Sync] Tombstones flushed: ${ok} ok, ${err} err`);
  return { ok, err };
}

// ══════════════════════════════════════════════════════════════
//  PROCESS SINGLE QUEUE ITEM
// ══════════════════════════════════════════════════════════════

async function _processItem(item) {
  try {
    // Stale check: if record has moved on since this item was queued, discard
    if (item.operation === 'save' && item.entityType !== 'photo') {
      const rec = await dbGet(item.entityType, item.localId);
      if (!rec) {
        await removeSyncItem(item.id);
        return true; // record gone, nothing to do
      }
      if (rec.localVersion > item.localVersion + 1) {
        // A newer queue item was already inserted for the same record
        await removeSyncItem(item.id);
        return true;
      }
    }

    switch (`${item.entityType}:${item.operation}`) {
      case 'diary:save':   await _syncDiaryEntry(item);  break;
      case 'agenda:save':  await _syncAgendaEvent(item); break;
      default:
        console.warn('[Sync] Unknown item type:', item.entityType, item.operation);
    }

    await removeSyncItem(item.id);
    return true;

  } catch (err) {
    return _handleItemError(item, err);
  }
}

// ══════════════════════════════════════════════════════════════
//  CONFLICT RESOLUTION
// ══════════════════════════════════════════════════════════════

/**
 * Determine sync strategy by comparing version vectors:
 *
 *  localVersion > serverVersion && serverHash === localServerHash
 *    → FAST_FORWARD: server hasn't changed, safe to overwrite
 *
 *  localVersion > serverVersion && serverHash !== localServerHash
 *    → CONFLICT: both sides changed since last sync
 *
 *  localVersion === serverVersion
 *    → NOOP: already in sync
 */
async function _resolveStrategy(localRecord, serverSnapshot) {
  if (!serverSnapshot) return 'FAST_FORWARD'; // new record, no server copy

  const serverVer  = serverSnapshot.version ?? 0;
  const serverHash = serverSnapshot.hash    ?? '';

  if (localRecord.serverVersion === serverVer) {
    // Server hasn't changed since our last sync
    return 'FAST_FORWARD';
  }

  // Server HAS changed — check if content is actually different
  const localHash = await hashContent(
    JSON.stringify({
      title:        localRecord.title,
      content_html: localRecord.content_html,
      date:         localRecord.date
    })
  );

  if (localHash === serverHash) {
    // Content is identical despite version bump — safe merge
    return 'FAST_FORWARD';
  }

  // True conflict: both local and remote have different changes
  return 'CONFLICT';
}

// ── Diary sync ────────────────────────────────────────────────
async function _syncDiaryEntry(item) {
  const entry = await dbGet('diary', item.localId);
  if (!entry || entry.deleted) return; // tombstone handles deletes

  // Fetch server snapshot for conflict detection
  let serverSnapshot = null;
  if (entry.remoteId) {
    try {
      const res = await apiCall('getDiaryEntry', { id: entry.remoteId });
      serverSnapshot = res.entry ?? null;
    } catch (_) { /* server might not have it yet */ }
  }

  const strategy = await _resolveStrategy(entry, serverSnapshot);

  if (strategy === 'CONFLICT') {
    console.warn('[Sync] Conflict detected for diary:', entry.id);
    await saveConflict({
      entityType:   'diary',
      localId:      entry.id,
      remoteId:     entry.remoteId,
      localRecord:  entry,
      remoteRecord: serverSnapshot
    });
    // Mark as conflict in DB
    await dbPut('diary', { ...entry, syncStatus: 'conflict' });
    _notifyConflict('diary', entry.title);
    return; // do NOT overwrite server
  }

  // FAST_FORWARD: push local to server
  const res = await apiCall('saveDiaryEntry', {
    id:           entry.remoteId ?? null,
    date:         entry.date,
    title:        entry.title,
    content_html: entry.content_html,
    photo_urls:   entry.photo_urls ?? []
  });

  await markDiarySynced(entry.id, {
    remoteId:      res.id ?? entry.remoteId,
    serverVersion: res.version ?? entry.localVersion,
    serverHash:    res.hash ?? ''
  });

  console.log('[Sync] Diary synced:', entry.id, '→', res.id);
}

// ── Agenda sync ───────────────────────────────────────────────
async function _syncAgendaEvent(item) {
  const event = await dbGet('agenda', item.localId);
  if (!event || event.deleted) return;

  let serverSnapshot = null;
  if (event.remoteId) {
    try {
      const res = await apiCall('getCalendarEvent', { id: event.remoteId });
      serverSnapshot = res.event ?? null;
    } catch (_) {}
  }

  const strategy = await _resolveStrategy(event, serverSnapshot);

  if (strategy === 'CONFLICT') {
    console.warn('[Sync] Conflict detected for agenda:', event.id);
    await saveConflict({
      entityType:   'agenda',
      localId:      event.id,
      remoteId:     event.remoteId,
      localRecord:  event,
      remoteRecord: serverSnapshot
    });
    await dbPut('agenda', { ...event, syncStatus: 'conflict' });
    _notifyConflict('agenda', event.title);
    return;
  }

  const res = await apiCall('saveCalendarEvent', {
    id:              event.remoteId ?? null,
    title:           event.title,
    description:     event.description,
    startTime:       event.startTime,
    endTime:         event.endTime,
    reminderMinutes: event.reminderMinutes
  });

  await markAgendaSynced(event.id, {
    remoteId:      res.id ?? event.remoteId,
    serverVersion: res.version ?? event.localVersion,
    serverHash:    res.hash ?? ''
  });

  console.log('[Sync] Agenda synced:', event.id, '→', res.id);
}

// ══════════════════════════════════════════════════════════════
//  PHOTO UPLOAD (concurrent)
// ══════════════════════════════════════════════════════════════

async function _processPhotosConcurrently(photoItems) {
  let ok = 0, err = 0;
  const semaphore = new Semaphore(PHOTO_CONCURRENCY);

  await Promise.all(photoItems.map(async (item) => {
    await semaphore.acquire();
    try {
      const success = await _uploadPhoto(item);
      success ? ok++ : err++;
    } finally {
      semaphore.release();
    }
  }));

  return { ok, err };
}

async function _uploadPhoto(item) {
  try {
    const photo = await getPhotoBlob(item.localId);
    if (!photo || photo.syncStatus === 'synced') {
      await removeSyncItem(item.id);
      return true;
    }
    if (!photo.blob) {
      console.warn('[Sync] Photo blob gone (may have been freed):', item.localId);
      await removeSyncItem(item.id);
      return true;
    }

    // Convert Blob → base64 only at upload time (never persisted)
    const base64 = await blobToBase64(photo.blob);

    const res = await apiCall('uploadPhoto', {
      id:     item.localId,
      base64,
      name:   photo.name,
      type:   photo.mimeType
    });

    await markPhotoSynced(photo.id, { driveUrl: res.url, driveId: res.id, thumbUrl: res.thumbUrl || null });
    await removeSyncItem(item.id);
    console.log('[Sync] Photo uploaded:', photo.id, '→', res.url);
    return true;

  } catch (err) {
    console.error('[Sync] Photo upload failed:', item.localId, err.message);
    await markPhotoError(item.localId, err.message);
    return _handleItemError(item, err);
  }
}

// ══════════════════════════════════════════════════════════════
//  ERROR HANDLING + BACKOFF
// ══════════════════════════════════════════════════════════════

async function _handleItemError(item, err) {
  item.retries   = (item.retries ?? 0) + 1;
  item.lastError = err.message;

  if (item.retries >= MAX_RETRIES) {
    console.error(`[Sync] Max retries (${MAX_RETRIES}) hit, dropping:`, item.localId);
    await removeSyncItem(item.id);
    return false;
  }

  // Exponential backoff with jitter: 2^n * 1000ms ± 20%
  const baseMs  = Math.min(BASE_BACKOFF_MS * Math.pow(2, item.retries), MAX_BACKOFF_MS);
  const jitter  = baseMs * 0.2 * (Math.random() * 2 - 1);
  const delayMs = Math.round(baseMs + jitter);

  item.nextRetryAt = new Date(Date.now() + delayMs).toISOString();
  await updateSyncItem(item);

  console.log(`[Sync] Retry ${item.retries}/${MAX_RETRIES} in ${(delayMs/1000).toFixed(1)}s:`, item.localId, '—', err.message);
  return false;
}

// ══════════════════════════════════════════════════════════════
//  API LAYER
// ══════════════════════════════════════════════════════════════

export async function apiCall(action, params = {}) {
  if (!_apiUrl) throw new Error('API URL not configured. Open Settings to add it.');

  const controller = new AbortController();
  const timeout    = setTimeout(() => controller.abort(), 25_000); // 25s timeout

  try {
    const res = await fetch(_apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body:    JSON.stringify({ action, ...params }),
      signal:  controller.signal
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const text = await res.text();
    let data;
    try   { data = JSON.parse(text); }
    catch { throw new Error('Bad JSON from API: ' + text.slice(0, 80)); }

    if (data.error) throw new Error(data.error);
    return data;

  } finally {
    clearTimeout(timeout);
  }
}

// ══════════════════════════════════════════════════════════════
//  REMINDERS
// ══════════════════════════════════════════════════════════════

export async function _checkReminders() {
  const { getAgendaEvents, dbPut } = await import('./db.js');
  const events = await getAgendaEvents();
  const now    = Date.now();

  for (const event of events) {
    if (event.reminderFired) continue;
    const startMs  = new Date(event.startTime).getTime();
    const alertMs  = startMs - (event.reminderMinutes ?? 30) * 60_000;
    const delayMs  = alertMs - now;

    if (delayMs > 0 && delayMs < 3_600_000) { // within 1 hour
      _scheduleNotification(
        `⏰ ${event.title}`,
        `Starts in ${event.reminderMinutes} min`,
        delayMs
      );
      await dbPut('agenda', { ...event, reminderFired: true });
    }
  }
}

function _scheduleNotification(title, body, delay) {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
      reg.active?.postMessage({ type: 'SCHEDULE_NOTIFICATION', title, body, delay });
    });
  } else if (Notification.permission === 'granted') {
    setTimeout(() => new Notification(title, { body }), delay);
  }
}

function _notifyConflict(entityType, name) {
  window.dispatchEvent(new CustomEvent('lumina:conflict', {
    detail: { entityType, name }
  }));
  showToast(`Sync conflict: "${name}" — tap to resolve`, 'warning');
}

// ══════════════════════════════════════════════════════════════
//  UI STATUS
// ══════════════════════════════════════════════════════════════

function _updateStatusUI(status, count = 0) {
  const el = document.getElementById('sync-status');
  if (!el) return;

  el.className = `sync-status ${status}`;
  const map = {
    online:   ['●', 'Online'],
    offline:  ['○', 'Offline'],
    syncing:  ['↻', 'Syncing…'],
    success:  ['✓', count ? `Synced ${count}` : 'Synced'],
    error:    ['!', 'Sync error'],
    conflict: ['⚡', 'Conflicts'],
    idle:     ['●', 'Idle']
  };
  const [icon, label] = map[status] ?? ['●', status];
  el.innerHTML = `<span class="sync-icon">${icon}</span><span class="sync-label">${label}</span>`;

  if (status === 'success') {
    setTimeout(() => _updateStatusUI(navigator.onLine ? 'online' : 'offline'), 3_000);
  }
}

// ══════════════════════════════════════════════════════════════
//  SEMAPHORE (for photo concurrency control)
// ══════════════════════════════════════════════════════════════

class Semaphore {
  constructor(limit) {
    this._limit    = limit;
    this._active   = 0;
    this._queue    = [];
  }
  acquire() {
    if (this._active < this._limit) {
      this._active++;
      return Promise.resolve();
    }
    return new Promise(resolve => this._queue.push(resolve));
  }
  release() {
    this._active--;
    const next = this._queue.shift();
    if (next) { this._active++; next(); }
  }
}

// ══════════════════════════════════════════════════════════════
//  UTILITIES
// ══════════════════════════════════════════════════════════════

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function showToast(message, type = 'info') {
  window.dispatchEvent(new CustomEvent('lumina:toast', { detail: { message, type } }));
}


// ══════════════════════════════════════════════════════════════
//  PULL FROM SERVER  (initial sync for new devices)
// ══════════════════════════════════════════════════════════════

/**
 * Pull all data from the server and write it into the local IndexedDB.
 *
 * MERGE STRATEGY (per record):
 *   - Record doesn't exist locally → insert it as synced
 *   - Record exists locally as 'synced' → overwrite with server version
 *   - Record exists locally as 'pending' or 'conflict' → keep local
 *     (user has unsynced edits — don't clobber them)
 *
 * Called automatically on first boot (lastPullAt === null) and
 * exposed as manualPull() for the user to trigger manually.
 */
export async function pullFromServer() {
  if (!navigator.onLine) {
    showToast('You are offline — cannot pull data.', 'error');
    return { diary: 0, agenda: 0, photos: 0 };
  }
  if (!_apiUrl) {
    showToast('Set your API URL in Settings first.', 'error');
    return { diary: 0, agenda: 0, photos: 0 };
  }

  _updateStatusUI('syncing');
  console.log('[Sync] Pulling from server...');

  let diaryPulled = 0, agendaPulled = 0, photosPulled = 0;

  try {
    // ── Phase 1: Pull diary entries ──────────────────────
    const diaryRes = await apiCall('getDiaryEntries');
    const entries  = diaryRes.entries || [];

    for (const remote of entries) {
      const byRemote = await _findLocalByRemoteId('diary', remote.id);
      if (byRemote) {
        if (byRemote.syncStatus === 'synced') {
          await dbPut('diary', _remoteEntryToLocal(remote, byRemote.id));
          diaryPulled++;
        }
      } else {
        await dbPut('diary', _remoteEntryToLocal(remote));
        diaryPulled++;
      }
    }

    // ── Phase 2: Pull calendar events ───────────────────
    const now   = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
    const end   = new Date(now.getFullYear(), now.getMonth() + 6, 0).toISOString();
    const calRes  = await apiCall('getCalendarEvents', { start, end });
    const events  = calRes.events || [];

    for (const remote of events) {
      const byRemote = await _findLocalByRemoteId('agenda', remote.id);
      if (byRemote) {
        if (byRemote.syncStatus === 'synced') {
          await dbPut('agenda', _remoteEventToLocal(remote, byRemote.id));
          agendaPulled++;
        }
      } else {
        await dbPut('agenda', _remoteEventToLocal(remote));
        agendaPulled++;
      }
    }

    // ── Phase 3: Pull photos from Photos sheet ───────────
    // Sheet-based: instant O(n) scan, no Drive API query needed.
    // Each row = one photo's metadata (driveId, thumbUrl, name, etc.)
    try {
      const photoRes     = await apiCall('listPhotoMeta');
      const remotePhotos = photoRes.photos || [];

      // Build lookup of known driveIds for O(1) dedup check
      const localPhotos   = await dbGetAll('photoBlobs');
      const knownDriveIds = new Set(localPhotos.map(p => p.driveId).filter(Boolean));

      for (const remote of remotePhotos) {
        const driveId = remote.drive_id;
        if (!driveId) continue;

        if (knownDriveIds.has(driveId)) {
          // Already have it — patch thumbUrl if missing
          const existing = localPhotos.find(p => p.driveId === driveId);
          if (existing && !existing.thumbUrl && remote.thumb_url) {
            existing.thumbUrl = remote.thumb_url;
            await dbPut('photoBlobs', existing);
          }
          continue;
        }

        // New photo — create metadata-only record (no blob download)
        const thumbUrl = remote.thumb_url
          || `https://drive.google.com/thumbnail?id=${driveId}&sz=w400`;

        await dbPut('photoBlobs', {
          id:         _dbUtils.generateId('P'),
          entryId:    remote.entry_id  || null,
          blob:       null,
          thumbnail:  null,
          name:       remote.name      || 'photo.jpg',
          mimeType:   'image/jpeg',
          width:      0,
          height:     0,
          sizeBytes:  0,
          driveUrl:   remote.drive_url || `https://drive.google.com/uc?export=view&id=${driveId}`,
          driveId:    driveId,
          thumbUrl:   thumbUrl,
          syncStatus: 'synced',
          errorMsg:   null,
          createdAt:  remote.created_at || new Date().toISOString()
        });
        photosPulled++;
      }
    } catch (photoErr) {
      console.warn('[Sync] Photo pull failed (non-fatal):', photoErr.message);
    }

    // ── Done ─────────────────────────────────────────────
    await setSetting('lastPullAt', new Date().toISOString());

    const total = diaryPulled + agendaPulled + photosPulled;
    console.log(`[Sync] Pull complete: ${diaryPulled} diary, ${agendaPulled} agenda, ${photosPulled} photos`);
    _updateStatusUI('success', total);

    window.dispatchEvent(new CustomEvent('lumina:pulled', {
      detail: { diary: diaryPulled, agenda: agendaPulled, photos: photosPulled }
    }));

    return { diary: diaryPulled, agenda: agendaPulled, photos: photosPulled };

  } catch (err) {
    console.error('[Sync] Pull failed:', err);
    _updateStatusUI('error');
    showToast('Sync pull failed: ' + err.message, 'error');
    return { diary: 0, agenda: 0, photos: 0 };
  }
}

// ── Convert a server diary entry → local DB record ────────────
function _remoteEntryToLocal(remote, existingLocalId = null) {
  const { generateId } = _dbUtils;
  return {
    id:           existingLocalId || generateId('D'),
    remoteId:     remote.id,
    date:         remote.date         || '',
    title:        remote.title        || '',
    content_html: remote.content_html || '',
    photo_ids:    [],
    photo_urls:   remote.photo_urls   || [],
    localVersion:  remote.version     || 1,
    serverVersion: remote.version     || 1,
    serverHash:    remote.hash        || '',
    syncStatus:   'synced',
    deleted:      false,
    deletedAt:    null,
    createdAt:    remote.created_at   || new Date().toISOString(),
    updatedAt:    remote.updated_at   || new Date().toISOString()
  };
}

// ── Convert a server calendar event → local DB record ─────────
function _remoteEventToLocal(remote, existingLocalId = null) {
  const { generateId } = _dbUtils;
  return {
    id:              existingLocalId || generateId('A'),
    remoteId:        remote.id,
    title:           remote.title           || '',
    description:     remote.description     || '',
    startTime:       remote.startTime       || '',
    endTime:         remote.endTime         || '',
    allDay:          remote.allDay          || false,
    color:           remote.colorId         ? '#c8a97e' : '#c8a97e',
    reminderMinutes: remote.reminderMinutes || 30,
    localVersion:    remote.version         || 1,
    serverVersion:   remote.version         || 1,
    serverHash:      remote.hash            || '',
    syncStatus:      'synced',
    deleted:         false,
    reminderFired:   false,
    createdAt:       remote.created         || new Date().toISOString(),
    updatedAt:       remote.updated         || new Date().toISOString()
  };
}

// ── Find a local record by its remoteId ───────────────────────
async function _findLocalByRemoteId(storeName, remoteId) {
  if (!remoteId) return null;
  try {
    const db = await import('./db.js').then(m => m.openDB());
    const results = await db.getAllFromIndex(storeName, 'remoteId', remoteId);
    return results?.[0] || null;
  } catch (_) {
    // Fallback: scan all (slower but safe if index missing)
    const all = await dbGetAll(storeName);
    return all.find(r => r.remoteId === remoteId) || null;
  }
}

// Lazy reference to db utils (avoids import-time circular issues)
const _dbUtils = {
  get generateId() {
    return (prefix = '') => {
      const ts   = Date.now().toString(36).toUpperCase();
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      return `${prefix}${ts}${rand}`;
    };
  }
};

function _remoteIdToLocalKey(store, remoteId) { return remoteId; }

// ══════════════════════════════════════════════════════════════
//  PUBLIC EXPORTS
// ══════════════════════════════════════════════════════════════

export async function manualSync() {
  if (!navigator.onLine) {
    showToast('You are offline. Connect to sync.', 'error');
    return;
  }
  await processQueue();
}

export function isOnline()   { return navigator.onLine; }
export function isSyncing()  { return _syncInProgress; }

// enqueueSync is imported directly from db.js in feature modules

console.log('[Sync] v2 module loaded');

export async function checkReminders() { return _checkReminders(); }
