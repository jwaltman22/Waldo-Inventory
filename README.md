# Jim Inventory — iPhone / Android / PC (web version)

The same app as the Android build — speak to stock in, ask where something is,
print a NIIMBOT label — but it runs in a browser, so it works on **Jim's iPhone**,
Android phones and the office PC. All of them share one inventory through a
Google Sheet.

| Device | How Jim opens it | Prints straight to the M2-H? |
|---|---|---|
| **iPhone / iPad** | **Bluefy** browser (free, App Store) | ✅ yes |
| iPhone in Safari | Safari | ❌ — Apple blocks Bluetooth in Safari. Use **Label image** → print in the NIIMBOT app |
| Android | Chrome | ✅ yes |
| Windows / Mac PC | Chrome or Edge | ✅ yes |

Total setup time: about 15 minutes, once.

---

## 1. Put the app online (5 min, free)

The app is a folder of plain files. It needs an `https://` address (browsers only
allow Bluetooth on secure pages). Either option below works.

**GitHub Pages**

1. On github.com: **New repository** → name it `jim-inventory` → **Public** → Create.
   (Free accounts can only publish Pages from public repos. The code is public, but
   the inventory isn't: it lives on the phones and in your Google Sheet.)
2. **Add file → Upload files** → drag in *everything inside* `JimInventory-Web`
   (so `index.html` sits at the top of the repo, not inside a subfolder) → Commit.
3. **Settings → Pages** → *Source:* **Deploy from a branch** → Branch **main**, folder **/ (root)** → Save.
4. After a minute or two the link appears at the top of that page:
   `https://YOUR-USERNAME.github.io/jim-inventory/`

To update later, upload the changed files again. Also bump `VERSION` in `sw.js`
so phones don't keep the old copy.

**Netlify (alternative)**

Go to **https://app.netlify.com/drop** and drag the `JimInventory-Web` folder onto
the page. You get a link like `https://jim-inventory-1234.netlify.app`.

## 2. Turn on sync with a Google Sheet (5 min, free)

This is what makes the iPhone, an Android phone and the PC all see the same inventory.

1. Create a new Google Sheet — name it *Jim Inventory*.
2. In the Sheet: **Extensions → Apps Script**. Delete what's there and paste in
   all of `sync/Code.gs`.
3. On the line `const SYNC_KEY = 'change-me-to-a-passphrase';` replace the text in
   quotes with a passphrase of your own (e.g. `waldo-hangar-2026`). Save (💾).
4. **Deploy → New deployment →** gear icon **→ Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - Click **Deploy**, approve the Google permission prompt
     (*Advanced → Go to project* if Google warns it's unverified — it's your own script).
5. Copy the **Web app URL** (ends in `/exec`).
6. In the app on each device: **⚙︎ Settings** → paste the URL + the passphrase → **Save**.
   The pill at the top turns green: **Synced**.

The *Inventory* tab of the Sheet now shows every item. You can fix a drawer or
quantity right in the Sheet and the phones pick it up. To delete from the Sheet,
set the `deleted` column to `TRUE` (don't delete the row).

> If you ever change `Code.gs`, use **Deploy → Manage deployments → Edit → New version**
> so the URL stays the same.

## 3. Jim's iPhone (3 min)

1. Install **Bluefy – Web BLE Browser** from the App Store (free).
2. Open your app link (GitHub Pages or Netlify) **in Bluefy** and bookmark it (share icon → *Add to Favorites*).
   Always open the app from Bluefy — a Safari home-screen icon won't have Bluetooth.
3. Allow **Bluetooth** when Bluefy asks.
4. **⚙︎ Settings** → paste the sync URL + passphrase → Save.

## 4. Connect the NIIMBOT M2-H

1. **Close the NIIMBOT app** on the phone (or disconnect the printer in it).
   The printer only talks to one app at a time.
2. Turn the M2-H on; load a genuine NIIMBOT roll (the printer refuses most third-party rolls).
3. In Jim Inventory tap **Printer** (top) → **Connect** → pick **M2_H-1721050135**.
4. The dialog should say **Model: M2_H · 300 dpi · head 567 px · task B1**.
5. Choose the **label size** that matches the roll (the size is printed on the roll box —
   e.g. 50 × 30 mm) → **Test print**. Adjust **Darkness** if it's faint.

To go back to the NIIMBOT app later, tap **Disconnect** first.

## Using it

Tap **Speak** and talk, or type in the box — same thing.

| Say | What happens |
|---|---|
| “just got in a WAC-47 lens, drawer 3” | Saves it, prints the label |
| “add 4 of M5 bolts in bin 7” | Quantity 4, Bin 7 |
| “add torque wrench” | Asks which drawer, suggests the next free one |
| “where is the WAC-47 lens” | Says the drawer out loud |
| “how many M5 bolts do I have” | Count + location |
| “used up 2 of the M5 bolts” | Takes 2 off |
| “remove the torque wrench” | Deletes it |
| “print a label for the M5 bolts” | Reprints |
| “what’s in drawer 3” / “show everything” | Lists |

Adding the same item to the same drawer again just bumps the quantity.

**Voice on iPhone:** if the big Speak button can't use the microphone in Bluefy, it
puts the cursor in the box — tap the **🎤 on the iPhone keyboard**, talk, then **Go**.
Spoken answers still work.

**No printer handy / in Safari:** open an item → **Label image** → *Save Image*
(or share to the NIIMBOT app) → print it from the NIIMBOT app as an image.

**Works offline.** Everything saves on the device; the pill shows *Offline* / *Pending*
and syncs on its own when there's signal again.

**Backup:** ⚙︎ Settings → *Export backup* saves a file of the whole inventory.

---

## For whoever maintains this

```
index.html            UI + styles
app.js                inventory, voice, label renderer, printer, sync
parser.js             voice/typed command parser (port of VoiceCommandParser.kt)
vendor/niimbluelib.js NIIMBOT protocol (niimbluelib 0.47.0, MIT) bundled for the browser
sync/Code.gs          Google Apps Script backend (paste into the Sheet)
sw.js                 offline cache — bump VERSION when you upload changes
tests/                parser unit tests + end-to-end test (fake M2-H + real Code.gs)
```

- Printing uses **niimbluelib**, the open-source library behind niim.blue, which
  lists the M2-H as model 4608, 300 dpi, 567 px printhead, `B1` print task. The app
  reads the model from the printer at connect, and falls back to the Bluetooth name
  (`M2_H-…`) if that read fails.
- Sync: newest edit wins per item; deletes are kept as `deleted = TRUE` rows so they sync.
- Run tests: `node --test tests/parser.test.js` and `node tests/e2e.mjs`
  (needs Playwright + `http-server`). The end-to-end test simulates an M2-H over
  fake Web Bluetooth and two phones syncing through the real `Code.gs`.
- **Not yet proven on the real printer.** Run one test print on Jim's M2-H before
  relying on it (step 4 above).
- niimbluelib is MIT-licensed and isn't affiliated with NIIMBOT. Its author asks
  that it not be used commercially without the vendor's consent, so keep this as
  an internal shop tool.
