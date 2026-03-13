// ============================================================
// Lumina PWA — Google Apps Script Backend  (v3)
// File: Code.gs — Router, Config, Shared Utilities
//
// REQUIRES Advanced Services (Extensions → Advanced Google Services):
//   ✅ Google Calendar API  (identifier: Calendar)
//   ✅ Google Drive API     (identifier: Drive)
//   ✅ Google Sheets API    (identifier: Sheets)
//
// HOW TO ENABLE:
//   1. Open this project in Apps Script editor
//   2. Click "Extensions" → "Advanced Google Services"
//   3. Toggle ON: Google Calendar API, Drive API, Google Sheets API
//   4. Click "OK" — the globals Calendar, Drive, Sheets are now available
//
// DEPLOY AS WEB APP:
//   Deploy → New Deployment → Web App
//   Execute as: Me | Who has access: Anyone
// ============================================================

// ── Configuration — fill these in before deploying ───────────
var CONFIG = {
  // Paste your Google Spreadsheet ID from the URL:
  // https://docs.google.com/spreadsheets/d/[ID]/edit
  SPREADSHEET_ID: '1FRQeB744nGDIMaCA3LaPjx54MIuiLGdLGjhE9tw7RK0',

  // Paste your Google Drive folder ID from the URL:
  // https://drive.google.com/drive/folders/[ID]
  // Leave blank to auto-create a "Lumina Photos" folder
  DRIVE_FOLDER_ID: '',

  // 'primary' uses your main calendar.
  // Or paste a specific calendar ID from Google Calendar settings.
  CALENDAR_ID: 'primary',

  // Restrict to your GitHub Pages domain for security, e.g.:
  // 'https://yourusername.github.io'
  ALLOWED_ORIGINS: '*',

  VERSION: '3.0.0'
};

// ── Shared response helpers ───────────────────────────────────

function makeResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function makeErrorResponse(msg, code) {
  return makeResponse({ error: msg, code: code || 'ERROR' });
}

// ── GET handler — health check / ping ────────────────────────

function doGet(e) {
  return makeResponse({
    status:  'ok',
    app:     'Lumina API',
    version: CONFIG.VERSION,
    ts:      new Date().toISOString(),
    services: {
      calendar: typeof Calendar !== 'undefined' ? 'enabled' : 'MISSING',
      drive:    typeof Drive    !== 'undefined' ? 'enabled' : 'MISSING',
      sheets:   typeof Sheets   !== 'undefined' ? 'enabled' : 'MISSING'
    }
  });
}

// ── POST handler — main action router ────────────────────────

function doPost(e) {
  try {
    var raw    = (e.postData || {}).contents || '{}';
    var params = JSON.parse(raw);
    var action = params.action;

    if (!action) {
      return makeErrorResponse('Missing required field: action', 'MISSING_ACTION');
    }

    Logger.log('[Lumina] action=' + action);

    switch (action) {

      // ── Diary (Google Sheets API) ─────────────────────
      case 'saveDiaryEntry':       return saveDiaryEntry(params);
      case 'getDiaryEntry':        return getDiaryEntry(params);
      case 'getDiaryEntries':      return getDiaryEntries(params);
      case 'deleteDiaryEntry':     return deleteDiaryEntry(params);

      // ── Calendar (Google Calendar API) ────────────────
      case 'saveCalendarEvent':    return saveCalendarEvent(params);
      case 'getCalendarEvent':     return getCalendarEvent(params);
      case 'getCalendarEvents':    return getCalendarEvents(params);
      case 'deleteCalendarEvent':  return deleteCalendarEvent(params);

      // ── Photos — Drive upload ─────────────────────────
      case 'uploadPhoto':          return uploadPhoto(params);
      case 'deletePhoto':          return deletePhoto(params);

      // ── Photos — Sheet metadata index (fast cross-device sync)
      case 'savePhotoMeta':        return savePhotoMeta(params);
      case 'listPhotoMeta':        return listPhotoMeta(params);
      case 'deletePhotoMeta':      return deletePhotoMeta(params);

      // ── Money — future feature (Google Sheets API) ────
      case 'saveMoneyTransaction':    return saveMoneyTransaction(params);
      case 'getMoneyTransactions':    return getMoneyTransactions(params);
      case 'deleteMoneyTransaction':  return deleteMoneyTransaction(params);

      // ── Utility ───────────────────────────────────────
      case 'ping':
        return makeResponse({ pong: true, ts: new Date().toISOString() });

      default:
        return makeErrorResponse('Unknown action: ' + action, 'UNKNOWN_ACTION');
    }

  } catch (err) {
    Logger.log('[Lumina] ERROR in doPost: ' + err.message + '\n' + err.stack);
    return makeErrorResponse(err.message, 'INTERNAL_ERROR');
  }
}

