/*
 * Jim Inventory — web app (iPhone via Bluefy, Android Chrome, desktop Chrome/Edge).
 * Port of the Android app: voice-first stock-in / find, NIIMBOT label printing,
 * plus sync through a Google Sheet so every device sees the same inventory.
 */
(function () {
  'use strict';

  const N = window.niimbluelib;
  const { parse, normalize } = window.JimParser;
  const $ = (id) => document.getElementById(id);

  // ---------------------------------------------------------------- storage
  const LS = {
    get(key, fallback) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch (e) { return false; }
    },
  };

  const DEFAULT_SETTINGS = {
    syncUrl: '', syncKey: '', speakAnswers: true, autoPrint: true, askDrawer: false,
    labelSize: '50x30', customW: 50, customH: 30, density: 3,
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('jim.settings', {}));
  let items = LS.get('jim.items', []);
  let syncState = LS.get('jim.sync', { cursor: 0, lastOk: 0, lastError: '' });

  function saveItems() {
    if (!LS.set('jim.items', items)) toast('Could not save on this device (storage blocked?)');
    render();
    scheduleSync();
  }
  function saveSettings() { LS.set('jim.settings', settings); }
  function saveSyncState() { LS.set('jim.sync', syncState); }

  const live = () => items.filter((i) => !i.deleted);
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10));

  function touch(item) { item.updatedAt = Date.now(); item.dirty = true; }

  // ---------------------------------------------------------------- inventory logic (InventoryRepository port)
  function addItem({ name, drawer, quantity = 1, sku = '', category = '', notes = '' }) {
    name = String(name).trim(); drawer = String(drawer).trim();
    const key = normalize(name);
    const existing = live().find((i) => normalize(i.name) === key && i.drawer.toLowerCase() === drawer.toLowerCase());
    if (existing) {
      existing.quantity += Math.max(1, quantity);
      if (sku) existing.sku = sku;
      touch(existing); saveItems();
      return { item: existing, merged: true };
    }
    const now = Date.now();
    const item = {
      id: uuid(), name, drawer, quantity: Math.max(1, quantity), sku: sku.trim(), category: category.trim(), notes: notes.trim(),
      createdAt: now, updatedAt: now, lastPrintedAt: null, deleted: false, dirty: true,
    };
    items.push(item); saveItems();
    return { item, merged: false };
  }

  function deleteItem(item) { item.deleted = true; touch(item); saveItems(); }

  function setQuantity(item, q) {
    if (q <= 0) { deleteItem(item); toast('Removed ' + item.name); return; }
    item.quantity = q; touch(item); saveItems();
  }

  const singular = (w) => w.length > 3 && w.endsWith('es') && /(ses|xes|zes|ches|shes)$/.test(w) ? w.slice(0, -2)
    : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
  const keyWords = (s) => normalize(s).split(' ').filter(Boolean).map(singular);

  /** exact > all words match > substring > any significant word. Best first. */
  function findItems(query) {
    const q = normalize(query);
    if (!q) return [];
    const qWords = keyWords(query);
    const scored = [];
    for (const it of live()) {
      const n = normalize(it.name);
      const words = keyWords(it.name).concat(keyWords(it.sku || ''));
      let score = 0;
      if (n === q || normalize(it.sku || '') === q) score = 100;
      else if (qWords.length && qWords.every((w) => words.includes(w))) score = 80;
      else if (n.includes(q) || q.includes(n)) score = 60;
      else {
        const hits = qWords.filter((w) => w.length >= 3 && words.some((x) => x.includes(w) || w.includes(x))).length;
        if (hits) score = 20 + hits * 10;
      }
      if (score) scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score || b.it.updatedAt - a.it.updatedAt);
    return scored.map((s) => s.it);
  }

  function suggestNextDrawer(prefix = 'Drawer ') {
    const used = new Set(live().map((i) => i.drawer.toLowerCase()));
    let n = 1;
    while (used.has((prefix + n).toLowerCase())) n++;
    return prefix + n;
  }

  /** Where should a new item go? Same item already stocked -> that drawer; otherwise the next empty drawer. */
  function chooseDrawer(name) {
    const key = normalize(name);
    const same = live().filter((i) => normalize(i.name) === key).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return same ? same.drawer : suggestNextDrawer();
  }

  // ---------------------------------------------------------------- voice
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognizer = null;
  let listening = false;

  function speak(text) {
    if (!settings.speakAnswers || !('speechSynthesis' in window)) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'en-US'; u.rate = 1.0;
      speechSynthesis.speak(u);
    } catch (e) { /* ignore */ }
  }

  function answer(text, spoken, action) {
    const el = $('answer');
    el.textContent = text; el.classList.add('show');
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn'; b.style.marginTop = '10px'; b.style.display = 'block';
      b.textContent = action.label; b.onclick = action.run;
      el.appendChild(b);
    }
    if (spoken !== false) speak(spoken || text);
  }

  function startListening() {
    if (!SR) {
      // iPhone in Bluefy/Safari without speech API: the keyboard mic works everywhere.
      const input = $('cmdInput');
      input.focus();
      toast('Tap the 🎤 on the keyboard and speak, then Go');
      return;
    }
    if (listening) { recognizer && recognizer.stop(); return; }
    try { speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* */ }
    recognizer = new SR();
    recognizer.lang = 'en-US';
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.continuous = false;
    let finalText = '';
    recognizer.onstart = () => setListening(true);
    recognizer.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
        else interim += e.results[i][0].transcript;
      }
      $('transcript').textContent = (finalText + ' ' + interim).trim();
    };
    recognizer.onerror = (e) => {
      setListening(false);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        toast('Microphone blocked — use the keyboard 🎤 in the box instead');
        $('cmdInput').focus();
      } else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Didn’t catch that (' + e.error + ')');
    };
    recognizer.onend = () => {
      setListening(false);
      const text = finalText.trim() || $('transcript').textContent.trim();
      if (text) runCommand(text);
    };
    try { recognizer.start(); } catch (e) { setListening(false); }
  }

  function setListening(on) {
    listening = on;
    $('micBtn').classList.toggle('listening', on);
    $('micLabel').textContent = on ? 'Listening… tap to stop' : 'Speak';
    if (on) $('transcript').textContent = '';
  }

  // ---------------------------------------------------------------- commands (MainViewModel.handleIntent port)
  let pendingAdd = null;

  async function runCommand(text) {
    $('transcript').textContent = '“' + text + '”';
    const intent = parse(text);
    switch (intent.type) {
      case 'add': {
        if (!intent.name) return answer('What item should I add? Try: “add WAC-47 lens drawer 3”.');
        if (intent.drawer) return stockIn(intent.name, intent.drawer, intent.quantity);
        if (!settings.askDrawer) return stockIn(intent.name, chooseDrawer(intent.name), intent.quantity, true);
        pendingAdd = { name: intent.name, quantity: intent.quantity };
        const suggestion = suggestNextDrawer();
        $('drawerQ').textContent = '“' + intent.name + '”' + (intent.quantity > 1 ? ' (×' + intent.quantity + ')' : '') + ' goes where? Suggested: ' + suggestion;
        $('drawerForm').drawer.value = suggestion;
        speak('Which drawer for ' + intent.name + '? I suggest ' + suggestion + '.');
        $('drawerDlg').showModal();
        return;
      }
      case 'find': {
        const hits = findItems(intent.query);
        if (!hits.length) return answer('No “' + intent.query + '” in inventory.', 'I don’t have ' + intent.query + ' in inventory.');
        $('filter').value = intent.query; render();
        if (hits.length === 1) {
          const it = hits[0];
          return answer(it.name + ' is in ' + it.drawer + ' (qty ' + it.quantity + ').', it.name + ' is in ' + it.drawer + '. Quantity ' + it.quantity + '.');
        }
        const lines = hits.slice(0, 5).map((i) => '• ' + i.name + ' — ' + i.drawer + ' (×' + i.quantity + ')').join('\n');
        return answer(hits.length + ' matches:\n' + lines, hits.length + ' matches. First is ' + hits[0].name + ' in ' + hits[0].drawer + '.');
      }
      case 'count': {
        const hits = findItems(intent.query);
        if (!hits.length) return answer('No “' + intent.query + '” in inventory.', 'None in inventory.');
        const top = hits[0];
        const same = hits.filter((h) => normalize(h.name) === normalize(top.name));
        const total = same.reduce((s, h) => s + h.quantity, 0);
        const where = [...new Set(same.map((h) => h.drawer))].join(', ');
        return answer(top.name + ': ' + total + ' on hand (' + where + ').', total + ' ' + top.name + ' on hand, in ' + where + '.');
      }
      case 'print': {
        let target = intent.query ? findItems(intent.query)[0] : null;
        if (!target && intent.drawer) target = live().find((i) => i.drawer.toLowerCase() === intent.drawer.toLowerCase());
        if (!target) return answer('Nothing matching “' + (intent.query || intent.drawer || '') + '” to print.');
        answer('Printing label for ' + target.name + '…', false);
        return printItem(target);
      }
      case 'remove': {
        const it = findItems(intent.query)[0];
        if (!it) return answer('Nothing matching “' + intent.query + '”.');
        if (intent.quantity && intent.quantity < it.quantity) {
          setQuantity(it, it.quantity - intent.quantity);
          return answer('Took ' + intent.quantity + ' ' + it.name + ' out of ' + it.drawer + '. ' + it.quantity + ' left.');
        }
        deleteItem(it);
        return answer('Removed ' + it.name + ' from ' + it.drawer + '.', 'Removed ' + it.name + '.');
      }
      case 'list': {
        const list = intent.drawer ? live().filter((i) => i.drawer.toLowerCase() === intent.drawer.toLowerCase()) : live();
        $('filter').value = intent.drawer || ''; render();
        if (!list.length) return answer(intent.drawer ? intent.drawer + ' is empty.' : 'Nothing stocked yet.');
        const lines = list.slice(0, 12).map((i) => '• ' + i.name + ' — ' + i.drawer + ' (×' + i.quantity + ')').join('\n');
        return answer(lines + (list.length > 12 ? '\n…and ' + (list.length - 12) + ' more' : ''),
          list.length + ' items' + (intent.drawer ? ' in ' + intent.drawer : '') + '.');
      }
      default:
        return answer('Didn’t understand “' + text + '”. Try “add X drawer 3” or “where is X”.', 'Sorry, I didn’t understand that.');
    }
  }

  function stockIn(name, drawer, quantity, assigned) {
    const { item, merged } = addItem({ name, drawer, quantity });
    let msg, spoken;
    if (assigned && merged) {
      msg = 'Put it in ' + item.drawer.toUpperCase() + ' — that’s where ' + item.name + ' already lives. Now ' + item.quantity + ' on hand.';
      spoken = 'Put it in ' + item.drawer + ', with the other ' + item.name + '.';
    } else if (assigned) {
      msg = 'Put ' + item.name + (quantity > 1 ? ' ×' + quantity : '') + ' in ' + item.drawer.toUpperCase() + '.';
      spoken = 'Put ' + item.name + ' in ' + item.drawer + '.';
    } else {
      msg = merged
        ? 'Added ' + quantity + ' more ' + item.name + ' — now ' + item.quantity + ' in ' + item.drawer + '.'
        : 'Added ' + item.name + (quantity > 1 ? ' ×' + quantity : '') + ' in ' + item.drawer + '.';
      spoken = item.name + ', ' + item.drawer + '.';
    }
    if (settings.autoPrint) {
      if (printer.connected) spoken += ' Printing label.';
      else { queuePrint(item); msg += '\nLabel will print as soon as the printer connects.'; spoken += ' The label will print when the printer connects.'; }
    }
    answer(msg, spoken, assigned ? { label: 'Use a different drawer', run: () => openItem(item) } : null);
    if (settings.autoPrint && printer.connected) printItem(item);
  }

  // Labels waiting for the printer (saved so a reload doesn't lose them)
  let printQueue = LS.get('jim.printQueue', []);
  function queuePrint(item) {
    if (!printQueue.includes(item.id)) printQueue.push(item.id);
    LS.set('jim.printQueue', printQueue); updatePrinterUi();
  }
  async function flushPrintQueue() {
    while (printQueue.length && printer.connected) {
      const id = printQueue[0];
      const it = items.find((i) => i.id === id && !i.deleted);
      if (it && !(await printItem(it))) break;
      printQueue.shift(); LS.set('jim.printQueue', printQueue); updatePrinterUi();
    }
  }

  // ---------------------------------------------------------------- label rendering (LabelRenderer port)
  function labelMm() {
    if (settings.labelSize === 'custom') return { w: +settings.customW || 50, h: +settings.customH || 30 };
    const [w, h] = settings.labelSize.split('x').map(Number);
    return { w, h };
  }

  /** Canvas size in printer pixels. Defaults to the M2-H (300 dpi, 567 px head) when not connected. */
  function labelGeometry() {
    const meta = printer.meta;
    const dpi = meta ? meta.dpi : 300;
    const head = meta ? meta.printheadPixels : 567;
    const dir = meta ? meta.printDirection : 'top';
    const { w, h } = labelMm();
    let wPx = Math.round(w / 25.4 * dpi);
    let hPx = Math.round(h / 25.4 * dpi);
    const headMax = Math.floor(head / 8) * 8;
    if (dir === 'top') wPx = Math.min(wPx, headMax); else hPx = Math.min(hPx, headMax);
    return { wPx, hPx, dpi, dir };
  }

  function fitFont(ctx, text, maxW, start, min, weight) {
    let size = start;
    while (size > min) {
      ctx.font = weight + ' ' + size + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
      if (ctx.measureText(text).width <= maxW) break;
      size -= 2;
    }
    ctx.font = weight + ' ' + size + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
    return size;
  }

  function wrapLines(ctx, text, maxW, maxLines) {
    const words = String(text).split(/\s+/);
    const lines = [];
    let line = '';
    for (const w of words) {
      const cand = line ? line + ' ' + w : w;
      if (ctx.measureText(cand).width > maxW && line) { lines.push(line); line = w; } else line = cand;
    }
    if (line) lines.push(line);
    if (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines);
      let last = kept[maxLines - 1] + '…';
      while (ctx.measureText(last).width > maxW && last.length > 2) last = last.slice(0, -2) + '…';
      kept[maxLines - 1] = last;
      return kept;
    }
    return lines;
  }

  function renderLabel(item, canvas) {
    const { wPx, hPx } = labelGeometry();
    canvas = canvas || document.createElement('canvas');
    canvas.width = wPx; canvas.height = hPx;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, wPx, hPx);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';

    const m = Math.max(8, Math.round(Math.min(wPx, hPx) * 0.06));
    const cw = wPx - m * 2;
    const ch = hPx - m * 2;

    // Budget: name ~40%, drawer ~35%, meta ~15%, gaps.
    const meta = [];
    if (item.sku) meta.push('SKU ' + item.sku);
    meta.push('QTY ' + item.quantity);
    if (item.category) meta.push(item.category);
    meta.push(new Date(item.createdAt || Date.now()).toLocaleDateString('en-US'));
    const metaText = meta.join('  ·  ');

    const drawerText = String(item.drawer || '').toUpperCase();
    const drawerSize = fitFont(ctx, drawerText, cw, Math.round(ch * 0.36), 14, '800');

    const metaSize = fitFont(ctx, metaText, cw, Math.max(12, Math.round(ch * 0.11)), 10, '500');

    const nameBudget = ch - drawerSize * 1.1 - metaSize * 1.6 - m * 0.6;
    let nameSize = Math.round(Math.min(ch * 0.3, nameBudget));
    let lines;
    for (; nameSize > 12; nameSize -= 2) {
      ctx.font = '700 ' + nameSize + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
      lines = wrapLines(ctx, item.name, cw, 3);
      if (lines.length * nameSize * 1.12 <= nameBudget && lines.every((l) => ctx.measureText(l).width <= cw)) break;
    }
    ctx.font = '700 ' + nameSize + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
    lines = wrapLines(ctx, item.name, cw, 3);

    let y = m;
    for (const l of lines) { y += nameSize; ctx.fillText(l, m, y); y += nameSize * 0.12; }

    // drawer — the line Jim reads across the shop
    y += Math.round(m * 0.4) + drawerSize * 0.95;
    ctx.font = '800 ' + drawerSize + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(drawerText, m, y);

    // divider + meta pinned to the bottom
    const metaBase = hPx - m;
    const lineY = metaBase - metaSize * 1.25;
    ctx.fillRect(m, Math.round(lineY), cw, Math.max(2, Math.round(hPx / 120)));
    ctx.font = '500 ' + metaSize + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(metaText, m, metaBase);

    // hard 1-bit threshold so the preview matches what the printer does
    const img = ctx.getImageData(0, 0, wPx, hPx);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 140 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  async function shareLabelImage(item) {
    const canvas = renderLabel(item);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const fname = 'label-' + normalize(item.name).replace(/ /g, '-').slice(0, 40) + '.png';
    const file = new File([blob], fname, { type: 'image/png' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: item.name });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------------------------------------------------------------- printer (niimbluelib over Web Bluetooth)
  const printer = { client: null, connected: false, meta: null, info: null, task: null, busy: false, name: '' };

  // Older WebKit-based BLE browsers only have writeValue(); niimbluelib calls writeValueWithoutResponse().
  if (window.BluetoothRemoteGATTCharacteristic && !BluetoothRemoteGATTCharacteristic.prototype.writeValueWithoutResponse) {
    BluetoothRemoteGATTCharacteristic.prototype.writeValueWithoutResponse = function (v) { return this.writeValue(v); };
  }

  async function bluetoothAvailable() {
    if (!navigator.bluetooth || !N) return false;
    try { return navigator.bluetooth.getAvailability ? await navigator.bluetooth.getAvailability() : true; } catch (e) { return true; }
  }

  // Every GATT service a NIIMBOT may use. Must be listed up front or the browser hides it after connecting.
  const NIIMBOT_SERVICES = ['e7810a71-73ae-499d-8c15-faa9aef0c3f2', '0000fee0-0000-1000-8000-00805f9b34fb',
    '0000ff00-0000-1000-8000-00805f9b34fb', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '000018f0-0000-1000-8000-00805f9b34fb'];

  /** showAll = list every nearby Bluetooth device (for printers that don't advertise their name/service). */
  async function pickDevice(showAll) {
    if (showAll) return navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: NIIMBOT_SERVICES });
    const prefixes = ['M2', 'M3', 'B1', 'B2', 'B3', 'B21', 'D1', 'D11', 'D110', 'K3', 'A8', 'NIIMBOT'];
    return navigator.bluetooth.requestDevice({
      filters: prefixes.map((p) => ({ namePrefix: p })).concat([{ services: [NIIMBOT_SERVICES[0]] }]),
      optionalServices: NIIMBOT_SERVICES,
    });
  }

  async function connectPrinter(showAll) {
    showAll = showAll === true;
    if (!(await bluetoothAvailable())) { $('btUnsupported').hidden = false; toast('Bluetooth printing isn’t available in this browser'); return; }
    if (printer.client) { try { await printer.client.disconnect(); } catch (e) { /* */ } }
    const client = new N.NiimbotBluetoothClient();
    printer.client = client;
    client.on('disconnect', () => {
      printer.connected = false; printer.busy = false;
      updatePrinterUi(); toast('Printer disconnected');
    });
    client.on('heartbeat', () => updatePrinterUi());
    setPrinterText('Connecting…', 'warn');
    try {
      const device = await pickDevice(showAll);
      setPrinterText('Connecting…', 'warn');
      const res = await client.connect({ authorizedDevice: device });
      printer.connected = true;
      printer.name = res.deviceName || 'NIIMBOT';
      printer.info = client.getPrinterInfo();
      printer.meta = client.getModelMetadata() || guessMetaFromName(printer.name);
      printer.task = client.getPrintTaskType() || 'B1';
      updatePrinterUi(); refreshTestPreview(); render();
      const waiting = printQueue.length;
      speak('Printer connected.' + (waiting ? ' Printing ' + waiting + ' waiting label' + (waiting > 1 ? 's.' : '.') : ''));
      toast('Connected to ' + printer.name);
      flushPrintQueue();
    } catch (e) {
      printer.connected = false;
      updatePrinterUi();
      const msg = String(e && e.message || e);
      if (/cancel|not found|no device/i.test(msg)) {
        toast(showAll ? 'No device picked' : 'Printer not in the list? Try “Show all devices”.');
        return;
      }
      if (/suitable.*characteristic/i.test(msg)) {
        toast('That device isn’t a NIIMBOT printer (or the NIIMBOT app still has it). Close the NIIMBOT app and try again.');
        return;
      }
      toast('Could not connect: ' + msg + ' — close the NIIMBOT app, turn the printer off and on, and try again.');
    }
  }

  /** If the model id read fails, the advertised name (e.g. "M2_H-1721050135") still identifies Jim's printer. */
  function guessMetaFromName(name) {
    const up = String(name || '').toUpperCase();
    const lib = N.modelsLibrary || [];
    const hit = lib.slice().sort((a, b) => b.model.length - a.model.length).find((m) => up.startsWith(String(m.model).toUpperCase()));
    return hit || { model: 'M2_H', dpi: 300, printheadPixels: 567, printDirection: 'top', densityMin: 1, densityMax: 5 };
  }

  async function disconnectPrinter() {
    if (printer.client) { try { await printer.client.disconnect(); } catch (e) { /* */ } }
    printer.connected = false; updatePrinterUi();
  }

  async function printItem(item, copies = 1) {
    if (!printer.connected) {
      toast('Connect the printer first (tap Printer at the top)');
      return false;
    }
    if (printer.busy) { toast('Printer busy — one moment'); return false; }
    printer.busy = true; updatePrinterUi();
    const bar = $('printProgress');
    bar.hidden = false; bar.firstElementChild.style.width = '5%';
    const client = printer.client;
    const onProgress = (e) => { bar.firstElementChild.style.width = Math.max(5, e.pagePrintProgress || 0) + '%'; };
    client.on('printprogress', onProgress);
    let task = null;
    try {
      const canvas = renderLabel(item);
      const encoded = N.ImageEncoder.encodeCanvas(canvas, N.PageColorType.SingleColor, printer.meta.printDirection || 'top');
      const dMax = printer.meta.densityMax || 5;
      task = client.protocol.newPrintTask(printer.task, {
        totalPages: copies,
        density: Math.min(dMax, Math.max(printer.meta.densityMin || 1, +settings.density || 3)),
        labelType: N.LabelType.WithGaps,
        pageColor: N.PageColorType.SingleColor,
        statusPollIntervalMs: 300,
        statusTimeoutMs: 15000,
        pageTimeoutMs: 15000,
      });
      await task.printInit();
      await task.printPage(encoded, copies);
      await task.waitForPageFinished();
      await task.waitForFinished();
      if (item.id) { item.lastPrintedAt = Date.now(); touch(item); saveItems(); }
      toast('Printed label for ' + item.name);
      return true;
    } catch (e) {
      console.error(e);
      toast('Print failed: ' + (e && e.message || e));
      answer('Print failed: ' + (e && e.message || e) + '\nCheck the lid is closed and a genuine NIIMBOT roll is loaded.', 'Print failed.');
      return false;
    } finally {
      if (task) { try { await task.printEnd(); } catch (e) { /* */ } }
      client.off('printprogress', onProgress);
      bar.firstElementChild.style.width = '100%';
      setTimeout(() => { bar.hidden = true; bar.firstElementChild.style.width = '0'; }, 800);
      printer.busy = false; updatePrinterUi();
    }
  }

  function setPrinterText(text, state) {
    $('printerText').textContent = text;
    $('printerDot').className = 'dot' + (state ? ' ' + state : '');
  }

  function updatePrinterUi() {
    if (printer.connected) {
      const batt = printer.info ? printer.info.batteryPercents : null;
      setPrinterText(printer.busy ? 'Printing…' : (printer.meta && printer.meta.model ? String(printer.meta.model).replace('_', '-') : 'Printer'), printer.busy ? 'warn' : 'ok');
      const g = labelGeometry();
      $('printerInfo').innerHTML = '';
      const lines = [
        'Connected: ' + printer.name,
        'Model: ' + (printer.meta.model || '?') + ' · ' + printer.meta.dpi + ' dpi · head ' + printer.meta.printheadPixels + ' px · task ' + printer.task,
        (printer.info && printer.info.serial ? 'Serial: ' + printer.info.serial + ' · ' : '') + (batt != null ? 'Battery: ' + batt + '%' : ''),
        'Label: ' + g.wPx + ' × ' + g.hPx + ' px',
      ];
      lines.filter(Boolean).forEach((l) => { const d = document.createElement('div'); d.textContent = l; $('printerInfo').appendChild(d); });
    } else {
      setPrinterText(printQueue.length ? 'Printer (' + printQueue.length + ' waiting)' : 'Printer', printQueue.length ? 'warn' : (printer.client ? 'bad' : ''));
      $('printerInfo').textContent = 'Not connected. Turn the M2-H on, then tap Connect and pick it from the list (it shows as “M2_H-…”).';
    }
    $('connectBtn').hidden = printer.connected;
    $('connectAllBtn').hidden = printer.connected;
    $('findHelp').hidden = printer.connected;
    $('disconnectBtn').hidden = !printer.connected;
    $('testPrintBtn').disabled = !printer.connected || printer.busy;
  }

  const SAMPLE = { name: 'WAC-47 Lens', drawer: 'Drawer 3', quantity: 2, sku: 'WAC-47', createdAt: Date.now() };
  function refreshTestPreview() { renderLabel(SAMPLE, $('testPreview')); }

  // ---------------------------------------------------------------- sync (Google Sheet via Apps Script)
  let syncTimer = null;
  let syncing = false;

  function scheduleSync(delay = 1500) {
    if (!settings.syncUrl) { updateSyncUi(); return; }
    clearTimeout(syncTimer);
    syncTimer = setTimeout(syncNow, delay);
    updateSyncUi();
  }

  async function syncNow() {
    if (!settings.syncUrl || syncing) return;
    if (!navigator.onLine) { updateSyncUi(); return; }
    syncing = true; updateSyncUi();
    const outgoing = items.filter((i) => i.dirty).map((i) => {
      const o = Object.assign({}, i); delete o.dirty; return o;
    });
    const sentVersion = new Map(outgoing.map((o) => [o.id, o.updatedAt]));
    try {
      const res = await fetch(settings.syncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // keeps it a "simple" request (no CORS preflight)
        body: JSON.stringify({ key: settings.syncKey, action: 'sync', since: syncState.cursor || 0, items: outgoing }),
        redirect: 'follow',
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error === 'bad_key' ? 'wrong passphrase' : (data.error || 'server error'));
      // our pushes landed — clear dirty flags unless edited again meanwhile
      for (const it of items) if (it.dirty && sentVersion.get(it.id) === it.updatedAt) it.dirty = false;
      // merge remote rows: newest edit wins
      const byId = new Map(items.map((i) => [i.id, i]));
      for (const r of data.items || []) {
        const local = byId.get(r.id);
        const remote = {
          id: r.id, name: r.name, drawer: r.drawer, quantity: Number(r.quantity) || 0, sku: r.sku || '', category: r.category || '',
          notes: r.notes || '', createdAt: r.createdAt || r.updatedAt || Date.now(), updatedAt: r.updatedAt || 0,
          lastPrintedAt: r.lastPrintedAt || null, deleted: !!r.deleted, dirty: false,
        };
        if (!local) { items.push(remote); byId.set(r.id, remote); }
        else if (!local.dirty && remote.updatedAt >= local.updatedAt) Object.assign(local, remote);
      }
      syncState.cursor = Math.max(0, (data.serverTime || Date.now()) - 2000); // small overlap; merges are idempotent
      syncState.lastOk = Date.now(); syncState.lastError = '';
      LS.set('jim.items', items); saveSyncState(); render();
    } catch (e) {
      syncState.lastError = String(e && e.message || e); saveSyncState();
    } finally {
      syncing = false; updateSyncUi();
      if (items.some((i) => i.dirty) && !syncState.lastError) scheduleSync(500);
    }
  }

  function updateSyncUi() {
    const pending = items.filter((i) => i.dirty).length;
    let text, state, info;
    if (!settings.syncUrl) { text = 'Local'; state = ''; info = 'Sync is off — inventory is stored on this device only. Add a sync URL to share it across devices.'; }
    else if (syncing) { text = 'Syncing…'; state = 'warn'; info = 'Syncing…'; }
    else if (!navigator.onLine) { text = pending ? 'Offline (' + pending + ')' : 'Offline'; state = 'warn'; info = 'Offline — changes are saved here and will sync when back online.'; }
    else if (syncState.lastError) { text = 'Sync error'; state = 'bad'; info = 'Last sync failed: ' + syncState.lastError; }
    else if (pending) { text = 'Pending ' + pending; state = 'warn'; info = pending + ' change(s) waiting to sync.'; }
    else { text = 'Synced'; state = 'ok'; info = syncState.lastOk ? 'Last synced ' + new Date(syncState.lastOk).toLocaleString() : 'Not synced yet.'; }
    $('syncText').textContent = text;
    $('syncDot').className = 'dot' + (state ? ' ' + state : '');
    $('syncInfo').textContent = info;
  }

  // ---------------------------------------------------------------- UI: list
  function render() {
    const q = $('filter').value.trim();
    let list = live();
    if (q) {
      const nq = normalize(q);
      const hits = new Set(findItems(q).map((i) => i.id));
      list = list.filter((i) => hits.has(i.id) || i.drawer.toLowerCase().includes(q.toLowerCase()) || normalize(i.drawer) === nq);
    }
    list.sort((a, b) => a.drawer.localeCompare(b.drawer, undefined, { numeric: true }) || a.name.localeCompare(b.name));
    $('count').textContent = list.length + (q ? ' of ' + live().length : '') + ' items';
    const root = $('list');
    root.textContent = '';
    if (!list.length) {
      const d = document.createElement('div'); d.className = 'empty';
      d.textContent = live().length ? 'No matches.' : 'Nothing stocked yet. Tap Speak or + to add the first item.';
      root.appendChild(d); return;
    }
    for (const it of list) root.appendChild(itemCard(it));
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function itemCard(it) {
    const card = el('div', 'item');
    const left = el('div');
    const name = el('div', 'name', it.name); name.onclick = () => openItem(it);
    left.appendChild(name);
    left.appendChild(el('div', 'drawer', it.drawer));
    card.appendChild(left);

    const qty = el('div', 'qty');
    const minus = el('button', null, '−'); minus.setAttribute('aria-label', 'Less');
    const plus = el('button', null, '+'); plus.setAttribute('aria-label', 'More');
    minus.onclick = () => { if (it.quantity <= 1 && !confirm('Remove ' + it.name + '?')) return; setQuantity(it, it.quantity - 1); };
    plus.onclick = () => setQuantity(it, it.quantity + 1);
    qty.append(minus, el('span', null, String(it.quantity)), plus);
    card.appendChild(qty);

    const meta = [it.sku && 'SKU ' + it.sku, it.category, it.notes, it.lastPrintedAt && 'printed ' + new Date(it.lastPrintedAt).toLocaleDateString()].filter(Boolean).join(' · ');
    if (meta) card.appendChild(el('div', 'meta', meta));

    const actions = el('div', 'actions');
    const say = el('button', 'btn', '🔊 Where'); say.onclick = () => answer(it.name + ' is in ' + it.drawer + ' (qty ' + it.quantity + ').', it.name + ' is in ' + it.drawer + '.');
    const pr = el('button', 'btn', '🖨 Print'); pr.onclick = () => printItem(it);
    if (!printer.connected) pr.title = 'Connect the printer first';
    const ed = el('button', 'btn', 'Edit'); ed.onclick = () => openItem(it);
    actions.append(say, pr, ed);
    card.appendChild(actions);
    return card;
  }

  // ---------------------------------------------------------------- UI: dialogs
  let editing = null;
  function openItem(it) {
    editing = it || null;
    const f = $('itemForm');
    $('itemTitle').textContent = it ? 'Edit item' : 'Add item';
    f.name.value = it ? it.name : '';
    f.drawer.value = it ? it.drawer : suggestNextDrawer();
    f.quantity.value = it ? it.quantity : 1;
    f.sku.value = it ? it.sku || '' : '';
    f.category.value = it ? it.category || '' : '';
    f.notes.value = it ? it.notes || '' : '';
    $('itemDelete').hidden = !it;
    updateItemPreview();
    $('itemDlg').showModal();
    if (!it) setTimeout(() => f.name.focus(), 50);
  }
  function formItem() {
    const f = $('itemForm');
    return {
      name: f.name.value.trim() || 'Item name', drawer: f.drawer.value.trim() || 'Drawer ?', quantity: Math.max(0, parseInt(f.quantity.value, 10) || 0),
      sku: f.sku.value.trim(), category: f.category.value.trim(), notes: f.notes.value.trim(),
      createdAt: editing ? editing.createdAt : Date.now(),
    };
  }
  function updateItemPreview() { renderLabel(formItem(), $('itemPreview')); }

  $('itemForm').addEventListener('input', updateItemPreview);
  $('itemForm').addEventListener('submit', (e) => {
    const action = e.submitter && e.submitter.value;
    if (action === 'cancel') return;
    const f = $('itemForm');
    if (!f.name.value.trim() || !f.drawer.value.trim()) { e.preventDefault(); toast('Name and drawer are required'); return; }
    const v = formItem();
    let target;
    if (editing) {
      Object.assign(editing, { name: v.name, drawer: v.drawer, quantity: v.quantity || 1, sku: v.sku, category: v.category, notes: v.notes });
      touch(editing); saveItems(); target = editing;
      toast('Saved');
    } else {
      target = addItem(Object.assign({}, v, { quantity: v.quantity || 1 })).item;
      toast('Added ' + target.name + ' in ' + target.drawer);
    }
    if (action === 'saveprint') printItem(target);
  });
  $('itemDelete').onclick = () => {
    if (editing && confirm('Delete ' + editing.name + '?')) { deleteItem(editing); $('itemDlg').close(); toast('Removed ' + editing.name); }
  };
  $('itemImage').onclick = () => shareLabelImage(formItem());

  $('drawerForm').addEventListener('submit', (e) => {
    const action = e.submitter && e.submitter.value;
    if (action === 'cancel' || !pendingAdd) { pendingAdd = null; return; }
    const drawer = $('drawerForm').drawer.value.trim();
    if (!drawer) { e.preventDefault(); return; }
    const p = pendingAdd; pendingAdd = null;
    stockIn(p.name, drawer, p.quantity);
  });

  // printer dialog
  function openPrinter() {
    $('labelSize').value = settings.labelSize;
    $('density').value = String(settings.density);
    $('customW').value = settings.customW; $('customH').value = settings.customH;
    $('customSize').hidden = settings.labelSize !== 'custom';
    bluetoothAvailable().then((ok) => { $('btUnsupported').hidden = ok; $('connectBtn').disabled = !ok; });
    updatePrinterUi(); refreshTestPreview();
    $('printerDlg').showModal();
  }
  $('labelSize').onchange = () => { settings.labelSize = $('labelSize').value; $('customSize').hidden = settings.labelSize !== 'custom'; saveSettings(); refreshTestPreview(); updatePrinterUi(); };
  $('customW').oninput = $('customH').oninput = () => { settings.customW = +$('customW').value || 50; settings.customH = +$('customH').value || 30; saveSettings(); refreshTestPreview(); updatePrinterUi(); };
  $('density').onchange = () => { settings.density = +$('density').value; saveSettings(); };
  $('connectBtn').onclick = () => connectPrinter(false);
  $('connectAllBtn').onclick = () => connectPrinter(true);
  $('disconnectBtn').onclick = disconnectPrinter;
  $('testPrintBtn').onclick = () => printItem(Object.assign({}, SAMPLE, { name: 'Test label', drawer: 'Drawer 1' }));
  $('printerClose').onclick = () => $('printerDlg').close();
  $('printerPill').onclick = openPrinter;

  // settings dialog
  function openSettings() {
    const f = $('settingsForm');
    f.syncUrl.value = settings.syncUrl; f.syncKey.value = settings.syncKey;
    f.speakAnswers.checked = !!settings.speakAnswers; f.autoPrint.checked = !!settings.autoPrint; f.askDrawer.checked = !!settings.askDrawer;
    updateSyncUi();
    $('settingsDlg').showModal();
  }
  $('settingsForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    const f = $('settingsForm');
    const newUrl = f.syncUrl.value.trim();
    if (newUrl && !/^https:\/\/script\.google(usercontent)?\.com\//.test(newUrl) && !confirm('That doesn’t look like a Google Apps Script URL. Use it anyway?')) { e.preventDefault(); return; }
    if (newUrl !== settings.syncUrl) {
      syncState.cursor = 0; saveSyncState();
      items.forEach((i) => { i.dirty = true; }); // push everything to the new sheet
    }
    settings.syncUrl = newUrl; settings.syncKey = f.syncKey.value;
    settings.speakAnswers = f.speakAnswers.checked; settings.autoPrint = f.autoPrint.checked; settings.askDrawer = f.askDrawer.checked;
    saveSettings(); LS.set('jim.items', items);
    scheduleSync(100);
  });
  $('settingsBtn').onclick = openSettings;
  $('syncPill').onclick = () => { if (settings.syncUrl) { syncNow(); toast('Syncing…'); } else openSettings(); };
  $('syncNowBtn').onclick = () => syncNow();

  $('exportBtn').onclick = async () => {
    const data = JSON.stringify({ app: 'jim-inventory', version: 1, exportedAt: new Date().toISOString(), items }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const fname = 'jim-inventory-backup-' + new Date().toISOString().slice(0, 10) + '.json';
    const file = new File([blob], fname, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: fname }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
  };
  $('importBtn').onclick = () => $('importFile').click();
  $('importFile').onchange = async () => {
    const file = $('importFile').files[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const incoming = Array.isArray(data) ? data : data.items;
      if (!Array.isArray(incoming)) throw new Error('not a Jim Inventory backup');
      const byId = new Map(items.map((i) => [i.id, i]));
      let n = 0;
      for (const r of incoming) {
        if (!r || !r.name) continue;
        const it = Object.assign({ id: uuid(), drawer: '', quantity: 1, sku: '', category: '', notes: '', createdAt: Date.now(), updatedAt: Date.now(), deleted: false }, r);
        it.id = String(it.id); it.dirty = true;
        const local = byId.get(it.id);
        if (!local) { items.push(it); n++; } else if ((it.updatedAt || 0) > (local.updatedAt || 0)) { Object.assign(local, it); n++; }
      }
      saveItems(); toast('Imported ' + n + ' items');
    } catch (e) { toast('Import failed: ' + (e.message || e)); }
    $('importFile').value = '';
  };

  // main controls
  $('micBtn').onclick = startListening;
  $('cmdForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('cmdInput').value.trim();
    if (!v) return;
    $('cmdInput').value = ''; $('cmdInput').blur();
    runCommand(v);
  });
  $('filter').addEventListener('input', render);
  $('addBtn').onclick = () => openItem(null);

  let toastTimer = null;
  function toast(text) {
    const t = $('toast'); t.textContent = text; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  if (!SR) $('voiceHint').textContent = 'Tap Speak, then the 🎤 on the keyboard. Say “just got in a WAC-47 lens” — it picks the drawer and prints the label.';

  window.addEventListener('online', () => scheduleSync(200));
  window.addEventListener('offline', updateSyncUi);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(200); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 45000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }

  // test hooks (harmless in production)
  window.JimApp = { runCommand, findItems, renderLabel, printItem, connectPrinter, syncNow, get items() { return items; }, printer, settings };

  render(); updatePrinterUi(); updateSyncUi(); scheduleSync(300);
})();
