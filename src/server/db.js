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
  event_date       TEXT,             -- DwC eventDate, if present
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

-- One row per GBIF occurrence-download job (the async DWCA export). Carries the
-- citable DOI and is the durable resume token for a background job.
CREATE TABLE IF NOT EXISTS downloads (
  key            TEXT PRIMARY KEY,   -- GBIF download key, e.g. 0064539-230530130749713
  slug           TEXT,               -- dwc/{slug} folder
  doi            TEXT,               -- 10.15468/dl.xxxxxx (present from PREPARING)
  source_url     TEXT,               -- the gbif.org search URL
  predicate_json TEXT,               -- the predicate we POSTed (audit/replay)
  format         TEXT DEFAULT 'DWCA',
  status         TEXT NOT NULL,      -- GBIF status + local phases (DOWNLOADING_ZIP/PARSING/QUEUED/DONE)
  total_records  INTEGER,
  num_datasets   INTEGER,
  size_bytes     INTEGER,
  license        TEXT,
  citation       TEXT,
  download_link  TEXT,
  archive_path   TEXT,
  error          TEXT,
  requested_at   TEXT NOT NULL DEFAULT (datetime('now')),
  polled_at      TEXT,
  completed_at   TEXT
);

-- Resumable per-image work queue for a download (survives app restart).
CREATE TABLE IF NOT EXISTS download_queue (
  gbif_id      TEXT PRIMARY KEY,
  download_key TEXT,
  image_url    TEXT,
  host         TEXT,               -- registrable-ish host, for per-host throttling
  host_seq     INTEGER DEFAULT 0,  -- Nth item for this host; drives domain-INTERLEAVED order
  occ_json     TEXT,               -- compact occurrence metadata (built from occurrence.txt)
  status       TEXT NOT NULL DEFAULT 'pending', -- pending|in_progress|blocked|done|failed|broken|skipped
  method       TEXT,               -- fetch tier that settled it: direct|webview-electron|webview-clean|webview-realistic
  http_status  INTEGER,            -- last HTTP status seen
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  updated_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_dlq_status ON download_queue(status, host_seq);
CREATE INDEX IF NOT EXISTS idx_dlq_key    ON download_queue(download_key);

-- Every fetch ATTEMPT (each tier), for trend analysis: which domains bot-block,
-- which browser emulation works for which domain, which are outright broken.
CREATE TABLE IF NOT EXISTS fetch_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gbif_id     TEXT,
  host        TEXT,
  method      TEXT,   -- direct | webview-electron | webview-clean | webview-realistic
  outcome     TEXT,   -- success | blocked | broken | timeout | http_error | not_image | error
  http_status INTEGER,
  message     TEXT,
  ts          TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fetchlog_host ON fetch_log(host, outcome);
CREATE INDEX IF NOT EXISTS idx_fetchlog_gbif ON fetch_log(gbif_id);
`;

// Additive migrations for DBs created by an earlier version (CREATE TABLE IF NOT
// EXISTS won't add a new column to an existing table).
function migrate(db) {
  const cols = db.pragma('table_info(images)').map((c) => c.name);
  if (!cols.includes('event_date')) db.exec('ALTER TABLE images ADD COLUMN event_date TEXT');
  const dq = db.pragma('table_info(download_queue)').map((c) => c.name);
  if (!dq.includes('host_seq')) db.exec('ALTER TABLE download_queue ADD COLUMN host_seq INTEGER DEFAULT 0');
  if (!dq.includes('method')) db.exec('ALTER TABLE download_queue ADD COLUMN method TEXT');
  if (!dq.includes('http_status')) db.exec('ALTER TABLE download_queue ADD COLUMN http_status INTEGER');
}

function open(dbFile) {
  if (conns.has(dbFile)) return conns.get(dbFile);
  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrate(db);
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
  'state_province', 'event_date', 'filename', 'img_x', 'img_y', 'megapixels',
  'occurrence_url', 'image_url', 'source', 'downloaded_at',
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
  'fullname', 'scientific_name', 'country', 'event_date', 'filename',
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

// --- downloads (DWCA jobs) -------------------------------------------------
const DOWNLOAD_COLS = [
  'key', 'slug', 'doi', 'source_url', 'predicate_json', 'format', 'status',
  'total_records', 'num_datasets', 'size_bytes', 'license', 'citation',
  'download_link', 'archive_path', 'error', 'requested_at', 'polled_at', 'completed_at',
];

function insertDownload(dbFile, row) {
  const db = open(dbFile);
  const cols = DOWNLOAD_COLS.filter((c) => row[c] !== undefined);
  const stmt = db.prepare(`INSERT OR REPLACE INTO downloads (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`);
  const filled = {};
  for (const c of cols) filled[c] = row[c] === undefined ? null : row[c];
  stmt.run(filled);
  return getDownload(dbFile, row.key);
}

function updateDownload(dbFile, key, patch) {
  const db = open(dbFile);
  const cols = Object.keys(patch).filter((c) => DOWNLOAD_COLS.includes(c));
  if (!cols.length) return getDownload(dbFile, key);
  db.prepare(`UPDATE downloads SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE key = @key`)
    .run({ ...patch, key });
  return getDownload(dbFile, key);
}

function getDownload(dbFile, key) {
  return open(dbFile).prepare('SELECT * FROM downloads WHERE key = ?').get(String(key));
}

function listDownloads(dbFile) {
  return open(dbFile).prepare('SELECT * FROM downloads ORDER BY requested_at DESC').all();
}

// Downloads not in a terminal local/GBIF state — resumed on startup.
const TERMINAL = ['DONE', 'FAILED', 'KILLED', 'CANCELLED', 'FILE_ERASED'];
function getActiveDownloads(dbFile) {
  const q = `SELECT * FROM downloads WHERE status NOT IN (${TERMINAL.map(() => '?').join(',')})`;
  return open(dbFile).prepare(q).all(...TERMINAL);
}

// --- download_queue (per-image work) --------------------------------------
// Enqueue with a per-host running index (host_seq). Ordering by (host_seq, host)
// then INTERLEAVES domains — every host's item 0 first, then every host's item
// 1, … — so workers pull different domains back-to-back with no runtime sorting,
// and no single server gets a burst. Counters are seeded from existing rows so
// Track B batches + the Track A top-up keep interleaving consistently.
function enqueue(dbFile, rows) {
  const db = open(dbFile);
  const counters = new Map();
  const nextSeq = (host) => {
    if (!counters.has(host)) counters.set(host, db.prepare('SELECT COUNT(*) AS n FROM download_queue WHERE host = ?').get(host).n);
    const s = counters.get(host);
    counters.set(host, s + 1);
    return s;
  };
  const stmt = db.prepare(`INSERT OR IGNORE INTO download_queue
    (gbif_id, download_key, image_url, host, host_seq, occ_json, status, updated_at)
    VALUES (@gbif_id, @download_key, @image_url, @host, @host_seq, @occ_json, 'pending', datetime('now'))`);
  const tx = db.transaction((batch) => {
    for (const r of batch) { r.host_seq = nextSeq(r.host); stmt.run(r); }
  });
  tx(rows);
  return rows.length;
}

// Mark queue rows whose gbif_id is already in images (idempotent restart / dedup).
function markSkippedAlreadyDownloaded(dbFile, key) {
  return open(dbFile).prepare(
    `UPDATE download_queue SET status='skipped', updated_at=datetime('now')
     WHERE download_key = ? AND status='pending' AND gbif_id IN (SELECT gbif_id FROM images)`
  ).run(String(key)).changes;
}

function nextQueueBatch(dbFile, { key, status = 'pending', limit = 500 } = {}) {
  const db = open(dbFile);
  const args = [status];
  let where = 'status = ?';
  if (key) { where += ' AND download_key = ?'; args.push(String(key)); }
  // Draw a RANDOM window of the remaining rows each refill. A random shuffle
  // scatters gbifIDs across domains so the pool doesn't march through one host's
  // block; combined with the per-host in-flight cap + per-worker streak delay in
  // the drain, no single domain gets hammered. Re-randomizing on every refill also
  // means no host can be permanently starved by a stale/uneven stored ordering.
  return db.prepare(`SELECT * FROM download_queue WHERE ${where} ORDER BY RANDOM() LIMIT ?`).all(...args, limit);
}

function setQueueStatus(dbFile, gbifId, status, err) {
  return open(dbFile).prepare(
    `UPDATE download_queue SET status=@status, last_error=@err, updated_at=datetime('now') WHERE gbif_id=@id`
  ).run({ id: String(gbifId), status, err: err || null }).changes;
}

function bumpQueueAttempt(dbFile, gbifId, err, maxAttempts = 4) {
  const db = open(dbFile);
  db.prepare(
    `UPDATE download_queue SET attempts = attempts + 1, last_error = @err,
       status = CASE WHEN attempts + 1 >= @max THEN 'failed' ELSE 'pending' END,
       updated_at = datetime('now')
     WHERE gbif_id = @id`
  ).run({ id: String(gbifId), err: err || null, max: maxAttempts });
}

function queueCounts(dbFile, key) {
  const db = open(dbFile);
  const args = key ? [String(key)] : [];
  const where = key ? 'WHERE download_key = ?' : '';
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM download_queue ${where} GROUP BY status`).all(...args);
  const out = { pending: 0, in_progress: 0, blocked: 0, done: 0, failed: 0, broken: 0, skipped: 0, total: 0 };
  for (const r of rows) { out[r.status] = r.n; out.total += r.n; }
  return out;
}

