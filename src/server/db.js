/*
 * The image index — a SQLite database at {parent_dir}/db/images.db, one row per
 * GBIF occurrence id. Uses better-sqlite3 (synchronous, native; rebuilt for
 * Electron by install-app-deps).
 *
 * Connections are cached per db-file path: the user can re-point parent_dir at
 * runtime, and each location gets its own long-lived handle.
 */

const Database = require('better-sqlite3');

const conns = new Map(); // dbFile -> Database

const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  gbif_id          TEXT PRIMARY KEY,
  herb_code        TEXT,
  dwc_order        TEXT,             -- "order" is a SQL keyword; store as dwc_order
  family           TEXT,
  genus            TEXT,
  specific_epithet TEXT,
  fullname         TEXT,             -- family_genus_specificEpithet
  scientific_name  TEXT,
  latitude         REAL,             -- decimalLatitude, if present
  longitude        REAL,             -- decimalLongitude, if present
  continent        TEXT,
  country          TEXT,
  state_province   TEXT,             -- if present
  filename         TEXT,             -- herbCode_gbifID_family_genus_specificEpithet.jpg
  img_x            INTEGER,          -- pixel width
  img_y            INTEGER,          -- pixel height
  megapixels       REAL,             -- rounded to 2 dp
  occurrence_url   TEXT,
  image_url        TEXT,
  source           TEXT DEFAULT 'gbif',
  downloaded_at    TEXT              -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_images_fullname ON images(fullname);
CREATE INDEX IF NOT EXISTS idx_images_family   ON images(family);
`;

function open(dbFile) {
  if (conns.has(dbFile)) return conns.get(dbFile);
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  conns.set(dbFile, db);
  return db;
}

function hasImage(dbFile, gbifId) {
  const db = open(dbFile);
  const row = db.prepare('SELECT 1 FROM images WHERE gbif_id = ?').get(String(gbifId));
  return !!row;
}

// Set of gbif ids already in this index — used to flag/skip duplicates before
// downloading anything.
function listDownloadedIds(dbFile) {
  const db = open(dbFile);
  const rows = db.prepare('SELECT gbif_id FROM images').all();
  return new Set(rows.map((r) => String(r.gbif_id)));
}

const COLUMNS = [
  'gbif_id', 'herb_code', 'dwc_order', 'family', 'genus', 'specific_epithet',
  'fullname', 'scientific_name', 'latitude', 'longitude', 'continent', 'country',
  'state_province', 'filename', 'img_x', 'img_y', 'megapixels', 'occurrence_url',
  'image_url', 'source', 'downloaded_at',
];

function upsertImage(dbFile, row) {
  const db = open(dbFile);
  const placeholders = COLUMNS.map((c) => `@${c}`).join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO images (${COLUMNS.join(', ')}) VALUES (${placeholders})`
  );
  // Fill any missing keys with null so named params never throw.
  const filled = {};
  for (const c of COLUMNS) filled[c] = row[c] === undefined ? null : row[c];
  stmt.run(filled);
  return filled;
}

function count(dbFile) {
  const db = open(dbFile);
  return db.prepare('SELECT COUNT(*) AS n FROM images').get().n;
}

// --- Viewer read helpers ---------------------------------------------------

// The images-table column definitions (PRAGMA table_info), for the Viewer's
// schema strip. open() always exec's SCHEMA, so this is safe on an empty db.
function schema(dbFile) {
  const db = open(dbFile);
  return db.pragma('table_info(images)');
}

// Text columns the Viewer's free-text filter searches over (fixed whitelist so
// the term is only ever a bound parameter, never interpolated into SQL).
const SEARCH_COLS = [
  'gbif_id', 'herb_code', 'dwc_order', 'family', 'genus', 'specific_epithet',
  'fullname', 'scientific_name', 'country', 'filename',
];

// Paginated + optionally filtered rows, newest first. Returns { rows, total,
// limit, offset } where total is the FILTERED count.
function rows(dbFile, { limit = 100, offset = 0, search = '' } = {}) {
  const db = open(dbFile);
  const lim = Math.min(Math.max(1, limit | 0), 500);
  const off = Math.max(0, offset | 0);
  const term = String(search || '').trim();

  let where = '';
  let params = [];
  if (term) {
    where = ' WHERE ' + SEARCH_COLS.map((c) => `${c} LIKE ?`).join(' OR ');
    params = SEARCH_COLS.map(() => `%${term}%`);
  }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM images${where}`).get(...params).n;
  const list = db
    .prepare(`SELECT * FROM images${where} ORDER BY downloaded_at DESC LIMIT ? OFFSET ?`)
    .all(...params, lim, off);
  return { rows: list, total, limit: lim, offset: off };
}

function getRow(dbFile, gbifId) {
  const db = open(dbFile);
  return db.prepare('SELECT * FROM images WHERE gbif_id = ?').get(String(gbifId));
}

module.exports = {
  open, hasImage, listDownloadedIds, upsertImage, count, schema, rows, getRow,
};
