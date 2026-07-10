/*
 * Save-location layout. Everything the app writes lives under a single
 * user-chosen parent_dir:
 *
 *   {parent_dir}/
 *     images/   the downloaded specimen JPGs
 *     dwc/      Darwin Core files (occurrence.csv / multimedia.csv) per search
 *     db/       images.db — the SQLite index (one row per GBIF id)
 *
 * Pure fs only (no electron), so the server layer stays portable.
 */

const fs = require('fs');
const path = require('path');

function resolvePaths(parentDir) {
  const root = path.resolve(String(parentDir));
  return {
    root,
    images: path.join(root, 'images'),
    dwc: path.join(root, 'dwc'),
    db: path.join(root, 'db'),
  };
}

// Create parent_dir and its images/ dwc/ db/ children if they don't exist.
// Entering a brand-new path in the header is the primary way a folder is made.
function ensurePaths(parentDir) {
  const p = resolvePaths(parentDir);
  for (const dir of [p.root, p.images, p.dwc, p.db]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

module.exports = { resolvePaths, ensurePaths };
