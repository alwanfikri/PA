/* ============================================================
   Lumina PWA — drive.js  (v2)
   Image compression pipeline + Drive upload via Apps Script

   KEY IMPROVEMENTS over v1:
   ─────────────────────────────────────────────────────────
   1. MULTI-PASS COMPRESSION — iterative quality reduction
      until the file is under a target size, not a fixed quality.

   2. EXIF STRIP + ORIENTATION FIX — reads EXIF orientation tag
      and rotates canvas accordingly before re-encoding. Prevents
      upside-down photos from mobile cameras.

   3. THUMBNAIL GENERATION — creates a 200px Blob alongside the
      full compressed image. Stored in IndexedDB for instant
      display without loading the full image.

   4. BLOB STORAGE — images are stored as Blobs (not base64)
      for ~37% storage savings. Base64 is only produced at
      upload time and never persisted.

   5. PROGRESSIVE UPLOAD — photos are queued individually and
      upload concurrently (max 2 at a time) via the sync engine.
   ============================================================ */

import {
  savePhotoBlob, getPendingPhotos, markPhotoSynced, markPhotoError,
  blobToObjectURL, generateId
} from './db.js';
import { enqueueSync } from './sync.js';

// ── Compression targets ────────────────────────────────────────
const MAX_DIMENSION   = 1600;   // px — max long edge
const THUMB_DIMENSION = 200;    // px — thumbnail long edge
const TARGET_SIZE_KB  = 400;    // target output size
const MIN_QUALITY     = 0.45;   // never compress below this
const MAX_QUALITY     = 0.90;   // start here and step down
const QUALITY_STEP    = 0.07;   // quality decrement per pass
const MIME_OUTPUT     = 'image/jpeg';

// ══════════════════════════════════════════════════════════════
//  PUBLIC API
// ══════════════════════════════════════════════════════════════

/**
 * Full pipeline: validate → read EXIF → resize → compress → thumbnail
 * → store Blob in IndexedDB → queue for Drive upload.
 *
 * Returns { photoId, objectURL, width, height, sizeKb, synced: false }
 * Caller should call URL.revokeObjectURL(objectURL) when no longer needed.
 */
export async function processAndQueuePhoto(file, entryId = null) {
  if (!file || !file.type.startsWith('image/')) {
    throw new Error('File must be an image');
  }

  const originalSizeKb = (file.size / 1024).toFixed(0);
  console.log(`[Drive] Processing: ${file.name} (${originalSizeKb} KB, ${file.type})`);

  // Step 1: Read raw bytes (needed for EXIF)
  const arrayBuffer = await file.arrayBuffer();

  // Step 2: Parse EXIF orientation
  const orientation = readExifOrientation(arrayBuffer);

  // Step 3: Decode image
  const bitmap = await createImageBitmapSafe(file);

  // Step 4: Compress full image
  const { blob: compressedBlob, width, height } = await compressImageBitmap(bitmap, orientation);
  const compressedKb = (compressedBlob.size / 1024).toFixed(0);
  console.log(`[Drive] Compressed: ${compressedKb} KB (was ${originalSizeKb} KB)`);

  // Step 5: Generate thumbnail Blob
  const thumbBlob = await generateThumbnail(bitmap, orientation);

  bitmap.close?.(); // Free bitmap memory

  // Step 6: Store in IndexedDB as Blob (not base64)
  const photo = await savePhotoBlob({
    blob:      compressedBlob,
    thumbnail: thumbBlob,
    name:      file.name,
    mimeType:  MIME_OUTPUT,
    width,
    height,
    entryId
  });

  // Step 7: Queue for background upload (priority 3 = medium)
  await enqueueSync({
    entityType:   'photo',
    operation:    'save',
    localId:      photo.id,
    priority:     3,
    localVersion: 0
  });

  // Step 8: Return ObjectURL for immediate display
  const objectURL = blobToObjectURL(compressedBlob);

  return {
    photoId:   photo.id,
    objectURL,           // revoke when no longer needed
    thumbURL:  blobToObjectURL(thumbBlob),
    width,
    height,
    sizeKb:    compressedKb,
    synced:    false
  };
}

