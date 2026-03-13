/* ============================================================
   Lumina PWA — app.js
   Main application controller
   Handles: navigation, tab switching, settings, toasts,
            SW registration, install prompt, init
   ============================================================ */

import { openDB, getSetting, setSetting, getSyncStats, getUnresolvedConflicts } from './db.js';
import { initSync, setApiUrl, manualSync, pullFromServer, isOnline, processQueue, scheduleSync } from './sync.js';
import { initDiary, openDiaryEditor, closeDiaryEditor, saveDiaryEditorEntry } from './diary.js';
import { initCalendar, openEventEditor, closeEventEditor, saveEventEditorEntry, setAgendaView } from './calendar.js';
import { initPhotoGallery } from './drive.js';

let installPromptEvent = null;

// ── App boot ──────────────────────────────────────────────────
async function boot() {
  console.log('[App] Booting Lumina…');

  // Show splash briefly
  await showSplash();

  // Initialize IndexedDB
  await openDB();

  // Register Service Worker
  await registerServiceWorker();

  // Load settings
  const apiUrl = await getSetting('apiUrl', '');

  // Initialize sync engine
  await initSync();
  if (apiUrl) setApiUrl(apiUrl);

  // ── First-run pull: if this device has never synced, pull everything ──
  // This is what makes a second device see existing data immediately.
  if (apiUrl) {
    const lastPull = await getSetting('lastPullAt', null);
    if (!lastPull) {
      console.log('[App] First run — pulling data from server...');
      showToast('First sync — pulling your data…', 'info');
      const pullResult = await pullFromServer();
      if (pullResult.photos > 0) {
        // Gallery needs to re-render after module init
        setTimeout(async () => {
          const m = await import('./drive.js');
          m.renderGallery?.();
        }, 500);
      }
    }
  }

  // Initialize feature modules
  await initDiary();
  await initCalendar();
  initPhotoGallery();

  // Bind global UI events
  bindGlobalEvents();
  bindNavigation();
  bindSettings();
  bindInstallBanner();

  // Handle deep-link params
  handleUrlParams();

  // Set initial tab
  const savedTab = await getSetting('lastTab', 'agenda');
  switchTab(savedTab, false);

  // Update sync status badge
  updateSyncBadge();

  hideSplash();
  console.log('[App] Boot complete');
}

// ── Splash screen ─────────────────────────────────────────────
async function showSplash() {
  return new Promise(resolve => {
    const splash = document.getElementById('splash');
    if (splash) splash.style.display = 'flex';
    setTimeout(resolve, 800);
  });
}

function hideSplash() {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.style.opacity = '0';
    setTimeout(() => splash.style.display = 'none', 400);
  }
}

// ── Service Worker Registration ───────────────────────────────
async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('[App] Service Worker not supported');
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/service-worker.js', { scope: '/' });
    console.log('[App] SW registered:', reg.scope);

    reg.addEventListener('updatefound', () => {
      const newWorker = reg.installing;
      newWorker.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          showUpdateBanner();
        }
      });
    });

    // Register for periodic sync if supported
    if ('periodicSync' in reg) {
      try {
        await reg.periodicSync.register('check-reminders', { minInterval: 60 * 60 * 1000 });
      } catch (e) {
        console.warn('[App] Periodic sync not available:', e.message);
      }
    }
  } catch (err) {
    console.error('[App] SW registration failed:', err);
  }
}

// ── Tab navigation ────────────────────────────────────────────
function bindNavigation() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

export function switchTab(tabName, save = true) {
  // Hide all tabs
  document.querySelectorAll('.tab-content').forEach(tab => {
    tab.classList.remove('active');
  });
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.classList.remove('active');
  });

  // Show target
  const tabEl = document.getElementById(tabName + '-tab');
  const navBtn = document.querySelector(`[data-tab="${tabName}"]`);
  if (tabEl) tabEl.classList.add('active');
  if (navBtn) navBtn.classList.add('active');

  if (save) setSetting('lastTab', tabName);
}

