/* ============================================================
   Lumina PWA — drive.js  (v3)
   Photo gallery with carousel viewer, delete, and full sync
   ============================================================ */

import {
  savePhotoBlob, markPhotoSynced, markPhotoError,
  blobToObjectURL, dbGetAll, dbDelete, dbPut
} from './db.js';
import { enqueueSync, scheduleSync } from './sync.js';

// ── Compression settings ──────────────────────────────────────
const MAX_DIMENSION   = 1600;
const THUMB_DIMENSION = 200;
const TARGET_SIZE_KB  = 400;
const MIN_QUALITY     = 0.45;
const MAX_QUALITY     = 0.90;
const QUALITY_STEP    = 0.07;
const MIME_OUTPUT     = 'image/jpeg';

// ── In-memory gallery state (for carousel) ────────────────────
let _galleryPhotos = [];   // ordered array shown in grid
let _carouselIndex = 0;    // currently open photo index

// ── ObjectURL tracker ─────────────────────────────────────────
const _activeObjectURLs = new Set();
function trackURL(url) { if (url) _activeObjectURLs.add(url); return url; }
export function revokeAllObjectURLs() {
  _activeObjectURLs.forEach(u => URL.revokeObjectURL(u));
  _activeObjectURLs.clear();
}

// ══════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════

export function initPhotoGallery() {
  const input = document.getElementById('gallery-upload-input');
  if (input) {
    input.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      for (const file of files) {
        if (file.type.startsWith('image/')) await handleGalleryUpload(file);
      }
    });
  }

  _buildCarouselDOM();
  renderGallery();
  console.log('[Drive] Gallery v3 initialized');
}

// ══════════════════════════════════════════════════════════════
//  UPLOAD PIPELINE
// ══════════════════════════════════════════════════════════════

export async function processAndQueuePhoto(file, entryId = null) {
  if (!file || !file.type.startsWith('image/')) throw new Error('File must be an image');

  const arrayBuffer  = await file.arrayBuffer();
  const orientation  = readExifOrientation(arrayBuffer);
  const bitmap       = await createImageBitmapSafe(file);
  const { blob: compressedBlob, width, height } = await compressImageBitmap(bitmap, orientation);
  const thumbBlob    = await generateThumbnail(bitmap, orientation);
  bitmap.close?.();

  const photo = await savePhotoBlob({
    blob: compressedBlob, thumbnail: thumbBlob,
    name: file.name, mimeType: MIME_OUTPUT, width, height, entryId
  });

  await enqueueSync({ entityType: 'photo', operation: 'save', localId: photo.id, priority: 3, localVersion: 0 });
  scheduleSync(2_000);

  const objectURL = blobToObjectURL(compressedBlob);
  const sizeKb    = (compressedBlob.size / 1024).toFixed(0);

  return { photoId: photo.id, objectURL, thumbURL: blobToObjectURL(thumbBlob), width, height, sizeKb, synced: false };
}

// ══════════════════════════════════════════════════════════════
//  GALLERY RENDER
// ══════════════════════════════════════════════════════════════

async function handleGalleryUpload(file) {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  const placeholder = document.createElement('div');
  placeholder.className = 'gallery-item loading';
  placeholder.innerHTML = '<div class="thumb-spinner"></div>';
  grid.prepend(placeholder);

  try {
    const result = await processAndQueuePhoto(file, null);
    trackURL(result.objectURL);
    trackURL(result.thumbURL);

    placeholder.className = 'gallery-item';
    placeholder.innerHTML = `
      <img src="${result.thumbURL || result.objectURL}" alt="${escapeHtml(file.name)}" loading="lazy">
      <div class="gallery-item-overlay"><span class="gallery-sync-badge pending">↑</span></div>`;

    // Add to gallery state immediately
    await renderGallery();
    showToast(`Photo queued (${result.sizeKb} KB)`, 'success');
  } catch (err) {
    placeholder.remove();
    showToast('Photo failed: ' + err.message, 'error');
  }
}

