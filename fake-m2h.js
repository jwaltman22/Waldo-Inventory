// Injected into the page before load: a fake Web Bluetooth stack with a simulated NIIMBOT M2-H.
// Speaks the 55 55 … AA AA protocol, answers like real B1-task firmware, and records what it was asked to print.
(() => {
  const hex = (s) => new Uint8Array(s.trim().split(/\s+/).map((b) => parseInt(b, 16)));
  const log = (window.__m2h = { packets: [], pageSize: null, rows: 0, density: null, labelType: null, printed: 0, connected: false });

  const frame = (cmd, data) => {
    const d = Array.from(data); let chk = cmd ^ d.length; d.forEach((b) => (chk ^= b));
    return new Uint8Array([0x55, 0x55, cmd, d.length, ...d, chk, 0xaa, 0xaa]);
  };
  const DUMP = {
    0xa5: [0xb5, hex('30 30 03 20 00 c8 00 00 00 0f 01 02 04 01 98 00')],
    0x1a: [0x1b, hex('88 1d 7e 4f d9 97 00 00 08 31 30 32 36 32 32 36 30 10 50 5a 31 47 32 32 31 33 32 32 30 30 34 32 30 35 01 14 00 99 01')],
  };
  const INFO = { 0x08: [0x12, 0x00] /* model 4608 = M2_H */, 0x0b: Array.from(new TextEncoder().encode('M2H1721050135')),
    0x0d: [0x27, 0x03, 0x07, 0x17, 0x6e, 0x82], 0x0a: [0x04], 0x07: [0x01], 0x03: [0x01], 0x0c: [0x05, 0x0a], 0x09: [0x05, 0x16] };
  const SIMPLE = { 0x21: 0x31, 0x23: 0x33, 0x01: 0x02, 0x03: 0x04, 0x13: 0x14, 0xe3: 0xe4, 0xf3: 0xf4 };

  let notify = null, pages = 0, statusPolls = 0;
  function respond(cmd, data) {
    log.packets.push(cmd);
    let out = null;
    if (cmd === 0xc1) out = frame(0xc2, [0x03]);
    else if (cmd === 0x40) out = INFO[data[0]] ? frame(0x40 + data[0], INFO[data[0]]) : frame(0x00, [0x01]);
    else if (DUMP[cmd]) out = frame(DUMP[cmd][0], DUMP[cmd][1]);
    else if (cmd === 0xdc) out = data[0] === 3 ? frame(0xde, hex('05 0a 05 16 01 80 02 02 01 00')) : frame(0xd9, hex('20 41 04 4d 00 00 01 00 00'));
    else if (cmd === 0x84 || cmd === 0x85 || cmd === 0x83) { log.rows += 1; return; }
    else if (SIMPLE[cmd] !== undefined) {
      if (cmd === 0x21) log.density = data[0];
      if (cmd === 0x23) log.labelType = data[0];
      if (cmd === 0x01) { pages = (data[0] << 8) | data[1]; statusPolls = 0; log.totalPages = pages; }
      if (cmd === 0x13) log.pageSize = { rows: (data[0] << 8) | data[1], cols: (data[2] << 8) | data[3], copies: data.length >= 6 ? data[5] : 1 };
      if (cmd === 0xf3) log.printed += 1;
      out = frame(SIMPLE[cmd], [0x01]);
    } else if (cmd === 0xa3) {
      statusPolls++;
      const done = statusPolls >= 3 ? pages : 0; // page counter moves after a few polls, like the real thing
      out = frame(0xb3, [0, done, 100, statusPolls >= 3 ? 100 : 50]);
    } else out = frame(0x00, [0x01]);
    setTimeout(() => notify && notify(out), 5);
  }

  let buf = [];
  function feed(bytes) {
    buf.push(...bytes);
    for (;;) {
      const i = buf.findIndex((b, k) => b === 0x55 && buf[k + 1] === 0x55);
      if (i < 0) { buf = []; return; }
      if (buf.length < i + 4) return;
      const len = buf[i + 3], end = i + 4 + len + 3;
      if (buf.length < end) return;
      const cmd = buf[i + 2], data = buf.slice(i + 4, i + 4 + len);
      buf = buf.slice(end);
      respond(cmd, data);
    }
  }

  const listeners = {};
  const characteristic = {
    uuid: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f',
    properties: { notify: true, writeWithoutResponse: true, write: true },
    value: null,
    addEventListener: (t, f) => (listeners[t] = f),
    startNotifications: async () => { notify = (bytes) => { characteristic.value = new DataView(bytes.buffer); listeners.characteristicvaluechanged && listeners.characteristicvaluechanged({ target: characteristic }); }; return characteristic; },
    writeValueWithoutResponse: async (ab) => feed(Array.from(new Uint8Array(ab))),
    writeValue: async (ab) => feed(Array.from(new Uint8Array(ab))),
  };
  const devListeners = {};
  const device = {
    name: 'M2_H-1721050135', id: 'fake',
    addEventListener: (t, f) => (devListeners[t] = f), removeEventListener: () => {},
    gatt: {
      connected: false,
      connect: async () => { device.gatt.connected = true; log.connected = true; return device.gatt; },
      disconnect: () => { device.gatt.connected = false; log.connected = false; devListeners.gattserverdisconnected && devListeners.gattserverdisconnected(); },
      getPrimaryServices: async () => [{ uuid: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', getCharacteristics: async () => [characteristic] }],
    },
  };
  Object.defineProperty(navigator, 'bluetooth', { value: {
    getAvailability: async () => true,
    requestDevice: async (opts) => { log.requestOptions = opts; return device; },
  } });
})();
