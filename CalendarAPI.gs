// ============================================================
// Lumina PWA — CalendarAPI.gs  (v3)
// Google Calendar CRUD using Calendar API v3 (Advanced Service)
//
// WHY Calendar API v3 OVER CalendarApp:
//
//   CalendarApp (old)                   Calendar API v3 (new)
//   ─────────────────────────────────   ──────────────────────────────────
//   No etag                             etag on every event ← conflict hash
//   No sequence number                  sequence field ← version number
//   No colorId                          colorId (1–11 Google colors)
//   Update = 3+ method calls            PATCH = 1 call, only changed fields
//   getEventById = extra round-trip     Events.get() = same, but returns
//                                         etag + sequence together
//   No iCalUID                          iCalUID for cross-calendar dedup
//
// etag vs sequence:
//   • etag  — opaque hash, changes whenever the event changes on the server
//             → used as serverHash in the conflict resolver
//   • sequence — integer, incremented on each update
//             → used as serverVersion in the conflict resolver
//
// COLOR MAP (Google Calendar colorIds):
//   1=Lavender  2=Sage    3=Grape    4=Flamingo  5=Banana
//   6=Tangerine 7=Peacock 8=Graphite 9=Blueberry 10=Basil 11=Tomato
// ============================================================

var CAL_ID = CONFIG.CALENDAR_ID || 'primary';

// ── Map hex color → nearest Google Calendar colorId ──────────
var COLOR_MAP = {
  '#7986cb': '1', '#33b679': '2', '#8e24aa': '3', '#e67c73': '4',
  '#f6c026': '5', '#f5511d': '6', '#039be5': '7', '#616161': '8',
  '#3f51b5': '9', '#0b8043': '10', '#d50000': '11'
};

function hexToColorId(hex) {
  if (!hex) return '5'; // default: Banana (yellow, closest to amber)
  var lower = hex.toLowerCase();
  if (COLOR_MAP[lower]) return COLOR_MAP[lower];
  // Fallback: return '5' (banana/yellow) — closest to Lumina's amber
  return '5';
}

// ════════════════════════════════════════════════════════════
//  CREATE / UPDATE  — saveCalendarEvent
// ════════════════════════════════════════════════════════════

function saveCalendarEvent(params) {
  try {
    _validateEventParams(params);

    var reminderMinutes = parseInt(params.reminderMinutes) || 30;
    var colorId         = hexToColorId(params.color);

    // Build the Calendar API v3 event resource
    // Only include fields that are set — PATCH will only update these
    var resource = {
      summary:     params.title,
      description: params.description || '',
      colorId:     colorId,
      reminders: {
        useDefault: false,
        overrides:  reminderMinutes > 0
          ? [{ method: 'popup', minutes: reminderMinutes }]
          : []
      }
    };

    // Set start/end — handle all-day events separately
    if (params.allDay) {
      var dayStr = params.startTime.split('T')[0];
      resource.start = { date: dayStr };
      resource.end   = { date: params.endTime.split('T')[0] || dayStr };
    } else {
      resource.start = { dateTime: params.startTime, timeZone: _getCalendarTimeZone() };
      resource.end   = { dateTime: params.endTime,   timeZone: _getCalendarTimeZone() };
    }

    if (params.id) {
      // ── PATCH (partial update) — only sends changed fields ──
      // Much more efficient than a full PUT, and safe for concurrent edits
      try {
        var patched = Calendar.Events.patch(resource, CAL_ID, params.id);
        Logger.log('[CalAPI] Event patched: ' + patched.id + ' seq=' + patched.sequence + ' etag=' + patched.etag);
        return makeResponse({
          success:  true,
          id:       patched.id,
          action:   'updated',
          version:  patched.sequence  || 0,
          hash:     _cleanEtag(patched.etag),
          colorId:  patched.colorId,
          htmlLink: patched.htmlLink  || ''
        });
      } catch (patchErr) {
        // Event not found on server — fall through to create
        Logger.log('[CalAPI] Patch failed (event not found?), creating new: ' + patchErr.message);
      }
    }

    // ── INSERT new event ──────────────────────────────────────
    var created = Calendar.Events.insert(resource, CAL_ID);
    Logger.log('[CalAPI] Event created: ' + created.id + ' seq=' + created.sequence);

    return makeResponse({
      success:  true,
      id:       created.id,
      action:   'created',
      version:  created.sequence  || 0,
      hash:     _cleanEtag(created.etag),
      colorId:  created.colorId,
      htmlLink: created.htmlLink  || ''
    });

  } catch (err) {
    Logger.log('[CalAPI] saveCalendarEvent error: ' + err.message + '\n' + err.stack);
    return makeErrorResponse(err.message, 'CALENDAR_SAVE_ERROR');
  }
}

