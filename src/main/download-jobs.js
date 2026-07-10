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
const gbifApi = require('../server/gbif-api');
const predicate = require('../server/predicate-builder');
const dwca = require('../server/dwca');
const imageFetch = require('../server/image-fetch');
const downloadService = require('../server/download-service');
const { generateImageFilename } = require('../server/herb-code');

const POLL_MS = 20000;
const DRAIN_GLOBAL = 16;   // concurrent direct fetches (worker board shows each)
const DRAIN_PER_HOST = 2;  // per institution host (be polite)

function herbCodeOf(occ) { try { return generateImageFilename(occ, null).herbCode; } catch (_) { return ''; } }
const EXTRACT = ['occurrence.txt', 'multimedia.txt', 'verbatim.txt', 'citations.txt', 'rights.txt', 'metadata.xml', 'meta.xml'];

let win = null;
const jobs = new Map(); // key -> { parentDir, pollTimer, draining, cancelled }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init(mainWindow) { win = mainWindow; }
function push(channel, data) { if (win && !win.isDestroyed()) win.webContents.send(channel, data); }
function dbFileFor(parentDir) { return path.join(paths.resolvePaths(parentDir).db, 'images.db'); }

function snapshot(parentDir, key) {
  const dbFile = dbFileFor(parentDir);
  const row = db.getDownload(dbFile, key);
  const counts = db.queueCounts(dbFile, key);
  const job = jobs.get(key) || {};
  const archiveTerminal = row && ['EXTRACTED', 'DONE', 'FAILED', 'KILLED', 'CANCELLED', 'FILE_ERASED'].includes(row.status);
  const busy = !!(row && (!archiveTerminal || job.enumerating || counts.pending || counts.in_progress || counts.blocked));
  return { ...row, counts, enumerating: !!job.enumerating, busy };
}

// Build the compact, saveOne-shaped occ from a live search result (same shape
// as dwca.compactOcc) so the image stage needs zero per-record API calls.
function compactOccFromSearch(occ) {
  const id = String(occ.key);
  return {
    key: id, gbifID: id,
    institutionCode: occ.institutionCode || null, institutionID: occ.institutionID || null,
    ownerInstitutionCode: occ.ownerInstitutionCode || null, collectionCode: occ.collectionCode || null,
    occurrenceID: occ.occurrenceID || null, order: occ.order || null, family: occ.family || null,
    genus: occ.genus || null, specificEpithet: occ.specificEpithet || null, scientificName: occ.scientificName || null,
    decimalLatitude: occ.decimalLatitude != null ? occ.decimalLatitude : null,
    decimalLongitude: occ.decimalLongitude != null ? occ.decimalLongitude : null,
    continent: occ.continent || null, country: occ.country || null, stateProvince: occ.stateProvince || null,
    eventDate: occ.eventDate || null, publishingOrgKey: occ.publishingOrgKey || null,
  };
}
function pushProgress(parentDir, key) { push('gbif:jobProgress', snapshot(parentDir, key)); }

// Live per-worker board (throttled). job.workers[i] = { current, prev }.
let lastWorkersPush = 0;
function pushWorkers(key, force) {
  const now = Date.now();
  if (!force && now - lastWorkersPush < 300) return;
  lastWorkersPush = now;
  const job = jobs.get(key) || {};
  push('gbif:workers', { key, count: DRAIN_GLOBAL, workers: job.workers || [] });
}

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
  startPoll(parentDir, key);              // Track A: archive + DOI (async, ~minutes–hours)
  startImmediateEnumerate(parentDir, key, searchUrl); // Track B: images NOW (don't await)
  pushProgress(parentDir, key);
  return { key, doi: st.doi || null, slug };
}

