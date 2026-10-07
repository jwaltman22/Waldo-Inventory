/*
 * Waldo Supply — web app (iPhone via Bluefy, Android Chrome, desktop Chrome/Edge).
 * Port of the Android app: voice-first stock-in / find, NIIMBOT label printing,
 * plus sync through a Google Sheet so every device sees the same inventory.
 */
(function () {
  'use strict';

  const N = window.niimbluelib;
  // Running inside the native iPhone/Android app (Capacitor)? Then use the phone's own Bluetooth, speech and voice.
  const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  const NB = NATIVE ? (window.NativeBridge || {}) : {};
  const { parse, normalize, fixHomophones } = window.JimParser;
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
    syncUrl: '', syncKey: '', speakAnswers: true, autoPrint: true, askDrawer: false, userName: '', qrOnLabels: true, voiceName: '', voiceRate: 1, sortBy: 'drawer', starFirst: true, aiEnabled: true, theme: 'auto', drawerView: 'map', handsFree: false,
    labelSize: '50x30', customW: 50, customH: 30, density: 3,
  };
  // Real storage: IndexedDB is the main copy (no 5 MB cap, transactional), localStorage is a fast mirror for
  // instant start-up. Whichever copy was saved last wins at start-up. Rolling automatic backups live in IndexedDB too.
  const Store = (() => {
    let dbp = null;
    function db() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('no IndexedDB'));
        const req = indexedDB.open('waldo-supply', 2);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
          if (!d.objectStoreNames.contains('backups')) d.createObjectStore('backups', { keyPath: 'at' });
          if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('IndexedDB blocked'));
      }).catch((e) => { dbp = Promise.resolve(null); return null; });
      return dbp;
    }
    function tx(store, mode, fn) {
      return db().then((d) => d && new Promise((resolve, reject) => {
        const t = d.transaction(store, mode); const os = t.objectStore(store);
        let out; const r = fn(os); if (r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
      })).catch(() => null);
    }
    let ok = null;   // true once an IndexedDB write succeeded
    return {
      get: (k) => tx('kv', 'readonly', (os) => os.get(k)),
      put: (k, v) => tx('kv', 'readwrite', (os) => os.put(v, k)).then((r) => { ok = r !== null || ok; return r; }),
      backups: () => tx('backups', 'readonly', (os) => os.getAll()).then((l) => (l || []).sort((a, b) => b.at - a.at)),
      addBackup: (b) => tx('backups', 'readwrite', (os) => os.put(b)),
      delBackup: (at) => tx('backups', 'readwrite', (os) => os.delete(at)),
      available: () => db().then((d) => !!d),
      photos: () => tx('photos', 'readonly', (os) => os.getAll()).then((l) => l || []),
      putPhoto: (rec) => tx('photos', 'readwrite', (os) => os.put(rec)),
      delPhoto: (id) => tx('photos', 'readwrite', (os) => os.delete(id)),
      get ok() { return ok; },
    };
  })();
  /** Save one key to both stores. The stamp says which copy is newest. */
  function persist(key, value) {
    const t = Date.now();
    const lsOk = LS.set(key, value) && LS.set(key + '@', t);
    const p = Store.put(key, { t, value });
    if (!lsOk) p.then((r) => { if (r === null) toast('Could not save on this device (storage full or blocked)'); });
    return p;
  }
  /** At start-up: if IndexedDB holds a newer copy than localStorage (e.g. localStorage was full or cleared), use it. */
  async function loadNewer(key, current) {
    const rec = await Store.get(key);
    const lsT = LS.get(key + '@', 0);
    if (rec && rec.value && (rec.t > lsT || (!lsT && !(current && current.length)))) return rec.value;
    if (!rec && current && current.length) Store.put(key, { t: lsT || Date.now(), value: current }); // first run: copy localStorage → IndexedDB
    return null;
  }

  let settings = Object.assign({}, DEFAULT_SETTINGS, LS.get('jim.settings', {}));
  let items = LS.get('jim.items', []);
  let syncState = LS.get('jim.sync', { cursor: 0, lastOk: 0, lastError: '' });
  let storeReady = false;

  function saveItems() {
    persist('jim.items', items);
    autoBackup();
    render();
    scheduleSync();
  }

  // ---- automatic backups: a snapshot at most every 3 hours (and at start-up), the last 14 kept
  const BACKUP_GAP = 3 * 3600e3, BACKUP_KEEP = 14;
  let lastBackupAt = 0, backupBusy = false;
  async function autoBackup(force, reason) {
    if (!storeReady || backupBusy) return;
    if (!force && Date.now() - lastBackupAt < BACKUP_GAP) return;
    const liveItems = items.filter((i) => !i.deleted);
    if (!liveItems.length && !force) return;
    backupBusy = true;
    try {
      const at = Date.now();
      await Store.addBackup({ at, reason: reason || 'auto', count: liveItems.filter((i) => !isConfig(i)).length,
        items: liveItems.map((i) => { const o = Object.assign({}, i); delete o.dirty; return o; }) });
      lastBackupAt = at;
      const all = await Store.backups();
      for (const b of all.slice(BACKUP_KEEP)) await Store.delBackup(b.at);
    } finally { backupBusy = false; }
  }
  async function restoreBackup(at) {
    const b = (await Store.backups()).find((x) => x.at === at);
    if (!b) return toast('That backup is gone');
    await autoBackup(true, 'before restore');
    const now = Date.now();
    const keep = new Set(b.items.map((i) => i.id));
    for (const it of items) if (!keep.has(it.id) && !it.deleted) { it.deleted = true; it.updatedAt = now; it.dirty = true; }
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const src of b.items) {
      const copy = Object.assign({}, src, { deleted: false, updatedAt: now, dirty: true });
      const cur = byId.get(src.id);
      if (cur) Object.assign(cur, copy, { syncedAt: cur.syncedAt, qtyBase: null }); else items.push(copy);
    }
    saveItems();
    log('edit', 'Restored the backup from ' + new Date(at).toLocaleString());
    toast('Restored ' + b.count + ' items from ' + new Date(at).toLocaleString());
    renderBackups();
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

  function findItems(query) { return findScored(query).map((s) => s.it); }
  /** Matches with a score: 100 exact · 80 all words · 60 contains · 20–50 some words. */
  function findScored(query) {
    const q = normalize(query);
    if (!q) return [];
    const qWords = keyWords(query);
    const qNums = q.match(/\d+/g) || [];
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
        // loose: some words overlap — but a part number in the question must be in the item (AN4 never finds AN3)
        const hay = [n, ...parts.map(normalize)].join(' ');
        const numsOk = qNums.every((d) => new RegExp('(^|[^0-9])' + d + '($|[^0-9])').test(hay));
        const hits = numsOk ? qWords.filter((w) => w.length >= 3 && !/^\d+$/.test(w) && words.some((x) => x.length >= 3 && (x.includes(w) || w.includes(x)))).length : 0;
        if (hits) score = 20 + hits * 10;
      }
      if (score) scored.push({ it, score });
    }
    scored.sort((a, b) => b.score - a.score || b.it.updatedAt - a.it.updatedAt);
    return scored;
  }

  // ---------------------------------------------------------------- fuzzy matching ("did you mean…?")
  // Typos, mishearings and sound-alikes: "jetson nana" ≈ Jetson Nano, "capton tape" ≈ Kapton Tape, "torque ranch" ≈ Torque Wrench.
  // Numbers must match exactly (AN3 ≠ AN4), so part numbers are never silently swapped.
  const FUZZY_AUTO = 0.9, FUZZY_ASK = 0.66;
  const NUMW = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
    eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20' };
  const FZ_STOP = new Set(['the', 'a', 'an', 'of', 'for', 'some', 'new', 'my', 'our', 'and', 'with']);
  const fzTokens = (s) => keyWords(s).map((w) => NUMW[w] || w).filter((w) => !FZ_STOP.has(w));
  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m || !n) return m || n;
    let pp = null, prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        if (pp && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) cur[j] = Math.min(cur[j], pp[j - 2] + 1); // swapped letters
      }
      pp = prev; prev = cur;
    }
    return prev[n];
  }
  /** Rough "sounds like" key: same letters for same sounds, vowels after the first letter dropped. */
  function soundKey(w) {
    let x = w.toLowerCase().replace(/[^a-z]/g, '');
    if (!x) return '';
    x = x.replace(/^kn|^gn|^pn|^wr/, (m) => m[1]).replace(/ph/g, 'f').replace(/ck/g, 'k').replace(/q/g, 'k').replace(/x/g, 'ks')
      .replace(/c(?=[eiy])/g, 's').replace(/c/g, 'k').replace(/z/g, 's').replace(/dg(?=[eiy])/g, 'j').replace(/gh(?![aeiou])/g, '')
      .replace(/sh/g, 'S').replace(/th/g, '0').replace(/wh/g, 'w').replace(/v/g, 'f').replace(/([a-z])\1+/g, '$1');
    return x[0] + x.slice(1).replace(/[aeiouyhw]/g, '');
  }
  function tokSim(a, b) {
    if (a === b) return 1;
    const na = a.match(/\d+/g), nb = b.match(/\d+/g);
    if (na || nb) {
      if (String(na) !== String(nb)) return 0.15;                        // different numbers: never the same part
      return a.replace(/\d+/g, '#') === b.replace(/\d+/g, '#') ? 1 : 0.6;
    }
    let s = 1 - lev(a, b) / Math.max(a.length, b.length);
    if (a.length >= 3 && b.length >= 3 && soundKey(a) === soundKey(b)) s = Math.max(s, 0.86);
    if (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) s = Math.max(s, 0.8);
    return s;
  }
  /** 0..1 — how likely the spoken words name this item. */
  function nameSim(query, name) { return simDetail(query, name).sim; }
  /** sim = overall likeness; cover = how well every spoken word is found in the name ("kapton tape" fully covers "rolls of Kapton tape"). */
  function simDetail(query, name) {
    const Q = fzTokens(query), T = fzTokens(name);
    if (!Q.length || !T.length) return { sim: 0, cover: 0 };
    const best = (w, list) => Math.max(...list.map((t) => tokSim(w, t)));
    const wavg = (ws) => ws.reduce((s, w) => s + best(w.w, w.o) * w.w.length, 0) / ws.reduce((s, w) => s + w.w.length, 0);
    const qs = wavg(Q.map((w) => ({ w, o: T }))), ts = wavg(T.map((w) => ({ w, o: Q })));
    let sim = 0.65 * qs + 0.35 * ts;
    const jq = Q.join(''), jt = T.join('');                                // "jetsonnano" vs "jetson nano"
    if (!/\d/.test(jq + jt) || String(jq.match(/\d+/g)) === String(jt.match(/\d+/g))) sim = Math.max(sim, 0.95 * (1 - lev(jq, jt) / Math.max(jq.length, jt.length)));
    return { sim, cover: qs };
  }
  /** Close matches across item names and mixed-drawer parts, best first. */
  function fuzzyCandidates(query, min = FUZZY_ASK) {
    const out = [];
    for (const it of live()) {
      const names = isMixed(it) ? getContents(it) : [it.name];
      for (const nm of names) {
        const d = simDetail(query, nm);
        if (d.sim >= min) out.push({ it, name: nm, score: d.sim, cover: d.cover });
      }
    }
    out.sort((a, b) => b.score - a.score);
    return out.filter((c, i) => out.findIndex((d) => d.name === c.name && d.it === c.it) === i).slice(0, 3);
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
  /** The shared config row holds { drawers: [...], aliases: { heard → real name } } (older versions: just the drawers array). */
  function cfgData() {
    const c = items.find((i) => i.id === CONFIG_ID && !i.deleted);
    if (c) {
      try {
        const v = JSON.parse(c.notes);
        if (Array.isArray(v)) return { drawers: v, aliases: {} };
        if (v && typeof v === 'object') return Object.assign({}, v, { drawers: Array.isArray(v.drawers) ? v.drawers : [], aliases: v.aliases || {} });
      } catch (e) { /* fall back */ }
    }
    return { drawers: [], aliases: {} };
  }
  function drawerCfg() {
    const d = cfgData().drawers;
    return d.length ? d : DEFAULT_DRAWERS;
  }
  function saveDrawerCfg(list, aliases) {
    writeCfg(Object.assign(cfgData(), { drawers: list, aliases: aliases || cfgData().aliases }));
  }
  /** Names Waldo has been corrected on: what it heard → what the thing is really called. */
  const getAliases = () => cfgData().aliases;
  function applyAlias(name) {
    const a = getAliases()[normalize(name)];
    return a || name;
  }
  function learnAlias(heard, real) {
    const k = normalize(heard);
    if (!k || k === normalize(real)) return;
    const aliases = Object.assign({}, getAliases(), { [k]: real });
    writeCfg(Object.assign(cfgData(), { drawers: cfgData().drawers.length ? cfgData().drawers : DEFAULT_DRAWERS, aliases }));
  }
  function writeCfg(data) {
    let c = items.find((i) => i.id === CONFIG_ID);
    if (!c) {
      c = { id: CONFIG_ID, name: 'Waldo Supply drawer setup (managed by the app)', drawer: '', quantity: 0, sku: 'CONFIG', category: '',
        notes: '', createdAt: Date.now(), lastPrintedAt: null, deleted: false };
      items.push(c);
    }
    c.deleted = false; c.notes = JSON.stringify(data); touch(c); saveItems();
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

  // ---- voice choice: the phone's own text-to-speech voices
  const NOVELTY = /^(albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|kathy|ralph|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley)\b/i;
  const NICE = ['ava', 'zoe', 'samantha', 'allison', 'susan', 'serena', 'karen', 'moira', 'tessa', 'evan', 'nathan', 'tom', 'daniel', 'google us english', 'microsoft aria', 'microsoft jenny'];
  function voiceRank(v) {
    const n = v.name.toLowerCase();
    let r = 0;
    if (/premium/.test(n)) r += 300; else if (/enhanced|natural|neural|online/.test(n)) r += 200;
    const i = NICE.findIndex((k) => n.startsWith(k));
    if (i >= 0) r += 100 - i;
    if (/^en[-_]us/i.test(v.lang)) r += 5;
    return r;
  }
  let nativeVoices = [];
  if (NB.TextToSpeech) NB.TextToSpeech.getSupportedVoices().then((r) => { nativeVoices = (r && r.voices) || []; }).catch(() => {});
  function englishVoices() {
    let all;
    if (NB.TextToSpeech) all = nativeVoices;
    else if ('speechSynthesis' in window) all = speechSynthesis.getVoices();
    else return [];
    return all.filter((v) => /^en([-_]|$)/i.test(v.lang) && !NOVELTY.test(v.name))
      .sort((a, b) => voiceRank(b) - voiceRank(a) || a.name.localeCompare(b.name));
  }
  function chosenVoice() {
    const list = englishVoices();
    if (settings.voiceName) { const v = list.find((x) => x.name === settings.voiceName); if (v) return v; }
    return list[0] || null; // best-ranked English voice
  }

  /** Speaks, and returns a promise that settles when Waldo has finished talking (hands-free waits for it). */
  function speak(text, force) {
    if (!settings.speakAnswers && !force) return Promise.resolve();
    const guess = 1500 + String(text).length * 85 / Math.max(0.7, +settings.voiceRate || 1);   // in case "end" never fires
    if (NB.TextToSpeech) {
      const v = chosenVoice();
      const idx = v ? nativeVoices.indexOf(v) : -1;
      const opts = { text, lang: (v && v.lang) || 'en-US', rate: Math.min(1.4, Math.max(0.7, +settings.voiceRate || 1)), category: 'playback' };
      if (idx >= 0) opts.voice = idx;
      return Promise.race([
        NB.TextToSpeech.stop().catch(() => {}).then(() => NB.TextToSpeech.speak(opts)).catch(() => {}),
        new Promise((r) => setTimeout(r, guess + 4000)),
      ]);
    }
    if (!('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((resolve) => {
      try {
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        const v = chosenVoice();
        if (v) { u.voice = v; u.lang = v.lang; } else u.lang = 'en-US';
        u.rate = Math.min(1.4, Math.max(0.7, +settings.voiceRate || 1));
        const t = setTimeout(resolve, guess + 4000);
        u.onend = u.onerror = () => { clearTimeout(t); resolve(); };
        speechSynthesis.speak(u);
      } catch (e) { resolve(); }
    });
  }
  let lastSpeech = Promise.resolve();

  function answer(text, spoken, actions) {
    if (currentTab !== 'items') switchTab('items');
    const el = $('answer');
    el.classList.toggle('ai', !!lastAnswerAi); lastAnswerAi = false;
    if (fuzzyNote) { text = fuzzyNote + text; if (typeof spoken === 'string') spoken = fuzzyNote + spoken; fuzzyNote = ''; }
    el.textContent = text; el.classList.add('show'); delete el.dataset.item;
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
    lastSpeech = spoken !== false ? speak(spoken || text) : Promise.resolve();
  }

  // Native app: the phone's own speech recognition (plugin). Stops after a short pause or a second tap.
  let nativeFinish = null;
  async function nativeListen() {
    const R = NB.SpeechRecognition;
    if (listening && nativeFinish) return nativeFinish();
    try {
      const p = await R.checkPermissions();
      if (!p || p.speechRecognition !== 'granted') {
        const r = await R.requestPermissions();
        if (!r || r.speechRecognition !== 'granted') { toast('Turn on Microphone and Speech Recognition for Waldo Supply in iPhone/Android Settings'); return; }
      }
    } catch (e) { /* older plugin versions: just try */ }
    let latest = '', silence = null, done = false;
    nativeFinish = async (discard) => {
      if (done) return; done = true;
      if (discard) latest = '';
      clearTimeout(silence); nativeFinish = null;
      setListening(false);
      try { await R.stop(); } catch (e) { /* */ }
      try { await R.removeAllListeners(); } catch (e) { /* */ }
      heard(latest.trim());
    };
    try { await R.removeAllListeners(); } catch (e) { /* */ }
    R.addListener('partialResults', (d) => {
      const m = d && d.matches && d.matches[0];
      if (m) { latest = m; $('transcript').textContent = m; }
      clearTimeout(silence); silence = setTimeout(() => nativeFinish && nativeFinish(), 1600);
    });
    R.addListener('listeningState', (d) => { if (d && d.status === 'stopped' && nativeFinish) nativeFinish(); });
    try { speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* */ }
    if (NB.TextToSpeech) NB.TextToSpeech.stop().catch(() => {});
    setListening(true);
    silence = setTimeout(() => nativeFinish && nativeFinish(), 8000);
    try {
      await R.start({ language: 'en-US', maxResults: 1, partialResults: true, popup: false });
    } catch (e) {
      done = true; nativeFinish = null; clearTimeout(silence); setListening(false);
      toast('Couldn’t start listening: ' + (e && e.message || e));
    }
  }

  function startListening() {
    if (NB.SpeechRecognition) return nativeListen();
    if (!SR) {
      // iPhone in Bluefy/Safari without speech API: the keyboard mic works everywhere.
      const input = $('cmdInput');
      input.focus();
      toast('Tap the 🎤 on the keyboard and speak, then Go');
      return;
    }
    if (listening) { recognizer && recognizer.stop(); return; }
    try { speechSynthesis && speechSynthesis.cancel(); } catch (e) { /* */ }
    if (recognizer) { try { recognizer.onend = null; recognizer.abort(); } catch (e) { /* */ } }
    recognizer = new SR();
    recognizer.lang = 'en-US';
    recognizer.interimResults = true;
    recognizer.maxAlternatives = 1;
    recognizer.continuous = false;
    let finalText = '', heardSomething = false;
    recognizer.onstart = () => setListening(true);
    recognizer.onresult = (e) => {
      heardSomething = true;
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
        if (handsFree) setHandsFree(false, true);
        toast('Microphone blocked — use the keyboard 🎤 in the box instead');
        $('cmdInput').focus();
      } else if (e.error !== 'aborted' && e.error !== 'no-speech') toast('Didn’t catch that (' + e.error + ')');
    };
    recognizer.onend = () => {
      setListening(false);
      const text = finalText.trim() || (heardSomething ? $('transcript').textContent.trim() : '');
      heard(text);
    };
    try { recognizer.start(); } catch (e) { setListening(false); }
  }

  function setListening(on) {
    listening = on;
    $('micBtn').classList.toggle('listening', on);
    $('micLabel').textContent = on ? (handsFree ? 'Hands-free · listening…' : 'Listening… tap to stop') : (handsFree ? 'Hands-free · one moment…' : 'Tap to speak');
    if (on) $('transcript').textContent = '';
  }

  // ---- hands-free: keep listening between items until "stop", a minute and a half of quiet, or a tap
  const canListen = () => !!(SR || NB.SpeechRecognition);
  const HF_STOP = /^\s*(?:ok(?:ay)?\s+|alright\s+)?(?:stop|stop listening|that'?s (?:all|it)|that is (?:all|it)|(?:i'?m|we'?re|all) done|done|hands[- ]?free off|stop hands[- ]?free|turn off hands[- ]?free|good ?bye|bye|thanks waldo|thank you waldo)\s*[.!]?\s*$/i;
  const HF_START = /^\s*(?:start |turn on |go )?(?:hands[- ]?free(?: mode)?(?: on)?|keep listening|continuous(?: listening)?(?: mode)?)\s*[.!]?\s*$/i;
  const HF_IDLE = 90000;
  let handsFree = false, hfLastHeard = 0, hfTimer = null;
  function setHandsFree(on, quiet) {
    if (on && !canListen()) {
      toast('Hands-free needs the phone’s speech recognition: use Chrome on Android/PC or the Waldo Supply app. In Bluefy, use the keyboard 🎤.');
      return;
    }
    handsFree = !!on;
    $('handsFreeBtn').setAttribute('aria-pressed', String(handsFree));
    clearTimeout(hfTimer);
    if (handsFree) {
      hfLastHeard = Date.now();
      if (!quiet) answer('Hands-free is on. Tell me what came in, one item at a time. Say “stop” when you’re done.', 'Hands-free on. Go ahead.');
      hfNext(quiet ? 0 : null);
    } else {
      if (listening) { if (nativeFinish) nativeFinish(true); else if (recognizer) { try { recognizer.onend = null; recognizer.abort(); } catch (e) { /* */ } setListening(false); } }
      setListening(false);
      if (!quiet) answer('Hands-free is off.', 'Hands-free off.');
    }
  }
  /** After Waldo answers (and finishes talking), listen again. */
  function hfNext(delay) {
    if (!handsFree) return;
    clearTimeout(hfTimer);
    const go = async () => {
      if (!handsFree || listening) return;
      try { await lastSpeech; } catch (e) { /* */ }
      if (!handsFree || listening) return;
      if (document.querySelector('dialog[open]') || document.hidden) { hfTimer = setTimeout(go, 800); return; }   // wait for a sheet to close
      if (Date.now() - hfLastHeard > HF_IDLE) {
        handsFree = false; $('handsFreeBtn').setAttribute('aria-pressed', 'false'); setListening(false);
        answer('Hands-free paused — it was quiet for a while. Tap Hands-free to start again.', 'Hands-free paused.');
        return;
      }
      startListening();
    };
    hfTimer = setTimeout(go, delay == null ? 350 : delay);
  }
  /** Everything heard by the microphone comes through here. */
  async function heard(text) {
    text = String(text || '').trim();
    if (!text) { hfNext(); return; }
    if (handsFree) {
      hfLastHeard = Date.now();
      if (HF_STOP.test(text)) { $('transcript').textContent = '“' + text + '”'; setHandsFree(false); return; }
    }
    await runCommand(text);
    hfNext();
  }
  $('handsFreeBtn').onclick = () => setHandsFree(!handsFree);

  // ---------------------------------------------------------------- AI understanding (Grok or Gemini, via the Apps Script)
  let aiState = LS.get('jim.ai', { ready: null, lastError: '', lastOk: 0 });
  let lastAnswerAi = false;
  const aiUsable = () => settings.aiEnabled !== false && !!settings.syncUrl && navigator.onLine && aiState.ready !== false;
  function setAiState(patch) { Object.assign(aiState, patch); LS.set('jim.ai', aiState); updateAiUi(); }

  /** Short summary the AI needs: the drawers and what's in them. */
  function aiContext() {
    return {
      drawers: drawerCfg().map((d) => ({ name: d.name, category: d.category, mode: d.mode })),
      items: live().slice(0, 250).map((i) => isMixed(i)
        ? i.drawer + ' (mixed) contains: ' + getContents(i).slice(0, 30).join(', ') + ' | ' + i.drawer + ' | -'
        : i.name + ' | ' + i.drawer + ' | ' + i.quantity),
    };
  }
  const LOC = /^(drawer|bin|shelf|cabinet|slot|box|tray|rack)\s*#?\s*(.+)$/i;
  function cleanDrawer(d) {
    if (!d) return null;
    const s = String(d).trim();
    const known = drawerCfg().find((x) => x.name.toLowerCase() === s.toLowerCase());
    if (known) return known.name;
    const m = LOC.exec(s);
    return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() + ' ' + m[2].replace(/\s+/g, '').toUpperCase() : s;
  }
  /** Map Gemini's JSON onto the same command shapes the built-in parser produces. Null = let the rules handle it. */
  function aiToIntent(r, raw) {
    if (!r || typeof r !== 'object') return null;
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const qty = Number.isInteger(r.quantity) && r.quantity > 0 ? r.quantity : null;
    const drawer = cleanDrawer(str(r.drawer));
    switch (r.type) {
      case 'add': return str(r.name) ? { type: 'add', name: str(r.name), drawer, quantity: qty || 1, raw } : null;
      case 'find': case 'count': return str(r.query || r.name) ? { type: r.type, query: str(r.query || r.name), raw } : null;
      case 'remove': return str(r.query || r.name) ? { type: 'remove', query: str(r.query || r.name), quantity: qty, raw } : null;
      case 'print':
        if (r.allInDrawer && drawer) return { type: 'printAll', drawer, raw };
        if (r.drawerLabel && drawer) return { type: 'print', query: '', drawer, raw };
        return str(r.query || r.name) ? { type: 'print', query: str(r.query || r.name), drawer: null, raw } : null;
      case 'list': return { type: 'list', drawer, raw };
      case 'answer': return str(r.reply) ? { type: 'answer', reply: str(r.reply), raw } : null;
      default: return null;
    }
  }
  async function aiInterpret(text) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = setTimeout(() => ctl && ctl.abort(), 15000);
    try {
      const res = await fetch(settings.syncUrl, {
        method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow', signal: ctl ? ctl.signal : undefined,
        body: JSON.stringify({ key: settings.syncKey, action: 'ai', text, context: aiContext() }),
      });
      const data = await res.json();
      if (!data.ok) {
        if (data.error === 'no_ai_key' || data.error === 'bad_action') setAiState({ ready: false, lastError: data.error });
        else setAiState({ lastError: data.error + (data.detail ? ': ' + data.detail : '') });
        return null;
      }
      const intent = aiToIntent(data.result, text);
      setAiState({ ready: true, provider: data.provider || aiState.provider || '', lastError: intent ? '' : 'unclear', lastOk: Date.now() });
      return intent;
    } catch (e) {
      setAiState({ lastError: e && e.name === 'AbortError' ? 'timed out' : String(e && e.message || e) });
      return null;
    } finally { clearTimeout(timer); }
  }
  function updateAiUi() {
    const st = $('aiStatus');
    if (!st) return;
    let t;
    if (settings.aiEnabled === false) t = 'Off — using the built-in rules.';
    else if (!settings.syncUrl) t = 'Needs sync set up first (the AI runs through your Google Apps Script).';
    else if (aiState.ready === false) t = aiState.lastError === 'bad_action'
      ? 'Your Apps Script is an older version — paste in the new Code.gs and deploy a new version.'
      : 'Not set up yet — add GROK_API_KEY or GEMINI_API_KEY in your Apps Script’s Script Properties.';
    else if (aiState.ready === true) t = '✓ ' + (aiState.provider === 'grok' ? 'Grok' : aiState.provider === 'gemini' ? 'Gemini' : 'AI') + ' connected' + (aiState.lastError && aiState.lastError !== 'unclear' ? ' (last problem: ' + aiState.lastError + ')' : '') + '.';
    else t = 'Will connect on the next sync or command.';
    st.textContent = t;
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
    if (/^\s*(?:please\s+)?(?:cancel|clear|stop|delete|forget)\s+(?:all\s+)?(?:the\s+)?(?:waiting\s+|pending\s+|queued\s+)?(?:prints?|printing|labels?|print\s+(?:jobs?|queue)|queue)\b/i.test(text)) {
      const n = printQueue.length;
      cancelQueued('all');
      return answer(n ? 'Canceled ' + n + ' waiting label' + (n === 1 ? '' : 's') + '.' : 'Nothing was waiting to print.');
    }
    if (HF_START.test(text)) { setHandsFree(true); return; }
    if (pendingChoice) {
      const pc = pendingChoice; pendingChoice = null;
      if (/^\s*(?:yes|yeah|yep|yup|correct|right|sure|ok(?:ay)?|that one|the first(?: one)?|first(?: one)?)\b/i.test(text)) return pc.acts[0].run();
      if (/^\s*(?:the )?second(?: one)?\b/i.test(text) && pc.cands.length > 1) return pc.acts[1].run();
      if (/^\s*(?:the )?third(?: one)?\b/i.test(text) && pc.cands.length > 2) return pc.acts[2].run();
      if (/^\s*(?:no|nope|neither|none(?: of them)?|wrong)\b\W*$/i.test(text)) return pc.acts[pc.acts.length - 1].run();
      const best = pc.cands.map((c, i) => ({ i, s: nameSim(text, c.name) })).sort((a, b) => b.s - a.s)[0];
      if (best && best.s >= 0.8) return pc.acts[best.i].run();
    }
    let intent = null;
    let viaAi = false;
    if (aiUsable()) {
      $('transcript').textContent = '“' + text + '” · thinking…';
      intent = await aiInterpret(fixHomophones(text));   // "got in for AA batteries" → 4
      viaAi = !!intent;
      $('transcript').textContent = '“' + text + '”';
    }
    if (!intent) intent = parse(text);
    lastAnswerAi = viaAi;
    for (const k of ['name', 'query']) if (intent[k]) intent[k] = applyAlias(intent[k]);
    return handleIntent(intent, text);
  }

  /** Ask "Did you mean…?" with a button per close match (picking one also teaches Waldo the phrase). */
  function askDidYouMean(heard, cands, onPick, noBtn, question) {
    const names = cands.map((c) => c.name + (isMixed(c.it) ? ' (' + c.it.drawer + ')' : ''));
    const acts = cands.map((c, i) => ({ label: (cands.length === 1 ? 'Yes — ' : '') + names[i], run: () => { learnAlias(heard, c.name); onPick(c); } }));
    acts.push(noBtn || { label: 'No', run: () => answer('Okay — try saying it again, or type it.', 'Okay, say it again.') });
    for (const a of acts) { const run = a.run; a.run = () => { pendingChoice = null; return run(); }; }
    const list = cands.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' or ' + names[names.length - 1];
    const spokenList = cands.length === 1 ? cands[0].name : cands.slice(0, -1).map((c) => c.name).join(', ') + ', or ' + cands[cands.length - 1].name;
    const ret = question
      ? answer(question(list), question(spokenList), acts)
      : answer('I didn’t find “' + heard + '”. Did you mean ' + list + '?', 'Did you mean ' + spokenList + '?', acts);
    pendingChoice = { acts, cands };   // a spoken "yes" / "no" / "the second one" answers it too
    return ret || true;
  }

  /** For lookups: exact/word matches first; otherwise a close match is used (very close) or offered (close). */
  function resolveLookup(intent, text) {
    if (!intent.query) return null;
    const found = findScored(intent.query);
    if (found.length && found[0].score >= 60) return null;            // a real match: no guessing needed
    const cands = fuzzyCandidates(intent.query).filter((c) => normalize(c.name) !== normalize(intent.query));
    if (!cands.length) return null;                                    // only loose word overlaps (or nothing): handled as before
    // Sure enough to just go: very close and clearly ahead — or the only close match, with every spoken word in it.
    const clear = (cands[0].score >= FUZZY_AUTO && (cands.length === 1 || cands[0].score - cands[1].score >= 0.06)) ||
      (cands.length === 1 && cands[0].score >= 0.8 && cands[0].cover >= 0.88);
    if (clear) { fuzzyNote = 'I think you meant ' + cands[0].name + '. '; return handleIntent(Object.assign({}, intent, { query: cands[0].name }), text); }
    return askDidYouMean(intent.query, cands, (c) => handleIntent(Object.assign({}, intent, { query: c.name }), text));
  }
  let fuzzyNote = '';
  let pendingChoice = null;

  async function handleIntent(intent, text) {
    if (['find', 'count', 'remove'].includes(intent.type) || (intent.type === 'print' && intent.query && !/^(drawer\s+)?(label|tag|sticker)s?(\s+for)?$/i.test(intent.query))) {
      const r = resolveLookup(intent, text);
      if (r) return r;
    }
    if ((intent.type === 'add' || intent.type === 'bare') && intent.name && !strongMatch(intent.name) && !intent._checked) {
      const cands = fuzzyCandidates(intent.name, 0.8);
      if (cands.length) {
        const again = Object.assign({}, intent, { _checked: true });
        return askDidYouMean(intent.name, cands,
          (c) => (intent.type === 'bare' && !intent.drawer ? focusItem(c.it, false, c.name) : handleIntent(Object.assign({}, again, { name: c.name }), text)),
          { label: 'No — it’s new', run: () => handleIntent(again, text) },
          (l) => 'Is “' + intent.name + '” the same as ' + l + ' you already have?');
      }
    }
    switch (intent.type) {
      case 'answer':
        return answer(intent.reply || 'I’m not sure.');
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
        const sc = findScored(intent.query), hits = sc.map((x) => x.it);
        if (!hits.length) return answer('No “' + intent.query + '” in inventory.', 'I don’t have ' + intent.query + ' in inventory.');
        $('filter').value = intent.query; render();
        if (hits.length === 1 || matchedPart(hits[0], intent.query) || (sc[0].score >= 80 && sc[1].score < 60)) return focusItem(hits[0], false, intent.query);
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
      case 'printAll':
        return printDrawerAll(intent.drawer);
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
      acts.push({ label: 'Fix name', run: () => openItem(item, true) });
      for (const d of drawerCfg()) if (!isGeneral(d) && d.category) acts.push({ label: d.category, run: () => moveToCategory(item, d) });
    } else acts.push({ label: 'Fix name or drawer', run: () => openItem(item, true) });
    acts.push({ label: photoUrl.has(item.id) ? '📷 Retake photo' : '📷 Add photo', run: () => pickPhoto(item) });
    acts.push(undo);
    answer(msg, spoken, acts);
    addAnswerPhoto(item);
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
      { label: photoUrl.has(it.id) ? 'Photo' : '📷 Add photo', run: () => openPhoto(it) },
      { label: 'On map', run: () => showOnMap(it.name) },
      { label: 'Edit', run: () => openItem(it) },
    ]);
    addAnswerPhoto(it);
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

  /** Batch: every label in one drawer (each tracked item, each part of a mixed drawer). Cancelable while it runs. */
  function drawerItems(name) {
    const k = String(name || '').trim().toLowerCase();
    return live().filter((i) => i.drawer.toLowerCase() === k).sort((a, b) => a.name.localeCompare(b.name));
  }
  function drawerLabelEntries(name) {
    const out = [];
    for (const it of drawerItems(name)) {
      if (isMixed(it)) for (const part of getContents(it)) out.push({ v: { name: part, drawer: it.drawer, category: it.category, mixed: true, qrId: it.id, createdAt: it.createdAt } });
      else out.push(it.id);
    }
    return out;
  }
  function printDrawerAll(name, withDrawerLabel) {
    if (!name) return answer('Which drawer? Try “print all the labels for drawer 3”.');
    const d = cfgFor(name);
    const dn = d ? d.name : ((drawerItems(name)[0] || {}).drawer || name);
    const batch = drawerLabelEntries(dn);
    if (withDrawerLabel) batch.unshift({ d: dn, c: d ? d.category : '', m: d ? d.mode : 'tracked' });
    if (!batch.length) return answer(dn + ' is empty — nothing to print.', dn + ' is empty.');
    for (const e of batch) if (typeof e !== 'string' || !printQueue.includes(e)) printQueue.push(e);
    LS.set('jim.printQueue', printQueue); updatePrinterUi();
    const n = batch.length, word = n + ' label' + (n === 1 ? '' : 's');
    log('print', 'Batch: ' + word + ' for ' + dn);
    const cancel = { label: 'Cancel these', run: () => {
      const left = printQueue.filter((e) => batch.includes(e)).length;
      printQueue = printQueue.filter((e) => !batch.includes(e)); LS.set('jim.printQueue', printQueue); updatePrinterUi();
      answer(left ? 'Canceled ' + left + ' label' + (left === 1 ? '' : 's') + ' for ' + dn + '.' : 'Those labels already printed.', false);
    } };
    if (printer.connected) { answer('Printing ' + word + ' for ' + dn + '…', 'Printing ' + word + ' for ' + dn + '.', [cancel]); flushPrintQueue(); }
    else answer(word + ' for ' + dn + ' will print as soon as the printer connects.', word + ' for ' + dn + ' will print when the printer connects.', [cancel]);
    return n;
  }

  // Labels waiting for the printer (saved so a reload doesn't lose them)
  let printQueue = LS.get('jim.printQueue', []);
  /** Entries: an item id, { v: bag-label item } for mixed-drawer parts, or { d: drawer name } for a drawer-front label. */
  function queuePrint(entry) {
    if (typeof entry !== 'string' || !printQueue.includes(entry)) printQueue.push(entry);
    LS.set('jim.printQueue', printQueue); updatePrinterUi();
  }
  function queueLabel(e) {
    if (typeof e === 'string') {
      const it = items.find((i) => i.id === e);
      return it ? { name: it.name, sub: it.drawer + (it.deleted ? ' · removed' : '') } : { name: 'Item label', sub: '' };
    }
    if (e && e.v) return { name: e.v.name, sub: e.v.drawer + ' · mixed' };
    if (e && e.d) return { name: 'Drawer label', sub: e.d };
    return { name: 'Label', sub: '' };
  }
  function cancelQueued(index) {
    const gone = index === 'all' ? printQueue.length : 1;
    if (index === 'all') printQueue = []; else printQueue.splice(index, 1);
    LS.set('jim.printQueue', printQueue);
    if (gone) log('remove', 'Canceled ' + gone + ' waiting label' + (gone > 1 ? 's' : ''));
    updatePrinterUi();
  }
  function renderQueue() {
    const box = $('queueBox');
    if (!box) return;
    box.hidden = !printQueue.length;
    $('queueTitle').textContent = printQueue.length + ' label' + (printQueue.length === 1 ? '' : 's') + ' waiting to print';
    const root = $('queueList'); root.textContent = '';
    printQueue.forEach((e, i) => {
      const L = queueLabel(e);
      const row = el('div', 'qrow');
      const t = el('div', 'qtxt', L.name); if (L.sub) t.appendChild(el('small', null, L.sub));
      const x = el('button', null, '✕'); x.type = 'button'; x.setAttribute('aria-label', 'Cancel this label');
      x.onclick = () => cancelQueued(i);
      row.append(t, x); root.appendChild(row);
    });
  }

  let flushing = false;
  async function flushPrintQueue() {
    if (flushing) return;
    flushing = true;
    try { await flushNow(); } finally { flushing = false; }
  }
  async function flushNow() {
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
  const appBase = () => (NATIVE || !/^https?:$/.test(location.protocol))
    ? (window.WALDO_PUBLIC_URL || 'https://jwaltman22.github.io/Waldo-Inventory/')
    : location.origin + location.pathname;
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
    if (NATIVE) return !!(N && N.NiimbotCapacitorBleClient);
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
    const client = NATIVE ? new N.NiimbotCapacitorBleClient() : new N.NiimbotBluetoothClient();
    printer.client = client;
    let connecting = true;
    client.on('disconnect', () => {
      if (connecting) return; // the native client emits a stray "disconnect" while it sets up
      printer.connected = false; printer.busy = false;
      updatePrinterUi(); toast('Printer disconnected');
    });
    client.on('heartbeat', () => updatePrinterUi());
    setPrinterText('Connecting…', 'warn');
    try {
      let res;
      if (NATIVE) res = await client.connect(); // the phone shows its own Bluetooth device picker
      else {
        const device = await pickDevice(showAll);
        setPrinterText('Connecting…', 'warn');
        res = await client.connect({ authorizedDevice: device });
      }
      connecting = false;
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
      connecting = false;
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
    $('connectAllBtn').hidden = printer.connected || NATIVE;
    $('findHelp').hidden = printer.connected || NATIVE;
    $('niimbotAppNote').hidden = false;
    $('disconnectBtn').hidden = !printer.connected;
    $('testPrintBtn').disabled = !printer.connected || printer.busy;
    renderQueue();
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

  // ---------------------------------------------------------------- item photos
  // Taken with the phone camera, shrunk to a small JPEG (fits in one Google Sheet cell), kept in IndexedDB,
  // and synced through the Sheet's "Photos" tab so every phone sees them.
  const photoUrl = new Map();            // item id -> data: URL
  const PHOTO_MAX = 45000;               // characters; a Sheet cell holds 50,000
  async function loadPhotos() {
    for (const r of await Store.photos()) if (r.data) photoUrl.set(r.id, r.data);
  }
  function compressPhoto(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let side = 640, q = 0.72, out = '';
        for (let i = 0; i < 12; i++) {
          const k = Math.min(1, side / Math.max(img.naturalWidth, img.naturalHeight));
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
          const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
          out = c.toDataURL('image/jpeg', q);
          if (out.length <= PHOTO_MAX) return resolve(out);
          if (q > 0.5) q -= 0.08; else side = Math.round(side * 0.85);
        }
        resolve(out.length <= PHOTO_MAX ? out : null);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file isn’t a photo the phone can open')); };
      img.src = url;
    });
  }
  let photoTarget = null;
  function pickPhoto(it) {
    if (!it || !it.id) return;
    photoTarget = it;
    const inp = $('photoFile'); inp.value = ''; inp.click();
  }
  $('photoFile').addEventListener('change', async () => {
    const file = $('photoFile').files[0], it = photoTarget;
    photoTarget = null;
    if (!file || !it) return;
    try {
      const data = await compressPhoto(file);
      if (!data) return toast('Couldn’t make that photo small enough — try again a little closer');
      await setPhoto(it, data);
    } catch (e) { toast(String(e && e.message || e)); }
  });
  async function setPhoto(it, data) {
    const at = Date.now();
    await Store.putPhoto({ id: it.id, at, data, dirty: true });
    photoUrl.set(it.id, data);
    it.photoAt = at; touch(it); saveItems();
    log('edit', 'Added a photo of ' + it.name);
    toast('Photo saved with ' + it.name);
    refreshPhotoUi(it);
  }
  async function removePhoto(it) {
    const at = Date.now();
    await Store.putPhoto({ id: it.id, at, data: '', dirty: true });
    photoUrl.delete(it.id);
    it.photoAt = 0; touch(it); saveItems();
    log('edit', 'Removed the photo of ' + it.name);
    refreshPhotoUi(it);
  }
  function refreshPhotoUi(it) {
    if (editing === it && $('itemDlg').open) showItemPhoto(it);
    const a = $('answer').querySelector('.ans-photo');
    if (a && a.dataset.id === it.id) { if (photoUrl.has(it.id)) a.src = photoUrl.get(it.id); else a.remove(); }
    else if (photoUrl.has(it.id) && $('answer').dataset.item === it.id) addAnswerPhoto(it);
    render();
  }
  function addAnswerPhoto(it) {
    const box = $('answer');
    box.dataset.item = it.id;
    if (!photoUrl.has(it.id) || box.querySelector('.ans-photo')) return;
    const img = el('img', 'ans-photo'); img.src = photoUrl.get(it.id); img.alt = 'Photo of ' + it.name; img.dataset.id = it.id;
    img.onclick = () => openPhoto(it);
    box.insertBefore(img, box.firstChild);
  }
  function openPhoto(it) {
    if (!photoUrl.has(it.id)) return pickPhoto(it);
    $('photoBig').src = photoUrl.get(it.id);
    $('photoTitle').textContent = it.name + ' · ' + it.drawer;
    $('photoRetake').onclick = () => { $('photoDlg').close(); pickPhoto(it); };
    $('photoDlg').showModal();
  }
  function showItemPhoto(it) {
    const has = !!(it && photoUrl.has(it.id));
    $('photoRow').hidden = !it;
    $('itemPhoto').hidden = !has;
    if (has) $('itemPhoto').src = photoUrl.get(it.id);
    $('photoAdd').textContent = has ? 'Retake photo' : '📷 Add photo';
    $('photoRemove').hidden = !has;
  }
  $('photoAdd').onclick = () => { if (editing) pickPhoto(editing); };
  $('photoRemove').onclick = () => { if (editing) removePhoto(editing); };
  $('itemPhoto').onclick = () => { if (editing) openPhoto(editing); };
  $('photoClose').onclick = () => $('photoDlg').close();

  /** Push photos taken here, pull photos taken on other phones. Runs after each successful sync. */
  let photoSyncing = false, photoSyncOff = false;
  async function syncPhotos() {
    if (photoSyncing || photoSyncOff || !settings.syncUrl || !navigator.onLine) return;
    photoSyncing = true;
    const post = async (body) => {
      const res = await fetch(settings.syncUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, redirect: 'follow',
        body: JSON.stringify(Object.assign({ key: settings.syncKey }, body)) });
      return res.json();
    };
    try {
      const recs = await Store.photos();
      const local = new Map(recs.map((r) => [r.id, r]));
      // up
      for (const r of recs.filter((x) => x.dirty)) {
        const d = await post({ action: 'photoPut', id: r.id, at: r.at, data: r.data || '' });
        if (!d.ok) {
          if (d.error === 'bad_action') { photoSyncOff = true; toast('Photos stay on this phone until the Apps Script is updated (see the v21 notes)'); }
          break;
        }
        r.dirty = false; await Store.putPhoto(r);
      }
      // down: items whose photo is newer than ours; photos removed elsewhere
      const want = [];
      for (const it of items) {
        if (it.deleted || isConfig(it)) continue;
        const mine = local.get(it.id);
        if (it.photoAt > 0 && (!mine || mine.at < it.photoAt) && !(mine && mine.dirty)) want.push(it.id);
        if (it.photoAt === 0 && mine && mine.data && !mine.dirty && mine.at < Date.now()) { await Store.delPhoto(it.id); photoUrl.delete(it.id); }
      }
      for (let i = 0; i < want.length && !photoSyncOff; i += 6) {
        const d = await post({ action: 'photoGet', ids: want.slice(i, i + 6) });
        if (!d.ok) { if (d.error === 'bad_action') photoSyncOff = true; break; }
        for (const p of d.photos || []) {
          if (p.data) { await Store.putPhoto({ id: p.id, at: Number(p.at) || 0, data: p.data, dirty: false }); photoUrl.set(p.id, p.data); }
        }
      }
      if (want.length) render();
    } catch (e) { /* tries again after the next sync */ } finally { photoSyncing = false; }
  }

  // Sync that tells the truth: changes wait in a queue on the phone (saved with the item), go up when there's
  // signal, retry with back-off, and the server merges two phones' edits instead of overwriting.
  let syncFails = 0, retryTimer = null;
  const toRemote = (r) => ({
    id: r.id, name: r.name, drawer: r.drawer, quantity: Number(r.quantity) || 0, sku: r.sku || '', category: r.category || '',
    notes: r.notes || '', createdAt: r.createdAt || r.updatedAt || Date.now(), updatedAt: r.updatedAt || 0,
    lastPrintedAt: r.lastPrintedAt || null, deleted: !!r.deleted, dirty: false, syncedAt: Number(r.syncedAt) || 0, qtyBase: Number(r.quantity) || 0,
    ...(r.photoAt !== undefined ? { photoAt: Number(r.photoAt) || 0 } : {}),
  });
  function friendlySyncError(e) {
    const m = String(e && e.message || e);
    if (/wrong passphrase/.test(m)) return 'wrong passphrase — check Settings';
    if (/Unexpected token|JSON/i.test(m)) return 'the sync link didn’t answer with data — check the URL and that the Apps Script is deployed for “Anyone”';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'no connection to Google — will retry';
    return m;
  }
  async function syncNow() {
    if (!settings.syncUrl || syncing) return;
    if (!storeReady) { scheduleSync(300); return; }
    if (!navigator.onLine) { updateSyncUi(); return; }
    clearTimeout(retryTimer);
    syncing = true; updateSyncUi();
    const outgoing = items.filter((i) => i.dirty).map((i) => {
      const o = Object.assign({}, i); delete o.dirty; delete o.qtyBase; delete o.syncedAt;
      o.base = i.syncedAt || 0;                                              // the server version this edit started from
      o.qtyBase = i.syncedAt && typeof i.qtyBase === 'number' ? i.qtyBase : null; // quantity at that version (so changes add up)
      return o;
    });
    const firstSync = !syncState.cursor;
    const sent = new Map(outgoing.map((o) => [o.id, { updatedAt: o.updatedAt, quantity: o.quantity }]));
    try {
      const res = await fetch(settings.syncUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // keeps it a "simple" request (no CORS preflight)
        body: JSON.stringify({ key: settings.syncKey, action: 'sync', proto: 2, since: syncState.cursor || 0, items: outgoing }),
        redirect: 'follow',
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error === 'bad_key' ? 'wrong passphrase' : (data.error || 'server error'));
      if (typeof data.ai === 'boolean' && (data.ai !== aiState.ready || (data.aiProvider || '') !== (aiState.provider || ''))) setAiState({ ready: data.ai, provider: data.aiProvider || '', lastError: data.ai ? '' : 'no_ai_key' });
      const byId = new Map(items.map((i) => [i.id, i]));
      let fromOthers = 0;
      for (const r of data.items || []) {
        const remote = toRemote(r);
        const local = byId.get(r.id);
        const mine = sent.get(r.id);
        if (!local) { items.push(remote); byId.set(r.id, remote); if (!remote.deleted) fromOthers++; continue; }
        if (mine) {
          if (local.updatedAt === mine.updatedAt) {
            // Our change landed. Take the server's copy: it may include another phone's change merged in.
            const changed = remote.quantity !== local.quantity || remote.name !== local.name || remote.drawer !== local.drawer || remote.notes !== local.notes || remote.deleted !== local.deleted;
            Object.assign(local, remote);
            if (changed) fromOthers++;
          } else {
            // Edited again while we were sending: keep the new edit, rebased on the server's copy.
            const delta = local.quantity - mine.quantity;
            local.syncedAt = remote.syncedAt; local.qtyBase = remote.quantity;
            if (!isMixed(local)) local.quantity = Math.max(0, remote.quantity + delta);
          }
          continue;
        }
        if (local.dirty) {
          // Another phone changed it and we have an edit waiting: the server will merge when we send ours.
          continue;
        }
        if ((remote.syncedAt || 0) >= (local.syncedAt || 0) || remote.updatedAt >= local.updatedAt) {
          const changed = remote.updatedAt !== local.updatedAt || remote.quantity !== local.quantity || remote.deleted !== local.deleted;
          Object.assign(local, remote);
          if (changed && !isConfig(local)) fromOthers++;
        }
      }
      syncState.cursor = Math.max(0, (data.serverTime || Date.now()) - 2000); // small overlap; merges are idempotent
      syncState.lastOk = Date.now(); syncState.lastError = '';
      syncState.merged = Number(data.merged) || 0;
      syncFails = 0;
      persist('jim.items', items); saveSyncState(); render();
      syncPhotos();
      if (data.merged) { toast('Merged ' + data.merged + ' change' + (data.merged > 1 ? 's' : '') + ' with another phone’s edits'); log('sync', 'Merged ' + data.merged + ' change' + (data.merged > 1 ? 's' : '') + ' with another device'); }
      else if (fromOthers && !firstSync) toast(fromOthers + ' update' + (fromOthers > 1 ? 's' : '') + ' from another device');
    } catch (e) {
      syncFails++;
      syncState.lastError = friendlySyncError(e); saveSyncState();
      const wait = Math.min(60000, 2000 * Math.pow(2, syncFails - 1));   // 2s, 4s, 8s … up to a minute
      syncState.retryAt = Date.now() + wait;
      clearTimeout(retryTimer); retryTimer = setTimeout(syncNow, wait);
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
    else if (syncState.lastError) {
      text = pending && !/passphrase|sync link/.test(syncState.lastError) ? 'Retrying (' + pending + ')' : 'Sync error'; state = 'bad';
      const secs = Math.max(0, Math.round(((syncState.retryAt || 0) - Date.now()) / 1000));
      info = 'Couldn’t sync: ' + syncState.lastError + '. ' + (pending ? pending + ' change(s) are safe on this phone and will go up automatically' + (secs ? ' (next try in ' + secs + 's)' : '') + '.' : 'Will try again shortly.');
    }
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
      : printQueue.length ? printQueue.length + ' label' + (printQueue.length > 1 ? 's are' : ' is') + ' waiting for the printer — tap to review'
      : 'What came in today?';
    $('greetSub').classList.toggle('tappable', !!printQueue.length);
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
    if (!$('list')) return;
    const q = $('filter').value.trim();
    let list = live();
    if (q) {
      const nq = normalize(q);
      const hits = new Set(findItems(q).map((i) => i.id));
      list = list.filter((i) => hits.has(i.id) || i.drawer.toLowerCase().includes(q.toLowerCase()) || normalize(i.drawer) === nq);
    }
    const byDrawer = (a, b) => a.drawer.localeCompare(b.drawer, undefined, { numeric: true }) || a.name.localeCompare(b.name);
    const sorters = {
      drawer: byDrawer,
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }),
      newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      qty: (a, b) => (isMixed(b) ? -1 : b.quantity) - (isMixed(a) ? -1 : a.quantity) || byDrawer(a, b),
    };
    const sorter = sorters[settings.sortBy] || byDrawer;
    list.sort((a, b) => (settings.starFirst !== false ? (isFav(b) - isFav(a)) : 0) || sorter(a, b));
    $('sortLabel').textContent = 'Sorted by ' + ({ drawer: 'drawer', name: 'name', newest: 'newest', qty: 'quantity' }[settings.sortBy] || 'drawer') + (settings.starFirst !== false && favs.size ? ' · starred first' : '');
    renderDrawers();
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
    battery: '<rect x="2" y="7" width="17" height="10" rx="2"/><path d="M22 11v2"/><path d="M6 10v4M10 10v4"/>',
    tape: '<circle cx="11" cy="12" r="8"/><circle cx="11" cy="12" r="3"/><path d="M19 12h3"/>',
    drop: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    plug: '<path d="M9 2v5M15 2v5"/><path d="M6 7h12v4a6 6 0 0 1-12 0z"/><path d="M12 17v5"/>',
    nut: '<path d="M12 2l8.5 5v10L12 22l-8.5-5V7z"/><circle cx="12" cy="12" r="3.5"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    book: '<path d="M4 4.5A2.5 2.5 0 0 1 6.5 2H20v17H6.5A2.5 2.5 0 0 0 4 21.5z"/><path d="M4 21.5V4.5"/><path d="M8 7h8"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>',
    can: '<rect x="6" y="6" width="12" height="16" rx="2"/><path d="M9 6V3h6v3"/><path d="M6 12h12"/>',
    box: '<path d="M21 8l-9-5-9 5v8l9 5 9-5z"/><path d="M3 8l9 5 9-5"/><path d="M12 13v8"/>',
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

  // ---- category look: a color + icon per kind of item (from the category, else the name)
  const KINDS = [
    { re: /\bbatter|\baaa?\b|\b9v\b|\blithium|\bcr\d|coin cell/, icon: 'battery', color: '#e08a00' },
    { re: /\btapes?\b|kapton|\bduct\b|masking|gaffer/, icon: 'tape', color: '#7c4dff' },
    { re: /adhesive|\bepox|\bglue|\brtv\b|sealant|loctite|\bweld|silicone/, icon: 'drop', color: '#d6336c' },
    { re: /\bcables?\b|\busb|\bhdmi|\bcords?\b|charger|adapter|ethernet|lightning/, icon: 'plug', color: '#0aa2c0' },
    { re: /hardware|\bbolts?\b|\bnuts?\b|\bscrews?\b|washers?\b|\brivets?\b|fastener|cotter|standoff/, icon: 'nut', color: '#5b6b80' },
    { re: /electric|\bfuses?\b|\bswitch|\brelays?\b|\bbulbs?\b|\bleds?\b|\bwires?\b/, icon: 'zap', color: '#d4a106' },
    { re: /\bmanuals?\b|\bbooks?\b|\bguides?\b|binder|\blogbook|\bdocs?\b|document/, icon: 'book', color: '#0a74c2' },
    { re: /wrench|\btools?\b|driver|pliers?\b|\bsockets?\b|ratchet|hammer|\bdrills?\b/, icon: 'wrench', color: '#c12026' },
    { re: /\boils?\b|\bfluids?\b|grease|lubric|\bfuel|cleaner|\bspray/, icon: 'can', color: '#2f9e44' },
  ];
  function kindOf(it) {
    const cat = String(it.category || '').toLowerCase(), nm = String(it.name || '').toLowerCase();
    return KINDS.find((k) => k.re.test(cat)) || KINDS.find((k) => k.re.test(nm)) || { icon: 'box', color: '#003469' };
  }
  function drawerColor(drawer) {
    const d = cfgFor(drawer);
    return d && d.category && !isGeneral(d) ? kindOf({ category: d.category }).color : '#4a5a70';
  }

  // ---- favorites (stars) are kept per phone
  let favs = new Set(LS.get('jim.favs', []));
  const isFav = (it) => (favs.has(it.id) ? 1 : 0);
  function toggleFav(it) {
    if (favs.has(it.id)) favs.delete(it.id); else favs.add(it.id);
    LS.set('jim.favs', [...favs]); render();
  }

  function itemCard(it) {
    const card = el('div', 'item');
    const k = kindOf(it);
    const av = el('div', 'avatar'); av.style.background = k.color;
    if (photoUrl.has(it.id)) { av.classList.add('photo'); av.style.backgroundImage = 'url("' + photoUrl.get(it.id) + '")'; }
    else av.appendChild(icon(k.icon, 22));
    card.appendChild(av);

    const main = el('div', 'item-main');
    main.appendChild(el('div', 'name', it.name));
    const q = el('div', 'qline');
    if (isMixed(it)) q.append(document.createTextNode('Mixed drawer · '), el('b', null, String(getContents(it).length)), document.createTextNode(getContents(it).length === 1 ? ' part' : ' parts'));
    else {
      q.append(document.createTextNode('Qty '), el('b', null, String(it.quantity)));
      q.appendChild(el('i', null, '  ·  Added ' + new Date(it.createdAt || Date.now()).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })));
    }
    main.appendChild(q);
    const chips = el('div', 'chips');
    const dc = el('span', 'tag drawer'); dc.style.background = drawerColor(it.drawer); dc.append(icon('drawer', 12), document.createTextNode(it.drawer));
    chips.appendChild(dc);
    if (isMixed(it)) chips.appendChild(el('span', 'tag mixed', 'Mixed'));
    if (it.category && !(cfgFor(it.drawer) && cfgFor(it.drawer).category === it.category && isMixed(it))) chips.appendChild(el('span', 'tag soft', it.category));
    if (it.sku && !isMixed(it)) chips.appendChild(el('span', 'tag soft', it.sku));
    main.appendChild(chips);
    card.appendChild(main);

    const star = el('button', 'star' + (favs.has(it.id) ? ' on' : ''));
    star.setAttribute('aria-label', favs.has(it.id) ? 'Unstar' : 'Star');
    star.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="' + (favs.has(it.id) ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg>';
    star.onclick = (e) => { e.stopPropagation(); toggleFav(it); };
    card.appendChild(star);

    if (isMixed(it)) {
      const parts = getContents(it);
      const box = el('div', 'parts');
      parts.slice(0, 10).forEach((p) => box.appendChild(el('span', 'part', p)));
      if (parts.length > 10) box.appendChild(el('span', 'part more', '+' + (parts.length - 10) + ' more'));
      if (!parts.length) box.appendChild(el('span', 'part more', 'No parts listed yet'));
      card.appendChild(box);
    }
    card.addEventListener('click', () => (isMixed(it) ? focusItem(it, true) : openItem(it)));
    return card;
  }

  // ---- Drawers tab
  /** Every drawer name: the configured ones plus any drawer an item mentions. Sorted naturally (Drawer 2 before Drawer 10). */
  function allDrawerNames() {
    const names = drawerCfg().map((d) => d.name);
    for (const i of live()) if (i.drawer && !names.some((n) => n.toLowerCase() === i.drawer.toLowerCase())) names.push(i.drawer);
    return names.sort((x, y) => x.localeCompare(y, undefined, { numeric: true }));
  }
  const drawerShort = (name) => (String(name).match(/[A-Z]?-?\d+[A-Z]?$/i) || [String(name).slice(0, 2)])[0].toUpperCase();
  function drawerSummary(name) {
    const d = cfgFor(name) || { name, category: '', mode: 'tracked' };
    const inside = drawerItems(name);
    const mixedBox = inside.find(isMixed);
    const tracked = inside.filter((i) => !isMixed(i));
    const parts = mixedBox ? getContents(mixedBox).length : 0;
    const units = tracked.reduce((s2, i) => s2 + i.quantity, 0);
    const bits = [];
    if (d.mode === 'mixed' || mixedBox) bits.push('Mixed · ' + parts + (parts === 1 ? ' part' : ' parts'));
    if (tracked.length) bits.push(tracked.length + ' item' + (tracked.length > 1 ? 's' : '') + ' · ' + units + ' unit' + (units === 1 ? '' : 's'));
    return { d, inside, tracked, mixedBox, labels: tracked.length + parts, text: bits.join(' · ') || 'Empty', empty: !inside.length };
  }
  let mapHighlight = '';   // search text highlighted on the map
  function mapCols() { const n = +cfgData().mapCols; return n >= 1 && n <= 8 ? n : 3; }

  function renderDrawers() {
    const root = $('drawerList');
    if (!root) return;
    root.textContent = '';
    const view = settings.drawerView === 'list' ? 'list' : 'map';
    document.querySelectorAll('#drawerViewSeg button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $('mapTools').hidden = view !== 'map';
    root.className = view === 'map' ? 'dmap' : 'list';
    const names = allDrawerNames();
    if (view === 'map') {
      root.style.gridTemplateColumns = 'repeat(' + mapCols() + ', minmax(0, 1fr))';
      $('mapColsVal').textContent = mapCols();
      const q = mapHighlight.trim();
      let hitDrawers = null;
      if (q) {
        hitDrawers = new Set();
        const hits = findItems(q);
        (hits.length ? hits : fuzzyCandidates(q, 0.6).map((c) => c.it)).forEach((i) => hitDrawers.add(i.drawer.toLowerCase()));
        names.forEach((n) => { if (n.toLowerCase().includes(q.toLowerCase())) hitDrawers.add(n.toLowerCase()); });
        $('mapHint').textContent = hitDrawers.size ? '“' + q + '” is in ' + names.filter((n) => hitDrawers.has(n.toLowerCase())).join(', ') : 'No drawer has “' + q + '”.';
      } else $('mapHint').textContent = 'Tap a drawer to see what’s inside.';
      for (const name of names) {
        const S = drawerSummary(name);
        const t = el('button', 'tile' + (S.empty ? ' empty' : '') + (hitDrawers ? (hitDrawers.has(name.toLowerCase()) ? ' hit' : ' dim') : ''));
        t.type = 'button';
        t.style.setProperty('--c', drawerColor(name));
        t.dataset.drawer = name;
        t.appendChild(el('span', 'tnum', drawerShort(name)));
        t.appendChild(el('span', 'tcat', S.d.category || (S.empty ? 'Empty' : name)));
        t.appendChild(el('span', 'tcount', S.empty ? '—' : S.mixedBox && !S.tracked.length ? S.labels + (S.labels === 1 ? ' part' : ' parts') : S.tracked.length + (S.tracked.length === 1 ? ' item' : ' items') + (S.mixedBox ? ' + mix' : '')));
        t.onclick = () => openDrawerSheet(name);
        root.appendChild(t);
      }
      return;
    }
    root.style.gridTemplateColumns = '';
    for (const name of names) {
      const S = drawerSummary(name), d = S.d;
      const card = el('div', 'dcard');
      const num = el('div', 'dnum', drawerShort(name));
      num.style.background = drawerColor(name);
      const mid = el('div');
      mid.appendChild(el('div', 'dname', name + (d.category ? ' · ' + d.category : '')));
      mid.appendChild(el('div', 'dsub', S.text));
      const acts = el('div', 'dacts');
      if (S.labels) {
        const pa = el('button', 'btn sm'); pa.append(icon('print', 14), document.createTextNode('All ' + S.labels));
        pa.title = 'Print every label in this drawer';
        pa.onclick = (e) => { e.stopPropagation(); printDrawerAll(name); };
        acts.appendChild(pa);
      }
      const lb = el('button', 'btn sm'); lb.append(icon('print', 14), document.createTextNode('Label'));
      lb.onclick = (e) => { e.stopPropagation(); printOrQueueDrawer(d); };
      acts.appendChild(lb);
      card.append(num, mid, acts);
      card.style.cursor = 'pointer';
      card.onclick = () => focusDrawer(name);
      root.appendChild(card);
    }
  }

  /** Drawer sheet (from the map): what's inside, plus batch print. */
  function openDrawerSheet(name) {
    const S = drawerSummary(name), d = S.d;
    $('dsTitle').textContent = name + (d.category ? ' · ' + d.category : '');
    $('dsSub').textContent = S.text;
    const box = $('dsList'); box.textContent = '';
    if (S.empty) box.appendChild(el('div', 'kv', 'Nothing in this drawer yet.'));
    for (const it of S.inside) {
      if (isMixed(it)) {
        for (const part of getContents(it)) { const r = el('div', 'qrow'); r.appendChild(el('div', 'qtxt', part)); r.lastChild.appendChild(el('small', null, 'mixed')); box.appendChild(r); }
        continue;
      }
      const r = el('div', 'qrow');
      const t = el('div', 'qtxt', it.name); t.appendChild(el('small', null, '×' + it.quantity));
      if (photoUrl.has(it.id)) { const th = el('img', 'ds-thumb'); th.src = photoUrl.get(it.id); th.alt = ''; r.appendChild(th); }
      const b = el('button', null, '›'); b.type = 'button'; b.style.color = 'var(--muted)'; b.setAttribute('aria-label', 'Open ' + it.name);
      r.onclick = () => { $('drawerSheet').close(); openItem(it); };
      r.append(t, b); box.appendChild(r);
    }
    const pa = $('dsPrintAll');
    pa.hidden = !S.labels; pa.textContent = 'Print all ' + S.labels + ' label' + (S.labels === 1 ? '' : 's');
    pa.onclick = () => { $('drawerSheet').close(); printDrawerAll(name); };
    $('dsDrawerLabel').onclick = () => { $('drawerSheet').close(); printOrQueueDrawer(d); };
    $('dsShow').onclick = () => { $('drawerSheet').close(); switchTab('items'); focusDrawer(name); };
    $('drawerSheet').showModal();
  }
  function showOnMap(text) {
    mapHighlight = text || '';
    settings.drawerView = 'map'; saveSettings();
    if ($('mapSearch')) $('mapSearch').value = mapHighlight;
    switchTab('drawers'); renderDrawers();
  }


  // ---- tabs
  let currentTab = 'items';
  function switchTab(name) {
    currentTab = name;
    document.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== name; });
    const tabs = [...document.querySelectorAll('.tab')];
    tabs.forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
    const idx = tabs.findIndex((t) => t.dataset.tab === name);
    $('tabInk').style.transform = 'translateX(' + (idx * 100) + '%) translateX(' + (idx * 36) + 'px)';
    $('addBtn').hidden = name === 'activity';
    if (name === 'activity') { activityAll = true; renderActivity(); }
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => switchTab(t.dataset.tab); });

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
    persist('jim.activity', activity);
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
    if (!activity.length) {
      $('activitySummary').textContent = 'Nothing yet. Stock, use or print something and it shows up here.';
      $('activityList').textContent = ''; $('activityMore').hidden = true; return;
    }
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const today = activity.filter((a) => a.t >= start.getTime());
    const c = (type) => today.filter((a) => a.type === type).length;
    const bits = [[c('stock'), 'stocked'], [c('use'), 'used'], [c('remove'), 'removed'], [c('print'), 'printed']].filter((b) => b[0]).map((b) => b[0] + ' ' + b[1]);
    $('activitySummary').textContent = today.length ? 'Today: ' + bits.join(' · ') : 'Nothing yet today.';
    const root = $('activityList');
    root.textContent = '';
    for (const a of activity.slice(0, activityAll ? 60 : 5)) {
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
  let editingOrigName = '';
  function openItem(it, fixName) {
    editing = it || null;
    editingOrigName = it ? it.name : '';
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
    $('quickBar').hidden = !it || isMixed(it);
    if (it && !isMixed(it)) $('qVal').textContent = it.quantity;
    updateItemPreview();
    showItemPhoto(it && !isMixed(it) ? it : null);
    $('itemDlg').showModal();
    if (!it || fixName) setTimeout(() => { f.name.focus(); if (fixName) f.name.select(); }, 60);
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
      const renamed = editingOrigName && normalize(editingOrigName) !== normalize(target.name);
      if (renamed) {
        learnAlias(editingOrigName, target.name);
        log('edit', 'Renamed “' + editingOrigName + '” → ' + target.name);
        answer('Saved as ' + target.name + '. Next time I hear “' + editingOrigName + '”, I’ll know you mean ' + target.name + '.', 'Got it. ' + target.name + '.');
        if (action !== 'saveprint' && target.lastPrintedAt) {
          if (printer.connected) printItem(target, 1, true);
          else { queuePrint(target.id); toast('New label will print when the printer connects'); }
        }
      } else {
        log('edit', 'Edited ' + target.name);
        toast('Saved');
      }
    } else if ((cfgFor(v.drawer) || {}).mode === 'mixed') {
      stockIn(v.name, v.drawer, 1);
      return;
    } else {
      target = addItem(Object.assign({}, v, { quantity: v.quantity || 1 })).item;
      log('stock', 'Stocked ' + target.name + ' → ' + target.drawer);
      const t2 = target;
      answer('Added ' + t2.name + ' in ' + t2.drawer.toUpperCase() + '.', false, [{ label: '📷 Add photo', run: () => pickPhoto(t2) }]);
    }
    if (action === 'saveprint') printItem(target);
  });
  $('itemDelete').onclick = () => {
    if (editing) { const it = editing; $('itemDlg').close(); removeWithUndo(it); }
  };
  $('itemImage').onclick = () => shareLabelImage(formItem());
  const qStep = (d) => {
    const it = editing; if (!it) return;
    if (it.quantity + d <= 0) { $('itemDlg').close(); removeWithUndo(it); return; }
    setQuantity(it, it.quantity + d);
    $('qVal').textContent = it.quantity; $('itemForm').quantity.value = it.quantity; updateItemPreview();
  };
  $('qMinus').onclick = () => qStep(-1);
  $('qPlus').onclick = () => qStep(1);
  $('qPrint').onclick = () => { if (editing) printItem(editing); };
  $('qLocate').onclick = () => { const it = editing; if (it) { $('itemDlg').close(); focusItem(it); } };

  // sort sheet + search + drawers tab buttons
  $('sortBtn').onclick = () => {
    const f = $('sortForm');
    [...f.sortBy].forEach((r) => { r.checked = r.value === (settings.sortBy || 'drawer'); });
    f.starFirst.checked = settings.starFirst !== false;
    $('sortDlg').showModal();
  };
  $('sortForm').addEventListener('change', () => {
    const f = $('sortForm');
    settings.sortBy = ([...f.sortBy].find((r) => r.checked) || {}).value || 'drawer';
    settings.starFirst = f.starFirst.checked;
    saveSettings(); render();
  });
  $('searchBtn').onclick = () => {
    switchTab('items');
    const box = $('searchBox');
    window.scrollTo({ top: Math.max(0, box.getBoundingClientRect().top + window.scrollY - 140), behavior: 'smooth' });
    setTimeout(() => $('filter').focus(), 250);
  };
  $('editDrawersBtn').onclick = openDrawers;

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
  $('greetSub').onclick = () => { if (printQueue.length) openPrinter(); };
  $('cancelQueue').onclick = () => {
    const n = printQueue.length;
    cancelQueued('all'); toast('Canceled ' + n + ' waiting label' + (n === 1 ? '' : 's'));
  };

  // settings dialog
  function openSettings() {
    const f = $('settingsForm');
    f.userName.value = settings.userName || '';
    f.syncUrl.value = settings.syncUrl; f.syncKey.value = settings.syncKey;
    f.speakAnswers.checked = !!settings.speakAnswers; f.autoPrint.checked = !!settings.autoPrint; f.askDrawer.checked = !!settings.askDrawer;
    f.qrOnLabels.checked = settings.qrOnLabels !== false;
    fillVoiceList();
    f.aiEnabled.checked = settings.aiEnabled !== false;
    updateAiUi();
    f.voiceRate.value = settings.voiceRate || 1;
    updateSyncUi(); renderBackups();
    $('settingsDlg').showModal();
  }
  async function renderBackups() {
    const box = $('backupList'); if (!box) return;
    const idb = await Store.available();
    let usage = '';
    try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); usage = ' · ' + Math.max(1, Math.round((e.usage || 0) / 1024)) + ' KB used'; } } catch (e) { /* */ }
    let persisted = false;
    try { persisted = !!(navigator.storage && navigator.storage.persisted && await navigator.storage.persisted()); } catch (e) { /* */ }
    $('storeInfo').textContent = idb
      ? 'Saved in this phone’s database (IndexedDB)' + (persisted ? ', protected from automatic clean-up' : '') + usage + '. A snapshot is taken every few hours; the last ' + BACKUP_KEEP + ' are kept.'
      : 'This browser has no database storage, so the app is using basic storage (about 5 MB). Use Export backup now and then.';
    box.textContent = '';
    const list = idb ? await Store.backups() : [];
    box.hidden = !list.length;
    for (const b of list) {
      const r = el('div', 'qrow');
      const t = el('div', 'qtxt', new Date(b.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }));
      t.appendChild(el('small', null, b.count + ' items' + (b.reason && b.reason !== 'auto' ? ' · ' + b.reason : '')));
      const go = el('button', 'btn sm', 'Restore'); go.type = 'button'; go.style.cssText = 'width:auto;color:var(--ink);font-size:13px';
      go.onclick = () => {
        if (!go.dataset.armed) { go.dataset.armed = '1'; go.textContent = 'Tap again'; go.style.color = 'var(--bad)'; setTimeout(() => { if (go.isConnected) { delete go.dataset.armed; go.textContent = 'Restore'; go.style.color = 'var(--ink)'; } }, 4000); return; }
        restoreBackup(b.at);
      };
      r.append(t, go); box.appendChild(r);
    }
  }
  $('backupNowBtn').onclick = async () => { await autoBackup(true, 'manual'); renderBackups(); toast('Backup saved on this phone'); };
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
    settings.voiceName = f.voiceName.value; settings.voiceRate = +f.voiceRate.value || 1;
    settings.aiEnabled = f.aiEnabled.checked;
    if (newUrl !== (settings._lastAiUrl || '')) { settings._lastAiUrl = newUrl; setAiState({ ready: null, lastError: '' }); }
    saveSettings(); persist('jim.items', items);
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
  document.querySelectorAll('#drawerViewSeg button').forEach((b) => { b.onclick = () => { settings.drawerView = b.dataset.view; saveSettings(); renderDrawers(); }; });
  $('mapSearch').addEventListener('input', (e) => { mapHighlight = e.target.value; renderDrawers(); });
  const setCols = (n) => { n = Math.max(1, Math.min(8, n)); if (n !== mapCols()) { writeCfg(Object.assign(cfgData(), { drawers: drawerCfg() , mapCols: n })); } renderDrawers(); };
  $('mapColsMinus').onclick = () => setCols(mapCols() - 1);
  $('mapColsPlus').onclick = () => setCols(mapCols() + 1);
  $('dsClose').onclick = () => $('drawerSheet').close();
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

  function fillVoiceList() {
    const sel = $('settingsForm').voiceName;
    const list = englishVoices();
    sel.textContent = '';
    const auto = document.createElement('option');
    auto.value = ''; auto.textContent = list.length ? 'Automatic (' + list[0].name + ')' : 'Phone default';
    sel.appendChild(auto);
    for (const v of list) {
      const o = document.createElement('option');
      o.value = v.name;
      o.textContent = v.name + (v.lang && !/^en[-_]us/i.test(v.lang) ? ' · ' + v.lang.replace('_', '-') : '');
      sel.appendChild(o);
    }
    sel.value = list.some((v) => v.name === settings.voiceName) ? settings.voiceName : '';
  }
  if ('speechSynthesis' in window) speechSynthesis.addEventListener && speechSynthesis.addEventListener('voiceschanged', () => { if ($('settingsDlg').open) fillVoiceList(); });
  $('voiceTest').onclick = () => {
    const f = $('settingsForm');
    const keep = { voiceName: settings.voiceName, voiceRate: settings.voiceRate };
    settings.voiceName = f.voiceName.value; settings.voiceRate = +f.voiceRate.value || 1;
    const nm = (f.userName.value || '').trim();
    speak((nm ? 'Hi ' + nm + '. ' : 'Hi. ') + 'Put AA batteries in Drawer 1. Printing label.', true);
    Object.assign(settings, keep);
  };

  // ---- appearance: Automatic follows the phone; Light/Dark override it (applied instantly, saved per phone)
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const dark = t === 'dark' || (t !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
    document.querySelectorAll('meta[name=theme-color]').forEach((m) => { m.setAttribute('content', dark ? '#04172e' : '#002a55'); m.removeAttribute('media'); });
    document.querySelectorAll('#themeSeg button').forEach((b) => b.classList.toggle('on', b.dataset.themeOpt === (t || 'auto')));
  }
  document.querySelectorAll('#themeSeg button').forEach((b) => {
    b.onclick = () => { settings.theme = b.dataset.themeOpt; saveSettings(); applyTheme(settings.theme); };
  });
  applyTheme(settings.theme);

  $('activityMore').onclick = () => { activityAll = !activityAll; renderActivity(); };

  // main controls
  $('micBtn').onclick = () => { if (handsFree) return setHandsFree(false); startListening(); };
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

  if (!SR && !NB.SpeechRecognition) $('voiceHint').textContent = 'Tap the mic, then the 🎤 on your keyboard. Say an item name — I’ll pick the drawer and print the label.';
  setInterval(renderGreeting, 60000);

  window.addEventListener('online', () => scheduleSync(200));
  window.addEventListener('offline', updateSyncUi);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync(200); });
  setInterval(() => { if (!document.hidden) syncNow(); }, 45000);

  if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => { /* optional */ });
  }

  // test hooks (harmless in production)
  window.JimApp = { setPhoto, removePhoto, syncPhotos, photoUrl, compressPhoto, cancelQueued, printDrawerAll, findScored, nameSim, fuzzyCandidates, soundKey, NATIVE, applyAlias, getAliases, runCommand, findItems, renderLabel, renderDrawerLabel, printItem, connectPrinter, syncNow, handleLink, drawerCfg, saveDrawerCfg, itemLink,
    get items() { return items; }, get activity() { return activity; }, printer, settings };

  switchTab('items');
  render(); updatePrinterUi(); updateSyncUi(); checkHash();
  // Storage start-up: pick up a newer IndexedDB copy, then allow sync and backups.
  (async () => {
    try {
      const newer = await loadNewer('jim.items', items);
      if (newer) items = newer;
      const act = await loadNewer('jim.activity', activity);
      if (act) activity = act;
    } catch (e) { /* fall back to what localStorage had */ }
    try { await loadPhotos(); } catch (e) { /* */ }
    storeReady = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* */ }
    try { const bl = await Store.backups(); lastBackupAt = bl.length ? bl[0].at : 0; } catch (e) { /* */ }
    autoBackup();
    render(); renderActivity(); updateSyncUi(); scheduleSync(300);
  })();
})();
