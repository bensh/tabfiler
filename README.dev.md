# TabFiler — Firefox extension

Saves your open tabs into tidy bookmark folders, sorted by what each page is about.
Built from the wireframe spec: priority-based keyword categorisation with a popup,
all-tabs review, settings, a rules editor, onboarding, and undoable notifications.

## Load it in Firefox (temporary, for testing)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `manifest.json` inside the unzipped `tabfiler` folder
4. The onboarding tab opens on first install. The TabFiler icon appears in the toolbar.

To package for distribution, zip the *contents* of the folder (the included
`tabfiler-extension.zip` already does this) and submit to AMO, or run `web-ext build`.

> Requires Firefox 140+ (142+ on Android). Uses Manifest V2 (Firefox's stable
> extension format).

## Permanent install + auto-updates (self-hosted on GitHub)

Firefox won't permanently install an *unsigned* extension, so the file must be signed
by Mozilla once. After that it installs permanently in normal Firefox and updates
itself from your GitHub — no web host required.

**One-time setup**
1. Push this folder to a GitHub repo named `tabfiler` under your account.
2. Enable **GitHub Pages** for the repo (Settings → Pages → deploy from `main`).
   That makes `https://<user>.github.io/tabfiler/updates.json` reachable, which is the
   `update_url` already set in `manifest.json`.

**Each release** (the `release.sh` script automates steps 1–3):
1. `./release.sh 0.2.0` — bumps `manifest.json`, updates `updates.json`, builds a zip.
2. Upload that zip to <https://addons.mozilla.org/developers/> and choose
   **"On your own"** (unlisted). Mozilla signs it and gives you a `.xpi` back.
3. Rename the signed file to `tabfiler-<version>.xpi`.
4. Create a GitHub **release** tagged `v<version>` and attach the signed `.xpi`.
   (`updates.json` points at exactly this release-asset URL.)
5. Commit and push the updated `manifest.json` + `updates.json`.

Firefox checks `updates.json` periodically; when it lists a newer version than the
one installed, it downloads the signed `.xpi` from your GitHub release and updates
silently. To install the first time, download the signed `.xpi` from your release page
and open it in Firefox.

**Signing from the command line** (alternative to the AMO website):
```
web-ext sign --channel=unlisted \
  --api-key=<JWT issuer> --api-secret=<JWT secret> \
  --ignore-files release.sh updates.json
```
Get the keys from your AMO account under *Manage API Keys*.

> Note: `release.sh`, `updates.json`, and `README.md` are project files, not part of
> the extension — they're excluded from the signed package via `--ignore-files`.

## Preview the screens without installing

The UI degrades to a built-in demo mode when opened as a normal web page, so you can
browse every screen over a local server (ES modules need http, not file://):

```
cd tabfiler
python3 -m http.server 8000
```

Then visit:
- Popup &nbsp; `http://localhost:8000/popup/popup.html`
- Review &nbsp; `http://localhost:8000/options/options.html#review`
- Settings `http://localhost:8000/options/options.html#settings`
- Rules &nbsp; `http://localhost:8000/options/options.html#rules`
- Onboarding `http://localhost:8000/onboarding/onboarding.html`

In demo mode, bookmarking is simulated (no real bookmarks are written).

## How categorisation works

`lib/categorize.js` is the single source of truth. A title is matched against each
category's keywords; when several match, the category **higher in the priority list
wins**. Order ships as: Android → iOS → Kubernetes/Docker → Security → Mobile →
Unknown. "Match whole words only" is **on by default** — it avoids false hits like
*ios* inside *scenarios*, and still catches keywords glued to punctuation (e.g.
*docker:networking*, *objective-c*). Turning it off in Settings also catches keywords
glued to digits like *iOS18*, at the cost of occasional false matches. All six spec
examples are covered by the logic.

## File map

| Path | Role |
|---|---|
| `manifest.json` | Extension manifest (MV2) |
| `background.js` | Auto-file on page load / tab close, notifications, onboarding launch |
| `lib/categorize.js` | Pure categorisation engine (shared everywhere) |
| `lib/bookmarks.js` | Folder management + duplicate-aware filing (shared by popup & background) |
| `lib/store.js` | Settings + rules storage, with demo fallback |
| `lib/theme.css` | Design system (paper + ink, category colors, components) |
| `popup/` | Toolbar popup |
| `options/` | Settings + All-tabs review + Rules editor (hash-routed) |
| `onboarding/` | First-run flow |
| `icons/` | Toolbar / store icons |

## Notes & limitations

- Bookmarks are written under **Bookmarks Menu / TabFiler / [category]**. The root
  folder name is configurable in Settings.
- **Per-category auto-bookmark** (the popup toggle) is fully wired: a page auto-files
  if either the global on-load/on-close switch is on, *or* its category was opted in
  via the popup toggle. New categories you opt in are filed on tab close at minimum.
- **Duplicate handling** follows a match matrix (shared by manual and automatic
  filing, in `lib/bookmarks.js`):
  - **Same URL**, or **same title on the same site** → a real duplicate. Settings
    decides: *Skip* (leave it), *Update* (refresh the title and URL, move to the right
    folder), or *Allow* (keep both).
  - **Same title on a different site** → almost certainly a different page, so it's
    filed as new and marked “(possible duplicate)”. It is *never* merged, so an
    unrelated bookmark can't be silently overwritten.
  - **Generic titles** (Home, Login, Dashboard, New Tab, 404, Search, …) are excluded
    from title-only matching entirely. Titles are normalised first, so "(3) Dashboard"
    and "Networking…" match their plain forms.
  - **Both different** → a brand-new bookmark.
- **Backup (export / import)** lives at the bottom of Settings. Export downloads a
  small `tabfiler-backup-YYYY-MM-DD.json` with your folders, keywords, priority order,
  and settings. Import validates the file strictly (rejects malformed JSON, wrong
  format, newer versions; sanitises category names, IDs, colors, and keywords) before
  replacing your current rules and settings. Bookmarks are never touched by either
  operation — they live in Firefox, not the extension.
- **New folder** is an inline dialog in the popup (from the folder dropdown's
  "+ New folder…" or the Unknown-state button). It validates empty/duplicate names and
  selects the new folder immediately. New folders sit just above Unknown in priority,
  so they don't unexpectedly outrank your existing specific categories.
- **Fonts are bundled locally** (`fonts/`, latin subset, ~135 KB). Extension pages
  never call a CDN under normal use. If a bundled face fails to load, `font-loader.js`
  injects the Google Fonts CDN as a one-time fallback; the CSP permits exactly that
  origin for fonts and nothing else for scripts.

## Security

- All tab titles and URLs are HTML-escaped before display (verified against injected
  `<script>`/`<img onerror>` payloads — they render as inert text).
- Category names are escaped and category IDs are stripped to `[a-z0-9_-]` at every
  DOM sink, so an imported/synced rule set can't carry an XSS payload.
- Favicons only accept `http(s):` and `data:image/` URLs.
- Keyword regexes are escaped (no ReDoS); titles are clamped to 500 chars; the
  background script's tracking maps are size-capped so long sessions can't leak memory.
- A Content Security Policy locks scripts to the extension's own origin.