// ══════════════════════════════════════════════════════════════
//  COMPRESSION
// ══════════════════════════════════════════════════════════════

/**
 * Compress an ImageBitmap using multi-pass quality reduction.
 * Applies EXIF rotation fix before encoding.
 */
async function compressImageBitmap(bitmap, orientation = 1) {
  const { sw, sh, dw, dh, transforms } = calculateDimensions(
    bitmap.width, bitmap.height, orientation, MAX_DIMENSION
  );

  const canvas = new OffscreenCanvas(dw, dh);
  const ctx    = canvas.getContext('2d');

  // Apply transform for EXIF orientation
  applyOrientation(ctx, dw, dh, orientation);
  ctx.drawImage(bitmap, 0, 0, sw, sh, 0, 0, ...transforms);

  // Multi-pass compression
  let quality = MAX_QUALITY;
  let blob;

  do {
    blob = await canvas.convertToBlob({ type: MIME_OUTPUT, quality });
    if (blob.size <= TARGET_SIZE_KB * 1024 || quality <= MIN_QUALITY) break;
    quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
  } while (quality > MIN_QUALITY);

  return { blob, width: dw, height: dh };
}

/**
 * Generate a small thumbnail Blob (THUMB_DIMENSION × auto).
 */
async function generateThumbnail(bitmap, orientation = 1) {
  const { sw, sh, dw, dh, transforms } = calculateDimensions(
    bitmap.width, bitmap.height, orientation, THUMB_DIMENSION
  );

  const canvas = new OffscreenCanvas(dw, dh);
  const ctx    = canvas.getContext('2d');

  applyOrientation(ctx, dw, dh, orientation);
  ctx.drawImage(bitmap, 0, 0, sw, sh, 0, 0, ...transforms);

  return canvas.convertToBlob({ type: MIME_OUTPUT, quality: 0.7 });
}

// ── Dimension / transform calculator ─────────────────────────
function calculateDimensions(srcW, srcH, orientation, maxDim) {
  // For orientations 5-8, width and height are swapped
  const swapped = orientation >= 5 && orientation <= 8;
  const logicalW = swapped ? srcH : srcW;
  const logicalH = swapped ? srcW : srcH;

  const ratio = Math.min(1, maxDim / Math.max(logicalW, logicalH));
  const dw    = Math.round(logicalW * ratio);
  const dh    = Math.round(logicalH * ratio);

  return {
    sw: srcW, sh: srcH,
    dw, dh,
    transforms: [dw, dh]  // destination width, height for drawImage
  };
}

// ── Apply EXIF orientation transform to canvas context ────────
function applyOrientation(ctx, dw, dh, orientation) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, dw, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, dw, dh); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, dh); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, dh, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, dh, dw); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, dw); break;
    default: break; // 1 = normal
  }
}

// ══════════════════════════════════════════════════════════════
//  EXIF ORIENTATION READER
// ══════════════════════════════════════════════════════════════

/**
 * Parse EXIF orientation from raw ArrayBuffer (JPEG only).
 * Returns 1–8 (1 = normal). Fast binary scan — no library needed.
 */
function readExifOrientation(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xFFD8) return 1; // not JPEG

    let offset = 2;
    const length = buffer.byteLength;

    while (offset < length) {
      const marker = view.getUint16(offset);
      offset += 2;

      if (marker === 0xFFE1) { // APP1 (EXIF)
        const exifLength = view.getUint16(offset);
        offset += 2;

        // Check for "Exif" header
        const exifHeader = String.fromCharCode(
          view.getUint8(offset), view.getUint8(offset+1),
          view.getUint8(offset+2), view.getUint8(offset+3)
        );
        if (exifHeader !== 'Exif') return 1;

        // TIFF header starts at offset+6
        const tiffOffset = offset + 6;
        const littleEndian = view.getUint16(tiffOffset) === 0x4949;

        const getUint16 = (o) => view.getUint16(tiffOffset + o, littleEndian);
        const getUint32 = (o) => view.getUint32(tiffOffset + o, littleEndian);

        const ifdOffset  = getUint32(4);
        const ifdEntries = getUint16(ifdOffset);

        for (let i = 0; i < ifdEntries; i++) {
          const entryOffset = ifdOffset + 2 + i * 12;
          const tag = getUint16(entryOffset);
          if (tag === 0x0112) { // Orientation tag
            return getUint16(entryOffset + 8);
          }
        }
        return 1;
      }

      if ((marker & 0xFF00) !== 0xFF00) break;
      offset += view.getUint16(offset);
    }
  } catch (_) { /* silent — return default */ }
  return 1;
}

