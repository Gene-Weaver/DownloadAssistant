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
const RATE_COOLDOWN_MS = 30000; // after a 429, rest this host this long before retrying
const UNREACHABLE_STRIKES = 3;       // consecutive connect-timeouts before we rest a host
const UNREACHABLE_COOLDOWN_MS = 300000; // 5 min — stop burning ~25s/row on a dead host (arctos)

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
  const paused = !!job.cancelled && (counts.pending > 0 || counts.in_progress > 0 || counts.blocked > 0);
  return { ...row, parentDir, counts, enumerating: !!job.enumerating, busy, paused };
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
let workersTrailing = null;
function pushWorkers(key, force) {
  const now = Date.now();
  const emit = () => { lastWorkersPush = Date.now(); const job = jobs.get(key) || {}; push('gbif:workers', { key, count: job.workerCount || DRAIN_GLOBAL, workers: job.workers || [] }); };
  if (force || now - lastWorkersPush >= 120) { if (workersTrailing) { clearTimeout(workersTrailing); workersTrailing = null; } emit(); return; }
  // trailing edge so the latest state always lands even under a burst
  if (!workersTrailing) workersTrailing = setTimeout(() => { workersTrailing = null; emit(); }, 120 - (now - lastWorkersPush));
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
  if (job.paused || job.enumerating) return;
  job.enumerating = true;
  const dbFile = dbFileFor(parentDir);
  startDrain(parentDir, key); // begin draining as soon as rows appear
  try {
    await gbifApi.enumerateAll(searchUrl, {
      isCancelled: () => job.cancelled || job.paused,
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
  job.parentDir = parentDir;
  if (job.paused) return; // don't restart archive polling for an explicitly-paused job
  job.cancelled = false;
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
  const job = jobs.get(key) || {}; job.parentDir = parentDir; jobs.set(key, job);
  if (job.paused) return; // explicit pause blocks any (re)start (enqueue/enumerate/extract all call this)
  job.cancelled = false;
  if (job.draining) return;
  job.draining = true;
  job.workerCount = settings.getWorkerCount(); // capture the pool size for this run
  if (!job.workers || job.workers.length !== job.workerCount) {
    job.workers = Array.from({ length: job.workerCount }, () => ({ current: null, prev: null }));
  }
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
  // Rate-limit memory persists across passes: hosts that returned 429 get capped to
  // 1 concurrent (sensitive) and rested (cooldown) so we stop tripping the limit.
  if (!job.hostCooldown) job.hostCooldown = new Map();
  if (!job.hostSensitive) job.hostSensitive = new Set();
  if (!job.hostTimeouts) job.hostTimeouts = new Map();
  let buffer = db.nextQueueBatch(dbFile, { key, status: 'pending', limit: 800 });
  let lastPush = 0;

  // Atomically claim a buffered row whose host is under cap AND not cooling down
  // (no await → race-free).
  const claim = () => {
    const now = Date.now();
    for (let i = 0; i < buffer.length; i++) {
      const r = buffer[i];
      const cap = job.hostSensitive.has(r.host) ? 1 : DRAIN_PER_HOST;
      if (now >= (job.hostCooldown.get(r.host) || 0) && (hostInFlight.get(r.host) || 0) < cap) {
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
        job.hostTimeouts.delete(row.host); // host is alive — reset its strike count
        ok = true;
      } catch (e) {
        db.logFetch(dbFile, { gbif_id: row.gbif_id, host: row.host, method: 'direct', outcome: e.outcome || 'error', http_status: e.status, message: e.message });
        const kind = e.kind || 'transient';
        if (kind === 'ratelimited') {
          // 429 → back the WHOLE host off (cap→1 + cooldown) and put the row back to
          // pending so it retries later, slower. NOT the webview (shares our IP).
          job.hostSensitive.add(row.host);
          job.hostCooldown.set(row.host, Date.now() + RATE_COOLDOWN_MS);
          db.setQueueStatus(dbFile, row.gbif_id, 'pending');
        } else if (kind === 'blocked') db.setQueueOutcome(dbFile, row.gbif_id, { status: 'blocked', http_status: e.status, error: e.message }); // → webview drain
        else if (kind === 'broken') db.setQueueOutcome(dbFile, row.gbif_id, { status: 'broken', method: 'direct', http_status: e.status, error: e.message }); // dead link — never retry
        else {
          db.setQueueOutcome(dbFile, row.gbif_id, { status: 'failed', method: 'direct', http_status: e.status, error: e.message }); // transient — retry later
          // Host unreachable? After a few connect-timeouts in a row, rest it so we
          // stop burning ~25s per row on a dead host (e.g. arctos.database.museum).
          if (e.outcome === 'timeout' || e.outcome === 'error') {
            const n = (job.hostTimeouts.get(row.host) || 0) + 1;
            job.hostTimeouts.set(row.host, n);
            if (n >= UNREACHABLE_STRIKES) job.hostCooldown.set(row.host, Date.now() + UNREACHABLE_COOLDOWN_MS);
          }
        }
      } finally {
        dec(row.host);
        job.workers[w] = { current: null, prev: { gbif_id: row.gbif_id, herbCode, ok } };
        pushWorkers(key);
        await sleep(60 + Math.floor(Math.random() * 140)); // jitter, per worker
        maybePush();
      }
    }
  };
  await Promise.all(Array.from({ length: job.workerCount || DRAIN_GLOBAL }, (_, w) => worker(w)));
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

// Park a Cloudflare-gated row back to 'blocked' (resumable) instead of failing it,
// so it retries after the host is cleared via the one-time human solve.
function requeueBlocked(parentDir, key, gbifId) {
  db.setQueueStatus(dbFileFor(parentDir), gbifId, 'blocked');
}

// After a host is cleared through Cloudflare, flip its previously-'failed' rows
// back to 'blocked' so the webview drain retries them (now with cf_clearance).
function resetHostFailures(parentDir, key, host) {
  return db.requeueHostFailures(dbFileFor(parentDir), key, host);
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

// A manual Resume gives everything a clean retry: drop the in-memory per-host
// backoff (429 cooldowns, unreachable strikes, sensitive caps) so a drain that had
// throttled itself right down doesn't stay stuck when the user asks it to go again.
function clearBackoff(job) {
  if (!job) return;
  job.hostCooldown = new Map();
  job.hostSensitive = new Set();
  job.hostTimeouts = new Map();
}

// Restart a paused image drain (renderer "resume" button).
function resume(key) {
  const job = jobs.get(key) || {};
  job.paused = false; job.cancelled = false; // explicit resume clears the sticky pause
  clearBackoff(job);
  const parentDir = job.parentDir || settings.getParentDir();
  if (!parentDir) return;
  jobs.set(key, job);
  startDrain(parentDir, key);
}

// Resume all of ONE project's active downloads (both tracks). Un-pauses any of
// its jobs that were paused. Called on startup for the current project and by
// the Projects tab's Resume button for any project.
async function resumeProject(parentDir) {
  if (!parentDir) return { resumed: 0 };
  const dbFile = dbFileFor(parentDir);
  let active;
  try { active = db.getActiveDownloads(dbFile); } catch (_) { return { resumed: 0 }; }
  db.resetInProgress(dbFile);
  for (const row of active) {
    const existing = jobs.get(row.key);
    if (existing) { existing.cancelled = false; existing.paused = false; clearBackoff(existing); } // un-pause + clean retry
    const st = row.status;
    if (['PREPARING', 'RUNNING'].includes(st)) {
      startPoll(parentDir, row.key);
      if (row.source_url) startImmediateEnumerate(parentDir, row.key, row.source_url);
    } else if (['SUCCEEDED', 'DOWNLOADING_ZIP', 'PARSING'].includes(st)) {
      try {
        const s = await api.pollDownload(row.key);
        if (s.status === 'SUCCEEDED') handleSucceeded(parentDir, row.key, s);
        else if (s.status === 'FILE_ERASED') db.updateDownload(dbFile, row.key, { status: 'FILE_ERASED' });
        else startPoll(parentDir, row.key);
      } catch (_) { /* offline; retry next launch */ }
    } else if (['EXTRACTED', 'QUEUED'].includes(st)) {
      startDrain(parentDir, row.key);
    }
  }
  if (active.length) push('gbif:jobsActive', active.map((r) => r.key));
  return { resumed: active.length };
}

// Pause a project: stop polling + drain workers for all its jobs. Rows stay
// pending/blocked, so it's fully resumable.
function pauseProject(parentDir) {
  let n = 0;
  for (const [, job] of jobs) {
    if (job.parentDir === parentDir) {
      // Sticky pause: cancelled alone was being flipped back to false by the next
      // startDrain() (enqueue/enumerate/extract all call it), so a single Pause
      // press "didn't take". paused stays true until an explicit Resume, and every
      // (re)start path bails while it's set.
      job.paused = true;
      job.cancelled = true;
      if (job.pollTimer) { clearInterval(job.pollTimer); job.pollTimer = null; }
      n += 1;
    }
  }
  return { paused: n };
}

// Read-only status for a project (works even if its jobs aren't loaded).
function projectStatus(parentDir) {
  const dbFile = dbFileFor(parentDir);
  let downloads = [];
  let imageCount = 0;
  try { downloads = db.getActiveDownloads(dbFile); } catch (_) { /* no db yet */ }
  try { imageCount = db.count(dbFile); } catch (_) { /* no db yet */ }
  const all = { pending: 0, in_progress: 0, blocked: 0, done: 0, failed: 0, broken: 0, skipped: 0, total: 0 };
  for (const d of downloads) { const c = db.queueCounts(dbFile, d.key); for (const k of Object.keys(all)) all[k] += c[k] || 0; }
  const projJobs = [...jobs.values()].filter((j) => j.parentDir === parentDir);
  const running = projJobs.some((j) => !j.cancelled && (j.draining || j.pollTimer || j.enumerating));
  const hasWork = all.pending > 0 || all.in_progress > 0 || all.blocked > 0 ||
    downloads.some((d) => !['EXTRACTED', 'DONE', 'FAILED', 'KILLED', 'CANCELLED', 'FILE_ERASED'].includes(d.status));
  return { activeDownloads: downloads.length, counts: all, imageCount, running, paused: !running && hasWork };
}

// Startup = paused. Closing the app is treated as pressing Pause: we do NOT
// auto-resume. We only un-orphan any in_progress rows (so a later Resume is
// clean) and register each active download as paused, so the UI shows it as
// resumable and Pause/Resume + status report correctly. Nothing drains/polls
// until the user presses Resume.
async function resumeOnStartup() {
  const parentDir = settings.getParentDir();
  if (!parentDir) return;
  try {
    const dbFile = dbFileFor(parentDir);
    db.resetInProgress(dbFile);
    const active = db.getActiveDownloads(dbFile);
    for (const row of active) {
      const job = jobs.get(row.key) || {};
      job.parentDir = parentDir; job.paused = true; job.cancelled = true;
      jobs.set(row.key, job);
    }
    if (active.length) push('gbif:jobsActive', active.map((r) => r.key));
    for (const row of active) pushProgress(parentDir, row.key);
  } catch (_) { /* no db yet */ }
}

function listActive() {
  const parentDir = settings.getParentDir();
  if (!parentDir) return [];
  try { return db.getActiveDownloads(dbFileFor(parentDir)).map((r) => ({ ...r, counts: db.queueCounts(dbFileFor(parentDir), r.key) })); }
  catch (_) { return []; }
}

module.exports = {
  init, submit, cancel, resume, resumeOnStartup, listActive,
  resumeProject, pauseProject, projectStatus,
  nextBlocked, saveBlocked, failBlocked, requeueBlocked, resetHostFailures,
};