// Record a per-image terminal/intermediate outcome (status + winning-or-last
// method + http status). attempts is incremented so we can see how many tries.
function setQueueOutcome(dbFile, gbifId, { status, method, http_status, error }) {
  return open(dbFile).prepare(
    `UPDATE download_queue SET status=@status, method=@method, http_status=@http_status,
       last_error=@error, attempts=attempts+1, updated_at=datetime('now') WHERE gbif_id=@id`
  ).run({ id: String(gbifId), status, method: method || null, http_status: http_status != null ? http_status : null, error: error || null }).changes;
}

// Append a fetch attempt (or a batch of them) to the analysis log.
function logFetch(dbFile, e) {
  open(dbFile).prepare(
    `INSERT INTO fetch_log (gbif_id, host, method, outcome, http_status, message)
     VALUES (@gbif_id, @host, @method, @outcome, @http_status, @message)`
  ).run({
    gbif_id: e.gbif_id != null ? String(e.gbif_id) : null, host: e.host || null,
    method: e.method || null, outcome: e.outcome || null,
    http_status: e.http_status != null ? e.http_status : null, message: e.message ? String(e.message).slice(0, 300) : null,
  });
}
function logFetchBatch(dbFile, entries) {
  if (!entries || !entries.length) return;
  const db = open(dbFile);
  const tx = db.transaction((list) => { for (const e of list) logFetch(dbFile, e); });
  tx(entries);
}