// ════════════════════════════════════════════════════════════
//  SHARED UTILITIES — used by SheetAPI.gs, CalendarAPI.gs, DriveAPI.gs
// ════════════════════════════════════════════════════════════

/** Generate a UUID (used as local IDs in Sheets rows) */
function generateId() {
  return Utilities.getUuid();
}

/** Current timestamp as ISO 8601 string */
function isoNow() {
  return new Date().toISOString();
}

/**
 * Format a Sheets cell value to a plain string.
 * Handles Date objects (which Sheets returns for date cells),
 * null/undefined, and numbers.
 */
function formatVal(v) {
  if (v instanceof Date) return v.toISOString();
  if (v === null || v === undefined) return '';
  return String(v);
}

/**
 * Compute a 12-character SHA-1 hex prefix of a JSON-serialised object.
 * Used as the content hash for conflict detection.
 * The client-side hashContent() in db.js produces an identical value.
 */
function computeHash(obj) {
  var str = JSON.stringify(obj);
  var raw = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_1,
    str,
    Utilities.Charset.UTF_8
  );
  // raw is an array of signed bytes → convert to unsigned hex
  return raw.slice(0, 6).map(function(b) {
    return (b < 0 ? b + 256 : b).toString(16).padStart(2, '0');
  }).join('');
}

/**
 * Sanitize a filename: keep only safe characters, max 100 chars.
 */
function sanitizeFilename(name) {
  return (name || 'file')
    .replace(/[^a-zA-Z0-9._\-]/g, '_')
    .slice(0, 100);
}

// ── Assertion guard for required Advanced Services ────────────

function assertAdvancedServices() {
  var missing = [];
  if (typeof Calendar === 'undefined') missing.push('Calendar API');
  if (typeof Drive    === 'undefined') missing.push('Drive API');
  if (typeof Sheets   === 'undefined') missing.push('Sheets API');
  if (missing.length > 0) {
    throw new Error(
      'Advanced Services not enabled: ' + missing.join(', ') +
      '. Go to Extensions → Advanced Google Services and enable them.'
    );
  }
}

// ── Run this manually to verify everything is wired up ────────

function runSetupCheck() {
  try {
    assertAdvancedServices();

    // Verify spreadsheet is accessible
    var ss = Sheets.Spreadsheets.get(CONFIG.SPREADSHEET_ID);
    Logger.log('✅ Sheets API — spreadsheet: ' + ss.properties.title);

    // Verify calendar is accessible
    var cal = Calendar.Calendars.get(CONFIG.CALENDAR_ID);
    Logger.log('✅ Calendar API — calendar: ' + cal.summary);

    // Verify drive folder (or root) is accessible
    var folderId = CONFIG.DRIVE_FOLDER_ID || 'root';
    var folder   = Drive.Files.get(folderId);
    Logger.log('✅ Drive API — folder: ' + folder.name);

    Logger.log('✅ Setup check passed. Ready to deploy.');
  } catch (err) {
    Logger.log('❌ Setup check FAILED: ' + err.message);
  }
}

// ════════════════════════════════════════════════════════════
//  DEBUG — run these manually in Apps Script editor to verify
// ════════════════════════════════════════════════════════════

/** Step 1: Verify SPREADSHEET_ID is correct and sheets exist */
function debugCheckSetup() {
  Logger.log('SPREADSHEET_ID = ' + CONFIG.SPREADSHEET_ID);
  try {
    var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
    Logger.log('✅ Spreadsheet opened: ' + ss.getName());
    var sheets = ss.getSheets().map(function(s) { return s.getName(); });
    Logger.log('   Sheets: ' + sheets.join(', '));
  } catch(e) {
    Logger.log('❌ Cannot open spreadsheet: ' + e.message);
  }
}

/** Step 2: Test photo upload end-to-end */
function debugTestUpload() {
  // 1x1 white JPEG
  var whitePixel = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMCwsKCwsNCxAQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AJQAB/9k=';
  Logger.log('Testing upload...');
  var result = uploadPhoto({ base64: whitePixel, name: 'debug_test.jpg', type: 'image/jpeg', id: 'debug-001' });
  var data = JSON.parse(result.getContent());
  if (data.success) {
    Logger.log('✅ Upload OK  id=' + data.id + '  thumbUrl=' + data.thumbUrl);
    Logger.log('   Checking Photos sheet...');
    var meta = listPhotoMeta({});
    var metaData = JSON.parse(meta.getContent());
    Logger.log('   Photos in sheet: ' + metaData.count);
    deletePhoto({ id: data.id });
    Logger.log('✅ Cleanup done');
  } else {
    Logger.log('❌ Upload failed: ' + JSON.stringify(data));
  }
}
