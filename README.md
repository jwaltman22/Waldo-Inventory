# Waldo Supply — iPhone / Android / PC (web version)

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

## What's new in v18

- **"Did you mean…?"** Waldo no longer gives up on one misheard word. Close names are matched
  ("jetson nana" → Jetson Nano, "capton tape" → Kapton tape). If it's sure, it just goes ("I think you meant…");
  if not, it asks with buttons, and you can answer out loud ("yes", "no", "the second one").
  Your pick is remembered. Part numbers must match exactly, so AN4 is never swapped for AN3.
  Stocking something that's almost the name of an existing item asks "Is it the same as…?" first.
- **Real storage + automatic backups:** inventory now lives in the phone's database (IndexedDB), not the
  5 MB browser scratch space. A snapshot is saved every few hours (the last 14 are kept).
  ⚙︎ Settings → *Storage & automatic backups* → **Restore** (tap twice) or **Back up now**.
- **Sync that doesn't lie:** changes wait safely on the phone, retry on their own (2 s, 4 s, 8 s… up to a minute),
  and the status says exactly what's going on ("Retrying (2)"). If two phones change the same item before syncing,
  the **changes are combined** instead of one overwriting the other: Jim adds 3 while JW uses 1 → +2.
  Mixed-drawer part lists and learned names are combined too. **Needs the new Code.gs** (see below).
- **Batch printing:** "print all the labels for drawer 3" (or the **All** button on a drawer) queues every label in that
  drawer, one after another, with a **Cancel these** button.
- **Drawer map:** Drawers tab → **Map** shows the cabinet as a grid of colored tiles. Type in *Find on the map* to light up
  where something is; tap a tile for what's inside, **Print all**, or the drawer label. Set the number of columns
  to match the real cabinet (saved for every phone). Answers have an **On map** button too.
- **Hands-free:** tap **Hands-free** (or say/type "hands free") and keep talking, item after item, without touching
  the screen. Waldo listens again after each answer. Say **"stop"** or **"that's all"** to end it; it also pauses after
  90 seconds of quiet. Works in Chrome (Android/PC) and the native app. Bluefy has no speech recognition, so there it
  explains and you keep using the keyboard 🎤.

**Updating the Apps Script for v18:** open the Sheet → Extensions → Apps Script → replace everything with the new
`sync/Code.gs` → Save → **Deploy → Manage deployments → ✏︎ Edit → Version: New version → Deploy**. The URL stays the same,
and the passphrase and Gemini key stay where they are (Script Properties). Phones on the old app keep working.

## What's new in v17

- **Native iPhone & Android apps:** the `native/` folder wraps this same app with Capacitor, so it
  can run as a real app with the phone's own Bluetooth (no Bluefy), speech recognition and voice.
  Android builds automatically on GitHub; iPhone builds on Codemagic and installs through TestFlight.
  Full steps: `native/README-native.md`. The website keeps working exactly as before.

## What's new in v16

- **Appearance:** ⚙︎ Settings → Appearance → **Automatic** (follows the phone), **Light** or **Dark**.
  The change is instant and remembered on that phone.

## What's new in v15

- **Cancel waiting labels:** when labels are waiting for the printer, tap the orange
  "labels are waiting — tap to review" line (or the Printer status at the top). The printer screen
  lists each waiting label with a ✕ to cancel it, plus **Cancel all prints**. You can also just say
  "cancel all the prints".

## What's new in v14

- **Smarter understanding with Gemini (optional):** Waldo sends what you said to Google Gemini
  (through your Apps Script, so the key stays private) and gets back a clean command. It handles
  loose phrasing like "toss two of those blue zip ties in with the cables" and answers questions
  like "what batteries do we have?". Answers that came from the AI are marked **Waldo · AI**.
  No signal, no key, or Gemini down: Waldo quietly falls back to its built-in rules.
- **Secrets moved out of the script:** the sync passphrase and Gemini key now live in Apps Script →
  Project Settings → Script Properties (`SYNC_KEY`, `GEMINI_API_KEY`), so `Code.gs` has no secrets in it.
- Settings → **AI understanding** shows whether Gemini is connected, with an on/off switch.

## What's new in v13

- **Understands natural speech better:** "I just got in a new Jetson three", "we just received two
  new Jetson Nanos", "okay so I've got 3 new HDMI cables" now save just the item name (and the
  quantity), instead of the whole sentence.
- **Fix name:** if Waldo gets a name wrong, tap **Fix name** under its answer, correct it, and save.
  The label reprints and Waldo remembers: next time it hears the wrong version, it uses the right
  name. These corrections sync to every phone.

## What's new in v12

- **New look:** WaldoAir navy app bar with scan, sort, search and settings icons, and printer + sync
  status under the title. Three tabs: **Items**, **Drawers**, **Activity**. Red round **+** button.
- **Item rows:** a color-coded round icon for each kind of item (batteries, tape, adhesives, cables,
  hardware, tools, manuals…), bold quantity, colored drawer chip, and a ⭐ to pin favorites to the top.
- **Tap an item** to open its sheet with quick **− / +**, **Print** and **Locate** buttons.
- **Sort** by drawer, name, newest or quantity (with starred items on top).
- **Drawers tab:** every drawer with its category and what's in it; tap one to list it, or print its label.