// Paginated + searchable raw fetch_log (most recent first). onlyFailures hides
// the 'success' rows; finalOnly keeps only attempts whose item TERMINALLY failed
// — direct + every webview fallback exhausted (queue status broken|failed), i.e.
// the genuinely problematic domains (excludes 'blocked' items still awaiting the
// webview drain and items that eventually succeeded).
function fetchLog(dbFile, { limit = 100, offset = 0, search = '', onlyFailures = false, finalOnly = false } = {}) {
  const db = open(dbFile);
  const lim = Math.min(Math.max(1, limit | 0), 500);
  const off = Math.max(0, offset | 0);
  const clauses = [];
  const params = [];
  // host/gbif_id/method live in BOTH joined tables, so every column is qualified.
  if (finalOnly) clauses.push("q.status IN ('broken','failed')");
  else if (onlyFailures) clauses.push("f.outcome != 'success'");
  const term = String(search || '').trim();
  if (term) {
    clauses.push('(f.host LIKE ? OR f.gbif_id LIKE ? OR f.method LIKE ? OR f.outcome LIKE ? OR q.image_url LIKE ?)');
    params.push(`%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`, `%${term}%`);
  }
  // JOIN the queue row (gbif_id is its PRIMARY KEY) so every log entry carries the
  // image_url we tried; the GBIF occurrence page is derived from the id.
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const from = 'FROM fetch_log f LEFT JOIN download_queue q ON q.gbif_id = f.gbif_id';
  const total = db.prepare(`SELECT COUNT(*) AS n ${from} ${where}`).get(...params).n;
  const rows = db.prepare(`SELECT f.*, q.image_url AS image_url ${from} ${where} ORDER BY f.id DESC LIMIT ? OFFSET ?`).all(...params, lim, off);
  for (const r of rows) r.gbif_url = r.gbif_id ? `https://www.gbif.org/occurrence/${r.gbif_id}` : null;
  return { rows, total, limit: lim, offset: off };
}

// Per-domain fetch analytics: attempts + successes + block/broken/fail counts,
// and which method won most for each host. For a future Viewer "diagnostics" view.
function fetchStats(dbFile) {
  const db = open(dbFile);
  const byHost = db.prepare(
    `SELECT host,
       COUNT(*) AS attempts,
       SUM(outcome='success') AS ok,
       SUM(outcome='blocked') AS blocked,
       SUM(outcome='broken') AS broken,
       SUM(outcome NOT IN ('success','blocked','broken')) AS failed
     FROM fetch_log GROUP BY host ORDER BY attempts DESC`
  ).all();
  const winners = db.prepare(
    `SELECT host, method, COUNT(*) AS n FROM fetch_log WHERE outcome='success' AND method IS NOT NULL GROUP BY host, method ORDER BY host, n DESC`
  ).all();
  return { byHost, winners };
}

// On restart, any in_progress row was interrupted — requeue it.
function resetInProgress(dbFile) {
  return open(dbFile).prepare(
    "UPDATE download_queue SET status='pending', updated_at=datetime('now') WHERE status='in_progress'"
  ).run().changes;
}

module.exports = {
  open, hasImage, listDownloadedIds, upsertImage, count, schema, rows, getRow,
  insertDownload, updateDownload, getDownload, listDownloads, getActiveDownloads,
  enqueue, markSkippedAlreadyDownloaded, nextQueueBatch, setQueueStatus,
  bumpQueueAttempt, queueCounts, resetInProgress,
  setQueueOutcome, logFetch, logFetchBatch, fetchStats, fetchLog,
};