// ════════════════════════════════════════════════════════════
//  GET SINGLE EVENT  — for conflict detection
// ════════════════════════════════════════════════════════════

function getCalendarEvent(params) {
  try {
    if (!params.id) return makeErrorResponse('Missing event id', 'MISSING_ID');

    var event = Calendar.Events.get(CAL_ID, params.id);
    return makeResponse({ event: _eventToObj(event) });

  } catch (err) {
    // 404 means the event was deleted from the server side
    if (err.message && err.message.indexOf('404') !== -1) {
      return makeResponse({ event: null });
    }
    Logger.log('[CalAPI] getCalendarEvent error: ' + err.message);
    return makeErrorResponse(err.message, 'CALENDAR_GET_ERROR');
  }
}

// ════════════════════════════════════════════════════════════
//  LIST EVENTS IN RANGE
// ════════════════════════════════════════════════════════════

function getCalendarEvents(params) {
  try {
    var now       = new Date();
    var timeMin   = params.start
      ? new Date(params.start).toISOString()
      : new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    var timeMax   = params.end
      ? new Date(params.end).toISOString()
      : new Date(now.getFullYear(), now.getMonth() + 3, 0).toISOString();

    // Calendar.Events.list returns a paginated EventList resource
    var listParams = {
      timeMin:      timeMin,
      timeMax:      timeMax,
      singleEvents: true,               // expand recurring events
      orderBy:      'startTime',
      maxResults:   500,                // up from default 250
      showDeleted:  false
    };

    var events = [];
    var pageToken = null;

    // Handle pagination — rare but possible for busy calendars
    do {
      if (pageToken) listParams.pageToken = pageToken;
      var page = Calendar.Events.list(CAL_ID, listParams);
      (page.items || []).forEach(function(ev) {
        events.push(_eventToObj(ev));
      });
      pageToken = page.nextPageToken;
    } while (pageToken);

    Logger.log('[CalAPI] Fetched ' + events.length + ' events');

    return makeResponse({
      events: events,
      count:  events.length,
      range:  { start: timeMin, end: timeMax }
    });

  } catch (err) {
    Logger.log('[CalAPI] getCalendarEvents error: ' + err.message);
    return makeErrorResponse(err.message, 'CALENDAR_GET_ERROR');
  }
}

// ════════════════════════════════════════════════════════════
//  DELETE EVENT
// ════════════════════════════════════════════════════════════

function deleteCalendarEvent(params) {
  try {
    if (!params.id) return makeErrorResponse('Missing event id', 'MISSING_ID');

    try {
      // Calendar.Events.remove returns nothing on success (HTTP 204)
      Calendar.Events.remove(CAL_ID, params.id);
      Logger.log('[CalAPI] Event deleted: ' + params.id);
      return makeResponse({ success: true, id: params.id, deleted: true });
    } catch (removeErr) {
      // 404 = already deleted — treat as success
      if (removeErr.message && removeErr.message.indexOf('404') !== -1) {
        Logger.log('[CalAPI] Event already deleted: ' + params.id);
        return makeResponse({ success: true, id: params.id, deleted: true, note: 'already_deleted' });
      }
      // 410 Gone — also already deleted
      if (removeErr.message && removeErr.message.indexOf('410') !== -1) {
        return makeResponse({ success: true, id: params.id, deleted: true, note: 'gone' });
      }
      throw removeErr;
    }

  } catch (err) {
    Logger.log('[CalAPI] deleteCalendarEvent error: ' + err.message);
    return makeErrorResponse(err.message, 'CALENDAR_DELETE_ERROR');
  }
}

