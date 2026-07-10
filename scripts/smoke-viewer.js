/*
 * Viewer backend smoke test. Run under Electron's ABI:
 *   env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/smoke-viewer.js
 *
 * Covers the CSV parser (round-trips gbif-api's writer, incl. quoted commas /
 * quotes / newlines), db.schema/rows/getRow, and viewer.listDwc/readDwcCsv +
 * imageByFilename/imageByGbifId against a populated parent_dir.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const paths = require('../src/server/paths');
const db = require('../src/server/db');
const api = require('../src/server/gbif-api');
const ds = require('../src/server/download-service');
const csv = require('../src/server/csv');
const viewer = require('../src/server/viewer');

function ok(label, cond) { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; }

(async () => {
  // --- CSV parser round-trips the writer's quoting -----------------------
  const sample = 'gbifID,note\n1,"a,b"\n2,"she said ""hi"""\n3,"line1\nline2"\n';
  const parsed = csv.parseCsv(sample);
  ok('csv: 3 rows, no phantom', parsed.rows.length === 3);
  ok('csv: embedded comma', parsed.rows[0].note === 'a,b');
  ok('csv: embedded quote', parsed.rows[1].note === 'she said "hi"');
  ok('csv: embedded newline', parsed.rows[2].note === 'line1\nline2');
  ok('csv: columns', parsed.columns.join(',') === 'gbifID,note');

  // --- populate a parent_dir --------------------------------------------
  const tmp = path.join(os.tmpdir(), 'da-vsmoke-' + process.pid);
  fs.rmSync(tmp, { recursive: true, force: true });
  const P = paths.ensurePaths(tmp);
  const dbFile = path.join(P.db, 'images.db');

  const search = 'https://www.gbif.org/occurrence/search?q=Franklinia%20alatamaha&basisOfRecord=PRESERVED_SPECIMEN&mediaType=StillImage&view=GALLERY';
  const en = await api.enumerateSearch(search, {});
  const pick = en.occurrences.slice(0, 3);
  const jpg = await sharp({ create: { width: 1000, height: 800, channels: 3, background: { r: 20, g: 180, b: 90 } } }).jpeg().toBuffer();
  let firstFilename = null;
  for (const o of pick) {
    const occ = await api.getOccurrenceRecord(o.gbif_id);
    const pub = await api.resolvePublisher(occ);
    const row = await ds.saveOne({ parentDir: tmp, occ, publisher: pub, imageBuffer: jpg });
    if (!firstFilename) firstFilename = row.filename;
  }
  await api.writeDwc(P.dwc, en.slug, pick.map((p) => p.gbif_id), { source_url: search });

  // --- db viewer helpers -------------------------------------------------
  const schema = db.schema(dbFile);
  ok('db.schema returns images columns (gbif_id pk)', schema.some((c) => c.name === 'gbif_id' && c.pk) && schema.some((c) => c.name === 'megapixels'));
  const rowsRes = db.rows(dbFile, { limit: 10, offset: 0 });
  ok('db.rows returns 3 + total', rowsRes.rows.length === 3 && rowsRes.total === 3);
  const searched = db.rows(dbFile, { limit: 10, offset: 0, search: 'Franklinia' });
  ok('db.rows search filters', searched.total >= 1 && searched.rows.every((r) => /Franklinia/i.test(JSON.stringify(r))));
  const one = db.getRow(dbFile, pick[0].gbif_id);
  ok('db.getRow resolves filename', one && one.filename === firstFilename);

  // --- viewer dwc + images ----------------------------------------------
  const folders = viewer.listDwc(P.dwc);
  ok('viewer.listDwc lists the search folder', folders.length === 1 && folders[0].slug === en.slug && folders[0].hasOccurrence);
  const dwcRows = viewer.readDwcCsv(P.dwc, en.slug, 'occurrence.csv', { limit: 100, offset: 0 });
  ok('viewer.readDwcCsv rows + columns', dwcRows.total === 3 && dwcRows.columns[0] === 'gbifID');
  // path traversal is blocked (basename)
  const escaped = viewer.readDwcCsv(P.dwc, '../../etc', 'occurrence.csv', {});
  ok('viewer.readDwcCsv blocks traversal', escaped.total === 0);

  const img1 = await viewer.imageByFilename(P.images, firstFilename);
  ok('viewer.imageByFilename -> data URL', img1 && img1.dataUrl.startsWith('data:image/jpeg;base64,') && img1.width > 0);
  const img2 = await viewer.imageByGbifId(dbFile, P.images, pick[0].gbif_id);
  ok('viewer.imageByGbifId -> data URL + filename', img2 && img2.filename === firstFilename);
  const imgMissing = await viewer.imageByGbifId(dbFile, P.images, '000000');
  ok('viewer.imageByGbifId null for unknown id', imgMissing === null);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(process.exitCode ? '\n=== VIEWER SMOKE FAILED ===' : '\n=== VIEWER SMOKE OK ===');
})().catch((e) => { console.error('VIEWER SMOKE THREW:', e); process.exit(1); });