// Track B: enumerate gbifIDs + image URLs from the search API RIGHT NOW (facet
// partitioning to get past the offset wall) and drain images immediately, in
// parallel with the archive build. Any records this misses are topped up when
// the archive lands.
async function startImmediateEnumerate(parentDir, key, searchUrl) {
  const job = jobs.get(key) || {}; job.parentDir = parentDir; jobs.set(key, job);
  if (job.enumerating) return;
  job.enumerating = true;
  const dbFile = dbFileFor(parentDir);
  startDrain(parentDir, key); // begin draining as soon as rows appear
  try {
    await gbifApi.enumerateAll(searchUrl, {
      isCancelled: () => job.cancelled,
      onBatch: async (rows) => {
        const batch = rows.map(({ occ, image_url }) => ({
          gbif_id: String(occ.key), download_key: key, image_url,
          host: imageFetch.hostOf(image_url), occ_json: JSON.stringify(compactOccFromSearch(occ)),
        }));
        db.enqueue(dbFile, batch);
        db.markSkippedAlreadyDownloaded(dbFile, key);
        startDrain(parentDir, key); // (no-op if already draining)
        pushProgress(parentDir, key);
      },
    });
  } catch (_) { /* best-effort; the archive tops up */ }
  job.enumerating = false;
  startDrain(parentDir, key);
  pushProgress(parentDir, key);
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
  // EXTRACTED = archive done + DOI/files written; images may still be draining
  // (Track B started them immediately). Top-up rows are picked up by the drain.
  db.updateDownload(dbFile, key, { status: 'EXTRACTED', citation, completed_at: new Date().toISOString() });
  pushProgress(parentDir, key);
  startDrain(parentDir, key);
  checkComplete(parentDir, key);
}

// --- image drain: tier-1 headless direct fetch ----------------------------
// DONE only once BOTH tracks finish: the archive is extracted, enumeration has
// stopped, and every queued image is settled.
function checkComplete(parentDir, key) {
  const dbFile = dbFileFor(parentDir);
  const job = jobs.get(key) || {};
  const row = db.getDownload(dbFile, key);
  const c = db.queueCounts(dbFile, key);
  if (row && row.status === 'EXTRACTED' && !job.enumerating && c.pending === 0 && c.in_progress === 0 && c.blocked === 0) {
    db.updateDownload(dbFile, key, { status: 'DONE' });
  }
}

async function startDrain(parentDir, key) {
  const job = jobs.get(key) || {}; job.parentDir = parentDir; job.cancelled = false; jobs.set(key, job);
  if (job.draining) return;
  job.draining = true;
  if (!job.workers) job.workers = Array.from({ length: DRAIN_GLOBAL }, () => ({ current: null, prev: null }));
  const dbFile = dbFileFor(parentDir);
  db.resetInProgress(dbFile);

  // Keep draining while rows exist OR enumeration is still feeding the queue.
  while (!job.cancelled) {
    const c = db.queueCounts(dbFile, key);
    if (c.pending === 0 && c.in_progress === 0 && !job.enumerating) break;
    if (c.pending === 0) { await sleep(400); continue; } // wait for enumerate/archive to add rows
    await drainPass(parentDir, key, job);
  }

  job.draining = false;
  job.workers = job.workers.map((w) => ({ current: null, prev: w.prev })); // all idle
  pushWorkers(key, true);
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

  const worker = async (w) => {
    let lastHost = null;
    let streak = 0; // consecutive same-host downloads by THIS worker
    while (!job.cancelled) {
      const row = claim();
      if (!row) {
        if (!buffer.length) { buffer = db.nextQueueBatch(dbFile, { key, status: 'pending', limit: 800 }); if (!buffer.length) break; }
        await sleep(100);
        continue;
      }
      // >5 in a row from one host → 2s rest to give that server a break; the
      // moment the host changes, streak resets and there's no delay.
      if (row.host === lastHost) streak += 1; else { streak = 1; lastHost = row.host; }
      const delayActive = streak > 5;
      const occ = JSON.parse(row.occ_json || '{}');
      const herbCode = herbCodeOf(occ);
      job.workers[w] = { current: { gbif_id: row.gbif_id, herbCode, method: 'direct', delayActive }, prev: (job.workers[w] || {}).prev };
      pushWorkers(key);
      if (delayActive) await sleep(2000);
      inc(row.host);
      let ok = false;
      try {
        const buf = await imageFetch.tryDirect(row.image_url); // ONE attempt, no retry
        await downloadService.saveOne({ parentDir, occ, publisher: null, imageBuffer: buf, imageUrl: row.image_url });
        db.setQueueOutcome(dbFile, row.gbif_id, { status: 'done', method: 'direct', http_status: 200 });
        db.logFetch(dbFile, { gbif_id: row.gbif_id, host: row.host, method: 'direct', outcome: 'success', http_status: 200 });
        ok = true;
      } catch (e) {
        db.logFetch(dbFile, { gbif_id: row.gbif_id, host: row.host, method: 'direct', outcome: e.outcome || 'error', http_status: e.status, message: e.message });
        const kind = e.kind || 'transient';
        if (kind === 'blocked') db.setQueueOutcome(dbFile, row.gbif_id, { status: 'blocked', http_status: e.status, error: e.message }); // → webview drain
        else if (kind === 'broken') db.setQueueOutcome(dbFile, row.gbif_id, { status: 'broken', method: 'direct', http_status: e.status, error: e.message }); // dead link — never retry
        else db.setQueueOutcome(dbFile, row.gbif_id, { status: 'failed', method: 'direct', http_status: e.status, error: e.message }); // transient — retry later
      } finally {
        dec(row.host);
        job.workers[w] = { current: null, prev: { gbif_id: row.gbif_id, herbCode, ok } };
        pushWorkers(key);
        await sleep(60 + Math.floor(Math.random() * 140)); // jitter, per worker
        maybePush();
      }
    }
  };
  await Promise.all(Array.from({ length: DRAIN_GLOBAL }, (_, w) => worker(w)));
}