// ── Global UI events ──────────────────────────────────────────
function bindGlobalEvents() {
  // Toast system
  window.addEventListener('lumina:toast', (e) => {
    showToast(e.detail.message, e.detail.type);
  });

  // FAB (floating action button) clicks
  document.getElementById('fab-diary')?.addEventListener('click', () => openDiaryEditor());
  document.getElementById('fab-agenda')?.addEventListener('click', () => openEventEditor());

  // Diary modal controls
  document.getElementById('diary-close-btn')?.addEventListener('click', closeDiaryEditor);
  document.getElementById('diary-save-btn')?.addEventListener('click', saveDiaryEditorEntry);
  document.getElementById('diary-modal-overlay')?.addEventListener('click', closeDiaryEditor);

  // Event modal controls
  document.getElementById('event-close-btn')?.addEventListener('click', closeEventEditor);
  document.getElementById('event-save-btn')?.addEventListener('click', saveEventEditorEntry);
  document.getElementById('event-modal-overlay')?.addEventListener('click', closeEventEditor);

  // Agenda view toggle
  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => setAgendaView(btn.dataset.view));
  });

  // Sync button
  document.getElementById('sync-btn')?.addEventListener('click', async () => {
    await manualSync();
    updateSyncBadge();
  });

  // Gallery upload button
  document.getElementById('gallery-upload-btn')?.addEventListener('click', () => {
    document.getElementById('gallery-upload-input')?.click();
  });

  // Listen for synced events to update badge
  window.addEventListener('lumina:synced', updateSyncBadge);
  window.addEventListener('lumina:pulled', async (e) => {
    updateSyncBadge();
    const detail = e.detail || {};
    // Re-render active tab after pull
    const activeTab = document.querySelector('.tab-content.active')?.id;
    if (activeTab === 'diary-tab')   { const m = await import('./diary.js');    m.renderDiaryList?.(); }
    if (activeTab === 'agenda-tab')  { const m = await import('./calendar.js'); m.renderCalendar?.(); }
    if (activeTab === 'photos-tab')  { const m = await import('./drive.js');    m.renderGallery?.(); }
    // Always refresh gallery in background if photos were pulled
    if (detail.photos > 0 && activeTab !== 'photos-tab') {
      const m = await import('./drive.js');
      m.renderGallery?.();
    }
  });
  window.addEventListener('lumina:conflict', (e) => {
    updateSyncBadge();
    const { name } = e.detail;
    showToast('Conflict: ' + name + ' needs manual resolution', 'error');
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', handleKeyboard);

  // Pull-to-refresh (simple implementation)
  setupPullToRefresh();
}

function handleKeyboard(e) {
  // Escape closes modals
  if (e.key === 'Escape') {
    const openModal = document.querySelector('.modal.active');
    if (openModal) {
      openModal.classList.remove('active');
    }
  }
}

function setupPullToRefresh() {
  let startY = 0;
  let pulling = false;

  document.addEventListener('touchstart', (e) => {
    if (window.scrollY === 0) {
      startY = e.touches[0].clientY;
      pulling = true;
    }
  }, { passive: true });

  document.addEventListener('touchend', async (e) => {
    if (!pulling) return;
    const endY = e.changedTouches[0].clientY;
    const diff = endY - startY;
    if (diff > 80) {
      console.log('[App] Pull to refresh triggered');
      await manualSync();
      updateSyncBadge();
    }
    pulling = false;
  }, { passive: true });
}

// ── Settings panel ────────────────────────────────────────────
function bindSettings() {
  const settingsBtn = document.getElementById('settings-btn');
  const settingsPanel = document.getElementById('settings-panel');
  const settingsClose = document.getElementById('settings-close-btn');
  const apiUrlInput = document.getElementById('api-url-input');
  const apiSaveBtn = document.getElementById('api-save-btn');

  settingsBtn?.addEventListener('click', async () => {
    const currentUrl = await getSetting('apiUrl', '');
    if (apiUrlInput) apiUrlInput.value = currentUrl;
    settingsPanel?.classList.add('active');
  });

  settingsClose?.addEventListener('click', () => {
    settingsPanel?.classList.remove('active');
  });

  apiSaveBtn?.addEventListener('click', async () => {
    const url = apiUrlInput?.value.trim();
    if (url && !url.startsWith('https://')) {
      showToast('API URL must start with https://', 'error');
      return;
    }
    await setSetting('apiUrl', url);
    setApiUrl(url);
    settingsPanel?.classList.remove('active');
    showToast('API URL saved!', 'success');
    if (url) {
      // New URL saved — do a full pull then push any local changes
      showToast('Pulling data from server…', 'info');
      await pullFromServer();
      await import('./diary.js').then(m => m.initDiary?.());
      await import('./calendar.js').then(m => m.renderCalendar?.());
      await processQueue();
    }
  });

  // Pull latest data from server
  document.getElementById('pull-data-btn')?.addEventListener('click', async () => {
    if (!navigator.onLine) { showToast('You are offline.', 'error'); return; }
    showToast('Pulling latest data…', 'info');
    const result = await pullFromServer();
    const total = result.diary + result.agenda + result.photos;
    if (total > 0) {
      const parts = [];
      if (result.diary)  parts.push(`${result.diary} entries`);
      if (result.agenda) parts.push(`${result.agenda} events`);
      if (result.photos) parts.push(`${result.photos} photos`);
      showToast(`Pulled: ${parts.join(', ')}`, 'success');
      await import('./diary.js').then(m => m.renderDiaryList?.());
      await import('./calendar.js').then(m => m.renderCalendar?.());
      await import('./drive.js').then(m => m.renderGallery?.());
    } else {
      showToast('Already up to date', 'info');
    }
  });

  // Clear data
  document.getElementById('clear-data-btn')?.addEventListener('click', async () => {
    if (!confirm('⚠️ Clear ALL local data? This will delete all unsynced entries. This cannot be undone.')) return;
    const { dbClear } = await import('./db.js');
    await Promise.all(['diary', 'agenda', 'photos', 'syncQueue', 'money'].map(s => dbClear(s)));
    showToast('Local data cleared', 'info');
    location.reload();
  });
}

// ── Sync badge ────────────────────────────────────────────────
async function updateSyncBadge() {
  const badge = document.getElementById('sync-badge');
  if (!badge) return;

  const counts = await getSyncStats();

  // Update last pull time in settings
  const lastPullEl = document.getElementById('last-pull-detail');
  if (lastPullEl) {
    const lastPull = await getSetting('lastPullAt', null);
    lastPullEl.textContent = lastPull
      ? 'Last pulled: ' + new Date(lastPull).toLocaleString()
      : 'Never pulled from server';
  }
  const total = counts.diary + counts.agenda + counts.photos;

  const conflicts = counts.conflicts || 0;
  if (conflicts > 0) {
    badge.textContent = '⚡';
    badge.style.display = 'flex';
    badge.style.background = '#e05252';
  } else if (total > 0) {
    badge.textContent = total > 99 ? '99+' : total;
    badge.style.display = 'flex';
    badge.style.background = '';
  } else {
    badge.style.display = 'none';
  }
}

// ── Install prompt ────────────────────────────────────────────
function bindInstallBanner() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPromptEvent = e;
    document.getElementById('install-banner')?.classList.add('active');
  });

  document.getElementById('install-btn')?.addEventListener('click', async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    const result = await installPromptEvent.userChoice;
    console.log('[App] Install prompt result:', result.outcome);
    document.getElementById('install-banner')?.classList.remove('active');
    installPromptEvent = null;
  });

  document.getElementById('install-dismiss-btn')?.addEventListener('click', () => {
    document.getElementById('install-banner')?.classList.remove('active');
    setSetting('installDismissed', true);
  });

  window.addEventListener('appinstalled', () => {
    console.log('[App] PWA installed!');
    document.getElementById('install-banner')?.classList.remove('active');
    showToast('Lumina installed successfully!', 'success');
  });
}

// ── Update banner ─────────────────────────────────────────────
function showUpdateBanner() {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  banner.classList.add('active');

  document.getElementById('update-btn')?.addEventListener('click', () => {
    navigator.serviceWorker.controller?.postMessage({ type: 'SKIP_WAITING' });
    banner.classList.remove('active');
    setTimeout(() => location.reload(), 500);
  });
}

// ── URL params for deep linking ───────────────────────────────
function handleUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const tab = params.get('tab');
  const action = params.get('action');

  if (tab) switchTab(tab, false);

  if (action === 'new') {
    setTimeout(() => {
      if (tab === 'diary') openDiaryEditor();
      if (tab === 'agenda') openEventEditor();
    }, 500);
  }
}

// ── Toast notification ────────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span class="toast-icon">${type === 'success' ? '✓' : type === 'error' ? '✕' : 'ℹ'}</span>
    <span class="toast-msg">${escapeHtml(message)}</span>
  `;

  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 400);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ── Start the app ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

// Expose for HTML onclick (legacy compatibility)
window.luminaApp = { switchTab, showToast };
