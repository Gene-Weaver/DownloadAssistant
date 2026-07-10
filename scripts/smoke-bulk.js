/*
 * End-to-end smoke of the bulk pipeline WITHOUT the authenticated create/poll
 * (which needs a GBIF login): take a real DWCA zip, parse -> enqueue -> drain
 * (tier-1 direct fetch) -> saveOne, and confirm images + db rows + queue counts.
 *   env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke-bulk.js <dwca.zip>
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const db = require('../src/server/db');
const dwca = require('../src/server/dwca');
const imageFetch = require('../src/server/image-fetch');
const downloadService = require('../src/server/download-service');
const predicate = require('../src/server/predicate-builder');

function ok(l, c) { console.log(`${c ? 'PASS' : 'FAIL'}  ${l}`); if (!c) process.exitCode = 1; }

(async () => {
  const zip = process.argv[2];
  if (!zip || !fs.existsSync(zip)) { console.error('need a dwca zip path'); process.exit(1); }

  // predicate builder still good
  const { body } = predicate.buildDownloadRequest('https://www.gbif.org/occurrence/search?taxonKey=94JD&basisOfRecord=PRESERVED_SPECIMEN&mediaType=StillImage');
  ok('predicate: checklistKey top-level for 94JD', body.checklistKey === '7ddf754f-d193-4cc9-b351-99906754a03b');

  const tmp = path.join(os.tmpdir(), 'da-bulk-' + process.pid);
  fs.rmSync(tmp, { recursive: true, force: true });
  const P = require('../src/server/paths').ensurePaths(tmp);
  const dbFile = path.join(P.db, 'images.db');
  const KEY = 'testkey-0064539';

  db.insertDownload(dbFile, { key: KEY, slug: 'test', status: 'QUEUED', source_url: 'x', doi: '10.15468/dl.test' });
  ok('downloads row inserted with DOI', db.getDownload(dbFile, KEY).doi === '10.15468/dl.test');

  // parse + enqueue
  let batch = [];
  const flush = () => { if (batch.length) { db.enqueue(dbFile, batch); batch = []; } };
  await dwca.parseArchive(zip, {
    onOccurrence: ({ gbifId, urls, occ }) => {
      if (!urls.length) return;
      batch.push({ gbif_id: gbifId, download_key: KEY, image_url: urls[0], host: imageFetch.hostOf(urls[0]), occ_json: JSON.stringify(occ) });
    },
  });
  flush();
  let counts = db.queueCounts(dbFile, KEY);
  ok(`enqueued ${counts.pending} imaged occurrences`, counts.pending > 0);

  // mini drain: tier-1 direct only (no webview here)
  let done = 0, blocked = 0, failed = 0;
  const rows = db.nextQueueBatch(dbFile, { key: KEY, status: 'pending', limit: 100 });
  for (const row of rows) {
    try {
      const buf = await imageFetch.tryDirect(row.image_url);
      const occ = JSON.parse(row.occ_json);
      const r = await downloadService.saveOne({ parentDir: tmp, occ, publisher: null, imageBuffer: buf, imageUrl: row.image_url });
      db.setQueueStatus(dbFile, row.gbif_id, 'done'); done++;
      if (!global._sampleFile) global._sampleFile = r.filename;
    } catch (e) {
      if (e.blocked) { db.setQueueStatus(dbFile, row.gbif_id, 'blocked'); blocked++; }
      else { db.setQueueStatus(dbFile, row.gbif_id, 'failed'); failed++; }
    }
  }
  console.log(`     drained: ${done} direct-downloaded, ${blocked} blocked(->webview), ${failed} failed`);
  ok('some images downloaded directly (headless)', done > 0);
  ok('images written to disk + indexed', db.count(dbFile) === done);

  counts = db.queueCounts(dbFile, KEY);
  ok('queue counts reconcile', counts.done === done && counts.blocked === blocked);
  console.log('     sample filename:', global._sampleFile, '| queue:', JSON.stringify(counts));

  // verify a saved image file exists
  const anyImg = fs.readdirSync(P.images)[0];
  ok('image file on disk', !!anyImg && fs.statSync(path.join(P.images, anyImg)).size > 1000);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? '\n=== BULK SMOKE FAILED ===' : '\n=== BULK SMOKE OK ===');
})().catch((e) => { console.error('BULK SMOKE THREW:', e); process.exit(1); });
