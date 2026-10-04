/*
 * Waldo Supply — web app (iPhone via Bluefy, Android Chrome, desktop Chrome/Edge).
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
    syncUrl: '', syncKey: '', speakAnswers: true, autoPrint: true, askDrawer: false, userName: '', qrOnLabels: true,
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

  // The drawer setup rides along in the synced item list as one special row, so every device shares it.
  const CONFIG_ID = 'config-drawers';
  const isConfig = (i) => i.id === CONFIG_ID || i.sku === 'CONFIG';
  const live = () => items.filter((i) => !i.deleted && !isConfig(i));
  /** A "mixed" item is a whole assortment drawer (bolts, screws…): one row, a list of parts, no count. */
  const isMixed = (i) => !!i && i.sku === 'MIXED';
  function getContents(it) { const m = /^Contains:\s*([\s\S]*)$/.exec(it.notes || ''); return m ? m[1].split(/\s*;\s*/).filter(Boolean) : []; }
  function setContents(it, list) { it.notes = list.length ? 'Contains: ' + list.join('; ') : ''; }
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

  function deleteItem(item, silent) {
    item.deleted = true; touch(item); saveItems();
    if (!silent) log('remove', 'Removed ' + item.name + ' from ' + item.drawer);
  }

  function setQuantity(item, q, silent) {
    const delta = q - item.quantity;
    if (q <= 0) { deleteItem(item, silent); if (!silent) toast('Removed ' + item.name); return; }
    item.quantity = q; touch(item); saveItems();
    if (!silent && delta < 0) log('use', 'Used ' + (-delta) + ' ' + item.name + ' · ' + q + ' left');
    if (!silent && delta > 0) log('stock', 'Added ' + delta + ' ' + item.name + ' · now ' + q);
  }

  const singular = (w) => w.length > 3 && w.endsWith('es') && /(ses|xes|zes|ches|shes)$/.test(w) ? w.slice(0, -2)
    : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w;
  const keyWords = (s) => normalize(s).split(' ').filter(Boolean).map(singular);

  /** exact > all words match > substring > any significant word. Best first. */
  /** True when the words clearly name something already stocked (not just a loose word overlap). */
  function strongMatch(query) {
    const q = normalize(query), qWords = keyWords(query);
    if (!q) return null;
    return live().find((it) => normalize(it.name) === q || (!isMixed(it) && normalize(it.sku || '') === q) ||
      (qWords.length && qWords.every((w) => keyWords(it.name).includes(w))) || !!matchedPart(it, query)) || null;
  }

  /** For a mixed drawer: which listed part does the query name? */
  function matchedPart(it, query) {
    if (!isMixed(it)) return null;
    const q = normalize(query), qWords = keyWords(query);
    const parts = getContents(it);
    return parts.find((c) => normalize(c) === q) ||
      parts.find((c) => qWords.length && qWords.every((w) => keyWords(c).includes(w))) || null;
  }

  function findItems(query) {
    const q = normalize(query);
    if (!q) return [];
    const qWords = keyWords(query);
    const scored = [];
    for (const it of live()) {
      const n = normalize(it.name);
      const parts = isMixed(it) ? getContents(it) : [];
      const words = keyWords(it.name).concat(isMixed(it) ? [] : keyWords(it.sku || ''), ...parts.map(keyWords));
      let score = 0;
      if (n === q || (!isMixed(it) && normalize(it.sku || '') === q) || parts.some((c) => normalize(c) === q)) score = 100;
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

  // ---------------------------------------------------------------- drawers & categories
  // Sample layout until Jim's real one is entered under Settings → Drawers & categories.
  const DEFAULT_DRAWERS = [
    { name: 'Drawer 1', category: 'Batteries', mode: 'tracked', keywords: 'battery, AA, AAA, 9V, C cell, D cell, lithium, coin cell, CR2032, CR123' },
    { name: 'Drawer 2', category: 'Tape', mode: 'tracked', keywords: 'tape, duct, electrical tape, masking, Kapton, gaffer, painter, speed tape, teflon' },
    { name: 'Drawer 3', category: 'Adhesives', mode: 'tracked', keywords: 'epoxy, epoxi, glue, JB Weld, superglue, CA glue, RTV, sealant, silicone, adhesive, Loctite, threadlocker' },
    { name: 'Drawer 4', category: 'Cables', mode: 'tracked', keywords: 'cable, cord, USB, USB-C, HDMI, Lightning, adapter, charger, ethernet, extension' },
    { name: 'Drawer 5', category: 'Hardware', mode: 'mixed', keywords: 'bolt, nut, screw, washer, rivet, cotter pin, safety wire, hose clamp, fastener, standoff' },
    { name: 'Drawer 6', category: 'General', mode: 'tracked', keywords: '' },
  ];
  function drawerCfg() {
    const c = items.find((i) => i.id === CONFIG_ID && !i.deleted);
    if (c) { try { const v = JSON.parse(c.notes); if (Array.isArray(v) && v.length) return v; } catch (e) { /* fall back */ } }
    return DEFAULT_DRAWERS;
  }
  function saveDrawerCfg(list) {
    let c = items.find((i) => i.id === CONFIG_ID);
    if (!c) {
      c = { id: CONFIG_ID, name: 'Waldo Supply drawer setup (managed by the app)', drawer: '', quantity: 0, sku: 'CONFIG', category: '',
        notes: '', createdAt: Date.now(), lastPrintedAt: null, deleted: false };
      items.push(c);
    }
    c.deleted = false; c.notes = JSON.stringify(list); touch(c); saveItems();
  }
  const isGeneral = (d) => !!d && /^(general|misc|miscellaneous|other|uncategorized)$/i.test(String(d.category || '').trim());
  const cfgFor = (drawer) => drawerCfg().find((d) => d.name.toLowerCase() === String(drawer || '').trim().toLowerCase()) || null;
  const generalDrawer = () => drawerCfg().find(isGeneral) || null;
  const kwList = (d) => String(d.keywords || '').split(',').map((k) => keyWords(k).join(' ')).filter(Boolean);

  /** Which category drawer does this item belong in? The longest matching keyword wins. */
  function matchCategory(name) {
    const hay = ' ' + keyWords(name).join(' ') + ' ';
    const hayRaw = ' ' + normalize(name) + ' ';
    let best = null, bestLen = 0;
    for (const d of drawerCfg()) {
      if (isGeneral(d)) continue;
      for (const k of kwList(d)) {
        if ((hay.includes(' ' + k + ' ') || hayRaw.includes(' ' + k + ' ')) && k.length > bestLen) { best = d; bestLen = k.length; }
      }
    }
    return best;
  }

  /** Where should a new item go? Already stocked -> same drawer; else its category's drawer; else General; else next empty. */
  function chooseDrawer(name) {
    const key = normalize(name);
    const same = live().filter((i) => !isMixed(i) && normalize(i.name) === key).sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (same) return { drawer: same.drawer, how: 'existing', cfg: cfgFor(same.drawer) };
    const inMix = live().find((i) => isMixed(i) && getContents(i).some((c) => normalize(c) === key));
    if (inMix) return { drawer: inMix.drawer, how: 'existing', cfg: cfgFor(inMix.drawer) };
    const cat = matchCategory(name);
    if (cat) return { drawer: cat.name, how: 'category', cfg: cat };
    const gen = generalDrawer();
    if (gen) return { drawer: gen.name, how: 'general', cfg: gen };
    return { drawer: suggestNextDrawer(), how: 'next', cfg: null };
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

  function answer(text, spoken, actions) {
    const el = $('answer');
    el.textContent = text; el.classList.add('show');
    actions = [].concat(actions || []).filter(Boolean);
    if (actions.length) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:10px';
      for (const a of actions) {
        const b = document.createElement('button');
        b.className = 'btn'; b.textContent = a.label; b.onclick = a.run;
        row.appendChild(b);
      }
      el.appendChild(row);
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
    $('micLabel').textContent = on ? 'Listening… tap to stop' : 'Tap to speak';
    if (on) $('transcript').textContent = '';
  }

  // ---------------------------------------------------------------- commands (MainViewModel.handleIntent port)
  let pendingAdd = null;

  async function runCommand(text) {
    $('transcript').textContent = '“' + text + '”';
    const nm = /^\s*(?:my name is|my name's|call me|i am|i'm)\s+([a-z][a-z .'-]{0,38})[.!]?\s*$/i.exec(text);
    if (nm && !/\b(drawer|bin|shelf)\b/i.test(text) && nm[1].trim().split(/\s+/).length <= 3) {
      settings.userName = nm[1].trim().replace(/\b([a-z])/g, (c) => c.toUpperCase()); saveSettings(); renderGreeting();
      return answer('Nice to meet you, ' + settings.userName + '.');
    }
    const intent = parse(text);
    switch (intent.type) {
      case 'add': {
        if (!intent.name) return answer('What item should I add? Try: “add WAC-47 lens drawer 3”.');
        if (intent.drawer) return stockIn(intent.name, intent.drawer, intent.quantity);
        if (!settings.askDrawer) return stockIn(intent.name, null, intent.quantity);
        pendingAdd = { name: intent.name, quantity: intent.quantity };
        const suggestion = chooseDrawer(intent.name).drawer;
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
        if (hits.length === 1 || matchedPart(hits[0], intent.query)) return focusItem(hits[0], false, intent.query);
        const lines = hits.slice(0, 5).map((i) => '• ' + describe(i, intent.query)).join('\n');
        return answer(hits.length + ' matches:\n' + lines, hits.length + ' matches. First is ' + hits[0].name + ' in ' + hits[0].drawer + '.');
      }
      case 'count': {
        const hits = findItems(intent.query);
        if (!hits.length) return answer('No “' + intent.query + '” in inventory.', 'None in inventory.');
        const top = hits[0];
        if (isMixed(top)) {
          const part = matchedPart(top, intent.query) || intent.query;
          return answer(part + ' is in ' + top.drawer + ', the mixed ' + top.category + ' drawer. Mixed drawers aren’t counted piece by piece.',
            part + ' is in ' + top.drawer + '. That drawer isn’t counted.');
        }
        const same = hits.filter((h) => normalize(h.name) === normalize(top.name));
        const total = same.reduce((s, h) => s + h.quantity, 0);
        const where = [...new Set(same.map((h) => h.drawer))].join(', ');
        return answer(top.name + ': ' + total + ' on hand (' + where + ').', total + ' ' + top.name + ' on hand, in ' + where + '.');
      }
      case 'print': {
        const q = (intent.query || '').trim();
        if (intent.drawer && (!q || /^(drawer\s+)?(label|tag|sticker)s?(\s+for)?$/i.test(q))) {
          const d = cfgFor(intent.drawer) || { name: intent.drawer, category: ((live().find((i) => i.drawer.toLowerCase() === intent.drawer.toLowerCase()) || {}).category) || '', mode: 'tracked' };
          return printOrQueueDrawer(d);
        }
        if (/^(drawer\s+)?(label|tag)s?$/i.test(q)) return answer('Which drawer? Try “print the label for drawer 5”.');
        let target = intent.query ? findItems(intent.query)[0] : null;
        if (!target && intent.drawer) target = live().find((i) => i.drawer.toLowerCase() === intent.drawer.toLowerCase());
        if (!target) return answer('Nothing matching “' + (intent.query || intent.drawer || '') + '” to print.');
        answer('Printing label for ' + target.name + '…', false);
        return printItem(target);
      }
      case 'remove': {
        const it = findItems(intent.query)[0];
        if (!it) return answer('Nothing matching “' + intent.query + '”.');
        const part = matchedPart(it, intent.query);
        if (part) {
          setContents(it, getContents(it).filter((c) => c !== part)); touch(it); saveItems();
          log('remove', 'Removed ' + part + ' from ' + it.drawer + ' (mixed)');
          return answer('Took ' + part + ' off the list for ' + it.drawer + '.', 'Removed ' + part + '.');
        }
        if (isMixed(it)) return answer(it.drawer + ' is a mixed drawer. Say which part, like “remove the M5 bolts”, or swipe the drawer card to remove it all.');
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
        const lines = list.slice(0, 12).map((i) => '• ' + describe(i)).join('\n');
        return answer(lines + (list.length > 12 ? '\n…and ' + (list.length - 12) + ' more' : ''),
          list.length + ' items' + (intent.drawer ? ' in ' + intent.drawer : '') + '.');
      }
      case 'bare': {
        const known = strongMatch(intent.name);
        if (known) return focusItem(known, false, intent.name);
        if (settings.askDrawer) return runCommand('add ' + intent.name);
        return stockIn(intent.name, null, intent.quantity);
      }
      default:
        return answer('Didn’t understand “' + text + '”. Try “add X drawer 3” or “where is X”.', 'Sorry, I didn’t understand that.');
    }
  }

  /** One-line description used in lists and answers. */
  function describe(i, query) {
    if (isMixed(i)) {
      const part = query ? matchedPart(i, query) : null;
      return (part || i.name) + ' — ' + i.drawer + ' (mixed ' + i.category + (part ? '' : ', ' + getContents(i).length + ' parts') + ')';
    }
    return i.name + ' — ' + i.drawer + ' (×' + i.quantity + ')';
  }

  /** Stock an item in. drawer = null lets the app choose (category rules); a named drawer is used as-is. */
  function stockIn(name, drawer, quantity) {
    const assigned = !drawer;
    const pick = drawer ? { drawer, how: 'told', cfg: cfgFor(drawer) } : chooseDrawer(name);
    const cfg = pick.cfg;
    if (cfg && cfg.mode === 'mixed') return stockInMixed(name, cfg);
    const category = cfg && !isGeneral(cfg) ? cfg.category : '';
    const { item, merged } = addItem({ name, drawer: pick.drawer, quantity, category });
    const where = item.drawer.toUpperCase() + (category && pick.how === 'category' ? ' (' + category + ')' : '');
    let msg, spoken;
    if (assigned && merged) {
      msg = 'Put it in ' + item.drawer.toUpperCase() + ' — that’s where ' + item.name + ' already lives. Now ' + item.quantity + ' on hand.';
      spoken = 'Put it in ' + item.drawer + ', with the other ' + item.name + '.';
    } else if (assigned) {
      msg = 'Put ' + item.name + (quantity > 1 ? ' ×' + quantity : '') + ' in ' + where + '.';
      spoken = 'Put ' + item.name + ' in ' + item.drawer + '.';
    } else {
      msg = merged
        ? 'Added ' + quantity + ' more ' + item.name + ' — now ' + item.quantity + ' in ' + item.drawer + '.'
        : 'Added ' + item.name + (quantity > 1 ? ' ×' + quantity : '') + ' in ' + item.drawer + '.';
      spoken = item.name + ', ' + item.drawer + '.';
    }
    log('stock', (merged ? 'Added ' + quantity + ' more ' : 'Stocked ' + (quantity > 1 ? quantity + ' ' : '')) + item.name + ' → ' + item.drawer);
    if (pick.how === 'general') {
      msg += '\nWhat kind of item is it? Pick a category and I’ll remember for next time.';
      spoken += ' What category is it?';
    }
    if (settings.autoPrint) {
      if (printer.connected) spoken += ' Printing label.';
      else { queuePrint(item.id); msg += '\nLabel will print as soon as the printer connects.'; spoken += ' The label will print when the printer connects.'; }
    }
    const undo = {
      label: 'Undo',
      run: () => {
        printQueue = printQueue.filter((id) => id !== item.id); LS.set('jim.printQueue', printQueue);
        if (merged) setQuantity(item, item.quantity - quantity, true); else deleteItem(item, true);
        log('remove', 'Undid stocking ' + item.name);
        answer('Undone — ' + item.name + (merged ? ' back to ' + item.quantity + '.' : ' removed.'), 'Undone.');
        updatePrinterUi();
      },
    };
    const acts = [];
    if (pick.how === 'general') {
      for (const d of drawerCfg()) if (!isGeneral(d) && d.category) acts.push({ label: d.category, run: () => moveToCategory(item, d) });
    } else if (assigned) acts.push({ label: 'Use a different drawer', run: () => openItem(item) });
    acts.push(undo);
    answer(msg, spoken, acts);
    if (settings.autoPrint && printer.connected) printItem(item, 1, true);
  }

  /** Mixed drawer: add the part to the drawer's list instead of making a counted item. */
  function stockInMixed(name, cfg) {
    const now = Date.now();
    let box = live().find((i) => isMixed(i) && i.drawer.toLowerCase() === cfg.name.toLowerCase());
    let created = false;
    if (!box) {
      box = { id: uuid(), name: cfg.category + ' (assorted)', drawer: cfg.name, quantity: 1, sku: 'MIXED', category: cfg.category,
        notes: '', createdAt: now, updatedAt: now, lastPrintedAt: null, deleted: false, dirty: true };
      items.push(box); created = true;
    }
    const parts = getContents(box);
    const had = parts.find((c) => normalize(c) === normalize(name));
    if (!had) parts.push(String(name).trim());
    setContents(box, parts); touch(box); saveItems();
    const shown = had || String(name).trim();
    let msg = had
      ? shown + ' already lives in ' + cfg.name.toUpperCase() + ', the mixed ' + cfg.category + ' drawer.'
      : 'Put ' + shown + ' in ' + cfg.name.toUpperCase() + ' — the mixed ' + cfg.category + ' drawer.';
    let spoken = 'Put ' + shown + ' in ' + cfg.name + ', with the ' + cfg.category.toLowerCase() + '.';
    if (!had) log('stock', 'Stocked ' + shown + ' → ' + cfg.name + ' (mixed)');
    const bag = { name: shown, drawer: cfg.name, category: cfg.category, mixed: true, qrId: box.id, createdAt: now };
    if (settings.autoPrint) {
      if (printer.connected) spoken += ' Printing label.';
      else { queuePrint({ v: bag }); msg += '\nLabel will print as soon as the printer connects.'; }
    }
    const acts = [];
    if (created) acts.push({ label: 'Print drawer label', run: () => printOrQueueDrawer(cfg) });
    if (!had) acts.push({ label: 'Undo', run: () => {
      setContents(box, getContents(box).filter((c) => c !== shown));
      if (created && !getContents(box).length) box.deleted = true;
      touch(box); saveItems(); log('remove', 'Undid stocking ' + shown);
      answer('Undone — ' + shown + ' removed.', 'Undone.');
    } });
    answer(msg, spoken, acts);
    if (settings.autoPrint && printer.connected) printItem(bag, 1, true);
  }

  /** Item landed in General: file it under a category, and learn its name as a keyword for that category. */
  function moveToCategory(item, d) {
    const list = drawerCfg().map((x) => Object.assign({}, x));
    const target = list.find((x) => x.name === d.name);
    const kw = normalize(item.name);
    if (target && !kwList(target).includes(keyWords(item.name).join(' '))) {
      target.keywords = (target.keywords ? target.keywords + ', ' : '') + kw;
    }
    saveDrawerCfg(list);
    printQueue = printQueue.filter((id) => id !== item.id); LS.set('jim.printQueue', printQueue);
    if (d.mode === 'mixed') {
      deleteItem(item, true);
      log('move', 'Filed ' + item.name + ' under ' + d.category);
      return stockInMixed(item.name, d);
    }
    item.drawer = d.name; item.category = d.category; touch(item); saveItems();
    log('move', 'Moved ' + item.name + ' → ' + d.name + ' (' + d.category + ')');
    let msg = 'Moved ' + item.name + ' to ' + d.name.toUpperCase() + ' (' + d.category + '). I’ll remember that for next time.';
    if (settings.autoPrint) {
      if (printer.connected) printItem(item, 1, true);
      else { queuePrint(item.id); msg += '\nLabel will print as soon as the printer connects.'; }
    }
    answer(msg, 'Moved to ' + d.name + '.');
  }

  /** Show one item (from a find, a bare name, or a scanned QR label) with quick actions. */
  function focusItem(it, quiet, query) {
    $('filter').value = isMixed(it) ? it.drawer : it.name; render();
    if (isMixed(it)) {
      const part = query ? matchedPart(it, query) : null;
      const parts = getContents(it);
      const text = (part ? part + ' is in ' + it.drawer.toUpperCase() + ' — the mixed ' + it.category + ' drawer.'
        : it.drawer.toUpperCase() + ' · mixed ' + it.category + '\n' + (parts.length ? parts.slice(0, 15).join(', ') + (parts.length > 15 ? '…' : '') : 'Nothing listed yet.'));
      return answer(text, quiet ? false : (part || it.name) + ', ' + it.drawer + '.', [
        { label: 'Print drawer label', run: () => printOrQueueDrawer(cfgFor(it.drawer) || { name: it.drawer, category: it.category, mode: 'mixed' }) },
        { label: 'Edit', run: () => openItem(it) },
      ]);
    }
    answer(it.name + ' is in ' + it.drawer.toUpperCase() + ' · qty ' + it.quantity + '.', quiet ? false : it.name + ' is in ' + it.drawer + '. Quantity ' + it.quantity + '.', [
      { label: 'Used one', run: () => { setQuantity(it, it.quantity - 1); if (!it.deleted) focusItem(it, true); else answer('Used the last ' + it.name + ' — removed.', false); } },
      { label: 'Add one', run: () => { setQuantity(it, it.quantity + 1); focusItem(it, true); } },
      { label: 'Reprint', run: () => printItem(it) },
      { label: 'Edit', run: () => openItem(it) },
    ]);
  }

  function focusDrawer(name) {
    const d = cfgFor(name);
    const list = live().filter((i) => i.drawer.toLowerCase() === String(name).toLowerCase());
    $('filter').value = name; render();
    const head = name.toUpperCase() + (d && d.category ? ' · ' + d.category + (d.mode === 'mixed' ? ' (mixed)' : '') : '');
    answer(head + '\n' + (list.length ? list.map((i) => '• ' + describe(i)).join('\n') : 'Empty.'), name + (list.length ? ', ' + list.length + ' items.' : ' is empty.'),
      [{ label: 'Print drawer label', run: () => printOrQueueDrawer(d || { name, category: '', mode: 'tracked' }) }]);
  }

  function printOrQueueDrawer(d) {
    if (printer.connected) { answer('Printing the drawer label for ' + d.name + '…', false); return printDrawerLabel(d); }
    queuePrint({ d: d.name, c: d.category, m: d.mode });
    answer('The drawer label for ' + d.name + ' will print as soon as the printer connects.');
  }

  // Labels waiting for the printer (saved so a reload doesn't lose them)
  let printQueue = LS.get('jim.printQueue', []);
  /** Entries: an item id, { v: bag-label item } for mixed-drawer parts, or { d: drawer name } for a drawer-front label. */
  function queuePrint(entry) {
    if (typeof entry !== 'string' || !printQueue.includes(entry)) printQueue.push(entry);
    LS.set('jim.printQueue', printQueue); updatePrinterUi();
  }
  async function flushPrintQueue() {
    while (printQueue.length && printer.connected) {
      const e = printQueue[0];
      let ok = true;
      if (typeof e === 'string') { const it = items.find((i) => i.id === e && !i.deleted); if (it) ok = await printItem(it, 1, true); }
      else if (e && e.v) ok = await printItem(e.v, 1, true);
      else if (e && e.d) ok = await printDrawerLabel(cfgFor(e.d) || { name: e.d, category: e.c || '', mode: e.m || 'tracked' });
      if (!ok) break;
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
    const ch = hPx - m * 2;
    // QR code on the right; text gets the rest.
    const qrUrl = labelQrUrl(item);
    const qrSize = qrUrl ? Math.min(ch, Math.round(wPx * 0.31)) : 0;
    const cw = wPx - m * 2 - (qrSize ? qrSize + Math.round(m * 0.7) : 0);
    if (qrSize) drawQr(ctx, qrUrl, wPx - m - qrSize, m + Math.round((ch - qrSize) / 2), qrSize);

    // Budget: name ~40%, drawer ~35%, meta ~15%, gaps.
    const meta = [];
    if (item.mixed) { meta.push('MIXED'); if (item.category) meta.push(item.category); }
    else {
      if (item.sku) meta.push('SKU ' + item.sku);
      meta.push('QTY ' + item.quantity);
      if (item.category) meta.push(item.category);
    }
    meta.push(new Date(item.createdAt || Date.now()).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' }));
    const metaText = meta.join(' · ');

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

    binarize(ctx, wPx, hPx);
    return canvas;
  }

  /** Hard 1-bit threshold so the preview matches what the printer does. */
  function binarize(ctx, w, h) {
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 < 140 ? 0 : 255;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------------------------------------------------------------- QR codes (labels link back into the app)
  const appBase = () => location.origin + location.pathname;
  const shortId = (id) => String(id).replace(/-/g, '').slice(0, 12).toLowerCase();
  const itemLink = (id) => appBase() + '#i=' + shortId(id);
  const drawerLink = (name) => appBase() + '#d=' + encodeURIComponent(name);
  function labelQrUrl(item) {
    if (settings.qrOnLabels === false || !window.qrcode) return null;
    const id = item.qrId || item.id;
    return id ? itemLink(id) : null;
  }
  function drawQr(ctx, text, x, y, size) {
    const q = window.qrcode(0, 'L');
    q.addData(text); q.make();
    const n = q.getModuleCount();
    const cell = Math.max(1, Math.floor(size / n));
    const off = Math.floor((size - cell * n) / 2);
    ctx.save(); ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(x + off + c * cell, y + off + r * cell, cell, cell);
    ctx.restore();
  }

  /** Drawer-front label: the drawer name as big as it fits, its category under it. */
  function renderDrawerLabel(d, canvas) {
    const { wPx, hPx } = labelGeometry();
    canvas = canvas || document.createElement('canvas');
    canvas.width = wPx; canvas.height = hPx;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, wPx, hPx);
    ctx.fillStyle = '#000'; ctx.textBaseline = 'alphabetic';
    const m = Math.max(8, Math.round(Math.min(wPx, hPx) * 0.06));
    const ch = hPx - m * 2;
    const qrSize = settings.qrOnLabels !== false && window.qrcode ? Math.min(Math.round(ch * 0.62), Math.round(wPx * 0.3)) : 0;
    const cw = wPx - m * 2 - (qrSize ? qrSize + Math.round(m * 0.7) : 0);
    const title = String(d.name || '').toUpperCase();
    const cat = String(d.category || '').toUpperCase();
    const foot = (d.mode === 'mixed' ? 'MIXED · ' : '') + 'WALDO SUPPLY';
    const footSize = fitFont(ctx, foot, cw, Math.max(12, Math.round(ch * 0.1)), 10, '600');
    const titleSize = fitFont(ctx, title, cw, Math.round(ch * (cat ? 0.46 : 0.6)), 14, '800');
    let y = m + titleSize * 0.92;
    ctx.fillText(title, m, y);
    if (cat) {
      const catSize = fitFont(ctx, cat, cw, Math.round(ch * 0.26), 12, '700');
      y += catSize * 1.18;
      ctx.fillText(cat, m, y);
    }
    const base = hPx - m;
    ctx.fillRect(m, Math.round(base - footSize * 1.3), cw, Math.max(2, Math.round(hPx / 120)));
    ctx.font = '600 ' + footSize + 'px -apple-system, "Helvetica Neue", Arial, sans-serif';
    ctx.fillText(foot, m, base);
    if (qrSize) drawQr(ctx, drawerLink(d.name), wPx - m - qrSize, m + Math.round((ch - qrSize) / 2), qrSize);
    binarize(ctx, wPx, hPx);
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

  async function printItem(item, copies = 1, auto = false) {
    if (isMixed(item)) return printDrawerLabel(cfgFor(item.drawer) || { name: item.drawer, category: item.category, mode: 'mixed' });
    const ok = await printCanvas(renderLabel(item), 'label for ' + item.name, copies);
    if (ok && item.id && items.includes(item)) { item.lastPrintedAt = Date.now(); touch(item); saveItems(); }
    if (ok && !auto && (items.includes(item) || item.mixed)) log('print', 'Printed label for ' + item.name);
    return ok;
  }
  async function printDrawerLabel(d) {
    const ok = await printCanvas(renderDrawerLabel(d), 'drawer label for ' + d.name);
    if (ok) log('print', 'Printed drawer label for ' + d.name);
    return ok;
  }

  // Labels print one at a time, in order; a new request waits for the one before it.
  let printChain = Promise.resolve();
  function printCanvas(canvas, what, copies = 1) {
    const run = printChain.then(() => printCanvasNow(canvas, what, copies));
    printChain = run.catch(() => {});
    return run;
  }

  async function printCanvasNow(canvas, what, copies = 1) {
    if (!printer.connected) {
      toast('Connect the printer first (tap Printer at the top)');
      return false;
    }
    printer.busy = true; updatePrinterUi();
    const bar = $('printProgress');
    bar.hidden = false; bar.firstElementChild.style.width = '5%';
    const client = printer.client;
    const onProgress = (e) => { bar.firstElementChild.style.width = Math.max(5, e.pagePrintProgress || 0) + '%'; };
    client.on('printprogress', onProgress);
    let task = null;
    try {
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
      toast('Printed ' + what);
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
    renderGreeting();
  }

  const SAMPLE = { name: 'WAC-47 Lens', drawer: 'Drawer 3', quantity: 2, sku: 'WAC-47', createdAt: Date.now(), qrId: 'sample-label' };
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

  // ---------------------------------------------------------------- UI: greeting
  function partOfDay(d = new Date()) {
    const h = d.getHours();
    return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  }
  function renderGreeting() {
    const now = new Date();
    const name = String(settings.userName || '').trim();
    $('greetTime').textContent = partOfDay(now);
    $('greetDate').textContent = now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    $('greetName').textContent = name || 'there';
    $('setNameBtn').hidden = !!name;
    const n = live().length;
    $('greetSub').textContent = !n ? 'Ready when you are. What came in today?'
      : printQueue.length ? printQueue.length + ' label' + (printQueue.length > 1 ? 's are' : ' is') + ' waiting for the printer.'
      : 'What came in today?';
  }
  function renderStats() {
    const all = live();
    const tracked = all.filter((i) => !isMixed(i));
    $('statItems').textContent = tracked.length + all.filter(isMixed).reduce((s, i) => s + getContents(i).length, 0);
    $('statUnits').textContent = tracked.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    $('statDrawers').textContent = new Set(all.map((i) => i.drawer.toLowerCase())).size;
  }

  // ---------------------------------------------------------------- UI: list
  function render() {
    renderStats(); renderGreeting(); renderActivity();
    const q = $('filter').value.trim();
    let list = live();
    if (q) {
      const nq = normalize(q);
      const hits = new Set(findItems(q).map((i) => i.id));
      list = list.filter((i) => hits.has(i.id) || i.drawer.toLowerCase().includes(q.toLowerCase()) || normalize(i.drawer) === nq);
    }
    list.sort((a, b) => a.drawer.localeCompare(b.drawer, undefined, { numeric: true }) || a.name.localeCompare(b.name));
    $('count').textContent = q ? list.length + ' of ' + live().length : live().length + (live().length === 1 ? ' item' : ' items');
    const root = $('list');
    root.textContent = '';
    if (!list.length) {
      const d = document.createElement('div'); d.className = 'empty';
      d.textContent = live().length ? 'No matches.' : 'Nothing stocked yet. Tap the mic and say an item name.';
      root.appendChild(d); return;
    }
    for (const it of list) root.appendChild(swipeable(itemCard(it), it));
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  const ICON = {
    minus: '<path d="M5 12h14"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    locate: '<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>',
    print: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8" rx="1"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    drawer: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/><path d="M10 8h4M10 16h4"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
    stock: '<path d="M12 5v14M5 12h14"/>',
    use: '<path d="M5 12h14"/>',
    move: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 17h4v4h-4"/>',
  };
  function icon(name, size = 16) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICON[name];
    return s;
  }
  function actBtn(iconName, label, onClick) {
    const b = el('button', 'act'); b.append(icon(iconName, 15), document.createTextNode(label)); b.onclick = onClick; return b;
  }

  function itemCard(it) {
    const card = el('div', 'item');
    const left = el('div');
    const name = el('div', 'name', it.name); name.onclick = () => openItem(it);
    left.appendChild(name);
    const tags = el('div', 'tags');
    const badge = el('span', 'badge'); badge.append(icon('drawer', 12), document.createTextNode(it.drawer));
    tags.appendChild(badge);
    if (it.sku && !isMixed(it)) tags.appendChild(el('span', 'badge muted', it.sku));
    left.appendChild(tags);
    card.appendChild(left);

    if (isMixed(it)) {
      card.appendChild(el('span', 'badge muted', 'Mixed'));
      const parts = getContents(it);
      const box = el('div', 'parts');
      parts.slice(0, 12).forEach((p) => box.appendChild(el('span', 'part', p)));
      if (parts.length > 12) box.appendChild(el('span', 'part more', '+' + (parts.length - 12) + ' more'));
      if (!parts.length) box.appendChild(el('span', 'part more', 'No parts listed yet'));
      card.appendChild(box);
      const actions = el('div', 'actions');
      actions.append(
        actBtn('locate', 'Locate', () => focusItem(it)),
        actBtn('print', 'Label', () => printOrQueueDrawer(cfgFor(it.drawer) || { name: it.drawer, category: it.category, mode: 'mixed' })),
        actBtn('edit', 'Edit', () => openItem(it)),
      );
      card.appendChild(actions);
      return card;
    }

    const qty = el('div', 'qty');
    const minus = el('button'); minus.appendChild(icon('minus', 15)); minus.setAttribute('aria-label', 'Less');
    const plus = el('button'); plus.appendChild(icon('plus', 15)); plus.setAttribute('aria-label', 'More');
    minus.onclick = () => { if (it.quantity <= 1) return removeWithUndo(it); setQuantity(it, it.quantity - 1); };
    plus.onclick = () => setQuantity(it, it.quantity + 1);
    qty.append(minus, el('span', null, String(it.quantity)), plus);
    card.appendChild(qty);

    const meta = [it.category, it.notes, it.lastPrintedAt && 'Label printed ' + new Date(it.lastPrintedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })].filter(Boolean).join(' · ');
    if (meta) card.appendChild(el('div', 'meta', meta));

    const actions = el('div', 'actions');
    const pr = actBtn('print', 'Print', () => printItem(it));
    if (!printer.connected) pr.title = 'Connect the printer first';
    actions.append(
      actBtn('locate', 'Locate', () => focusItem(it)),
      pr,
      actBtn('edit', 'Edit', () => openItem(it)),
    );
    card.appendChild(actions);
    return card;
  }

  // ---------------------------------------------------------------- swipe actions (right = print, left = remove)
  function swipeable(card, it) {
    const wrap = el('div', 'swipe');
    const bgPrint = el('div', 'swipe-bg print'); bgPrint.append(icon('print', 18), document.createTextNode(isMixed(it) ? 'Drawer label' : 'Print'));
    const bgDel = el('div', 'swipe-bg del'); bgDel.append(document.createTextNode('Remove'), icon('trash', 18));
    wrap.append(bgPrint, bgDel, card);
    const T = 90;
    let x0 = 0, y0 = 0, dx = 0, down = false, locked = false, pid = null, swallowClick = false;
    card.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('button')) return;
      down = true; locked = false; dx = 0; pid = e.pointerId; x0 = e.clientX; y0 = e.clientY; card.style.transition = 'none';
    });
    card.addEventListener('pointermove', (e) => {
      if (!down || e.pointerId !== pid) return;
      const mx = e.clientX - x0, my = e.clientY - y0;
      if (!locked) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (Math.abs(my) > Math.abs(mx)) { down = false; return; }
        locked = true; try { card.setPointerCapture(pid); } catch (err) { /* */ }
      }
      dx = Math.max(-160, Math.min(160, mx));
      card.style.transform = 'translateX(' + dx + 'px)';
      wrap.classList.toggle('show-print', dx > 0); wrap.classList.toggle('show-del', dx < 0);
      wrap.classList.toggle('armed', Math.abs(dx) > T);
    });
    const end = () => {
      if (!down) return;
      down = false;
      card.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)'; card.style.transform = '';
      wrap.classList.remove('armed');
      setTimeout(() => wrap.classList.remove('show-print', 'show-del'), 220);
      if (!locked) return;
      swallowClick = true; setTimeout(() => { swallowClick = false; }, 300);
      if (dx > T) printItem(it);
      else if (dx < -T) removeWithUndo(it);
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
    card.addEventListener('click', (e) => { if (swallowClick) { e.stopPropagation(); e.preventDefault(); } }, true);
    return wrap;
  }

  function removeWithUndo(it) {
    deleteItem(it);
    showSnack('Removed ' + (isMixed(it) ? it.drawer + ' (mixed ' + it.category + ')' : it.name), 'Undo', () => {
      it.deleted = false; touch(it); saveItems(); log('stock', 'Restored ' + it.name);
    });
  }

  let snackTimer = null;
  function showSnack(text, label, fn) {
    const sn = $('snack');
    $('snackText').textContent = text;
    $('snackBtn').textContent = label;
    $('snackBtn').onclick = () => { sn.classList.remove('show'); clearTimeout(snackTimer); fn(); };
    sn.classList.add('show');
    clearTimeout(snackTimer); snackTimer = setTimeout(() => sn.classList.remove('show'), 6000);
  }

  // ---------------------------------------------------------------- recent activity
  let activity = LS.get('jim.activity', []);
  let activityAll = false;
  function log(type, text) {
    activity.unshift({ t: Date.now(), type, text, by: String(settings.userName || '').trim() });
    if (activity.length > 300) activity.length = 300;
    LS.set('jim.activity', activity);
    renderActivity();
  }
  function ago(t) {
    const s = (Date.now() - t) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function renderActivity() {
    const wrap = $('activityWrap');
    if (!wrap) return;
    wrap.hidden = !activity.length;
    if (!activity.length) return;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = activity.filter((a) => a.t >= start.getTime());
    const c = (type) => today.filter((a) => a.type === type).length;
    const bits = [[c('stock'), 'stocked'], [c('use'), 'used'], [c('remove'), 'removed'], [c('print'), 'printed']].filter((b) => b[0]).map((b) => b[0] + ' ' + b[1]);
    $('activitySummary').textContent = today.length ? 'Today: ' + bits.join(' · ') : 'Nothing yet today.';
    const root = $('activityList');
    root.textContent = '';
    for (const a of activity.slice(0, activityAll ? 40 : 5)) {
      const row = el('div', 'arow');
      const dot = el('span', 'adot ' + a.type);
      dot.appendChild(icon({ stock: 'stock', use: 'use', remove: 'trash', print: 'print', move: 'move', edit: 'edit' }[a.type] || 'edit', 13));
      const txt = el('div', 'atext', a.text);
      const when = el('div', 'awhen', ago(a.t) + (a.by ? ' · ' + a.by : ''));
      row.append(dot, txt, when);
      root.appendChild(row);
    }
    $('activityMore').hidden = activity.length <= 5;
    $('activityMore').textContent = activityAll ? 'Show less' : 'Show all';
  }

  // ---------------------------------------------------------------- UI: dialogs
  let editing = null;
  let drawerTouched = false;
  function openItem(it) {
    editing = it || null;
    drawerTouched = false;
    const f = $('itemForm');
    $('itemTitle').textContent = it ? 'Edit item' : 'Add item';
    f.name.value = it ? it.name : '';
    f.drawer.value = it ? it.drawer : '';
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
  function updateItemPreview() {
    const v = formItem();
    if (editing && isMixed(editing)) return renderDrawerLabel(cfgFor(v.drawer) || { name: v.drawer, category: v.category, mode: 'mixed' }, $('itemPreview'));
    v.qrId = editing ? editing.id : 'preview';
    renderLabel(v, $('itemPreview'));
  }

  $('itemForm').addEventListener('input', (e) => {
    const f = $('itemForm');
    if (e.target === f.drawer) drawerTouched = true;
    if (e.target === f.name && !editing && !drawerTouched) {
      const p = chooseDrawer(f.name.value);
      f.drawer.value = f.name.value.trim() ? p.drawer : '';
      if (p.cfg && !isGeneral(p.cfg)) f.category.value = p.cfg.category;
    }
    updateItemPreview();
  });
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
      log('edit', 'Edited ' + target.name);
      toast('Saved');
    } else if ((cfgFor(v.drawer) || {}).mode === 'mixed') {
      stockIn(v.name, v.drawer, 1);
      return;
    } else {
      target = addItem(Object.assign({}, v, { quantity: v.quantity || 1 })).item;
      log('stock', 'Stocked ' + target.name + ' → ' + target.drawer);
      toast('Added ' + target.name + ' in ' + target.drawer);
    }
    if (action === 'saveprint') printItem(target);
  });
  $('itemDelete').onclick = () => {
    if (editing) { const it = editing; $('itemDlg').close(); removeWithUndo(it); }
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
    f.userName.value = settings.userName || '';
    f.syncUrl.value = settings.syncUrl; f.syncKey.value = settings.syncKey;
    f.speakAnswers.checked = !!settings.speakAnswers; f.autoPrint.checked = !!settings.autoPrint; f.askDrawer.checked = !!settings.askDrawer;
    f.qrOnLabels.checked = settings.qrOnLabels !== false;
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
    settings.userName = f.userName.value.trim();
    settings.speakAnswers = f.speakAnswers.checked; settings.autoPrint = f.autoPrint.checked; settings.askDrawer = f.askDrawer.checked;
    settings.qrOnLabels = f.qrOnLabels.checked;
    saveSettings(); LS.set('jim.items', items);
    renderGreeting();
    scheduleSync(100);
  });
  $('settingsBtn').onclick = openSettings;
  const editName = () => { openSettings(); setTimeout(() => { const i = $('settingsForm').userName; i.focus(); i.select(); }, 60); };
  $('setNameBtn').onclick = editName;
  $('greetName').onclick = editName;
  $('syncPill').onclick = () => { if (settings.syncUrl) { syncNow(); toast('Syncing…'); } else openSettings(); };
  $('syncNowBtn').onclick = () => syncNow();

  $('exportBtn').onclick = async () => {
    const data = JSON.stringify({ app: 'jim-inventory', version: 1, exportedAt: new Date().toISOString(), items }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const fname = 'waldo-supply-backup-' + new Date().toISOString().slice(0, 10) + '.json';
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
      if (!Array.isArray(incoming)) throw new Error('not a Waldo Supply backup');
      const byId = new Map(items.map((i) => [i.id, i]));
      let n = 0;
      for (const r of incoming) {
        if (!r || !r.name) continue;
        const it = Object.assign({ id: uuid(), drawer: '', quantity: 1, sku: '', category: '', notes: '', createdAt: Date.now(), updatedAt: Date.now(), deleted: false }, r);
        it.id = String(it.id); it.dirty = true;
        const local = byId.get(it.id);
        if (!local) { items.push(it); n++; } else if ((it.updatedAt || 0) > (local.updatedAt || 0)) { Object.assign(local, it); n++; }
      }
      saveItems(); toast('Imported ' + n + ' items'); log('edit', 'Imported ' + n + ' items from a backup');
    } catch (e) { toast('Import failed: ' + (e.message || e)); }
    $('importFile').value = '';
  };

  // ---------------------------------------------------------------- drawers & categories editor
  function drawerRow(d) {
    const row = el('div', 'drow');
    row.innerHTML = '<div class="row2"><label>Drawer<input name="dname" required></label><label>Category<input name="dcat" placeholder="e.g. Batteries"></label></div>' +
      '<label>Words that send items here <span class="kv">(comma separated)</span><textarea name="dkw" rows="2" placeholder="battery, AA, AAA, 9V"></textarea></label>' +
      '<div class="drow-foot"><div class="seg"><button type="button" data-mode="tracked">Track each item</button><button type="button" data-mode="mixed">Mixed assortment</button></div>' +
      '<span style="flex:1"></span><button type="button" class="btn sm" data-act="label">Print label</button><button type="button" class="btn sm danger" data-act="del">Remove</button></div>';
    row.querySelector('[name=dname]').value = d.name || '';
    row.querySelector('[name=dcat]').value = d.category || '';
    row.querySelector('[name=dkw]').value = d.keywords || '';
    const setMode = (m) => { row.dataset.mode = m; row.querySelectorAll('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m)); };
    setMode(d.mode === 'mixed' ? 'mixed' : 'tracked');
    row.querySelectorAll('.seg button').forEach((b) => { b.onclick = () => setMode(b.dataset.mode); });
    row.querySelector('[data-act=del]').onclick = () => row.remove();
    row.querySelector('[data-act=label]').onclick = () => printOrQueueDrawer(readRow(row));
    return row;
  }
  const readRow = (row) => ({
    name: row.querySelector('[name=dname]').value.trim(), category: row.querySelector('[name=dcat]').value.trim(),
    keywords: row.querySelector('[name=dkw]').value.trim(), mode: row.dataset.mode === 'mixed' ? 'mixed' : 'tracked',
  });
  function openDrawers() {
    const root = $('drawerRows'); root.textContent = '';
    drawerCfg().forEach((d) => root.appendChild(drawerRow(d)));
    $('drawersDlg').showModal();
  }
  $('drawersBtn').onclick = () => { $('settingsDlg').close(); openDrawers(); };
  $('addDrawerRow').onclick = () => {
    const n = $('drawerRows').children.length + 1;
    const row = drawerRow({ name: 'Drawer ' + n, category: '', keywords: '', mode: 'tracked' });
    $('drawerRows').appendChild(row); row.querySelector('[name=dcat]').focus();
  };
  $('drawersForm').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    const list = [...$('drawerRows').children].map(readRow).filter((d) => d.name);
    const names = list.map((d) => d.name.toLowerCase());
    if (names.some((n, i) => names.indexOf(n) !== i)) { e.preventDefault(); toast('Two drawers have the same name'); return; }
    if (!list.length) { e.preventDefault(); toast('Add at least one drawer'); return; }
    saveDrawerCfg(list);
    log('edit', 'Updated the drawer setup (' + list.length + ' drawers)');
    toast('Drawer setup saved');
  });

  // ---------------------------------------------------------------- QR scanning + label links
  /** Opens what a scanned label (or a #i= / #d= link) points to. Returns true if it was ours. */
  function handleLink(text) {
    const s = String(text || '');
    const mi = /[#&?]i=([a-z0-9-]+)/i.exec(s);
    const md = /[#&?]d=([^&#]+)/i.exec(s);
    if (mi) {
      const key = mi[1].replace(/-/g, '').toLowerCase();
      const it = items.find((i) => !i.deleted && !isConfig(i) && i.id.replace(/-/g, '').toLowerCase().startsWith(key));
      if (!it) { answer('That label’s item isn’t in this inventory. If sync was just turned on, give it a moment and scan again.'); return true; }
      focusItem(it);
      return true;
    }
    if (md) { focusDrawer(decodeURIComponent(md[1])); return true; }
    return false;
  }

  let scanStream = null, scanRaf = 0;
  async function openScan() {
    $('scanMsg').textContent = 'Point the camera at a Waldo Supply label.';
    $('scanDlg').showModal();
    const v = $('scanVideo');
    if (!window.jsQR || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      v.hidden = true; $('scanMsg').textContent = 'Live camera isn’t available here — tap “Take a photo” instead.'; return;
    }
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
      v.hidden = false; v.srcObject = scanStream; await v.play();
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d', { willReadFrequently: true });
      const tick = () => {
        if (!scanStream) return;
        if (v.readyState >= 2 && v.videoWidth) {
          const k = Math.min(1, 720 / Math.max(v.videoWidth, v.videoHeight));
          c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const r = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
          if (r && r.data) return onScanned(r.data);
        }
        scanRaf = requestAnimationFrame(tick);
      };
      tick();
    } catch (err) {
      v.hidden = true;
      $('scanMsg').textContent = 'Camera blocked or unavailable — tap “Take a photo” instead (or allow Camera for Bluefy in iPhone Settings).';
    }
  }
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
  }
  function onScanned(text) {
    stopScan();
    if ($('scanDlg').open) $('scanDlg').close();
    if (!handleLink(text)) answer('That QR code isn’t a Waldo Supply label.');
  }
  function decodeImageFile(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1400 / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        const r = window.jsQR ? window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height) : null;
        resolve(r && r.data ? r.data : null);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  $('scanBtn').onclick = openScan;
  $('scanClose').onclick = () => $('scanDlg').close();
  $('scanDlg').addEventListener('close', stopScan);
  $('scanFile').onchange = async () => {
    const f = $('scanFile').files[0];
    $('scanFile').value = '';
    if (!f) return;
    $('scanMsg').textContent = 'Reading the photo…';
    const data = await decodeImageFile(f);
    if (data) onScanned(data);
    else $('scanMsg').textContent = 'Couldn’t find a QR code in that photo. Get a little closer and try again.';
  };
  function checkHash() {
    if (!location.hash || location.hash.length < 3) return;
    const h = location.hash;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* */ }
    handleLink(h);
  }
  window.addEventListener('hashchange', checkHash);

  $('activityMore').onclick = () => { activityAll = !activityAll; renderActivity(); };

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

  if (!SR) $('voiceHint').textContent = 'Tap the mic, then the 🎤 on your keyboard. Say an item name — I’ll pick a drawer and print the label.';
  setInterval(renderGreeting, 60000);

  window.addEventListener('online', () => scheduleSync(200));
  window.addEventListener('offline', updateSyncUi);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(200); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 45000);

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }

  // test hooks (harmless in production)
  window.JimApp = { runCommand, findItems, renderLabel, renderDrawerLabel, printItem, connectPrinter, syncNow, handleLink, drawerCfg, saveDrawerCfg, itemLink,
    get items() { return items; }, get activity() { return activity; }, printer, settings };

  render(); updatePrinterUi(); updateSyncUi(); scheduleSync(300); checkHash();
})();
