/*
 * Backend smoke test. Run under Electron's ABI so the native modules
 * (better-sqlite3, sharp) load the same way they will in the app:
 *
 *   env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke.js
 *
 * Exercises: paths, image (valid + HTML-rejection), db, live GBIF enumerate +
 * metadata + herbCode, download-service.saveOne, and Darwin Core file output.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const paths = require('../src/server/paths');
const db = require('../src/server/db');
const image = require('../src/server/image');
const api = require('../src/server/gbif-api');
const ds = require('../src/server/download-service');

function ok(label, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; }

(async () => {
  // Use a fixed suffix (no Date.now dependence needed, but fine here).
  const tmp = path.join(os.tmpdir(), 'da-smoke-' + process.pid);
  fs.rmSync(tmp, { recursive: true, force: true });
  const P = paths.ensurePaths(tmp);
  ok('ensurePaths creates images/ dwc/ db/', fs.existsSync(P.images) && fs.existsSync(P.dwc) && fs.existsSync(P.db));

  // sharp: dimensions + megapixels (2dp)
  const jpg = await sharp({ create: { width: 1234, height: 987, channels: 3, background: { r: 200, g: 30, b: 30 } } }).jpeg().toBuffer();
  const prep = await image.prepareImage(jpg);
  ok('prepareImage dims 1234x987', prep.width === 1234 && prep.height === 987);
  ok('megapixels 2dp = ' + prep.megapixels, prep.megapixels === Math.round((1234 * 987 / 1e6) * 100) / 100);

  // sharp must reject a non-image (HTML "Request Rejected" page)
  let rejected = false;
  try { await image.prepareImage(Buffer.from('<html><body>Request Rejected</body></html>')); } catch (_) { rejected = true; }
  ok('prepareImage rejects HTML', rejected);

  // better-sqlite3
  const dbFile = path.join(P.db, 'images.db');
  db.upsertImage(dbFile, { gbif_id: '999', family: 'Testaceae', filename: 'X_999_Testaceae.jpg', img_x: 10, img_y: 10, megapixels: 0 });
  ok('db upsert + hasImage', db.hasImage(dbFile, '999') && db.count(dbFile) === 1);
  ok('db listDownloadedIds', db.listDownloadedIds(dbFile).has('999'));

  // live GBIF enumerate (Franklinia alatamaha ~ 2 pages)
  const search = 'https://www.gbif.org/occurrence/search?q=Franklinia%20alatamaha&basisOfRecord=PRESERVED_SPECIMEN&mediaType=StillImage&view=GALLERY';
  const en = await api.enumerateSearch(search, { onProgress: () => {} });
  ok(`enumerate got ${en.occurrences.length} of total ${en.total}, slug=${en.slug}`, en.occurrences.length > 0 && en.total > 0 && !!en.slug);
  const first = en.occurrences[0];
  console.log('     first:', first.gbif_id, first.filename);

  // metadata + herbCode via buildMeta
  const occ = await api.getOccurrenceRecord(first.gbif_id);
  const meta = await api.buildMeta(occ, { resolvePublisher: true });
  console.log('     meta:', JSON.stringify({ id: meta.gbif_id, herb: meta.herb_code, file: meta.filename, country: meta.country, continent: meta.continent, state: meta.state_province, lat: meta.latitude }));
  ok('buildMeta has filename + herb_code', !!meta.filename && !!meta.herb_code);

  // download-service.saveOne (real occ + synthesized image bytes)
  const pub = await api.resolvePublisher(occ);
  const row = await ds.saveOne({ parentDir: tmp, occ, publisher: pub, imageBuffer: jpg });
  const imgPath = path.join(P.images, row.filename);
  ok('saveOne wrote image file', fs.existsSync(imgPath));
  ok('saveOne indexed row (img_x/y/mp set)', db.hasImage(dbFile, row.gbif_id) && row.img_x === 1234 && row.megapixels > 0);
  // second save of same id is a no-op duplicate
  const dup = await ds.saveOne({ parentDir: tmp, occ, publisher: pub, imageBuffer: jpg });
  ok('saveOne dedupes by gbif_id', dup.duplicate === true);

  // Darwin Core files
  const ids = en.occurrences.slice(0, 3).map((o) => o.gbif_id);
  const dwc = await api.writeDwc(P.dwc, en.slug, ids, { source_url: search });
  const occCsv = path.join(dwc.dir, 'occurrence.csv');
  const mmCsv = path.join(dwc.dir, 'multimedia.csv');
  ok(`writeDwc wrote ${dwc.count} records + csvs`, fs.existsSync(occCsv) && fs.existsSync(mmCsv) && fs.existsSync(path.join(dwc.dir, 'search_meta.json')));
  const header = fs.readFileSync(occCsv, 'utf8').split('\n')[0];
  ok('occurrence.csv header starts with gbifID', header.startsWith('gbifID,'));
  console.log('     occurrence.csv header (trunc):', header.slice(0, 140));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? '\n=== SMOKE FAILED ===' : '\n=== SMOKE OK ===');
})().catch((e) => { console.error('SMOKE THREW:', e); process.exit(1); });
