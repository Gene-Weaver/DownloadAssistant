/*
 * Bulk-acquire orchestrator (main process). Owns the long-running GBIF
 * occurrence-download jobs so they survive tab switches and app restarts.
 *
 * Flow: submit(searchUrl) → createDownload (auth) → poll → on SUCCEEDED fetch +
 * extract the DWCA, parse it into a resumable download_queue, then DRAIN the
 * queue: tier-1 headless direct fetch here in main (fast, most hosts); rows a
 * host bot-blocks are flipped to status='blocked' and the renderer drains those
 * through the webview. The `downloads` table (with the DOI) is the durable
 * resume token. Progress is pushed to the renderer via 'gbif:jobProgress'.
 */

const path = require('path');
const fs = require('fs');

const settings = require('./settings');
const auth = require('./auth');
const paths = require('../server/paths');
const db = require('../server/db');
const api = require('../server/gbif-download-api');
const predicate = require('../server/predicate-builder');
const dwca = require('../server/dwca');
const imageFetch = require('../server/image-fetch');
const downloadService = require('../server/download-service');

const POLL_MS = 20000;
const DRAIN_GLOBAL = 8;    // concurrent direct fetches
const DRAIN_PER_HOST = 2;  // per institution host (be polite)
const EXTRACT = ['occurrence.txt', 'multimedia.txt', 'verbatim.txt', 'citations.txt', 'rights.txt', 'metadata.xml', 'meta.xml'];