// --- renderer-driven webview drain of blocked rows ------------------------
function nextBlocked(parentDir, key, limit = 12) {
  const dbFile = dbFileFor(parentDir);
  const rows = db.nextQueueBatch(dbFile, { key, status: 'blocked', limit });
  for (const r of rows) db.setQueueStatus(dbFile, r.gbif_id, 'in_progress'); // claim
  return rows.map((r) => {
    let herbCode = '';
    try { herbCode = herbCodeOf(JSON.parse(r.occ_json || '{}')); } catch (_) { /* noop */ }
    return { gbif_id: r.gbif_id, image_url: r.image_url, herbCode };
  });
}

async function saveBlocked(parentDir, key, gbifId, imageBuffer, method, trail) {
  const dbFile = dbFileFor(parentDir);
  const row = db.open(dbFile).prepare('SELECT * FROM download_queue WHERE gbif_id = ?').get(String(gbifId));
  if (!row) return;
  db.logFetchBatch(dbFile, (trail || []).map((a) => ({ ...a, gbif_id: gbifId, host: row.host })));
  try {
    const occ = JSON.parse(row.occ_json || '{}');
    await downloadService.saveOne({ parentDir, occ, publisher: null, imageBuffer, imageUrl: row.image_url });
    db.setQueueOutcome(dbFile, gbifId, { status: 'done', method: method || 'webview', http_status: 200 });
  } catch (e) {
    db.setQueueOutcome(dbFile, gbifId, { status: 'failed', method: method || 'webview', error: e.message });
  }
  checkComplete(parentDir, key);
  pushProgress(parentDir, key);
}

// info = { kind:'broken'|'failed', status, trail:[{method,outcome,http_status,message}] }
function failBlocked(parentDir, key, gbifId, info) {
  const dbFile = dbFileFor(parentDir);
  const row = db.open(dbFile).prepare('SELECT host FROM download_queue WHERE gbif_id = ?').get(String(gbifId));
  const host = row ? row.host : null;
  const trail = (info && info.trail) || [];
  db.logFetchBatch(dbFile, trail.map((a) => ({ ...a, gbif_id: gbifId, host })));
  const status = (info && info.kind === 'broken') ? 'broken' : 'failed'; // broken → never retry
  db.setQueueOutcome(dbFile, gbifId, { status, method: 'webview', http_status: info && info.status, error: 'all webview fallbacks failed' });
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
    if (['PREPARING', 'RUNNING'].includes(st)) {
      startPoll(parentDir, row.key); // Track A resumes
      if (row.source_url) startImmediateEnumerate(parentDir, row.key, row.source_url); // Track B resumes
    } else if (['SUCCEEDED', 'DOWNLOADING_ZIP', 'PARSING'].includes(st)) {
      try {
        const s = await api.pollDownload(row.key);
        if (s.status === 'SUCCEEDED') handleSucceeded(parentDir, row.key, s);
        else if (s.status === 'FILE_ERASED') db.updateDownload(dbFile, row.key, { status: 'FILE_ERASED' });
        else startPoll(parentDir, row.key);
      } catch (_) { /* offline; will retry next launch */ }
    } else if (['EXTRACTED', 'QUEUED'].includes(st)) {
      startDrain(parentDir, row.key); // archive done; finish the image queue
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
