// ============================================================
// Lumina PWA — SheetAPI.gs  (v3)
// Diary + Money CRUD using Google Sheets API v4 (Advanced Service)
//
// WHY Sheets API v4 OVER SpreadsheetApp:
//
//   SpreadsheetApp (old):
//     sheet.getRange(row, col).setValue(x)  ← 1 API call per cell
//     Updating 7 columns = 7 round-trips to Google's servers
//
//   Sheets API v4 (new):
//     Sheets.Spreadsheets.Values.batchUpdate(...)  ← 1 API call total
//     All cell updates in a single HTTP request
//     ~6× faster for row updates, much lower quota consumption
//
//   Other gains:
//     • valueRenderOption: 'UNFORMATTED_VALUE' — returns raw numbers,
//       not formatted strings — no more "1/1/2024" date parsing issues
//     • Append with insertDataOption: 'INSERT_ROWS' — always appends
//       below last row, even if there are gaps
//     • getValues returns null for empty cells, not "" — cleaner checks
// ============================================================

// ── Sheet names ───────────────────────────────────────────────
var DIARY_SHEET = 'Diary';
var MONEY_SHEET = 'Money';

// ── Column definitions (1-based, matches sheet order) ─────────
//
//  Diary:  id | date | title | content_html | photo_urls | version | hash | created_at | updated_at
//  Money:  id | date | type  | category     | amount     | notes   | version | created_at | updated_at
//
// Using objects for readability — A=1, B=2, ... I=9
var DC = { id:1, date:2, title:3, content_html:4, photo_urls:5, version:6, hash:7, created_at:8, updated_at:9 };
var MC = { id:1, date:2, type:3, category:4, amount:5, notes:6, version:7, created_at:8, updated_at:9 };

var DIARY_HEADERS  = ['id','date','title','content_html','photo_urls','version','hash','created_at','updated_at'];
var MONEY_HEADERS  = ['id','date','type','category','amount','notes','version','created_at','updated_at'];

