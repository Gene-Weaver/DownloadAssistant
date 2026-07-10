/*
 * GBIF metadata + Darwin Core.
 *
 * This module ONLY talks to GBIF's open JSON API (api.gbif.org), which is not
 * behind Cloudflare and never touches the publishing institution's image host.
 * The image BYTES are downloaded separately, through the browser webview (see
 * src/renderer/js/gbif.js) — GBIF occurrence images are hosted by the
 * institution, and those hosts bot-block server-side fetches.
 *
 * Responsibilities:
 *   - resolve an occurrence id from a URL / gallery link / bare id
 *   - fetch occurrence records (+ cache them) and flatten to display metadata
 *   - enumerate every imaged occurrence in a search (paginating the API)
 *   - write real Darwin Core files (occurrence.csv / multimedia.csv) for a search
 */

const fs = require('fs');
const path = require('path');
const {
  generateImageFilename,
  hasShortCodeWithoutPublisher,
} = require('./herb-code');

const GBIF_API = 'https://api.gbif.org/v1';
const OCC_WEB = 'https://www.gbif.org/occurrence';
const FETCH_TIMEOUT_MS = 30000;

const ENUM_PAGE = 300;            // GBIF's maximum page size
const ENUM_HARD_OFFSET = 100000; // GBIF rejects offset+limit beyond this (HTTP 400)
const ENUM_CONCURRENCY = 6;      // parallel page fetches (be polite to the API)
// GBIF occurrence search uses Elasticsearch offset paging, which is fast for
// shallow offsets (~1s) but falls off a cliff at deep ones (offset ~10k+ times
// out entirely). A short per-page timeout lets us detect that "wall" fast and
// stop, instead of hanging 30s and failing the whole enumeration.
const ENUM_PAGE_TIMEOUT_MS = 12000;

// gbif.org's CURRENT default taxonomy is Catalogue of Life XR, whose taxon keys
// are alphanumeric (e.g. taxonKey=4J2JZ = Pinus torreyana) — NOT the classic
// integer GBIF-backbone keys. The occurrence API only resolves those keys when
// told which checklist to use (checklistKey); without it the default backbone is
// queried and an alphanumeric key silently matches nothing (count 0). Carried
// over from IRIS_Electron's gbif-service.
const COL_XR_CHECKLIST = '7ddf754f-d193-4cc9-b351-99906754a03b';
const TAXON_KEY_PARAMS = new Set([
  'taxonKey', 'taxonKeys', 'acceptedTaxonKey', 'speciesKey', 'genusKey',
  'familyKey', 'orderKey', 'classKey', 'phylumKey', 'kingdomKey', 'subgenusKey',
]);

// --- caches ---------------------------------------------------------------
// Full occurrence records, keyed by id, so the same record isn't fetched twice
// across enumerate -> saveImport -> writeDwc. Bounded FIFO to cap memory on huge
// searches; anything evicted is simply re-fetched on demand.
const OCC = new Map();
const OCC_MAX = 20000;
function cacheOcc(id, rec) {
  id = String(id);
  if (OCC.has(id)) OCC.delete(id);
  OCC.set(id, rec);
  if (OCC.size > OCC_MAX) OCC.delete(OCC.keys().next().value);
}

// Publishing-organization titles, keyed by publishingOrgKey (used only as a
// herb-code fallback, so this is small and rarely hit).
const ORG = new Map();

