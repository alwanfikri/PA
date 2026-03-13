/* ============================================================
   Lumina PWA — sync.js
   Auto Sync + Photo Sync Fix
   ============================================================ */

import {
  dbGet,
  dbPut,
  dbGetAll,
  getSetting,
  setSetting,
  getSyncQueue,
  removeSyncItem,
  markPhotoSynced,
  getPhotoBlob,
  enqueueSync
} from "./db.js";

export { enqueueSync } from "./db.js";

let _apiUrl = "";
let _syncInProgress = false;
let _syncTimer = null;
let _autoPullTimer = null;

/* ============================================================
   INIT
   ============================================================ */

export async function initSync() {

  _apiUrl = await getSetting("apiUrl", "");

  if (navigator.onLine && _apiUrl) {

    scheduleSync(2000);
    startAutoPull();

  }

  window.addEventListener("online", () => {

    scheduleSync(1000);
    startAutoPull();

  });

  console.log("[Sync] initialized");

}

export function setApiUrl(url) {

  _apiUrl = url;

}

/* ============================================================
   AUTO SYNC
   ============================================================ */

function startAutoPull() {

  if (_autoPullTimer) clearInterval(_autoPullTimer);

  _autoPullTimer = setInterval(async () => {

    if (!navigator.onLine) return;

    await pullFromServer();

  }, 3000); // every 3 seconds

}

/* ============================================================
   SYNC QUEUE
   ============================================================ */

export function scheduleSync(delay = 2000) {

  if (_syncTimer) clearTimeout(_syncTimer);

  _syncTimer = setTimeout(() => {

    if (navigator.onLine && _apiUrl) processQueue();

  }, delay);

}

export async function processQueue() {

  if (_syncInProgress) return;
  if (!_apiUrl) return;

  _syncInProgress = true;

  try {

    const queue = await getSyncQueue();

    for (const item of queue) {

      if (item.entityType === "photo") {

        await uploadPhoto(item);

      }

    }

  } catch (err) {

    console.error("[Sync] error", err);

  }

  _syncInProgress = false;

}

/* ============================================================
   PHOTO UPLOAD
   ============================================================ */

async function uploadPhoto(item) {

  const photo = await getPhotoBlob(item.localId);

  if (!photo) return;

  const base64 = await blobToBase64(photo.blob);

  const res = await apiCall("uploadPhoto", {

    base64,
    name: photo.name

  });

  await markPhotoSynced(photo.id, {

    driveId: res.driveId,
    driveUrl: res.driveUrl,
    thumbUrl: res.thumbUrl

  });

  await removeSyncItem(item.id);

}

/* ============================================================
   PULL DATA FROM SERVER
   ============================================================ */

export async function pullFromServer() {

  if (!_apiUrl) return;

  try {

    const response = await apiCall("listPhotoMeta");

    const remotePhotos = response.photos || [];

    const localPhotos = await dbGetAll("photoBlobs");

    const knownDriveIds = new Set(

      localPhotos.map(p => p.driveId).filter(Boolean)

    );

    let photosPulled = 0;

    for (const remote of remotePhotos) {

      const driveId =
        remote.driveId ||
        remote.drive_id;

      if (!driveId) continue;

      if (knownDriveIds.has(driveId)) continue;

      const thumbUrl =
        remote.thumbUrl ||
        remote.thumb_url ||
        `https://drive.google.com/thumbnail?id=${driveId}&sz=w400`;

      const driveUrl =
        remote.driveUrl ||
        remote.drive_url ||
        `https://drive.google.com/uc?export=view&id=${driveId}`;

      await dbPut("photoBlobs", {

        id: generateId("P"),

        entryId:
          remote.entryId ||
          remote.entry_id ||
          null,

        blob: null,

        thumbnail: null,

        name: remote.name || "photo.jpg",

        mimeType: "image/jpeg",

        width: 0,
        height: 0,
        sizeBytes: 0,

        driveId: driveId,
        driveUrl: driveUrl,
        thumbUrl: thumbUrl,

        syncStatus: "synced",

        createdAt:
          remote.createdAt ||
          remote.created_at ||
          new Date().toISOString()

      });

      photosPulled++;

    }

    if (photosPulled > 0) {

      console.log("[Sync] new photos pulled:", photosPulled);

      window.dispatchEvent(
        new CustomEvent("lumina:pulled", {
          detail: { photos: photosPulled }
        })
      );

    }

  } catch (err) {

    console.error("[Sync] pull error", err);

  }

}

/* ============================================================
   API CALL
   ============================================================ */

async function apiCall(action, params = {}) {

  const res = await fetch(_apiUrl, {

    method: "POST",

    headers: {
      "Content-Type": "text/plain"
    },

    body: JSON.stringify({
      action,
      ...params
    })

  });

  const text = await res.text();

  return JSON.parse(text);

}

/* ============================================================
   UTIL
   ============================================================ */

function blobToBase64(blob) {

  return new Promise((resolve, reject) => {

    const reader = new FileReader();

    reader.onload = e => {

      const base64 = e.target.result.split(",")[1];
      resolve(base64);

    };

    reader.onerror = reject;

    reader.readAsDataURL(blob);

  });

}

function generateId(prefix = "") {

  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);

  return prefix + ts + rand;

}