// ── Column index → A1 letter ──────────────────────────────────
function colLetter(n) {
  // n is 1-based: 1→A, 2→B, ... 26→Z, 27→AA, etc.
  var s = '';
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

// ── Get or create a sheet with styled headers ─────────────────
// Uses SpreadsheetApp only for sheet creation (one-time setup).
// All data reads/writes use Sheets API v4.
function ensureSheet(sheetName, headers) {
  var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(sheetName);
  if (!sheet) {
    sheet = ss.insertSheet(sheetName);

    // Write headers using SpreadsheetApp for styling
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#1a1d28');
    headerRange.setFontColor('#c8a97e');
    sheet.setFrozenRows(1);

    Logger.log('[SheetAPI] Created sheet: ' + sheetName);
  }
  return sheet;
}

// ── Read ALL rows using Sheets API v4 ─────────────────────────
// valueRenderOption UNFORMATTED_VALUE returns raw JS types,
// not locale-formatted strings (critical for numbers + dates).
function sheetGetAllRows(sheetName, numCols) {
  var range = sheetName + '!A1:' + colLetter(numCols);
  try {
    var result = Sheets.Spreadsheets.Values.get(
      CONFIG.SPREADSHEET_ID,
      range,
      { valueRenderOption: 'UNFORMATTED_VALUE' }
    );
    var rows = result.values || [];
    // rows[0] is the header row — skip it; return data rows only
    return rows.length > 1 ? rows.slice(1) : [];
  } catch (err) {
    Logger.log('[SheetAPI] sheetGetAllRows error: ' + err.message);
    return [];
  }
}

// ── Read a single row by row number (1-based, including header) ─
function sheetGetRow(sheetName, rowNum, numCols) {
  var range = sheetName + '!A' + rowNum + ':' + colLetter(numCols) + rowNum;
  var result = Sheets.Spreadsheets.Values.get(
    CONFIG.SPREADSHEET_ID,
    range,
    { valueRenderOption: 'UNFORMATTED_VALUE' }
  );
  return (result.values || [[]])[0] || [];
}

// ── Append a new row using Sheets API v4 ─────────────────────
// insertDataOption INSERT_ROWS always inserts after the last row
// with data, even if there are blank rows in between.
function sheetAppendRow(sheetName, values) {
  var range = sheetName + '!A:A';
  Sheets.Spreadsheets.Values.append(
    { values: [values] },
    CONFIG.SPREADSHEET_ID,
    range,
    {
      valueInputOption:  'USER_ENTERED',   // parses dates, numbers
      insertDataOption:  'INSERT_ROWS'
    }
  );
}

// ── Update specific cells in a row using batchUpdate ─────────
// updates is an array of { col: number(1-based), value: any }
// All updates happen in a SINGLE API call — key performance win.
function sheetBatchUpdateRow(sheetName, rowNum, updates) {
  var data = updates.map(function(u) {
    var cellRef = sheetName + '!' + colLetter(u.col) + rowNum;
    return {
      range:  cellRef,
      values: [[u.value]]
    };
  });

  Sheets.Spreadsheets.Values.batchUpdate(
    {
      valueInputOption: 'USER_ENTERED',
      data: data
    },
    CONFIG.SPREADSHEET_ID
  );
}

// ── Delete a row using Sheets API v4 batchUpdate (deleteDimension) ─
function sheetDeleteRow(sheetName, rowNum) {
  // Need the sheetId (numeric) for deleteDimension
  var ss      = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet   = ss.getSheetByName(sheetName);
  var sheetId = sheet ? sheet.getSheetId() : null;
  if (sheetId === null) {
    throw new Error('Sheet not found: ' + sheetName);
  }

  Sheets.Spreadsheets.batchUpdate(
    {
      requests: [{
        deleteDimension: {
          range: {
            sheetId:    sheetId,
            dimension:  'ROWS',
            startIndex: rowNum - 1,  // 0-based
            endIndex:   rowNum       // exclusive
          }
        }
      }]
    },
    CONFIG.SPREADSHEET_ID
  );
}

// ── Find a row by ID value in column 1 ───────────────────────
// Returns 1-based row number including header (so data row 1 = row 2),
// or -1 if not found.
function findRowById(sheetName, id, numCols) {
  var rows = sheetGetAllRows(sheetName, 1); // only need column A (id)
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      return i + 2; // +1 for 0-based, +1 for header row
    }
  }
  return -1;
}

// ════════════════════════════════════════════════════════════
//  DIARY OPERATIONS
// ════════════════════════════════════════════════════════════

function saveDiaryEntry(params) {
  try {
    ensureSheet(DIARY_SHEET, DIARY_HEADERS);

    var now       = isoNow();
    var id        = params.id || null;
    var photoUrls = Array.isArray(params.photo_urls)
      ? params.photo_urls.join(',')
      : (params.photo_urls || '');

    // Content hash — server-side mirror of client hashContent()
    var hash = computeHash({
      title:        params.title        || '',
      content_html: params.content_html || '',
      date:         params.date         || ''
    });

    if (id) {
      // ── UPDATE existing row ────────────────────────────
      var rowNum = findRowById(DIARY_SHEET, id, DC.id);
      if (rowNum === -1) {
        // Row not found — treat as new insert (can happen after a
        // spreadsheet was cleared manually)
        Logger.log('[SheetAPI] saveDiaryEntry: id not found, inserting as new: ' + id);
        return _diaryInsert(id, params, photoUrls, hash, now);
      }

      // Read current version to increment
      var currentRow     = sheetGetRow(DIARY_SHEET, rowNum, DIARY_HEADERS.length);
      var currentVersion = parseInt(currentRow[DC.version - 1]) || 0;
      var newVersion     = currentVersion + 1;

      // Single batchUpdate call for all changed columns
      sheetBatchUpdateRow(DIARY_SHEET, rowNum, [
        { col: DC.date,         value: params.date         || '' },
        { col: DC.title,        value: params.title        || '' },
        { col: DC.content_html, value: params.content_html || '' },
        { col: DC.photo_urls,   value: photoUrls },
        { col: DC.version,      value: newVersion },
        { col: DC.hash,         value: hash },
        { col: DC.updated_at,   value: now }
      ]);

      Logger.log('[SheetAPI] Diary updated: ' + id + ' v' + newVersion);
      return makeResponse({
        success: true, id: id, action: 'updated',
        version: newVersion, hash: hash
      });

    } else {
      // ── INSERT new row ─────────────────────────────────
      return _diaryInsert(generateId(), params, photoUrls, hash, now);
    }

  } catch (err) {
    Logger.log('[SheetAPI] saveDiaryEntry error: ' + err.message + '\n' + err.stack);
    return makeErrorResponse(err.message, 'DIARY_SAVE_ERROR');
  }
}

