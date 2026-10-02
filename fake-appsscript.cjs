// Runs the REAL sync/Code.gs in Node with an in-memory Sheet, exposed over HTTP (with CORS like Apps Script).
const fs = require('fs'), vm = require('vm'), http = require('http'), path = require('path');

function makeSheet() {
  const rows = [];
  const sheet = {
    rows,
    getName: () => 'Inventory',
    getLastRow: () => rows.length,
    appendRow: (r) => rows.push(r.slice()),
    setFrozenRows() {},
    getDataRange: () => ({ getValues: () => rows.map((r) => r.slice()) }),
    getRange(row, col, nr = 1, nc = 1) {
      return {
        setValues(vals) { for (let i = 0; i < nr; i++) { rows[row - 1 + i] = rows[row - 1 + i] || []; for (let j = 0; j < nc; j++) rows[row - 1 + i][col - 1 + j] = vals[i][j]; } },
        setValue(v) { rows[row - 1][col - 1] = v; },
        getValue() { return (rows[row - 1] || [])[col - 1]; },
        setFontWeight() {},
      };
    },
  };
  return sheet;
}

function load(syncKey) {
  const sheet = makeSheet();
  const ctx = {
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet, insertSheet: () => sheet }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: { MimeType: { JSON: 'json' }, createTextOutput: (s) => ({ setMimeType() { return s; } }) },
    Date, JSON, Number, String, Array, Object,
  };
  vm.createContext(ctx);
  let src = fs.readFileSync(path.join(__dirname, '../sync/Code.gs'), 'utf8');
  src = src.replace("const SYNC_KEY = 'change-me-to-a-passphrase';", "const SYNC_KEY = " + JSON.stringify(syncKey) + ";");
  vm.runInContext(src + '\nthis.doGet=doGet;this.doPost=doPost;this.onEdit=onEdit;', ctx);
  return { ctx, sheet };
}

function serve(port, syncKey) {
  const gs = load(syncKey);
  const server = http.createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
    if (req.method === 'OPTIONS') { res.writeHead(400, cors); return res.end('preflight not expected'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && !/^text\/plain/.test(req.headers['content-type'] || '')) { res.writeHead(415, cors); return res.end('{}'); }
      const out = req.method === 'POST' ? gs.ctx.doPost({ postData: { contents: body } })
        : gs.ctx.doGet({ parameter: Object.fromEntries(new URL(req.url, 'http://x').searchParams) });
      res.writeHead(200, cors); res.end(out);
    });
  });
  return new Promise((r) => server.listen(port, () => r({ server, gs })));
}
module.exports = { serve, load };