export async function renderGallery() {
  const grid = document.getElementById('gallery-grid');
  if (!grid) return;

  const raw = await dbGetAll('photoBlobs');
  _galleryPhotos = raw
    .filter(p => !p.deleted)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Migrate: derive thumbUrl from driveId for old records
  for (const p of _galleryPhotos) {
    if (!p.thumbUrl && p.driveId) {
      p.thumbUrl = `https://drive.google.com/thumbnail?id=${p.driveId}&sz=w400`;
      await dbPut('photoBlobs', p);
    }
  }

  if (!_galleryPhotos.length) {
    grid.innerHTML = `
      <div class="gallery-empty">
        <div class="empty-icon">📷</div>
        <p>No photos yet.</p>
        <p class="empty-sub">Tap <strong>+ Upload</strong> to add images.</p>
      </div>`;
    return;
  }

  grid.innerHTML = '';
  _galleryPhotos.forEach((photo, index) => {
    const src = _getDisplaySrc(photo);
    if (!src) return;

    const badge = photo.syncStatus === 'synced' ? '✓'
                : photo.syncStatus === 'error'  ? '!'
                : '↑';
    const badgeClass = photo.syncStatus === 'synced' ? 'synced'
                     : photo.syncStatus === 'error'  ? 'error'
                     : 'pending';

    const item = document.createElement('div');
    item.className = 'gallery-item';
    item.dataset.index = index;
    item.innerHTML = `
      <img src="${src}" alt="${escapeHtml(photo.name)}" loading="lazy"
           onerror="this.closest('.gallery-item').style.opacity='0.4'">
      <div class="gallery-item-overlay">
        <span class="gallery-sync-badge ${badgeClass}">${badge}</span>
      </div>`;

    item.addEventListener('click', () => openCarousel(index));
    grid.appendChild(item);
  });
}

// ══════════════════════════════════════════════════════════════
//  CAROUSEL VIEWER
// ══════════════════════════════════════════════════════════════