// ══════════════════════════════════════════════════════════════
//  SAFE IMAGE DECODE
// ══════════════════════════════════════════════════════════════

/** createImageBitmap with fallback for Safari/older browsers */
async function createImageBitmapSafe(file) {
  if (typeof createImageBitmap !== 'undefined') {
    return createImageBitmap(file);
  }
  // Canvas fallback
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// ══════════════════════════════════════════════════════════════
//  GALLERY
// ══════════════════════════════════════════════════════════════

// Track ObjectURLs so we can revoke them on cleanup
const _activeObjectURLs = new Set();

function trackURL(url) {
  if (url) _activeObjectURLs.add(url);
  return url;
}

export function revokeAllObjectURLs() {
  _activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
  _activeObjectURLs.clear();
}

export function initPhotoGallery() {
  const input = document.getElementById('gallery-upload-input');
  if (!input) return;

  input.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    for (const file of files) {
      if (file.type.startsWith('image/')) await handleGalleryUpload(file);
    }
  });

  renderGallery();
  console.log('[Drive] Gallery initialized');
}

async function handleGalleryUpload(file) {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  const placeholder = Object.assign(document.createElement('div'), {
    className: 'gallery-item loading',
    innerHTML: '<div class="thumb-spinner"></div>'
  });
  grid.prepend(placeholder);

  try {
    const result = await processAndQueuePhoto(file, null);
    trackURL(result.objectURL);
    trackURL(result.thumbURL);

    placeholder.className = 'gallery-item';
    placeholder.innerHTML = `
      <img src="${result.thumbURL || result.objectURL}" alt="${escapeHtml(file.name)}" loading="lazy">
      <div class="gallery-item-overlay">
        <span class="gallery-sync-badge pending">↑ Pending</span>
      </div>
      <div class="gallery-item-meta">${result.sizeKb} KB</div>`;

    showToast(`Photo queued for upload (${result.sizeKb} KB)`, 'success');
  } catch (err) {
    placeholder.remove();
    showToast('Photo processing failed: ' + err.message, 'error');
    console.error('[Drive] Upload error:', err);
  }
}

export async function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  const { dbGetAll } = await import('./db.js');
  const photos = (await dbGetAll('photoBlobs'))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (!photos.length) {
    grid.innerHTML = `
      <div class="gallery-empty">
        <div class="empty-icon">📷</div>
        <p>No photos yet.</p>
        <p class="empty-sub">Tap <strong>+ Upload</strong> to add images.</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  for (const photo of photos) {
    const item = document.createElement('div');
    item.className = 'gallery-item';

    let src = photo.driveUrl || null;
    if (!src && (photo.thumbnail || photo.blob)) {
      src = trackURL(blobToObjectURL(photo.thumbnail || photo.blob));
    }

    if (!src) continue;

    const badge = photo.syncStatus === 'synced'
      ? '<span class="gallery-sync-badge synced">✓</span>'
      : photo.syncStatus === 'error'
        ? '<span class="gallery-sync-badge error">!</span>'
        : '<span class="gallery-sync-badge pending">↑</span>';

    item.innerHTML = `
      <img src="${src}" alt="${escapeHtml(photo.name)}" loading="lazy">
      <div class="gallery-item-overlay">${badge}</div>`;
    grid.appendChild(item);
  }
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(message, type = 'info') {
  window.dispatchEvent(new CustomEvent('lumina:toast', { detail: { message, type } }));
}

console.log('[Drive] v2 module loaded');