// ════════════════════════════════════════════════════════════
//  UTILITIES
// ════════════════════════════════════════════════════════════

// Convert Calendar API event resource → plain object for JSON response
function _eventToObj(ev) {
  if (!ev) return null;

  var startTime, endTime, allDay = false;

  if (ev.start) {
    if (ev.start.dateTime) {
      startTime = ev.start.dateTime;
      endTime   = ev.end   && ev.end.dateTime   ? ev.end.dateTime   : startTime;
    } else if (ev.start.date) {
      // All-day event — store as ISO date at midnight UTC
      startTime = ev.start.date + 'T00:00:00Z';
      endTime   = ev.end   && ev.end.date       ? ev.end.date + 'T00:00:00Z' : startTime;
      allDay    = true;
    }
  }

  return {
    id:          ev.id,
    title:       ev.summary      || '',
    description: ev.description  || '',
    startTime:   startTime       || '',
    endTime:     endTime         || '',
    allDay:      allDay,
    colorId:     ev.colorId      || '5',
    location:    ev.location     || '',
    htmlLink:    ev.htmlLink     || '',
    iCalUID:     ev.iCalUID      || '',

    // Conflict resolution fields
    version:     ev.sequence     || 0,
    hash:        _cleanEtag(ev.etag),

    // Reminders
    reminderMinutes: _extractReminderMinutes(ev),

    // Timestamps
    created:     ev.created      || '',
    updated:     ev.updated      || ''
  };
}

// Extract the first popup reminder's minutes, or default 30
function _extractReminderMinutes(ev) {
  if (!ev.reminders) return 30;
  if (ev.reminders.useDefault) return 30;
  var overrides = ev.reminders.overrides || [];
  for (var i = 0; i < overrides.length; i++) {
    if (overrides[i].method === 'popup') return overrides[i].minutes;
  }
  return 0; // no reminder
}

// etag comes quoted from the API: '"abc123"' → 'abc123'
function _cleanEtag(etag) {
  if (!etag) return '';
  return etag.replace(/^"|"$/g, '');
}

// Get the calendar's time zone (cached after first call)
var _cachedTimezone = null;
function _getCalendarTimeZone() {
  if (_cachedTimezone) return _cachedTimezone;
  try {
    var cal = Calendar.Calendars.get(CAL_ID);
    _cachedTimezone = cal.timeZone || Session.getScriptTimeZone();
  } catch (_) {
    _cachedTimezone = Session.getScriptTimeZone();
  }
  return _cachedTimezone;
}

// Validate required event params
function _validateEventParams(params) {
  if (!params.title)     throw new Error('Event title is required');
  if (!params.startTime) throw new Error('startTime is required');
  if (!params.endTime)   throw new Error('endTime is required');

  var start = new Date(params.startTime);
  var end   = new Date(params.endTime);
  if (isNaN(start.getTime())) throw new Error('Invalid startTime: ' + params.startTime);
  if (isNaN(end.getTime()))   throw new Error('Invalid endTime: '   + params.endTime);
  if (end <= start)           throw new Error('endTime must be after startTime');
}

// ── Debug helper — run manually in Apps Script editor ─────────
function testCalendarAPI() {
  var now   = new Date();
  var start = new Date(now.getTime() + 3600000);
  var end   = new Date(start.getTime() + 3600000);

  var result = saveCalendarEvent({
    title:           'Lumina API v3 Test',
    description:     'Testing Calendar API v3 advanced service',
    startTime:       start.toISOString(),
    endTime:         end.toISOString(),
    color:           '#f6c026',  // banana/amber
    reminderMinutes: 10
  });

  Logger.log('Test result: ' + result.getContent());

  var data = JSON.parse(result.getContent());
  if (data.id) {
    Logger.log('✅ Calendar API v3 working. Event id=' + data.id + ' etag=' + data.hash);
    // Clean up test event
    deleteCalendarEvent({ id: data.id });
    Logger.log('✅ Test event deleted');
  }
}