function _buildCarouselDOM() {
  if (document.getElementById('lumina-carousel')) return; // already built

  const el = document.createElement('div');
  el.id        = 'lumina-carousel';
  el.className = 'carousel-overlay hidden';
  el.innerHTML = `
    <div class="carousel-backdrop"></div>
    <div class="carousel-container">
      <button class="carousel-close" aria-label="Close">✕</button>
      <button class="carousel-nav carousel-prev" aria-label="Previous">‹</button>
      <button class="carousel-nav carousel-next" aria-label="Next">›</button>

      <div class="carousel-media">
        <img id="carousel-img" src="" alt="" draggable="false">
        <div id="carousel-spinner" class="carousel-spinner">⟳</div>
      </div>

      <div class="carousel-footer">
        <div class="carousel-info">
          <span id="carousel-name" class="carousel-name"></span>
          <span id="carousel-counter" class="carousel-counter"></span>
        </div>
        <div class="carousel-actions">
          <a id="carousel-open-drive" href="#" target="_blank" rel="noopener"
             class="carousel-action-btn" title="Open in Drive">↗ Drive</a>
          <button id="carousel-delete-btn" class="carousel-action-btn carousel-delete"
                  title="Delete photo">🗑 Delete</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(el);

  // Close on backdrop click
  el.querySelector('.carousel-backdrop').addEventListener('click', closeCarousel);
  el.querySelector('.carousel-close').addEventListener('click', closeCarousel);

  // Navigation
  el.querySelector('.carousel-prev').addEventListener('click', (e) => { e.stopPropagation(); navigateCarousel(-1); });
  el.querySelector('.carousel-next').addEventListener('click', (e) => { e.stopPropagation(); navigateCarousel(1); });

  // Keyboard navigation
  document.addEventListener('keydown', (e) => {
    if (el.classList.contains('hidden')) return;
    if (e.key === 'Escape')      closeCarousel();
    if (e.key === 'ArrowLeft')   navigateCarousel(-1);
    if (e.key === 'ArrowRight')  navigateCarousel(1);
  });

  // Touch swipe
  let touchStartX = 0;
  el.addEventListener('touchstart', (e) => { touchStartX = e.touches[0].clientX; }, { passive: true });
  el.addEventListener('touchend', (e) => {
    const diff = touchStartX - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) navigateCarousel(diff > 0 ? 1 : -1);
  });

  // Delete button
  el.querySelector('#carousel-delete-btn').addEventListener('click', async () => {
    const photo = _galleryPhotos[_carouselIndex];
    if (!photo) return;
    if (!confirm(`Delete "${photo.name}"? This cannot be undone.`)) return;
    await deletePhoto(photo);
  });
}

function openCarousel(index) {
  _carouselIndex = Math.max(0, Math.min(index, _galleryPhotos.length - 1));
  const el = document.getElementById('lumina-carousel');
  if (!el) return;
  el.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  _renderCarouselSlide();
}

function closeCarousel() {
  const el = document.getElementById('lumina-carousel');
  if (!el) return;
  el.classList.add('hidden');
  document.body.style.overflow = '';
  // Clear img src to stop loading
  const img = document.getElementById('carousel-img');
  if (img) img.src = '';
}

function navigateCarousel(dir) {
  const newIndex = _carouselIndex + dir;
  if (newIndex < 0 || newIndex >= _galleryPhotos.length) return;
  _carouselIndex = newIndex;
  _renderCarouselSlide();
}

function _renderCarouselSlide() {
  const photo   = _galleryPhotos[_carouselIndex];
  if (!photo) return;

  const img      = document.getElementById('carousel-img');
  const spinner  = document.getElementById('carousel-spinner');
  const name     = document.getElementById('carousel-name');
  const counter  = document.getElementById('carousel-counter');
  const openBtn  = document.getElementById('carousel-open-drive');
  const delBtn   = document.getElementById('carousel-delete-btn');
  const prevBtn  = document.querySelector('.carousel-prev');
  const nextBtn  = document.querySelector('.carousel-next');

  // Show spinner while loading
  img.style.opacity = '0';
  spinner.style.display = 'block';

  // Full-res src: prefer Drive full image, fallback to thumb, fallback to blob
  const fullSrc = photo.driveId
    ? `https://drive.google.com/thumbnail?id=${photo.driveId}&sz=w1600`
    : _getDisplaySrc(photo);

  img.onload = () => {
    spinner.style.display = 'none';
    img.style.opacity = '1';
  };
  img.onerror = () => {
    spinner.style.display = 'none';
    img.style.opacity = '0.4';
    // Fall back to thumb if full-res fails
    if (img.src !== _getDisplaySrc(photo)) img.src = _getDisplaySrc(photo);
  };
  img.src = fullSrc;
  img.alt = photo.name;

  name.textContent    = photo.name || '';
  counter.textContent = `${_carouselIndex + 1} / ${_galleryPhotos.length}`;

  if (photo.driveId) {
    openBtn.href = `https://drive.google.com/file/d/${photo.driveId}/view`;
    openBtn.style.display = '';
  } else {
    openBtn.style.display = 'none';
  }

  // Delete always available
  delBtn.style.display = '';

  // Show/hide nav arrows
  prevBtn.style.visibility = _carouselIndex > 0 ? 'visible' : 'hidden';
  nextBtn.style.visibility = _carouselIndex < _galleryPhotos.length - 1 ? 'visible' : 'hidden';
}

// ══════════════════════════════════════════════════════════════
//  DELETE
// ══════════════════════════════════════════════════════════════

