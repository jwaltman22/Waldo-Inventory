/**
 * Jim Inventory — sync backend (Google Apps Script + Google Sheet).
 *
 * Every phone/PC running the Jim Inventory web app syncs through this script.
 * The inventory lives in the "Inventory" tab of the spreadsheet this script is
 * attached to, so the office can also just open the Sheet and look.
 *
 * SETUP (one time, ~5 minutes) — see README.md "Turn on sync":
 *   1. Create a Google Sheet. Extensions > Apps Script. Paste this file.
 *   2. Change SYNC_KEY below to your own passphrase.
 *   3. Deploy > New deployment > Web app.
 *        Execute as: Me      Who has access: Anyone
 *   4. Copy the Web app URL (ends in /exec) into the app's Settings,
 *      together with the same passphrase.
 *
 * Conflict rule: per item, the newest edit (updatedAt) wins.
 * Deletes are kept as tombstones (deleted = TRUE) so they sync too.
 */

const SYNC_KEY = 'change-me-to-a-passphrase';
const SHEET_NAME = 'Inventory';
const COLUMNS = ['id', 'name', 'drawer', 'quantity', 'sku', 'category', 'notes',
  'createdAt', 'updatedAt', 'lastPrintedAt', 'deleted', 'syncedAt'];

function doGet(e) {
  return handle_(e.parameter || {});
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData && e.postData.contents || '{}'); }
  catch (err) { return json_({ ok: false, error: 'bad_json' }); }
  return handle_(body);
}

function handle_(req) {
  if (String(req.key || '') !== SYNC_KEY) return json_({ ok: false, error: 'bad_key' });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sheet = sheet_();
    const now = Date.now();
    let accepted = 0;

    if (req.action === 'sync' && Array.isArray(req.items) && req.items.length) {
      accepted = upsert_(sheet, req.items, now);
    } else if (req.action !== 'sync' && req.action !== 'ping') {
      return json_({ ok: false, error: 'bad_action' });
    }

    const since = Number(req.since || 0);
    const rows = readAll_(sheet).filter(function (r) { return Number(r.syncedAt || 0) > since; });
    return json_({ ok: true, serverTime: now, accepted: accepted, items: rows });
  } finally {
    lock.releaseLock();
  }
}

function upsert_(sheet, items, now) {
  const data = sheet.getDataRange().getValues();
  const index = {};
  for (let i = 1; i < data.length; i++) index[String(data[i][0])] = i;

  let accepted = 0;
  const appends = [];
  items.forEach(function (it) {
    if (!it || !it.id) return;
    const row = COLUMNS.map(function (c) {
      if (c === 'syncedAt') return now;
      if (c === 'deleted') return it.deleted ? true : false;
      const v = it[c];
      return v === undefined || v === null ? '' : v;
    });
    const at = index[String(it.id)];
    if (at === undefined) {
      appends.push(row);
      index[String(it.id)] = -1;
      accepted++;
    } else if (at > 0) {
      const existingUpdated = Number(data[at][COLUMNS.indexOf('updatedAt')] || 0);
      if (Number(it.updatedAt || 0) >= existingUpdated) {
        data[at] = row;
        sheet.getRange(at + 1, 1, 1, COLUMNS.length).setValues([row]);
        accepted++;
      }
    }
  });
  if (appends.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, appends.length, COLUMNS.length).setValues(appends);
  }
  return accepted;
}

function readAll_(sheet) {
  const data = sheet.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = {};
    COLUMNS.forEach(function (c, j) { r[c] = data[i][j]; });
    if (!r.id) continue;
    r.quantity = Number(r.quantity) || 0;
    r.deleted = r.deleted === true || String(r.deleted).toUpperCase() === 'TRUE';
    ['createdAt', 'updatedAt', 'lastPrintedAt', 'syncedAt'].forEach(function (k) {
      r[k] = r[k] === '' ? null : Number(r[k]);
    });
    ['name', 'drawer', 'sku', 'category', 'notes'].forEach(function (k) { r[k] = String(r[k] || ''); });
    r.id = String(r.id);
    out.push(r);
  }
  return out;
}

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) sh = ss.insertSheet(SHEET_NAME);
  if (sh.getLastRow() === 0) {
    sh.appendRow(COLUMNS);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, COLUMNS.length).setFontWeight('bold');
  }
  return sh;
}

/**
 * Edits made by hand in the Sheet (fixing a drawer, a quantity) are stamped
 * so the phones pick them up on their next sync. Runs automatically.
 */
function onEdit(e) {
  const sh = e.range.getSheet();
  if (sh.getName() !== SHEET_NAME || e.range.getRow() === 1) return;
  const now = Date.now();
  const first = e.range.getRow();
  const n = e.range.getNumRows();
  const updCol = COLUMNS.indexOf('updatedAt') + 1;
  const synCol = COLUMNS.indexOf('syncedAt') + 1;
  for (let r = first; r < first + n; r++) {
    if (!sh.getRange(r, 1).getValue()) continue;
    sh.getRange(r, updCol).setValue(now);
    sh.getRange(r, synCol).setValue(now);
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