// --- fetch helpers --------------------------------------------------------
async function fetchJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctl.signal });
    if (!res.ok) throw new Error(`GBIF request failed (${res.status}).`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Accept a bare id, a gbif.org/occurrence/{id} URL, or a search/gallery URL
// carrying entity=o_{id} (the gallery's "selected occurrence" param).
function parseOccurrenceId(ref) {
  if (ref == null) return null;
  const s = String(ref).trim();
  if (/^\d+$/.test(s)) return s;
  let m = s.match(/occurrence\/(\d+)/);
  if (m) return m[1];
  m = s.match(/[?&]entity=o_(\d+)/);
  if (m) return m[1];
  return null;
}

// Pick the best image media entry from a GBIF occurrence.
function pickImageUrl(occ) {
  const media = Array.isArray(occ.media) ? occ.media : [];
  const img = media.find((m) => m && m.identifier && /image/i.test(m.type || ''))
    || media.find((m) => m && m.identifier);
  return img ? img.identifier : null;
}

async function getOccurrenceRecord(id) {
  id = String(id);
  if (OCC.has(id)) return OCC.get(id);
  const occ = await fetchJson(`${GBIF_API}/occurrence/${id}`);
  cacheOcc(id, occ);
  return occ;
}

async function resolvePublisher(occ) {
  const key = occ && occ.publishingOrgKey;
  if (!key) return null;
  if (ORG.has(key)) return ORG.get(key);
  try {
    const org = await fetchJson(`${GBIF_API}/organization/${key}`);
    const title = org.title || null;
    ORG.set(key, title);
    return title;
  } catch (_) {
    ORG.set(key, null);
    return null;
  }
}

// Flatten an occurrence record to the fields the UI + DB care about. Resolves
// the publisher (for the herb-code fallback) only when no short acronym exists,
// unless the caller forces it.
async function buildMeta(occ, { resolvePublisher: doResolve = false } = {}) {
  const id = String(occ.key != null ? occ.key : (occ.gbifID != null ? occ.gbifID : ''));
  const needPublisher = doResolve && !hasShortCodeWithoutPublisher(occ);
  const publisher = needPublisher ? await resolvePublisher(occ) : null;

  const fn = generateImageFilename(occ, publisher);
  const imageUrl = pickImageUrl(occ);

  return {
    gbif_id: id,
    image_url: imageUrl,
    has_image: !!imageUrl,
    scientific_name: occ.scientificName || null,
    order: occ.order || null,
    family: occ.family || null,
    genus: occ.genus || null,
    specific_epithet: occ.specificEpithet || null,
    fullname: fn.fullname,
    herb_code: fn.herbCode,
    filename: fn.filenameJpg,
    latitude: occ.decimalLatitude != null ? occ.decimalLatitude : null,
    longitude: occ.decimalLongitude != null ? occ.decimalLongitude : null,
    continent: occ.continent || null,
    country: occ.country || null,
    state_province: occ.stateProvince || null,
    occurrence_url: `${OCC_WEB}/${id}`,
  };
}

// --- search enumeration ---------------------------------------------------

// Translate a gbif.org gallery/search URL into an api.gbif.org occurrence search
// URL: forward the filter params verbatim, drop UI-only ones, add the CoL-XR
// checklistKey when the taxon filter is one of its alphanumeric keys, force
// StillImage so only imaged records come back, and page.
function buildSearchApiUrl(searchUrl, { limit, offset }) {
  const web = new URL(searchUrl);
  const api = new URL(`${GBIF_API}/occurrence/search`);
  const DROP = new Set(['view', 'entity', 'offset', 'limit', 'dwca_extension']);
  let alphanumericTaxon = false;
  let hasChecklist = false;
  for (const [k, v] of web.searchParams) {
    if (DROP.has(k) || k.startsWith('_')) continue; // '_CfChlFTk' (Cloudflare) etc.
    if (k === 'checklistKey') hasChecklist = true;
    if (TAXON_KEY_PARAMS.has(k) && /[a-z]/i.test(v)) alphanumericTaxon = true;
    api.searchParams.append(k, v);
  }
  if (alphanumericTaxon && !hasChecklist) api.searchParams.set('checklistKey', COL_XR_CHECKLIST);
  api.searchParams.set('mediaType', 'StillImage'); // only records that have an image
  api.searchParams.set('limit', String(limit));
  api.searchParams.set('offset', String(offset));
  return api.toString();
}

// Flatten a page's occurrence records to compact rows (+ cache the full record
// for save/DwC reuse). Preview filename uses the page record; the authoritative
// name is recomputed at save time (publisher fallback skipped here for speed).
function flattenPage(results, out) {
  for (const occ of (results || [])) {
    const img = pickImageUrl(occ);
    if (!img) continue;
    const id = String(occ.key);
    cacheOcc(id, occ);
    const fn = generateImageFilename(occ, null);
    out.push({ gbif_id: id, image_url: img, scientific_name: occ.scientificName || null, fullname: fn.fullname, filename: fn.filenameJpg });
  }
}

/*
 * Enumerate every imaged occurrence matching the current GBIF search by
 * paginating the JSON API (not by scraping the gallery).
 *
 * Pages are fetched with a bounded PARALLEL worker pool. GBIF's offset paging
 * dies at deep offsets, so we detect that adaptively: when a page times out (or
 * errors), we treat its offset as the "wall", stop handing out deeper offsets,
 * keep the contiguous prefix below the wall, and mark the result `capped` (the
 * UI tells the user to narrow the search). This never hangs and never throws for
 * a large search — only a failure on the FIRST page (the count source) throws.
 *
 * Full records are cached so save/DwC reuse them. Returns { total, occurrences,
 * capped, slug, api_url }.
 */
async function enumerateSearch(searchUrl, { onProgress } = {}) {
  if (!/^https?:\/\//i.test(String(searchUrl || ''))) {
    throw new Error('Open a GBIF search (gallery) first.');
  }

  // Page 0 first — the authoritative count + first results. A failure here is a
  // real error (bad search / network), so let it throw.
  const page0 = await fetchJson(buildSearchApiUrl(searchUrl, { limit: ENUM_PAGE, offset: 0 }), ENUM_PAGE_TIMEOUT_MS);
  const total = page0.count || 0;
  const api_url = buildSearchApiUrl(searchUrl, { limit: ENUM_PAGE, offset: 0 });
  const slug = deriveSlug(searchUrl);

  const pages = new Map();           // offset -> results[] (successful pages)
  pages.set(0, page0.results || []);
  let found = (page0.results || []).length;
  if (onProgress) onProgress(found, total);

  // Remaining offsets, ascending, bounded by count and GBIF's hard offset cap.
  const lastOffset = Math.min(total, ENUM_HARD_OFFSET) - 1;
  const offsets = [];
  for (let off = ENUM_PAGE; off <= lastOffset; off += ENUM_PAGE) offsets.push(off);

  let wall = Infinity; // smallest offset that failed → deep-pagination wall
  let cursor = 0;

  const fetchPage = async (off) => {
    try { return await fetchJson(buildSearchApiUrl(searchUrl, { limit: ENUM_PAGE, offset: off }), ENUM_PAGE_TIMEOUT_MS); }
    catch (e) {
      // Retry once only for SHALLOW offsets (rides out a transient blip). A deep
      // failure is the pagination wall — don't burn a second timeout on it.
      if (off > 3000) throw e;
      return await fetchJson(buildSearchApiUrl(searchUrl, { limit: ENUM_PAGE, offset: off }), ENUM_PAGE_TIMEOUT_MS);
    }
  };

  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= offsets.length) break;
      const off = offsets[i];
      if (off >= wall) break; // already past a discovered wall
      let page;
      try { page = await fetchPage(off); }
      catch (_) { if (off < wall) wall = off; break; } // hit the wall — stop going deeper
      pages.set(off, page.results || []);
      found += (page.results || []).length;
      if (onProgress) onProgress(found, total);
    }
  };

  await Promise.all(Array.from({ length: Math.min(ENUM_CONCURRENCY, offsets.length) }, worker));

  // Assemble the CONTIGUOUS prefix (offsets below the wall), ascending.
  const out = [];
  const kept = [...pages.keys()].filter((o) => o < wall).sort((a, b) => a - b);
  for (const off of kept) flattenPage(pages.get(off), out);

  const enumerated = kept.length * ENUM_PAGE; // records we actually paged through
  const capped = (wall !== Infinity) || (total > enumerated);
  return { total, occurrences: out, capped, slug, api_url };
}

