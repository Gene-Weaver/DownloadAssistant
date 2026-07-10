/*
 * Viewer-tab data access: list Darwin Core folders, read their CSVs as objects,
 * and turn a stored image into a downsized data: URL for the preview panel.
 *
 * The CSP blocks the renderer from loading arbitrary file:// images, and img-src
 * allows data:, so images are delivered as (downsized) data URLs over IPC. sharp
 * is used here and in image.js only.
 *
 * All paths that incorporate a slug/filename from the DB or a CSV are reduced
 * with path.basename() and whitelisted so a read can't escape dwc/ or images/.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const sharp = require('sharp');
const csv = require('./csv');
const db = require('./db');

// Data files we let the Viewer open: our quick-path CSVs (comma, quoted) and
// GBIF's real download files (tab-delimited, unquoted, potentially huge).
const DWC_FILES = new Set(['occurrence.csv', 'multimedia.csv', 'occurrence.txt', 'multimedia.txt', 'verbatim.txt']);

// List the dwc/{slug}/ subfolders, newest first (by search_meta.generated_at).
function listDwc(dwcRoot) {
  let entries;
  try { entries = fs.readdirSync(dwcRoot, { withFileTypes: true }); }
  catch (_) { return []; } // dwc/ not created yet
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(dwcRoot, e.name);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'search_meta.json'), 'utf8')); }
    catch (_) { /* no manifest */ }
    const files = [...DWC_FILES].filter((f) => fs.existsSync(path.join(dir, f)));
    out.push({
      slug: e.name,
      files,
      hasOccurrence: files.includes('occurrence.csv') || files.includes('occurrence.txt'),
      hasMultimedia: files.includes('multimedia.csv') || files.includes('multimedia.txt'),
      meta,
    });
  }
  out.sort((a, b) => {
    const ta = (a.meta && a.meta.generated_at) || '';
    const tb = (b.meta && b.meta.generated_at) || '';
    if (ta && tb) return tb.localeCompare(ta);
    return a.slug.localeCompare(b.slug);
  });
  return out;
}

// Read + paginate + (substring) filter one DwC file within a slug folder.
// .csv (our quick path) is small + quote-aware → parse whole. .txt (GBIF's real
// download files) can be millions of rows → stream line-by-line, tab-split.
async function readDwcCsv(dwcRoot, slug, file, { limit = 100, offset = 0, search = '' } = {}) {
  const f = DWC_FILES.has(file) ? file : 'occurrence.csv';
  const lim = Math.min(Math.max(1, limit | 0), 500);
  const off = Math.max(0, offset | 0);
  const abs = path.join(dwcRoot, path.basename(String(slug)), f); // basename blocks ../
  if (!fs.existsSync(abs)) return { columns: [], rows: [], total: 0, limit: lim, offset: off };

  const term = String(search || '').trim().toLowerCase();
  if (f.endsWith('.txt')) return streamTsvPage(abs, { lim, off, term });

  const parsed = csv.parseCsv(fs.readFileSync(abs, 'utf8'));
  let rows = parsed.rows;
  if (term) rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(term)));
  return { columns: parsed.columns, rows: rows.slice(off, off + lim), total: rows.length, limit: lim, offset: off };
}

// Stream a (possibly huge) tab-delimited GBIF file: header from line 1, then
// count matches and collect only the requested page. GBIF files are unquoted, so
// split('\t') is safe.
function streamTsvPage(absPath, { lim, off, term }) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: fs.createReadStream(absPath, 'utf8'), crlfDelay: Infinity });
    let columns = null;
    let matched = 0;
    const rows = [];
    rl.on('line', (line) => {
      if (columns === null) { columns = line.split('\t'); return; }
      if (!line) return;
      if (term && !line.toLowerCase().includes(term)) return;
      if (matched >= off && rows.length < lim) {
        const cells = line.split('\t');
        const obj = {};
        for (let i = 0; i < columns.length; i++) obj[columns[i]] = cells[i] !== undefined ? cells[i] : '';
        rows.push(obj);
      }
      matched += 1;
    });
    rl.on('close', () => resolve({ columns: columns || [], rows, total: matched, limit: lim, offset: off }));
    rl.on('error', () => resolve({ columns: columns || [], rows, total: matched, limit: lim, offset: off }));
  });
}

// Decode an on-disk image, downsize to fit maxDim, return a JPEG data URL.
async function imageToDataUrl(absPath, maxDim = 1400) {
  if (!absPath || !fs.existsSync(absPath)) return null;
  try {
    const pipeline = sharp(absPath, { failOn: 'none' }).rotate();
    const meta = await pipeline.metadata();
    if (Math.max(meta.width || 0, meta.height || 0) > maxDim) {
      pipeline.resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true });
    }
    const out = await pipeline.jpeg({ quality: 82 }).toBuffer({ resolveWithObject: true });
    return {
      dataUrl: `data:image/jpeg;base64,${out.data.toString('base64')}`,
      width: out.info.width,
      height: out.info.height,
    };
  } catch (_) { return null; }
}

function imageByFilename(imagesDir, filename, maxDim = 1400) {
  if (!filename) return null;
  return imageToDataUrl(path.join(imagesDir, path.basename(String(filename))), maxDim);
}

async function imageByGbifId(dbFile, imagesDir, gbifId, maxDim = 1400) {
  const row = db.getRow(dbFile, gbifId);
  if (!row || !row.filename) return null; // not downloaded / no image on disk
  const r = await imageByFilename(imagesDir, row.filename, maxDim);
  return r ? { ...r, filename: row.filename } : null;
}

module.exports = { listDwc, readDwcCsv, imageToDataUrl, imageByFilename, imageByGbifId };
