# TabFiler

A Firefox extension for people who keep too many tabs open. TabFiler reads each
page's title and files it into the right bookmark folder automatically — so you can
close tabs without losing anything.

Your bookmarks are saved as normal Firefox bookmarks under
**Bookmarks Menu → TabFiler → [category]**. Everything runs locally; nothing is sent
anywhere.

## How it works

Keywords in a tab's title decide the folder. When several categories match, the one
**higher in your priority list wins** — so an *Android security* page goes to
**Android**, not Security. Default folders:

| Priority | Folder |
|----------|--------|
| 1 | Android |
| 2 | iOS |
| 3 | Kubernetes / Docker |
| 4 | Security |
| 5 | Mobile |
| 6 | Unknown (fallback) |

You can add folders, edit keywords, reorder priority, and test any title live from the
extension's settings.

## Features

- **Popup** — see the current tab's folder, why it was chosen, and bookmark it (or
  override the folder) in one click.
- **Review all tabs** — categorise and bookmark every open tab at once.
- **Filed** — a read-only overview of everything TabFiler has saved, grouped by folder
  with live counts; expand a folder and click any page to open it, or remove one that
  was filed by mistake (with undo). Renaming and reordering stay in Firefox's own
  bookmark manager.
- **Smart duplicates** — within TabFiler's own folders, a page with the same URL or
  same title on the same site is treated as a duplicate (skip / update / keep both,
  your choice). Copies that live in other folders — yours or another tool's — are
  ignored and never modified. A matching title on a *different* site is flagged, never
  silently merged.
- **Auto-file** — optionally bookmark pages on load, on tab close, or per-category.
- **Backup** — export/import your rules and settings as JSON.
- **Private by design** — no tracking, no servers, no data collection.

## Install

Download the latest signed `.xpi` from the
[Releases page](https://github.com/bensh/tabfiler/releases) and open it in Firefox.
Once installed, it updates itself automatically from future releases.

Requires Firefox 140+ (142+ on Android).

### Run from source (for development)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → select `manifest.json`

Temporary add-ons reset when Firefox restarts; this is for testing only.

## Privacy

TabFiler collects and transmits no data. It uses your tabs (to read titles) and
bookmarks (to save pages), both entirely on your own machine.

## Building & releasing

See [`README.dev.md`](README.dev.md) for the signing and self-hosted auto-update
workflow.

## Licence

Code is released under the [MIT Licence](LICENSE). Bundled fonts (Space Grotesk and
JetBrains Mono) are licensed under the SIL Open Font License; see
[`fonts/OFL.txt`](fonts/OFL.txt).

---

Made by [bensh](https://github.com/bensh).
