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
const sharp = require('sharp');
const csv = require('./csv');
const db = require('./db');

const DWC_FILES = new Set(['occurrence.csv', 'multimedia.csv']);

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
    out.push({
      slug: e.name,
      hasOccurrence: fs.existsSync(path.join(dir, 'occurrence.csv')),
      hasMultimedia: fs.existsSync(path.join(dir, 'multimedia.csv')),
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

// Read + paginate + (substring) filter one DwC CSV within a slug folder.
function readDwcCsv(dwcRoot, slug, file, { limit = 100, offset = 0, search = '' } = {}) {
  const f = DWC_FILES.has(file) ? file : 'occurrence.csv';
  const lim = Math.min(Math.max(1, limit | 0), 500);
  const off = Math.max(0, offset | 0);
  const abs = path.join(dwcRoot, path.basename(String(slug)), f); // basename blocks ../
  if (!fs.existsSync(abs)) return { columns: [], rows: [], total: 0, limit: lim, offset: off };

  const parsed = csv.parseCsv(fs.readFileSync(abs, 'utf8'));
  let rows = parsed.rows;
  const term = String(search || '').trim().toLowerCase();
  if (term) rows = rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(term)));
  const total = rows.length;
  return { columns: parsed.columns, rows: rows.slice(off, off + lim), total, limit: lim, offset: off };
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