async function deletePhoto(photo) {
  try {
    if (photo.driveId) {
      // Queue delete on server — sync engine will call deletePhoto action
      await enqueueSync({
        entityType: 'photo',
        operation:  'delete',
        localId:    photo.id,
        remoteId:   photo.driveId,
        priority:   2,
        localVersion: 0
      });
      scheduleSync(1_000);
    }

    // Remove from local DB immediately
    await dbDelete('photoBlobs', photo.id);

    showToast('Photo deleted', 'info');
    closeCarousel();
    await renderGallery();
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════
//  COMPRESSION
// ══════════════════════════════════════════════════════════════

async function compressImageBitmap(bitmap, orientation = 1) {
  const { dw, dh } = calculateDimensions(bitmap.width, bitmap.height, orientation, MAX_DIMENSION);
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx    = canvas.getContext('2d');
  applyOrientation(ctx, dw, dh, orientation);
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, dw, dh);

  let quality = MAX_QUALITY, blob;
  do {
    blob = await canvas.convertToBlob({ type: MIME_OUTPUT, quality });
    if (blob.size <= TARGET_SIZE_KB * 1024 || quality <= MIN_QUALITY) break;
    quality = Math.max(MIN_QUALITY, quality - QUALITY_STEP);
  } while (quality > MIN_QUALITY);

  return { blob, width: dw, height: dh };
}

async function generateThumbnail(bitmap, orientation = 1) {
  const { dw, dh } = calculateDimensions(bitmap.width, bitmap.height, orientation, THUMB_DIMENSION);
  const canvas = new OffscreenCanvas(dw, dh);
  const ctx    = canvas.getContext('2d');
  applyOrientation(ctx, dw, dh, orientation);
  ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, dw, dh);
  return canvas.convertToBlob({ type: MIME_OUTPUT, quality: 0.7 });
}

function calculateDimensions(srcW, srcH, orientation, maxDim) {
  const swapped = orientation >= 5 && orientation <= 8;
  const logicalW = swapped ? srcH : srcW;
  const logicalH = swapped ? srcW : srcH;
  const ratio    = Math.min(1, maxDim / Math.max(logicalW, logicalH));
  return { dw: Math.round(logicalW * ratio), dh: Math.round(logicalH * ratio) };
}

function applyOrientation(ctx, dw, dh, orientation) {
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0,  1, dw,  0);  break;
    case 3: ctx.transform(-1, 0, 0, -1, dw, dh);  break;
    case 4: ctx.transform( 1, 0, 0, -1,  0, dh);  break;
    case 5: ctx.transform( 0, 1,  1, 0,  0,  0);  break;
    case 6: ctx.transform( 0, 1, -1, 0, dh,  0);  break;
    case 7: ctx.transform( 0,-1, -1, 0, dh, dw);  break;
    case 8: ctx.transform( 0,-1,  1, 0,  0, dw);  break;
    default: break;
  }
}

// ══════════════════════════════════════════════════════════════
//  EXIF ORIENTATION READER
// ══════════════════════════════════════════════════════════════

function readExifOrientation(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0) !== 0xFFD8) return 1;
    let offset = 2;
    while (offset < buffer.byteLength) {
      const marker = view.getUint16(offset); offset += 2;
      if (marker === 0xFFE1) {
        offset += 2;
        if (String.fromCharCode(view.getUint8(offset), view.getUint8(offset+1),
            view.getUint8(offset+2), view.getUint8(offset+3)) !== 'Exif') return 1;
        const tiff      = offset + 6;
        const le        = view.getUint16(tiff) === 0x4949;
        const get16     = o => view.getUint16(tiff + o, le);
        const get32     = o => view.getUint32(tiff + o, le);
        const ifdOff    = get32(4);
        const entries   = get16(ifdOff);
        for (let i = 0; i < entries; i++) {
          const e = ifdOff + 2 + i * 12;
          if (get16(e) === 0x0112) return get16(e + 8);
        }
        return 1;
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      offset += view.getUint16(offset);
    }
  } catch (_) {}
  return 1;
}

async function createImageBitmapSafe(file) {
  if (typeof createImageBitmap !== 'undefined') return createImageBitmap(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };
    img.src = url;
  });
}

// ══════════════════════════════════════════════════════════════
//  HELPERS
// ══════════════════════════════════════════════════════════════

function _getDisplaySrc(photo) {
  if (photo.thumbUrl)                   return photo.thumbUrl;
  if (photo.thumbnail || photo.blob)    return trackURL(blobToObjectURL(photo.thumbnail || photo.blob));
  if (photo.driveId)                    return `https://drive.google.com/thumbnail?id=${photo.driveId}&sz=w400`;
  return null;
}

function escapeHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showToast(message, type = 'info') {
  window.dispatchEvent(new CustomEvent('lumina:toast', { detail: { message, type } }));
}

console.log('[Drive] v3 module loaded');