function _diaryInsert(newId, params, photoUrls, hash, now) {
  sheetAppendRow(DIARY_SHEET, [
    newId,
    params.date         || now.split('T')[0],
    params.title        || '',
    params.content_html || '',
    photoUrls,
    1,     // initial version
    hash,
    now,   // created_at
    now    // updated_at
  ]);
  Logger.log('[SheetAPI] Diary created: ' + newId);
  return makeResponse({
    success: true, id: newId, action: 'created',
    version: 1, hash: hash
  });
}

function getDiaryEntry(params) {
  try {
    if (!params.id) return makeErrorResponse('Missing id', 'MISSING_ID');
    ensureSheet(DIARY_SHEET, DIARY_HEADERS);

    var rowNum = findRowById(DIARY_SHEET, params.id, DC.id);
    if (rowNum === -1) return makeResponse({ entry: null });

    var row = sheetGetRow(DIARY_SHEET, rowNum, DIARY_HEADERS.length);
    return makeResponse({ entry: _rowToDiaryEntry(row) });

  } catch (err) {
    Logger.log('[SheetAPI] getDiaryEntry error: ' + err.message);
    return makeErrorResponse(err.message, 'DIARY_GET_ERROR');
  }
}

function getDiaryEntries(params) {
  try {
    ensureSheet(DIARY_SHEET, DIARY_HEADERS);
    var rows    = sheetGetAllRows(DIARY_SHEET, DIARY_HEADERS.length);
    var entries = [];

    for (var i = 0; i < rows.length; i++) {
      if (!rows[i][0]) continue; // skip blank rows
      entries.push(_rowToDiaryEntry(rows[i]));
    }

    entries.sort(function(a, b) { return b.date.localeCompare(a.date); });
    return makeResponse({ entries: entries, count: entries.length });

  } catch (err) {
    Logger.log('[SheetAPI] getDiaryEntries error: ' + err.message);
    return makeErrorResponse(err.message, 'DIARY_GET_ERROR');
  }
}

function deleteDiaryEntry(params) {
  try {
    if (!params.id) return makeErrorResponse('Missing id', 'MISSING_ID');
    ensureSheet(DIARY_SHEET, DIARY_HEADERS);

    var rowNum = findRowById(DIARY_SHEET, params.id, DC.id);
    if (rowNum !== -1) {
      sheetDeleteRow(DIARY_SHEET, rowNum);
      Logger.log('[SheetAPI] Diary deleted row ' + rowNum + ' id=' + params.id);
    }
    return makeResponse({ success: true, id: params.id, deleted: true });

  } catch (err) {
    Logger.log('[SheetAPI] deleteDiaryEntry error: ' + err.message);
    return makeErrorResponse(err.message, 'DIARY_DELETE_ERROR');
  }
}

// ── Row → structured diary object ────────────────────────────
function _rowToDiaryEntry(row) {
  var photoUrls = formatVal(row[DC.photo_urls - 1]);
  return {
    id:           formatVal(row[DC.id - 1]),
    date:         formatVal(row[DC.date - 1]),
    title:        formatVal(row[DC.title - 1]),
    content_html: formatVal(row[DC.content_html - 1]),
    photo_urls:   photoUrls ? photoUrls.split(',').filter(Boolean) : [],
    version:      parseInt(row[DC.version - 1])    || 0,
    hash:         formatVal(row[DC.hash - 1]),
    created_at:   formatVal(row[DC.created_at - 1]),
    updated_at:   formatVal(row[DC.updated_at - 1])
  };
}

