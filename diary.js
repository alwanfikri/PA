/* ============================================================
   Lumina PWA — diary.js
   Rich-text diary / logbook with photo support
   Uses Quill.js for editing
   ============================================================ */

import {
  saveDiaryEntry, getDiaryEntries, getDiaryEntry,
  softDeleteDiaryEntry, savePhotoBlob, generateId, blobToObjectURL
} from './db.js';
import { enqueueSync, scheduleSync } from './sync.js';
import { processAndQueuePhoto } from './drive.js';

let quillEditor = null;
let currentEditId = null;
let diaryPhotos = []; // Photos for current edit session

// ── Initialize diary module ───────────────────────────────────
export function initDiary() {
  renderDiaryList();
  bindDiaryEvents();
  console.log('[Diary] Module initialized');
}

// ── Render diary list ─────────────────────────────────────────
export async function renderDiaryList() {
  const container = document.getElementById('diary-list');
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner"></div>';

  const entries = await getDiaryEntries();

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✍️</div>
        <p>No diary entries yet.</p>
        <p class="empty-sub">Tap <strong>+ New Entry</strong> to start writing.</p>
      </div>`;
    return;
  }

  container.innerHTML = entries.map(entry => renderDiaryCard(entry)).join('');
}

function renderDiaryCard(entry) {
  const dateStr = formatDate(entry.date);
  const preview = stripHtml(entry.content_html).slice(0, 120) || '(No content)';
  const hasPhotos = entry.photo_urls && entry.photo_urls.length > 0;
  const syncIcon = entry.synced ? '' : '<span class="unsynced-dot" title="Not synced"></span>';

  return `
    <article class="diary-card" data-id="${entry.id}">
      <div class="diary-card-header">
        <div>
          <span class="diary-card-date">${dateStr}</span>
          ${syncIcon}
        </div>
        <div class="diary-card-actions">
          <button class="btn-icon" onclick="window.luminaDiary.editEntry('${entry.id}')" title="Edit">✏️</button>
          <button class="btn-icon btn-danger" onclick="window.luminaDiary.confirmDelete('${entry.id}')" title="Delete">🗑️</button>
        </div>
      </div>
      <h3 class="diary-card-title">${escapeHtml(entry.title) || 'Untitled'}</h3>
      <p class="diary-card-preview">${escapeHtml(preview)}</p>
      ${hasPhotos ? `<div class="diary-card-photos">${entry.photo_urls.map(url =>
        `<img src="${url}" class="diary-thumb" alt="photo" loading="lazy" onerror="this.style.display='none'">`
      ).join('')}</div>` : ''}
    </article>`;
}

// ── Diary editor ──────────────────────────────────────────────
export async function openDiaryEditor(entryId = null) {
  currentEditId = entryId;
  diaryPhotos = [];

  const modal = document.getElementById('diary-modal');
  const titleInput = document.getElementById('diary-title-input');
  const dateInput = document.getElementById('diary-date-input');
  const photoPreview = document.getElementById('diary-photo-preview');

  // Set defaults
  dateInput.value = new Date().toISOString().split('T')[0];
  titleInput.value = '';
  photoPreview.innerHTML = '';

  // Init or reset Quill
  if (!quillEditor) {
    initQuill();
  }
  quillEditor.setContents([]);

  if (entryId) {
    const entry = await getDiaryEntry(entryId);
    if (entry) {
      titleInput.value = entry.title || '';
      dateInput.value = entry.date || new Date().toISOString().split('T')[0];
      quillEditor.root.innerHTML = entry.content_html || '';
      diaryPhotos = (entry.photo_urls || []).map(url => ({ url, synced: true }));
      renderPhotoPreview();
    }
  }

  modal.classList.add('active');
  titleInput.focus();
}

function initQuill() {
  const toolbarOptions = [
    [{ 'size': ['small', false, 'large', 'huge'] }],
    ['bold', 'italic', 'underline', 'strike'],
    [{ 'color': [] }, { 'background': [] }],
    [{ 'list': 'ordered' }, { 'list': 'bullet' }, { 'list': 'check' }],
    [{ 'indent': '-1' }, { 'indent': '+1' }],
    [{ 'align': [] }],
    ['link'],
    ['clean']
  ];

  quillEditor = new Quill('#diary-editor', {
    theme: 'snow',
    placeholder: 'Write your thoughts...',
    modules: {
      toolbar: toolbarOptions
    }
  });
}

export function closeDiaryEditor() {
  const modal = document.getElementById('diary-modal');
  modal.classList.remove('active');
  currentEditId = null;
  diaryPhotos = [];
}

export async function saveDiaryEditorEntry() {
  const titleInput = document.getElementById('diary-title-input');
  const dateInput = document.getElementById('diary-date-input');
  const saveBtn = document.getElementById('diary-save-btn');

  const title = titleInput.value.trim();
  const date = dateInput.value;
  const content_html = quillEditor ? quillEditor.root.innerHTML : '';

  if (!title && !content_html.replace(/<[^>]+>/g, '').trim()) {
    alert('Please add a title or some content before saving.');
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    // Collect photo URLs (already uploaded or pending)
    const photoUrls = diaryPhotos
      .filter(p => p.url)
      .map(p => p.url);

    const entry = await saveDiaryEntry({
      id: currentEditId || undefined,
      title,
      date,
      content_html,
      photo_urls: photoUrls
    });

    // Queue sync
    await enqueueSync({ entityType: 'diary', operation: 'save', localId: entry.id, localVersion: entry.localVersion, priority: 1 });

    closeDiaryEditor();
    await renderDiaryList();

    showToast('Entry saved!', 'success');
  } catch (err) {
    console.error('[Diary] Save error:', err);
    showToast('Failed to save entry: ' + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Entry';
  }
}

export async function confirmDeleteEntry(entryId) {
  if (!confirm('Delete this diary entry? This cannot be undone.')) return;

  try {
    const entry = await softDeleteDiaryEntry(entryId);
    await enqueueSync({ entityType: 'diary', operation: 'delete', localId: entry.id, remoteId: entry.remoteId, priority: 1 });
    await renderDiaryList();
    showToast('Entry deleted', 'info');
  } catch (err) {
    console.error('[Diary] Delete error:', err);
    showToast('Failed to delete entry', 'error');
  }
}

// ── Photo handling ────────────────────────────────────────────
export async function handleDiaryPhotoUpload(files) {
  const photoPreview = document.getElementById('diary-photo-preview');
  if (!files || files.length === 0) return;

  for (const file of Array.from(files)) {
    if (!file.type.startsWith('image/')) continue;

    const tempId = generateId('temp_');
    const placeholder = document.createElement('div');
    placeholder.className = 'photo-thumb loading';
    placeholder.id = tempId;
    placeholder.innerHTML = '<div class="thumb-spinner"></div>';
    photoPreview.appendChild(placeholder);

    try {
      const result = await processAndQueuePhoto(file, currentEditId || 'draft');
      diaryPhotos.push({ id: result.photoId, url: result.driveUrl || result.objectURL, synced: !!result.driveUrl });

      const thumbEl = document.getElementById(tempId);
      if (thumbEl) {
        thumbEl.className = 'photo-thumb';
        thumbEl.innerHTML = `
          <img src="${result.objectURL}" alt="photo" loading="lazy">
          <button class="remove-photo" onclick="window.luminaDiary.removePhoto('${result.photoId}', this.parentElement)" title="Remove">✕</button>
          ${!result.driveUrl ? '<span class="photo-unsynced">↑</span>' : ''}
        `;
      }
    } catch (err) {
      console.error('[Diary] Photo upload error:', err);
      const thumbEl = document.getElementById(tempId);
      if (thumbEl) thumbEl.remove();
      showToast('Photo upload failed: ' + err.message, 'error');
    }
  }
}

function renderPhotoPreview() {
  const photoPreview = document.getElementById('diary-photo-preview');
  if (!photoPreview) return;

  photoPreview.innerHTML = diaryPhotos.map((p, i) => `
    <div class="photo-thumb">
      <img src="${p.url}" alt="photo" loading="lazy">
      <button class="remove-photo" onclick="window.luminaDiary.removePhotoByIndex(${i}, this.parentElement)" title="Remove">✕</button>
    </div>
  `).join('');
}

export function removePhoto(photoId, element) {
  diaryPhotos = diaryPhotos.filter(p => p.id !== photoId);
  element?.remove();
}

export function removePhotoByIndex(index, element) {
  diaryPhotos.splice(index, 1);
  element?.remove();
}

// ── Bind events ───────────────────────────────────────────────
function bindDiaryEvents() {
  // Photo upload trigger
  const photoInput = document.getElementById('diary-photo-input');
  if (photoInput) {
    photoInput.addEventListener('change', (e) => {
      handleDiaryPhotoUpload(e.target.files);
      e.target.value = ''; // Reset so same file can be added again
    });
  }

  // Listen for sync events to re-render
  window.addEventListener('lumina:synced', () => {
    if (document.getElementById('diary-tab')?.classList.contains('active')) {
      renderDiaryList();
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────
function stripHtml(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div.textContent || div.innerText || '';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function showToast(message, type = 'info') {
  window.dispatchEvent(new CustomEvent('lumina:toast', { detail: { message, type } }));
}

// ── Expose for onclick handlers ───────────────────────────────
window.luminaDiary = {
  editEntry: openDiaryEditor,
  confirmDelete: confirmDeleteEntry,
  removePhoto,
  removePhotoByIndex
};

console.log('[Diary] Module loaded');
