# Download Assistant

A small, tabbed desktop app for **acquiring specimen images from GBIF** (and,
later, other sources) with full **Darwin Core** metadata — organized on disk and
indexed in SQLite. Dark "90s hacker terminal" theme. Built on Electron.

It is the GBIF download tool from **IRIS_Electron**, lifted out into a standalone
app: no projects, no accounts — just pick a folder and start pulling images.

---

## How it works

- **Metadata** comes from GBIF's open JSON API (`api.gbif.org`).
- **Image bytes** are pulled through a **browser `<webview>`**, not a server
  fetch. GBIF occurrence images are hosted by the *publishing institution*, and
  those hosts bot-block server-side requests — so a hidden webview that shares
  your live browse session (cookies + Cloudflare clearance) navigates to the
  image URL and reads the bytes with a same-origin fetch. Attachment-style
  images (`Content-Disposition: attachment`) are captured silently in the main
  process. A host that rejects the Electron user-agent is retried once as plain
  Chrome.

## Save-location layout

Set a **parent_dir** in the header bar (type a full path — created if missing —
or use **BROWSE**). Everything lands under it:

```
{parent_dir}/
  images/   HERBCODE_gbifID_Family_Genus_specificEpithet.jpg
  dwc/      one subfolder per search: occurrence.csv, multimedia.csv, search_meta.json
  db/       images.db  — the SQLite index (one row per GBIF id)
```

### `db/images.db` — `images` table

| column | source |
| --- | --- |
| `gbif_id` (PK) | GBIF occurrence key |
| `herb_code` | derived (see below) |
| `dwc_order`, `family`, `genus`, `specific_epithet` | DwC taxonomy |
| `fullname` | `family_genus_specificEpithet` |
| `scientific_name` | `scientificName` |
| `latitude`, `longitude` | `decimalLatitude/Longitude` (if present) |
| `continent`, `country`, `state_province` | DwC locality (state/province if present) |
| `filename` | `herbCode_gbifID_family_genus_specificEpithet.jpg` |
| `img_x`, `img_y` | pixel width / height |
| `megapixels` | `img_x*img_y/1e6`, rounded to 2 dp |
| `occurrence_url`, `image_url`, `source`, `downloaded_at` | provenance |

### herbCode

`src/server/herb-code.js` is a faithful JS port of VoucherVision's
`validate_herb_code` + `generate_image_filename`
(`vouchervision/utils_GBIF.py`): probe `institutionCode → institutionID →
ownerInstitutionCode → collectionCode → publisher → occurrenceID`, prefer a
short (≤8 char) acronym, with the same institution special-cases and manual
overrides.

## Acquiring

- **ACQUIRE TARGET** — download the specimen currently open on GBIF. When you
  open a specimen page the status bar shows a `TARGET LOCKED ▸ <filename>`
  preview (and flags it if already in the index).
- **ACQUIRE SEARCH…** — enumerate the imaged occurrences in the current search
  and download **all** of them, or a **random subset** (default 20). Enumeration
  pages the GBIF API in parallel (no artificial cap); GBIF's offset search dies
  at deep offsets (~10k+ for heavy queries), so it stops adaptively at that wall
  and marks the result *capped* (narrow the search to reach the rest). Already-
  indexed ids are skipped before any download.
- **☆ BOOKMARK** — save the current GBIF search; the caret opens your saved
  searches. Bookmarks are **app-wide, keyed by domain** (stored in
  `userData/bookmarks.json`), so when more source tabs are added each site keeps
  its own list.

## Full download — every image + a DOI (past the offset wall)

The GBIF occurrence-search API can't page past ~10k–100k records, so **ACQUIRE
SEARCH**, when you're signed in, uses GBIF's **occurrence-download API** instead:

1. Your search is translated to a download **predicate** (the CoL-XR
   `checklistKey` is handled, so alphanumeric taxon keys resolve).
2. GBIF builds a **Darwin Core Archive** of *every* matching record (millions if
   need be) and assigns it a **DOI** — stored in a new `downloads` table.
3. The archive's real `occurrence.txt` / `multimedia.txt` land in `dwc/{slug}/`,
   and every `(gbifID → image URL)` is queued in a **resumable** `download_queue`.
4. Images download **tiered**: a headless full-res fetch first (works for most
   hosts — Symbiota, etc.), falling back to the webview only for hosts that
   bot-block. The queue survives app restarts and skips anything already saved.

