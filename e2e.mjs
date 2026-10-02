import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const { serve } = require('./fake-appsscript.cjs');
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outDir = process.argv[2] || here;

let failures = 0;
const check = (cond, msg) => { console.log((cond ? 'PASS ' : 'FAIL ') + msg); if (!cond) failures++; };

const { server: gsServer, gs } = await serve(9090, 'shop-secret');
const http = spawn('/opt/node22/bin/node', ['/opt/node22/lib/node_modules/http-server/bin/http-server', root, '-p', '8080', '-s', '-c-1'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch();
const fakeM2H = fs.readFileSync(path.join(here, 'fake-m2h.js'), 'utf8');
const errors = [];

async function newPhone(name, viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  await ctx.addInitScript(fakeM2H);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(name + ': ' + e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto('http://localhost:8080/index.html');
  await page.waitForFunction(() => window.JimApp);
  return page;
}
const cmd = async (page, text) => { await page.fill('#cmdInput', text); await page.click('#cmdForm button'); await page.waitForTimeout(150); };
const answerText = (page) => page.textContent('#answer');

// ---------- Phone A (iPhone-sized) ----------
const A = await newPhone('A', { width: 390, height: 844 });
await A.screenshot({ path: path.join(outDir, 'shot-1-empty.png') });

// connect printer
await A.click('#printerPill');
await A.click('#connectBtn');
await A.waitForFunction(() => window.JimApp.printer.connected, null, { timeout: 8000 });
const info = await A.textContent('#printerInfo');
check(/M2_H/.test(info) && /300 dpi/.test(info) && /567/.test(info) && /task B1/.test(info), 'printer identified as M2_H, 300 dpi, 567 px, B1 task: ' + info.replace(/\s+/g, ' '));
check(/560 × 354/.test(info), 'label geometry 50x30mm -> 560 x 354 px');
const reqOpts = await A.evaluate(() => window.__m2h.requestOptions);
check(JSON.stringify(reqOpts).includes('"namePrefix":"M"'), 'device picker filter includes M* names (M2_H)');
await A.screenshot({ path: path.join(outDir, 'shot-2-printer.png') });
await A.click('#printerClose');

// stock in by "voice" (typed — same parser)
await cmd(A, 'just got in a WAC-47 lens, drawer 3');
await A.waitForFunction(() => window.__m2h.printed >= 1, null, { timeout: 15000 });
let m = await A.evaluate(() => window.__m2h);
check(/Added WAC-47 lens in Drawer 3/.test(await answerText(A)), 'stock-in answer');
check(m.pageSize && m.pageSize.cols === 560 && m.pageSize.rows === 354, 'printer got page size 560x354: ' + JSON.stringify(m.pageSize));
check(m.rows > 10, 'bitmap rows streamed: ' + m.rows);
check(m.density === 3 && m.labelType === 1, 'density 3, label type "with gaps"');
const order = m.packets.filter((c) => [0x21, 0x23, 0x01, 0x03, 0x13, 0xe3, 0xa3, 0xf3].includes(c));
const firstIdx = (c) => order.indexOf(c);
check(firstIdx(0x21) < firstIdx(0x01) && firstIdx(0x01) < firstIdx(0x03) && firstIdx(0x03) < firstIdx(0x13) && firstIdx(0x13) < firstIdx(0xe3) && firstIdx(0xe3) < firstIdx(0xa3) && firstIdx(0xa3) < firstIdx(0xf3),
  'B1 print sequence: density → printStart → pageStart → pageSize → rows → pageEnd → status poll → printEnd');

// merge
await cmd(A, 'add WAC-47 lens drawer 3');
await A.waitForFunction(() => window.__m2h.printed >= 2, null, { timeout: 15000 });
let rowsA = await A.evaluate(() => window.JimApp.items.filter((i) => !i.deleted));
check(rowsA.length === 1 && rowsA[0].quantity === 2, 'same item + drawer merges to qty 2');

// ask-for-drawer flow
await cmd(A, 'add torque wrench');
check(await A.isVisible('#drawerDlg'), 'asks which drawer when none given');
const suggested = await A.inputValue('#drawerForm input[name=drawer]');
check(suggested === 'Drawer 1', 'suggests next free drawer: ' + suggested);
await A.click('#drawerForm button[value=ok]');
await A.waitForFunction(() => window.__m2h.printed >= 3, null, { timeout: 15000 });

await cmd(A, 'received 4 of M5 bolts in bin 7');
await A.waitForFunction(() => window.__m2h.printed >= 4, null, { timeout: 15000 });

await cmd(A, 'where is the WAC 47 lens');
check(/WAC-47 lens is in Drawer 3 \(qty 2\)/.test(await answerText(A)), 'find: ' + await answerText(A));
await cmd(A, 'how many WAC-47 lenses do I have');
check(/2 on hand/.test(await answerText(A)), 'count with plural: ' + await answerText(A));
await cmd(A, 'used up 1 of the M5 bolts');
check(/3 left/.test(await answerText(A)), 'partial remove: ' + await answerText(A));
await cmd(A, "what's in drawer 3");
check(/WAC-47 lens/.test(await answerText(A)), 'list drawer');
await cmd(A, 'blah blah');
check(/Didn’t understand/.test(await answerText(A)), 'unknown command handled');
await cmd(A, '');
await A.fill('#filter', '');
await A.evaluate(() => document.querySelector('#filter').dispatchEvent(new Event('input')));
await A.screenshot({ path: path.join(outDir, 'shot-3-list.png'), fullPage: true });

// label preview image
await A.evaluate(() => { const c = window.JimApp.renderLabel({ name: 'WAC-47 Lens Assembly', drawer: 'Drawer 3', quantity: 2, sku: 'WAC-47', createdAt: Date.now() }); c.id = 'lbl'; document.body.appendChild(c); });
const lbl = await A.$('#lbl');
await lbl.screenshot({ path: path.join(outDir, 'shot-label.png') });
await A.evaluate(() => document.getElementById('lbl').remove());

// edit dialog screenshot
await A.click('.item .name');
await A.screenshot({ path: path.join(outDir, 'shot-4-edit.png') });
await A.click('#itemForm button[value=cancel]');

// ---------- sync ----------
await A.click('#settingsBtn');
await A.fill('#settingsForm input[name=syncUrl]', 'http://localhost:9090/exec');
await A.fill('#settingsForm input[name=syncKey]', 'wrong');
await A.click('#settingsForm button[value=save]');
await A.waitForTimeout(1200);
check(/Sync error/.test(await A.textContent('#syncText')), 'wrong passphrase shows sync error');
await A.click('#settingsBtn');
await A.fill('#settingsForm input[name=syncKey]', 'shop-secret');
await A.click('#settingsForm button[value=save]');
await A.waitForFunction(() => document.querySelector('#syncText').textContent === 'Synced', null, { timeout: 8000 });
check(gs.sheet.rows.length === 4, 'sheet has header + 3 items: ' + gs.sheet.rows.length);

// Phone B (Android-sized) joins with same sync settings
const B = await newPhone('B', { width: 412, height: 915 });
await B.evaluate(() => { localStorage.setItem('jim.settings', JSON.stringify({ syncUrl: 'http://localhost:9090/exec', syncKey: 'shop-secret' })); });
await B.reload(); await B.waitForFunction(() => window.JimApp);
await B.waitForFunction(() => window.JimApp.items.filter((i) => !i.deleted).length === 3, null, { timeout: 8000 });
check(true, 'phone B pulled all 3 items from the sheet');
await cmd(B, 'where is the torque wrench');
check(/torque wrench is in Drawer 1/.test(await answerText(B)), 'phone B finds item stocked on phone A');

// B edits, A receives
await cmd(B, 'remove the torque wrench');
await B.waitForFunction(() => document.querySelector('#syncText').textContent === 'Synced', null, { timeout: 8000 });
await A.evaluate(() => window.JimApp.syncNow());
await A.waitForTimeout(800);
const aLive = await A.evaluate(() => window.JimApp.items.filter((i) => !i.deleted).map((i) => i.name));
check(!aLive.includes('torque wrench') && aLive.length === 2, 'delete on B propagated to A: ' + aLive.join(', '));

// edit in the Google Sheet by hand -> phones pick it up
const hdr = gs.sheet.rows[0];
const r = gs.sheet.rows.findIndex((row) => row[1] === 'WAC-47 lens');
gs.sheet.rows[r][hdr.indexOf('drawer')] = 'Drawer 9';
gs.ctx.onEdit({ range: { getSheet: () => gs.sheet, getRow: () => r + 1, getNumRows: () => 1 } });
await B.evaluate(() => window.JimApp.syncNow()); await B.waitForTimeout(800);
await cmd(B, 'where is the WAC-47 lens');
check(/Drawer 9/.test(await answerText(B)), 'hand edit in Sheet reached phone B: ' + await answerText(B));

// offline edit on A then reconnect
await A.context().setOffline(true);
await cmd(A, 'add safety wire x2 drawer 5');
await A.waitForTimeout(300);
check(/Offline/.test(await A.textContent('#syncText')), 'offline state shown with pending change');
await A.context().setOffline(false);
await A.evaluate(() => window.dispatchEvent(new Event('online')));
await A.waitForFunction(() => document.querySelector('#syncText').textContent === 'Synced', null, { timeout: 8000 });
await B.evaluate(() => window.JimApp.syncNow()); await B.waitForTimeout(800);
const bNames = await B.evaluate(() => window.JimApp.items.filter((i) => !i.deleted).map((i) => i.name + '@' + i.drawer + 'x' + i.quantity));
check(bNames.includes('safety wire@Drawer 5x2'), 'offline add synced after reconnect: ' + bNames.join(', '));
await B.screenshot({ path: path.join(outDir, 'shot-5-phoneB.png'), fullPage: true });

// ---------- no-Bluetooth browser (plain iPhone Safari) ----------
const ctxC = await browser.newContext({ viewport: { width: 390, height: 844 } });
const C = await ctxC.newPage();
C.on('pageerror', (e) => errors.push('C: ' + e.message));
await C.goto('http://localhost:8080/index.html'); await C.waitForFunction(() => window.JimApp);
await C.evaluate(() => { try { delete Navigator.prototype.bluetooth; } catch (e) {} });
await C.click('#printerPill');
await C.waitForTimeout(300);
check(await C.isVisible('#btUnsupported'), 'no-Bluetooth browser shows Bluefy / NIIMBOT-app guidance');
await C.screenshot({ path: path.join(outDir, 'shot-6-nobt.png') });

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await browser.close(); http.kill(); gsServer.close();
console.log(failures ? failures + ' FAILED' : 'ALL PASSED');
process.exit(failures ? 1 : 0);