// ════════════════════════════════════════════════════════════
//  MONEY OPERATIONS (Future Feature — schema ready)
// ════════════════════════════════════════════════════════════

function saveMoneyTransaction(params) {
  try {
    ensureSheet(MONEY_SHEET, MONEY_HEADERS);
    var now = isoNow();
    var id  = params.id || null;

    if (id) {
      var rowNum = findRowById(MONEY_SHEET, id, MC.id);
      if (rowNum === -1) return makeErrorResponse('Transaction not found: ' + id, 'NOT_FOUND');

      var curRow = sheetGetRow(MONEY_SHEET, rowNum, MONEY_HEADERS.length);
      var newVer = (parseInt(curRow[MC.version - 1]) || 0) + 1;

      sheetBatchUpdateRow(MONEY_SHEET, rowNum, [
        { col: MC.date,       value: params.date              || '' },
        { col: MC.type,       value: params.type              || 'expense' },
        { col: MC.category,   value: params.category          || '' },
        { col: MC.amount,     value: parseFloat(params.amount) || 0 },
        { col: MC.notes,      value: params.notes             || '' },
        { col: MC.version,    value: newVer },
        { col: MC.updated_at, value: now }
      ]);

      return makeResponse({ success: true, id: id, action: 'updated', version: newVer });

    } else {
      var newId = generateId();
      sheetAppendRow(MONEY_SHEET, [
        newId,
        params.date              || now.split('T')[0],
        params.type              || 'expense',
        params.category          || 'General',
        parseFloat(params.amount) || 0,
        params.notes             || '',
        1,
        now,
        now
      ]);
      return makeResponse({ success: true, id: newId, action: 'created', version: 1 });
    }

  } catch (err) {
    Logger.log('[SheetAPI] saveMoneyTransaction error: ' + err.message);
    return makeErrorResponse(err.message, 'MONEY_SAVE_ERROR');
  }
}

function getMoneyTransactions(params) {
  try {
    ensureSheet(MONEY_SHEET, MONEY_HEADERS);
    var rows   = sheetGetAllRows(MONEY_SHEET, MONEY_HEADERS.length);
    var txs    = [];
    var totals = { income: 0, expense: 0, net: 0 };

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;

      var tx = {
        id:       formatVal(row[MC.id - 1]),
        date:     formatVal(row[MC.date - 1]),
        type:     formatVal(row[MC.type - 1]),
        category: formatVal(row[MC.category - 1]),
        amount:   parseFloat(row[MC.amount - 1])   || 0,
        notes:    formatVal(row[MC.notes - 1]),
        version:  parseInt(row[MC.version - 1])    || 0
      };

      if (params.type      && tx.type !== params.type)      continue;
      if (params.startDate && tx.date <  params.startDate)  continue;
      if (params.endDate   && tx.date >  params.endDate)    continue;

      txs.push(tx);
      if (tx.type === 'income') totals.income  += tx.amount;
      else                       totals.expense += tx.amount;
    }

    totals.net = totals.income - totals.expense;
    txs.sort(function(a, b) { return b.date.localeCompare(a.date); });

    return makeResponse({ transactions: txs, count: txs.length, totals: totals });

  } catch (err) {
    Logger.log('[SheetAPI] getMoneyTransactions error: ' + err.message);
    return makeErrorResponse(err.message, 'MONEY_GET_ERROR');
  }
}

function deleteMoneyTransaction(params) {
  try {
    if (!params.id) return makeErrorResponse('Missing id', 'MISSING_ID');
    ensureSheet(MONEY_SHEET, MONEY_HEADERS);

    var rowNum = findRowById(MONEY_SHEET, params.id, MC.id);
    if (rowNum !== -1) sheetDeleteRow(MONEY_SHEET, rowNum);

    return makeResponse({ success: true, id: params.id, deleted: true });

  } catch (err) {
    Logger.log('[SheetAPI] deleteMoneyTransaction error: ' + err.message);
    return makeErrorResponse(err.message, 'MONEY_DELETE_ERROR');
  }
}