// --- Darwin Core file output ---------------------------------------------

function sanitizeSlug(s) {
  return String(s || 'search').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{2,}/g, '_').slice(0, 90) || 'search';
}

// Small non-crypto hash so re-running the same search reuses its folder while
// different searches don't collide (djb2 -> base36).
function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// A readable, stable folder name for a search: its query/taxon plus a short hash.
function deriveSlug(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const q = p.get('q');
    const taxon = p.get('taxonKey') || p.get('taxon_key');
    let base = q || (taxon ? `taxon_${taxon}` : (p.get('country') || 'search'));
    return sanitizeSlug(`${base}_${shortHash(url)}`);
  } catch (_) {
    return sanitizeSlug(`search_${shortHash(String(url))}`);
  }
}

function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Top-level scalar Darwin Core terms only (arrays/objects like media/gadm/facts
// are handled separately or omitted). Always includes a gbifID column.
function flatScalars(occ) {
  const o = { gbifID: String(occ.key != null ? occ.key : (occ.gbifID != null ? occ.gbifID : '')) };
  for (const [k, v] of Object.entries(occ)) {
    if (v == null || typeof v === 'object') continue;
    o[k] = v;
  }
  return o;
}

function writeCsv(file, columns, rows) {
  const lines = [columns.map(csvEscape).join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvEscape(row[c])).join(','));
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function writeOccurrenceCsv(file, records) {
  const flat = records.map(flatScalars);
  // Union of all keys across records; gbifID first, the rest alphabetical.
  const keys = new Set();
  for (const r of flat) for (const k of Object.keys(r)) keys.add(k);
  keys.delete('gbifID');
  const columns = ['gbifID', ...[...keys].sort()];
  writeCsv(file, columns, flat);
}

function writeMultimediaCsv(file, records) {
  const MM = ['gbifID', 'type', 'format', 'identifier', 'references', 'title', 'description', 'created', 'creator', 'contributor', 'publisher', 'license', 'rightsHolder'];
  const rows = [];
  for (const occ of records) {
    const gbifID = String(occ.key != null ? occ.key : (occ.gbifID != null ? occ.gbifID : ''));
    const media = Array.isArray(occ.media) ? occ.media : [];
    for (const m of media) {
      const row = { gbifID };
      for (const c of MM) if (c !== 'gbifID') row[c] = m[c];
      rows.push(row);
    }
  }
  writeCsv(file, MM, rows);
}

/*
 * Write the Darwin Core files for a search into {dwc}/{slug}/:
 *   occurrence.csv   full flat DwC terms, one row per occurrence
 *   multimedia.csv   one row per media item (image URLs etc.)
 *   search_meta.json a small manifest (source URL, API URL, counts, timestamp)
 *
 * `ids` are the occurrences actually selected for download; records come from
 * the cache (re-fetched if evicted). Returns { dir, count }.
 */
async function writeDwc(dwcRoot, slug, ids, searchMeta = {}) {
  const dir = path.join(dwcRoot, sanitizeSlug(slug));
  fs.mkdirSync(dir, { recursive: true });

  const records = [];
  for (const id of ids || []) {
    try { records.push(await getOccurrenceRecord(id)); } catch (_) { /* skip unresolved */ }
  }

  writeOccurrenceCsv(path.join(dir, 'occurrence.csv'), records);
  writeMultimediaCsv(path.join(dir, 'multimedia.csv'), records);
  fs.writeFileSync(
    path.join(dir, 'search_meta.json'),
    JSON.stringify(
      { slug: sanitizeSlug(slug), count: records.length, generated_at: new Date().toISOString(), ...searchMeta },
      null, 2
    )
  );
  return { dir, count: records.length };
}

module.exports = {
  parseOccurrenceId,
  pickImageUrl,
  getOccurrenceRecord,
  resolvePublisher,
  buildMeta,
  enumerateSearch,
  writeDwc,
  deriveSlug,
  _buildSearchApiUrl: buildSearchApiUrl, // test seam
};