## What's new in v11

- **Choose Waldo's voice:** ⚙︎ Settings → Voice lists the phone's English voices (best ones first),
  with a speed slider and a ▶︎ Play sample button. For the most natural sound, download a
  Premium voice on the iPhone (Settings → Accessibility → Spoken Content → Voices → English →
  Ava or Zoe), then pick it here.

## What's new in v10

- **Drawers & categories** (⚙︎ Settings → Drawers & categories): each drawer has a category and
  the words that send items there. "AA batteries" goes to the Batteries drawer, "epoxi" to
  Adhesives, and so on. Anything that doesn't match lands in the **General** drawer, and the app
  asks which category it is, then remembers the answer for next time.
- **Two drawer styles:** *Track each item* (every part counted separately) or *Mixed assortment*
  (one list of what's in the drawer, such as bolts, nuts and washers, with no counting).
- **Drawer-front labels:** big drawer name + category. Print one from the drawer setup screen,
  from a mixed drawer's card, or by voice: "print the label for drawer 5".
- **QR codes on every label.** Tap the scan icon in the message box and point the camera at a
  label (or take a photo) to pull that item or drawer up instantly. You can turn QR codes off in Settings.
- **Recent activity:** today's summary plus a timeline of what was stocked, used, removed and printed, and by whom.
- **Swipe actions:** swipe an item right to print its label, or left to remove it (with Undo).
- Labels now print one after another, in order, when several items are stocked quickly.

The drawer setup syncs through the Google Sheet like everything else (it's the row named
"Waldo Supply drawer setup"; leave that row alone). No change to the Apps Script is needed.

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

1. Create a new Google Sheet — name it *Waldo Supply*.
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
3. In Waldo Supply tap **Printer** (top) → **Connect** → pick **M2_H-1721050135**.
4. The dialog should say **Model: M2_H · 300 dpi · head 567 px · task B1**.
5. Choose the **label size** that matches the roll (the size is printed on the roll box —
   e.g. 50 × 30 mm) → **Test print**. Adjust **Darkness** if it's faint.

To go back to the NIIMBOT app later, tap **Disconnect** first.

## Using it

Tap **Speak** and talk, or type in the box — same thing.

| Say | What happens |
|---|---|
| “NIIMBOT product manual” (just the name) | New item → picks a drawer and prints the label. Already stocked → tells you where it is |
| “just got in a WAC-47 lens” | **Picks the drawer for you**, says it out loud (“Put WAC-47 lens in Drawer 4”) and prints the label |
| “just got in a WAC-47 lens, drawer 3” | Uses the drawer you said, prints the label |
| “add 4 of M5 bolts in bin 7” | Quantity 4, Bin 7 |
| “where is the WAC-47 lens” | Says the drawer out loud |
| “how many M5 bolts do I have” | Count + location |
| “used up 2 of the M5 bolts” | Takes 2 off |
| “remove the torque wrench” | Deletes it |
| “print a label for the M5 bolts” | Reprints |
| “what’s in drawer 3” / “show everything” | Lists |

**How it picks the drawer:** if that item is already stocked, it goes in the same drawer
(the quantity goes up). Otherwise it uses the lowest-numbered empty drawer. Don't like
the pick? Said something by mistake? Tap **Undo**. Tap **Use a different drawer** under the answer, change it, and tap **Save + print**.
To have it ask every time instead, turn on ⚙︎ Settings → *Let me pick the drawer*.

**Printer off or out of range?** The item still saves, and the label waits. The Printer
button shows *(1 waiting)*, and the label prints on its own as soon as the printer connects.

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
qr.js                 QR code maker (qrcode-generator, MIT) + reader (jsQR, Apache-2.0)
niimbluelib.js        NIIMBOT protocol (niimbluelib 0.47.0, MIT) bundled for the browser
sync/Code.gs          Google Apps Script backend (paste into the Sheet)
sw.js                 offline cache — bump VERSION when you upload changes
tests/                parser unit tests + end-to-end test (fake M2-H + real Code.gs)
```

- Printing uses **niimbluelib**, the open-source library behind niim.blue, which
  lists the M2-H as model 4608, 300 dpi, 567 px printhead, `B1` print task. The app
  reads the model from the printer at connect, and falls back to the Bluetooth name
  (`M2_H-…`) if that read fails.
- Sync: each push says which server version it started from; concurrent edits are merged (quantities by delta,
  part lists and aliases by union, other fields newest-wins). Deletes are kept as `deleted = TRUE` rows so they sync.
- Run tests: `node --test tests/parser.test.js`, `node tests/e2e.mjs` and `node tests/v18.mjs`
  (needs Playwright + `http-server`). The end-to-end test simulates an M2-H over
  fake Web Bluetooth and two phones syncing through the real `Code.gs`.
- **Not yet proven on the real printer.** Run one test print on Jim's M2-H before
  relying on it (step 4 above).
- niimbluelib is MIT-licensed and isn't affiliated with NIIMBOT. Its author asks
  that it not be used commercially without the vendor's consent, so keep this as
  an internal shop tool.