// ════════════════════════════════════════════════════════════
//  PHOTOS SHEET  (metadata index for Drive files)
//
//  Why: Drive API's listPhotos uses appProperties queries which
//  can be slow and require the Drive Advanced Service.
//  A simple Sheet row is instant, cross-device, and zero-parsing.
//
//  Columns: id | name | drive_id | thumb_url | drive_url | entry_id | created_at
// ════════════════════════════════════════════════════════════

var PHOTOS_SHEET   = 'Photos';
var PHOTOS_HEADERS = ['id','name','drive_id','thumb_url','drive_url','entry_id','created_at'];
var PC = { id:1, name:2, drive_id:3, thumb_url:4, drive_url:5, entry_id:6, created_at:7 };

function savePhotoMeta(params) {
  try {
    if (!params.drive_id) return makeErrorResponse('Missing drive_id', 'MISSING_FIELD');
    ensureSheet(PHOTOS_SHEET, PHOTOS_HEADERS);

    // Check if row already exists (re-upload or retry)
    var existing = findRowById(PHOTOS_SHEET, params.drive_id, PC.drive_id);
    if (existing !== -1) {
      return makeResponse({ success: true, id: params.id, action: 'exists' });
    }

    sheetAppendRow(PHOTOS_SHEET, [
      params.id         || params.drive_id,
      params.name       || 'photo.jpg',
      params.drive_id,
      params.thumb_url  || '',
      params.drive_url  || '',
      params.entry_id   || '',
      params.created_at || isoNow()
    ]);

    Logger.log('[Photos] Meta saved: ' + params.drive_id);
    return makeResponse({ success: true, id: params.id, action: 'created' });
  } catch (err) {
    Logger.log('[Photos] savePhotoMeta error: ' + err.message);
    return makeErrorResponse(err.message, 'PHOTO_META_SAVE_ERROR');
  }
}

function listPhotoMeta(params) {
  try {
    ensureSheet(PHOTOS_SHEET, PHOTOS_HEADERS);
    var rows   = sheetGetAllRows(PHOTOS_SHEET, PHOTOS_HEADERS.length);
    var photos = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row[0]) continue;
      photos.push({
        id:         formatVal(row[PC.id - 1]),
        name:       formatVal(row[PC.name - 1]),
        drive_id:   formatVal(row[PC.drive_id - 1]),
        thumb_url:  formatVal(row[PC.thumb_url - 1]),
        drive_url:  formatVal(row[PC.drive_url - 1]),
        entry_id:   formatVal(row[PC.entry_id - 1]),
        created_at: formatVal(row[PC.created_at - 1])
      });
    }

    // Newest first
    photos.sort(function(a, b) { return b.created_at.localeCompare(a.created_at); });
    return makeResponse({ photos: photos, count: photos.length });
  } catch (err) {
    Logger.log('[Photos] listPhotoMeta error: ' + err.message);
    return makeErrorResponse(err.message, 'PHOTO_META_LIST_ERROR');
  }
}

function deletePhotoMeta(params) {
  try {
    if (!params.drive_id) return makeErrorResponse('Missing drive_id', 'MISSING_FIELD');
    ensureSheet(PHOTOS_SHEET, PHOTOS_HEADERS);
    var rowNum = findRowById(PHOTOS_SHEET, params.drive_id, PC.drive_id);
    if (rowNum !== -1) sheetDeleteRow(PHOTOS_SHEET, rowNum);
    return makeResponse({ success: true, drive_id: params.drive_id, deleted: true });
  } catch (err) {
    Logger.log('[Photos] deletePhotoMeta error: ' + err.message);
    return makeErrorResponse(err.message, 'PHOTO_META_DELETE_ERROR');
  }
}
