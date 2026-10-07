/*
 * Waldo Supply — voice/typed command parser (port of VoiceCommandParser.kt).
 *
 * Deliberately rule-based: in a loud shop, predictable beats clever.
 * Returns { type: 'add'|'find'|'count'|'print'|'remove'|'list'|'unknown', ... }.
 *
 * Fixes vs. the Android version:
 *  - quantity is read AFTER the verb is stripped, so "add 4 of M5 bolts" gives 4
 *  - spoken number words ("drawer three", "two of ...") become digits
 */
(function (root) {
  'use strict';

  const NUMBER_WORDS = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
    seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  };

  const LOCATION_WORDS = 'drawer|bin|shelf|cabinet|slot|box|tray|rack';
  const numWordRe = new RegExp('\\b(' + Object.keys(NUMBER_WORDS).join('|') + ')\\b', 'gi');

  // Only convert number words where they act as numbers: after a location word,
  // at the start of a quantity ("two of", "three x"), or after qty/x.
  function wordsToDigits(s) {
    const locRe = new RegExp('\\b(' + LOCATION_WORDS + ')\\s+(' + Object.keys(NUMBER_WORDS).join('|') + ')\\b', 'gi');
    s = s.replace(locRe, (m, loc, w) => loc + ' ' + NUMBER_WORDS[w.toLowerCase()]);
    s = s.replace(new RegExp('\\b(' + Object.keys(NUMBER_WORDS).join('|') + ')\\s+(of|x|pieces|pcs|units)\\b', 'gi'),
      (m, w, tail) => NUMBER_WORDS[w.toLowerCase()] + ' ' + tail);
    s = s.replace(new RegExp('\\b(qty|quantity|x)\\s+(' + Object.keys(NUMBER_WORDS).join('|') + ')\\b', 'gi'),
      (m, q, w) => q + ' ' + NUMBER_WORDS[w.toLowerCase()]);
    return s;
  }

  const drawerRe = new RegExp('(?:,\\s*)?\\b(?:in\\s+(?:the\\s+)?)?(' + LOCATION_WORDS + ')\\s*(?:number\\s+|#\\s*)?([a-z]-?\\d+|\\d+[a-z]?)\\b', 'i');
  const qtyPrefix = /^\s*(\d+)\s*(?:x\b|of\b|pieces? of\b|pcs of\b|units? of\b)?\s+/i;
  const qtySuffix = /[\s,]+(?:x\s*|qty\s*|quantity\s*)(\d+)\s*$/i;
  const qtySuffix2 = /[\s,]+(\d+)\s*(?:of them|pieces|pcs|units)\s*$/i;

  const VERBS = {
    find: ['where is', "where's", 'where are', 'where did i put', 'where do i keep', 'find', 'locate', 'look up', 'lookup', 'search for', 'get me', 'grab', 'pull'],
    count: ['how many', 'count'],
    print: ['reprint', 'print'],
    remove: ['remove', 'delete', 'take out', 'throw out', 'used up', 'used the last of', 'used the last'],
    list: ['list', 'show', "what's in", 'what is in', 'what do i have'],
    add: ['add', 'just got in', 'got in', 'just got', 'got', 'received', 'just received', 'new', 'stock', 'put away', 'put in', 'log', 'check in', 'checked in',
      'i got', 'we got', 'bought', 'picked up', 'have'],
  };
  const FILLER = ['a label for', 'labels for', 'label for', 'one more', 'another', 'more', 'a', 'an', 'the', 'some', 'my', 'our',
    'brand new', 'brand-new', 'new', 'a couple of', 'couple of', 'a few', 'few'];
  // Conversational lead-ins dropped before looking for the verb: "Okay so I just got in…", "We've also received…"
  const LEAD = /^(?:(?:ok(?:ay)?|hey|so|um+|uh+|well|alright|and|yeah|hi|waldo)[,\s]+)*(?:(?:i|we|i've|we've|ive|weve|i have|we have|i just|we just)\s+)?(?:just\s+|also\s+|finally\s+|now\s+|then\s+)*/i;
  const LEAD_NUM = new RegExp('^(' + Object.keys(NUMBER_WORDS).join('|') + ')\\s+(?=\\S)', 'i');
  const COUNT_TAIL = /\s+(?:do i have|do we have|are there|are left|have i got|in stock|on hand|left)\s*$/i;

  // Speech-to-text writes sound-alikes: "for" for 4, "to/too" for 2, "won" for 1, "ate" for 8 — and "four" for "for".
  // Fix them only where the meaning is clear from the words around them.
  const HOMO = { for: '4', fore: '4', four: '4', to: '2', too: '2', two: '2', won: '1', ate: '8' };
  const HOMO_RE = '(for|fore|to|too|won|ate)';
  const QTY_VERBS = "(?:just\\s+)?(?:add(?:ed)?|got in|got|have|received|stock(?:ed)?|put away|log(?:ged)?|check(?:ed)? in|bought|picked up|grabbed|used up|used|took out|take out|took|remove|need|ordered|returned)";
  const NOT_A_NOUN = '(?:the|a|an|my|our|your|this|that|these|those|it|them|me|you|us|drawer|bin|shelf|cabinet|slot|box|tray|rack|stock|inventory|work|go|be|do|see|use|print|find|put|get|take|make|have|order|replace|fix|check|keep|the\\b)';
  function fixHomophones(text) {
    let s = String(text || '');
    // "drawer for" → drawer 4, "bin to" → bin 2
    s = s.replace(new RegExp('\\b(' + LOCATION_WORDS + ')\\s+(?:number\\s+)?' + HOMO_RE + '\\b', 'gi'), (m, loc, w) => loc + ' ' + HOMO[w.toLowerCase()]);
    // "got in for AA batteries" → got in 4 AA batteries; "used up to of the bolts" → used up 2 of… (not "add to drawer 3", "got in to the shop")
    s = s.replace(new RegExp('^((?:[\\w\'’]+\\s+){0,4}?' + QTY_VERBS + ')\\s+' + HOMO_RE + '\\s+(?!' + NOT_A_NOUN + '\\b)(?=[a-z0-9])', 'i'),
      (m, verb, w) => verb + ' ' + HOMO[w.toLowerCase()] + ' ');
    // "for of the bolts", "to pieces" → numbers;  "qty for" / "x to" → numbers
    s = s.replace(new RegExp('\\b' + HOMO_RE + '\\s+(of|pieces|pcs|units|packs|boxes|rolls|pairs|sets)\\b', 'gi'), (m, w, tail) => HOMO[w.toLowerCase()] + ' ' + tail);
    s = s.replace(new RegExp('\\b(qty|quantity|times|x)\\s+' + HOMO_RE + '\\b', 'gi'), (m, q, w) => q + ' ' + HOMO[w.toLowerCase()]);
    // "four" that means "for": "a label four the bolts", "look four", "where's a cover four the pitot tube"
    s = s.replace(/\b(labels?|look|looking|search|searching|room|cover|covers|case|charger|adapter|parts?|kit)\s+four\b/gi, (m, a) => a + ' for');
    s = s.replace(/\bfour\s+(?=(?:the|a|an|my|our|this|that|these|those|it|them|drawer|bin)\b)/gi, (m) => (m[0] === 'F' ? 'For ' : 'for '));
    return s;
  }

  function startsWithWord(lower, p) {
    return lower === p || lower.startsWith(p + ' ') || lower.startsWith(p + ',');
  }

  function stripPrefixes(text, prefixes) {
    let out = text.trim();
    const sorted = prefixes.slice().sort((a, b) => b.length - a.length);
    let changed = true;
    while (changed && out) {
      changed = false;
      for (const p of sorted) {
        const low = out.toLowerCase();
        if (startsWithWord(low, p)) {
          out = out.slice(p.length).replace(/^[\s,]+/, '');
          changed = true;
        }
      }
    }
    return out.trim().replace(/[\s,]+$/, '');
  }

  function titleCase(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }

  function parse(rawInput) {
    const original = String(rawInput || '');
    let raw = original.trim().replace(/[.!?]+$/, '');
    if (!raw) return { type: 'unknown', raw: original };
    raw = wordsToDigits(fixHomophones(raw));
    // Strip "I just…" / "we've got…" etc. when what's left starts with a known command verb.
    const lead = raw.replace(LEAD, '');
    if (lead !== raw && lead && Object.values(VERBS).some((vs) => vs.some((p) => startsWithWord(lead.toLowerCase(), p)))) raw = lead;
    const lower = raw.toLowerCase();

    // --- drawer extraction ---
    let drawer = null;
    let working = raw;
    const dm = drawerRe.exec(raw);
    if (dm) {
      drawer = titleCase(dm[1]) + ' ' + dm[2].replace(/\s+/g, '').toUpperCase();
      working = (raw.slice(0, dm.index) + ' ' + raw.slice(dm.index + dm[0].length))
        .replace(/\s+/g, ' ').trim().replace(/^[,\s]+|[,\s]+$/g, '');
    }

    // --- intent by leading verb ---
    let type = null;
    for (const t of ['find', 'count', 'print', 'remove', 'list', 'add']) {
      if (VERBS[t].some((p) => startsWithWord(lower, p))) { type = t; break; }
    }

    let rest = type ? stripPrefixes(working, VERBS[type]) : working;
    if (type === 'add' || type === 'remove') rest = stripPrefixes(rest, ['a', 'an', 'some']).replace(LEAD_NUM, (m, w) => NUMBER_WORDS[w.toLowerCase()] + ' ');

    // --- quantity (after verb) ---
    let quantity = 1;
    let qtyFound = false;
    let m = qtyPrefix.exec(rest);
    if (m) { quantity = parseInt(m[1], 10) || 1; rest = rest.slice(m[0].length); qtyFound = true; }
    m = qtySuffix.exec(rest) || qtySuffix2.exec(rest);
    if (m) { quantity = parseInt(m[1], 10) || quantity; rest = rest.slice(0, m.index); qtyFound = true; }

    rest = stripPrefixes(rest, FILLER);
    if (type === 'count') rest = rest.replace(COUNT_TAIL, '').trim();
    rest = rest.replace(/[\s,]+$/, '');

    // "print all the labels for drawer 3", "print everything in drawer 3" -> every label in that drawer
    if (type === 'print' && drawer && /\b(all|everything|every|whole|each|entire)\b/i.test(working)) return { type: 'printAll', drawer, raw: original };

    switch (type) {
      case 'find': return { type, query: rest, raw: original };
      case 'count': return { type, query: rest, raw: original };
      case 'print': return { type, query: rest, drawer, raw: original };
      case 'remove': return { type, query: rest, quantity: qtyFound ? quantity : null, raw: original };
      case 'list': return { type, drawer, raw: original };
      case 'add': return { type, name: rest, drawer, quantity: Math.max(1, quantity), raw: original };
    }
    // No verb: "torque wrench, drawer 12" reads as stock-in.
    if (drawer && rest) return { type: 'add', name: rest, drawer, quantity: Math.max(1, quantity), raw: original };
    // Just an item name ("NIIMBOT product manual"): the app finds it if it's stocked, otherwise stocks it in.
    const bare = stripPrefixes(stripPrefixes(rest, ["here's", 'here is', 'this is', "it's", 'it is', 'i have', 'i got']), FILLER);
    if (/[a-z0-9]/i.test(bare)) return { type: 'bare', name: bare, quantity: Math.max(1, quantity), raw: original };
    return { type: 'unknown', raw: original };
  }

  /** lowercase, punctuation -> space, collapse (same as InventoryItem.normalize) */
  function normalize(s) {
    return String(s || '').toLowerCase().trim().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  const api = { parse, normalize, fixHomophones };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.JimParser = api;
})(typeof window !== 'undefined' ? window : globalThis);
