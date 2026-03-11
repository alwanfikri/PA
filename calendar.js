/* ============================================================
   Lumina PWA — calendar.js
   Agenda events: list view + FullCalendar view
   Reminder notifications via Service Worker
   ============================================================ */

import {
  saveAgendaEvent, getAgendaEvents, getAgendaEvent,
  softDeleteAgendaEvent, generateId
} from './db.js';
import { enqueueSync, scheduleSync, checkReminders as checkUpcomingReminders } from './sync.js';

let fullCalendarInstance = null;
let currentAgendaView = 'list'; // 'list' | 'calendar'
let currentEditEventId = null;

// ── Initialize module ─────────────────────────────────────────
export async function initCalendar() {
  await requestNotificationPermission();
  renderAgendaView();
  bindCalendarEvents();
  checkUpcomingReminders();
  console.log('[Calendar] Module initialized');
}

// ── View toggle ───────────────────────────────────────────────
export function setAgendaView(view) {
  currentAgendaView = view;

  document.querySelectorAll('.view-toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  const listContainer = document.getElementById('agenda-list');
  const calContainer = document.getElementById('calendar-container');

  if (view === 'list') {
    listContainer.style.display = 'block';
    calContainer.style.display = 'none';
    renderAgendaList();
  } else {
    listContainer.style.display = 'none';
    calContainer.style.display = 'block';
    renderFullCalendar();
  }
}

export async function renderAgendaView() {
  if (currentAgendaView === 'list') {
    await renderAgendaList();
  } else {
    await renderFullCalendar();
  }
}

// ── List view ─────────────────────────────────────────────────
async function renderAgendaList() {
  const container = document.getElementById('agenda-list');
  if (!container) return;

  container.innerHTML = '<div class="loading-spinner"></div>';

  const events = await getAgendaEvents();
  const now = new Date();

  // Separate upcoming vs past
  const upcoming = events.filter(e => new Date(e.endTime) >= now);
  const past = events.filter(e => new Date(e.endTime) < now).slice(0, 10);

  if (upcoming.length === 0 && past.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>No agenda events yet.</p>
        <p class="empty-sub">Tap <strong>+ New Event</strong> to get started.</p>
      </div>`;
    return;
  }

  let html = '';

  if (upcoming.length > 0) {
    html += '<div class="agenda-section-label">Upcoming</div>';
    html += upcoming.map(event => renderEventCard(event, false)).join('');
  }

  if (past.length > 0) {
    html += '<div class="agenda-section-label muted">Recent Past</div>';
    html += past.map(event => renderEventCard(event, true)).join('');
  }

  container.innerHTML = html;
}

function renderEventCard(event, isPast) {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);
  const syncIcon = event.synced ? '' : '<span class="unsynced-dot" title="Not synced"></span>';

  const dateStr = start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const timeStr = `${formatTime(start)} – ${formatTime(end)}`;

  return `
    <article class="event-card ${isPast ? 'past' : ''}" data-id="${event.id}"
      style="border-left-color: ${event.color || '#c8a97e'}">
      <div class="event-card-header">
        <div class="event-date-block">
          <span class="event-date">${dateStr}</span>
          <span class="event-time">${timeStr}</span>
        </div>
        <div class="event-card-actions">
          ${syncIcon}
          <button class="btn-icon" onclick="window.luminaCalendar.editEvent('${event.id}')" title="Edit">✏️</button>
          <button class="btn-icon btn-danger" onclick="window.luminaCalendar.confirmDelete('${event.id}')" title="Delete">🗑️</button>
        </div>
      </div>
      <h3 class="event-title">${escapeHtml(event.title)}</h3>
      ${event.description ? `<p class="event-desc">${escapeHtml(event.description)}</p>` : ''}
      <div class="event-meta">
        <span>🔔 ${event.reminderMinutes} min before</span>
      </div>
    </article>`;
}

// ── FullCalendar view ─────────────────────────────────────────
async function renderFullCalendar() {
  const container = document.getElementById('calendar-container');
  if (!container) return;
  if (!window.FullCalendar) {
    container.innerHTML = '<p class="error-msg">FullCalendar not loaded. Check internet connection.</p>';
    return;
  }

  const events = await getAgendaEvents();

  const fcEvents = events.map(e => ({
    id: e.id,
    title: e.title,
    start: e.startTime,
    end: e.endTime,
    allDay: e.allDay || false,
    backgroundColor: e.color || '#c8a97e',
    borderColor: e.color || '#c8a97e',
    textColor: '#0d0f14',
    extendedProps: { description: e.description, reminderMinutes: e.reminderMinutes }
  }));

  if (fullCalendarInstance) {
    fullCalendarInstance.destroy();
  }

  fullCalendarInstance = new FullCalendar.Calendar(container, {
    initialView: 'dayGridMonth',
    headerToolbar: {
      left: 'prev,next today',
      center: 'title',
      right: 'dayGridMonth,timeGridWeek,listWeek'
    },
    height: 'auto',
    events: fcEvents,
    eventClick: (info) => {
      openEventEditor(info.event.id);
    },
    dateClick: (info) => {
      openNewEventOnDate(info.dateStr);
    },
    themeSystem: 'standard'
  });

  fullCalendarInstance.render();
}

function refreshCalendar() {
  if (fullCalendarInstance && currentAgendaView === 'calendar') {
    renderFullCalendar();
  }
}

// ── Event editor modal ────────────────────────────────────────
export async function openEventEditor(eventId = null) {
  currentEditEventId = eventId;
  const modal = document.getElementById('event-modal');
  const titleInput = document.getElementById('event-title-input');
  const descInput = document.getElementById('event-desc-input');
  const startInput = document.getElementById('event-start-input');
  const endInput = document.getElementById('event-end-input');
  const colorInput = document.getElementById('event-color-input');
  const reminderInput = document.getElementById('event-reminder-input');

  // Default: next hour
  const now = new Date();
  const nextHour = new Date(now.getTime() + (60 - now.getMinutes()) * 60000);
  nextHour.setSeconds(0, 0);
  const hourAfter = new Date(nextHour.getTime() + 3600000);

  titleInput.value = '';
  descInput.value = '';
  startInput.value = toLocalDateTimeInput(nextHour);
  endInput.value = toLocalDateTimeInput(hourAfter);
  colorInput.value = '#c8a97e';
  reminderInput.value = '30';

  if (eventId) {
    const event = await getAgendaEvent(eventId);
    if (event) {
      titleInput.value = event.title || '';
      descInput.value = event.description || '';
      startInput.value = toLocalDateTimeInput(new Date(event.startTime));
      endInput.value = toLocalDateTimeInput(new Date(event.endTime));
      colorInput.value = event.color || '#c8a97e';
      reminderInput.value = event.reminderMinutes || 30;
    }
  }

  modal.classList.add('active');
  titleInput.focus();
}

function openNewEventOnDate(dateStr) {
  currentEditEventId = null;
  openEventEditor();
  setTimeout(() => {
    const startInput = document.getElementById('event-start-input');
    const endInput = document.getElementById('event-end-input');
    if (startInput) startInput.value = dateStr + 'T09:00';
    if (endInput) endInput.value = dateStr + 'T10:00';
  }, 50);
}

export function closeEventEditor() {
  const modal = document.getElementById('event-modal');
  modal.classList.remove('active');
  currentEditEventId = null;
}

export async function saveEventEditorEntry() {
  const titleInput = document.getElementById('event-title-input');
  const descInput = document.getElementById('event-desc-input');
  const startInput = document.getElementById('event-start-input');
  const endInput = document.getElementById('event-end-input');
  const colorInput = document.getElementById('event-color-input');
  const reminderInput = document.getElementById('event-reminder-input');
  const saveBtn = document.getElementById('event-save-btn');

  const title = titleInput.value.trim();
  const startTime = startInput.value;
  const endTime = endInput.value;

  if (!title) { alert('Please enter an event title.'); titleInput.focus(); return; }
  if (!startTime) { alert('Please set a start time.'); startInput.focus(); return; }
  if (!endTime) { alert('Please set an end time.'); endInput.focus(); return; }
  if (new Date(endTime) <= new Date(startTime)) {
    alert('End time must be after start time.'); endInput.focus(); return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    const event = await saveAgendaEvent({
      id: currentEditEventId || undefined,
      title,
      description: descInput.value.trim(),
      startTime: new Date(startTime).toISOString(),
      endTime: new Date(endTime).toISOString(),
      color: colorInput.value,
      reminderMinutes: parseInt(reminderInput.value) || 30
    });

    await enqueueSync({ entityType: 'agenda', operation: 'save', localId: event.id, localVersion: event.localVersion, priority: 1 });

    closeEventEditor();
    await renderAgendaView();
    refreshCalendar();
    checkUpcomingReminders();

    showToast('Event saved!', 'success');
  } catch (err) {
    console.error('[Calendar] Save error:', err);
    showToast('Failed to save event: ' + err.message, 'error');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save Event';
  }
}

export async function confirmDeleteEvent(eventId) {
  if (!confirm('Delete this event? This cannot be undone.')) return;
  try {
    const event = await softDeleteAgendaEvent(eventId);
    await enqueueSync({ entityType: 'agenda', operation: 'delete', localId: event.id, remoteId: event.remoteId, priority: 1 });
    await renderAgendaView();
    refreshCalendar();
    showToast('Event deleted', 'info');
  } catch (err) {
    console.error('[Calendar] Delete error:', err);
    showToast('Failed to delete event', 'error');
  }
}

// ── Notification permission ───────────────────────────────────
async function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    console.log('[Calendar] Notification permission:', permission);
  }
}

// ── Bind events ───────────────────────────────────────────────
function bindCalendarEvents() {
  window.addEventListener('lumina:synced', () => {
    if (document.getElementById('agenda-tab')?.classList.contains('active')) {
      renderAgendaView();
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────
function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

function toLocalDateTimeInput(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  window.dispatchEvent(new CustomEvent('lumina:toast', { detail: { message, type } }));
}

// ── Expose for onclick handlers ───────────────────────────────
window.luminaCalendar = {
  editEvent: openEventEditor,
  confirmDelete: confirmDeleteEvent
};

console.log('[Calendar] Module loaded');
