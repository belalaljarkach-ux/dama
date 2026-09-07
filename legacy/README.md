# سجل بوابة المجبل — Local Setup

Local-environment build of the gate-log app (`gate-log_3.html`) and its Google
Apps Script backend (`Code_2.gs`).

## What was wrong

The original HTML calls `window.storage.get()` / `window.storage.set()`. That
object only exists inside the hosted sandbox the app was authored in. In a
normal browser it is `undefined`, and because every call sits inside a
`try/catch`, the failure is **silent**: the app opens, looks fine, accepts
input, and loses everything on refresh.

Separately, `Code_2.gs` is never referenced by the HTML. There is no `fetch`,
no URL, no wiring of any kind. The two files were never connected.

## Files

| File | Purpose |
|---|---|
| `index.html` | The original app + one injected `<script>` tag (line ~376) |
| `storage-adapter.js` | Supplies `window.storage`. Three backends. **This is the fix.** |
| `server.js` | Optional zero-dependency Node backend. Stores JSON + CSV on disk. |
| `Code.fixed.gs` | Corrected Apps Script (date coercion, `replaceAll`, locking, auth) |
| `Code.original.gs` | Your original, untouched, for diffing |
| `data/` | Where `server.js` writes `entries.json`, `entries.csv`, `backups/` |

## Option 1 — Zero install (recommended to start)

Double-click `index.html`. Data is saved in the browser's `localStorage`.

- No runtime to install. Works offline.
- Data is tied to **one browser on one machine**. Clearing site data wipes it.
- Back up by copying the whole folder is *not* enough — use the export snippet
  below, or move to Option 2.

Export from the browser console (F12) at any time:

```js
copy(localStorage.getItem('gate-log-entries'))
```

If the console prints a warning that `localStorage` is blocked, your browser is
refusing storage on `file://` URLs. Use Option 2, or open the folder through
any static web server.

## Option 2 — Local server (real files on disk)

Requires Node.js, which is **not currently installed on this machine**. Install it:

```bash
winget install OpenJS.NodeJS.LTS
```

Close and reopen the terminal, then:

```bash
node "C:\Users\bilal\Downloads\gate-log-local\server.js"
```

Open <http://localhost:8787/?backend=server>.

You now get:

- `data/entries.json` and `data/entries.csv` — real rows, openable in Excel
  (UTF-8 BOM is written so Arabic renders correctly)
- `data/backups/` — a snapshot taken before every write, last 40 kept
- Atomic writes, so a crash mid-save cannot truncate the file
- Other machines on the same LAN can use it via `http://<your-ip>:8787`

To make `server` the default so you don't need the query string, edit the
`GATE_LOG_CONFIG` block in `index.html` and set `backend: "server"`.

## Option 3 — Keep Google Sheets

Use `Code.fixed.gs`, not the original — see the header comment in that file for
why the original corrupts dates and times.

1. Open your Google Sheet → **Extensions → Apps Script**
2. Replace the contents with `Code.fixed.gs`
3. Set `SECRET` to a long random string
4. **Deploy → New deployment → Web app**, Execute as *Me*, Access *Anyone*
5. Copy the `/exec` URL into `GATE_LOG_CONFIG.gasUrl` in `index.html`, and set
   `backend: "gas"`

Note: `Access: Anyone` means anyone holding the URL can read and write your
gate log. The `SECRET` check is the only thing standing in front of it. Send it
by appending `&token=YOUR_SECRET` in the adapter's fetch calls if you enable it.

## Switching backends

```
index.html                     -> localStorage (default)
index.html?backend=server      -> Node server
index.html?backend=gas         -> Google Sheets
index.html?view=reports        -> read-only reports screen, auto-refresh 30s
```

`?view=reports` combines with the others: `?backend=server&view=reports` is the
screen to leave open on a wall display.

## Offline note

`index.html` line 8 imports the Cairo font from Google Fonts. Offline this
request fails and the app falls back to the system sans-serif. Everything still
works; it just looks different. To fix permanently, download the Cairo woff2
files into this folder and replace the `@import` with a local `@font-face`.