let win = null;
const jobs = new Map(); // key -> { parentDir, pollTimer, draining, cancelled }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(mainWindow) { win = mainWindow; }
function push(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
function dbFileFor(parentDir) { return path.join(paths.resolvePaths(parentDir).db, 'images.db'); }

function snapshot(parentDir, key) {
  const dbFile = dbFileFor(parentDir);
  return { ...db.getDownload(dbFile, key), counts: db.queueCounts(dbFile, key) };
}
function pushProgress(parentDir, key) { push('gbif:jobProgress', snapshot(parentDir, key)); }

// --- submit ---------------------------------------------------------------
async function submit(searchUrl) {
  const parentDir = settings.getParentDir();
  if (!parentDir) throw new Error('Set a save location first.');
  const a = auth.getAuth();
  if (!a) { const e = new Error('GBIF login needed for the full download. Sign in on the GBIF tab, or add GBIF_USER/GBIF_PASS to a .env file.'); e.code = 'NO_AUTH'; throw e; }

  const dbFile = dbFileFor(parentDir);
  const { body, slug } = predicate.buildDownloadRequest(searchUrl, { creator: auth.getCreator(), email: auth.getEmail() });
  const key = await api.createDownload(body, a);

  let st = {};
  try { st = await api.pollDownload(key); } catch (_) { /* first poll best-effort */ }
  db.insertDownload(dbFile, {
    key, slug, doi: st.doi || null, source_url: searchUrl,
    predicate_json: JSON.stringify(body.predicate), status: st.status || 'PREPARING',
    total_records: st.totalRecords || null, license: st.license || null, download_link: st.downloadLink || null,
  });
  startPoll(parentDir, key);
  pushProgress(parentDir, key);
  return { key, doi: st.doi || null, slug };
}

// --- poll -----------------------------------------------------------------
function startPoll(parentDir, key) {
  const job = jobs.get(key) || {};
  job.parentDir = parentDir; job.cancelled = false;
  if (job.pollTimer) { jobs.set(key, job); return; }

  const tick = async () => {
    if (job.cancelled) return;
    const dbFile = dbFileFor(parentDir);
    let st;
    try { st = await api.pollDownload(key); } catch (_) { pushProgress(parentDir, key); return; }
    db.updateDownload(dbFile, key, {
      status: st.status, doi: st.doi || undefined, total_records: st.totalRecords || undefined,
      num_datasets: st.numberDatasets || undefined, size_bytes: st.size || undefined,
      license: st.license || undefined, download_link: st.downloadLink || undefined,
      polled_at: new Date().toISOString(),
    });
    pushProgress(parentDir, key);
    if (st.status === 'SUCCEEDED') {
      clearInterval(job.pollTimer); job.pollTimer = null;
      handleSucceeded(parentDir, key, st).catch((err) => {
        db.updateDownload(dbFile, key, { status: 'FAILED', error: err.message });
        pushProgress(parentDir, key);
      });
    } else if (['FAILED', 'KILLED', 'CANCELLED', 'FILE_ERASED'].includes(st.status)) {
      clearInterval(job.pollTimer); job.pollTimer = null;
    }
  };
  job.pollTimer = setInterval(tick, POLL_MS);
  jobs.set(key, job);
  tick();
}

// --- succeeded: download + extract + parse + enqueue ----------------------
async function handleSucceeded(parentDir, key, st) {
  const dbFile = dbFileFor(parentDir);
  const P = paths.ensurePaths(parentDir);
  const row = db.getDownload(dbFile, key);
  const dwcDir = path.join(P.dwc, row.slug || key);
  fs.mkdirSync(dwcDir, { recursive: true });
  const zipPath = path.join(dwcDir, 'download.zip');

  db.updateDownload(dbFile, key, { status: 'DOWNLOADING_ZIP', download_link: st.downloadLink });
  pushProgress(parentDir, key);
  let lastZip = 0;
  await api.fetchZip(st.downloadLink, zipPath, {
    onProgress: (recv) => { const n = Date.now(); if (n - lastZip > 800) { lastZip = n; push('gbif:jobProgress', { ...snapshot(parentDir, key), zipReceived: recv }); } },
  });

  db.updateDownload(dbFile, key, { archive_path: zipPath, status: 'PARSING' });
  pushProgress(parentDir, key);
  await dwca.extractFiles(zipPath, dwcDir, EXTRACT);

  const citation = st.doi ? `GBIF.org GBIF Occurrence Download https://doi.org/${st.doi}` : null;
  fs.writeFileSync(path.join(dwcDir, 'search_meta.json'), JSON.stringify({
    slug: row.slug, key, doi: st.doi, license: st.license, total_records: st.totalRecords,
    source_url: row.source_url, generated_at: new Date().toISOString(),
  }, null, 2));

  let batch = [];
  const flush = () => { if (batch.length) { db.enqueue(dbFile, batch); batch = []; } };
  await dwca.parseArchive(zipPath, {
    onOccurrence: ({ gbifId, urls, occ }) => {
      if (!urls.length) return;
      batch.push({ gbif_id: gbifId, download_key: key, image_url: urls[0], host: imageFetch.hostOf(urls[0]), occ_json: JSON.stringify(occ) });
      if (batch.length >= 1000) flush();
    },
  });
  flush();
  db.markSkippedAlreadyDownloaded(dbFile, key);
  db.updateDownload(dbFile, key, { status: 'QUEUED', citation, completed_at: new Date().toISOString() });
  pushProgress(parentDir, key);
  startDrain(parentDir, key);
}

// --- image drain: tier-1 headless direct fetch ----------------------------
function checkComplete(parentDir, key) {
  const dbFile = dbFileFor(parentDir);
  const c = db.queueCounts(dbFile, key);
  if (c.pending === 0 && c.in_progress === 0 && c.blocked === 0) {
    db.updateDownload(dbFile, key, { status: 'DONE' });
  }
}

async function startDrain(parentDir, key) {
  const job = jobs.get(key) || {}; job.parentDir = parentDir; job.cancelled = false; jobs.set(key, job);
  if (job.draining) return;
  job.draining = true;
  const dbFile = dbFileFor(parentDir);
  db.resetInProgress(dbFile);

  // Repeat passes until nothing is pending (retried rows re-enter as pending).
  while (!job.cancelled) {
    const c = db.queueCounts(dbFile, key);
    if (c.pending === 0 && c.in_progress === 0) break;
    await drainPass(parentDir, key, job);
  }

  job.draining = false;
  checkComplete(parentDir, key);
  pushProgress(parentDir, key);
}

async function drainPass(parentDir, key, job) {
  const dbFile = dbFileFor(parentDir);
  const hostInFlight = new Map();
  const inc = (h) => hostInFlight.set(h, (hostInFlight.get(h) || 0) + 1);
  const dec = (h) => hostInFlight.set(h, Math.max(0, (hostInFlight.get(h) || 0) - 1));
  let buffer = db.nextQueueBatch(dbFile, { key, status: 'pending', limit: 800 });
  let lastPush = 0;

  // Atomically claim a buffered row whose host is under cap (no await → race-free).
  const claim = () => {
    for (let i = 0; i < buffer.length; i++) {
      const r = buffer[i];
      if ((hostInFlight.get(r.host) || 0) < DRAIN_PER_HOST) {
        buffer.splice(i, 1);
        db.setQueueStatus(dbFile, r.gbif_id, 'in_progress');
        return r;
      }
    }
    return null;
  };
  const maybePush = () => { const n = Date.now(); if (n - lastPush > 800) { lastPush = n; pushProgress(parentDir, key); } };

  const worker = async () => {
    while (!job.cancelled) {
      const row = claim();
      if (!row) {
        if (!buffer.length) { buffer = db.nextQueueBatch(dbFile, { key, status: 'pending', limit: 800 }); if (!buffer.length) break; }
        await sleep(100);
        continue;
      }
      inc(row.host);
      try {
        const occ = JSON.parse(row.occ_json || '{}');
        const buf = await imageFetch.tryDirect(row.image_url);
        await downloadService.saveOne({ parentDir, occ, publisher: null, imageBuffer: buf, imageUrl: row.image_url });
        db.setQueueStatus(dbFile, row.gbif_id, 'done');
      } catch (e) {
        if (e.blocked) db.setQueueStatus(dbFile, row.gbif_id, 'blocked', e.message);
        else db.bumpQueueAttempt(dbFile, row.gbif_id, e.message);
      } finally {
        dec(row.host);
        await sleep(60 + Math.floor(Math.random() * 140)); // jitter, per worker
        maybePush();
      }
    }
  };
  await Promise.all(Array.from({ length: DRAIN_GLOBAL }, worker));
}

// --- renderer-driven webview drain of blocked rows ------------------------
function nextBlocked(parentDir, key, limit = 12) {
  const dbFile = dbFileFor(parentDir);
  const rows = db.nextQueueBatch(dbFile, { key, status: 'blocked', limit });
  for (const r of rows) db.setQueueStatus(dbFile, r.gbif_id, 'in_progress'); // claim
  return rows.map((r) => ({ gbif_id: r.gbif_id, image_url: r.image_url }));
}

async function saveBlocked(parentDir, key, gbifId, imageBuffer) {
  const dbFile = dbFileFor(parentDir);
  const row = db.open(dbFile).prepare('SELECT * FROM download_queue WHERE gbif_id = ?').get(String(gbifId));
  if (!row) return;
  try {
    const occ = JSON.parse(row.occ_json || '{}');
    await downloadService.saveOne({ parentDir, occ, publisher: null, imageBuffer, imageUrl: row.image_url });
    db.setQueueStatus(dbFile, gbifId, 'done');
  } catch (e) {
    db.setQueueStatus(dbFile, gbifId, 'failed', e.message);
  }
  checkComplete(parentDir, key);
  pushProgress(parentDir, key);
}

function failBlocked(parentDir, key, gbifId, err) {
  db.setQueueStatus(dbFileFor(parentDir), gbifId, 'failed', err || 'webview fetch failed');
  checkComplete(parentDir, key);
  pushProgress(parentDir, key);
}

// --- cancel / resume ------------------------------------------------------
async function cancel(key) {
  const job = jobs.get(key);
  const parentDir = (job && job.parentDir) || settings.getParentDir();
  if (!parentDir) return;
  const dbFile = dbFileFor(parentDir);
  const row = db.getDownload(dbFile, key);
  if (job) { job.cancelled = true; if (job.pollTimer) { clearInterval(job.pollTimer); job.pollTimer = null; } }
  if (row && ['PREPARING', 'RUNNING'].includes(row.status)) {
    try { await api.cancelDownload(key, auth.getAuth()); } catch (_) { /* best-effort */ }
    db.updateDownload(dbFile, key, { status: 'CANCELLED' });
  }
  // For QUEUED/draining, we just pause (rows stay pending/blocked, resumable).
  pushProgress(parentDir, key);
}

// Restart a paused image drain (renderer "resume" button).
function resume(key) {
  const job = jobs.get(key) || {};
  const parentDir = job.parentDir || settings.getParentDir();
  if (!parentDir) return;
  startDrain(parentDir, key);
}

async function resumeOnStartup() {
  const parentDir = settings.getParentDir();
  if (!parentDir) return;
  const dbFile = dbFileFor(parentDir);
  let active;
  try { active = db.getActiveDownloads(dbFile); } catch (_) { return; }
  if (!active.length) return;
  db.resetInProgress(dbFile);
  for (const row of active) {
    const st = row.status;
    if (['PREPARING', 'RUNNING'].includes(st)) startPoll(parentDir, row.key);
    else if (['SUCCEEDED', 'DOWNLOADING_ZIP', 'PARSING'].includes(st)) {
      try {
        const s = await api.pollDownload(row.key);
        if (s.status === 'SUCCEEDED') handleSucceeded(parentDir, row.key, s);
        else if (s.status === 'FILE_ERASED') db.updateDownload(dbFile, row.key, { status: 'FILE_ERASED' });
        else startPoll(parentDir, row.key);
      } catch (_) { /* offline; will retry next launch */ }
    } else if (st === 'QUEUED') {
      startDrain(parentDir, row.key);
    }
  }
  push('gbif:jobsActive', active.map((r) => r.key));
}

function listActive() {
  const parentDir = settings.getParentDir();
  if (!parentDir) return [];
  try { return db.getActiveDownloads(dbFileFor(parentDir)).map((r) => ({ ...r, counts: db.queueCounts(dbFileFor(parentDir), r.key) })); }
  catch (_) { return []; }
}

module.exports = {
  init, submit, cancel, resume, resumeOnStartup, listActive,
  nextBlocked, saveBlocked, failBlocked,
};