The whole job runs in the background (poll → download → parse → images) with a
progress card, and resumes on relaunch via the stored download key.

### GBIF login (required for the full download)

The download API needs your GBIF account via **HTTP Basic auth** — a browser
login is **not** enough (GBIF's website token is rejected by `api.gbif.org`).
Copy `.env.example` to **`.env`** (gitignored, never committed) and set:

```
GBIF_USER=your_gbif_username   # your USERNAME, not your email
GBIF_PASS=your_gbif_password
GBIF_EMAIL=you@example.org
```

Without credentials, ACQUIRE SEARCH falls back to the quick (capped) offset path.

## Viewer tab

Browse everything under the current `parent_dir` without leaving the app:

- **DATABASE** — the `images.db` schema (a PRAGMA strip) plus its rows, each a
  collapsible JSON-tree item; free-text filter + pagination.
- **DWC FOLDERS** — pick a `dwc/{slug}/` folder and browse `occurrence.csv` /
  `multimedia.csv` rows as JSON-tree items.
- Selecting a row loads its image into the right-hand panel (a DB row by its
  filename; a DwC row by matching its `gbifID` to a downloaded image). Images are
  delivered as downsized data URLs over IPC (the CSP blocks external `file://`).

Tabs are deep-linkable: `index.html#viewer`, or launch with `DA_START_TAB=viewer`.

## Auto-update

Packaged builds check GitHub Releases on launch (electron-updater). When an
update is available a chip appears in the header: **DOWNLOAD** → progress →
**RESTART & INSTALL**. The updater is a no-op in `npm start` (dev). Platform
reality:

| OS | auto-update unsigned? | first-launch friction unsigned |
| --- | --- | --- |
| **Windows** (NSIS) | ✅ yes (SHA-512 verified) | SmartScreen "Run anyway" |
| **Linux** (AppImage) | ✅ yes | none (must be `chmod +x`, run as the AppImage) |
| **macOS** (Squirrel.Mac) | ❌ **no** | "damaged/unidentified"; Sequoia+ has no right-click bypass |

**macOS auto-update requires a signed + notarized build** — non-negotiable. This
repo is wired for it (`hardenedRuntime`, `build-resources/entitlements.mac.plist`,
`notarize: true`); add the Apple secrets (below) to enable it.

## Run

```bash
npm install      # electron + better-sqlite3 + sharp (native, rebuilt for Electron)
npm start
```

`better-sqlite3` and `sharp` are native modules; `npm install`'s postinstall
runs `electron-builder install-app-deps` to rebuild them for Electron's ABI.

## Releasing (GitHub Actions → GitHub Releases)

`.github/workflows/release.yml` builds macOS (arm64+x64), Windows (x64) and Linux
(x64 AppImage) and uploads them — with the `electron-updater` metadata
(`latest*.yml` + blockmaps) — to a **draft** GitHub Release, publishing to
`Gene-Weaver/DownloadAssistant`.

```bash
# bump "version" in package.json first, then:
git tag v0.1.0
git push --tags          # → CI builds all 3 platforms into a DRAFT release
```

Then review the draft in the GitHub UI and **Publish release** — electron-updater
only sees published (non-draft) releases. A manual "Run workflow" builds without
publishing (for smoke-testing the packaging). Local one-offs: `npm run pack`
(unpacked `--dir`) or `npm run dist`.

### Code-signing secrets (repo → Settings → Secrets → Actions)

Nothing is required to ship unsigned Windows/Linux (which still auto-update). To
enable **macOS** signing + notarization (**required** for macOS auto-update):

| secret | purpose |
| --- | --- |
| `CSC_LINK` | base64 of your Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | the `.p12` password |
| `APPLE_ID` | Apple account email (notarization) |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password (not your account password) |
| `APPLE_TEAM_ID` | 10-char Team ID |

The same `CSC_LINK`/`CSC_KEY_PASSWORD` sign Windows if you later add a Windows
cert. Absent secrets → the build is unsigned but still succeeds.

## Layout

```
main.js / preload.js         Electron entry + IPC bridge (window.DA.api)
src/main/                    window, capture, settings, IPC handlers
src/server/                  framework-agnostic: gbif-api, herb-code, image, db,
                             paths, download-service (no electron imports)
src/renderer/                index.html + css/theme.css + js/{app,gbif,ui}.js
```

Adding a source later = a new tab button + a renderer module + (optionally) a
service; the save-location + DB + DwC plumbing is source-agnostic.
