/*
 * Seed a parent_dir with real GBIF metadata + synthesized (solid-color) JPGs so
 * the Viewer tab can be exercised without hand-downloading images. Run under
 * Electron's ABI:
 *   env ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron scripts/seed.js /path/to/dir
 */
const os = require('os');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const paths = require('../src/server/paths');
const api = require('../src/server/gbif-api');
const ds = require('../src/server/download-service');

const TARGET = process.argv[2] || path.join(os.homedir(), 'da-viewer-test');

(async () => {
  fs.rmSync(TARGET, { recursive: true, force: true });
  const P = paths.ensurePaths(TARGET);

  const search = 'https://www.gbif.org/occurrence/search?q=Franklinia%20alatamaha&basisOfRecord=PRESERVED_SPECIMEN&mediaType=StillImage&view=GALLERY';
  const en = await api.enumerateSearch(search, {});
  const pick = en.occurrences.slice(0, 8);
  const colors = [[200, 40, 40], [40, 160, 80], [60, 90, 200], [200, 160, 40], [160, 60, 180], [40, 170, 180], [210, 110, 40], [120, 120, 120]];

  let i = 0;
  for (const o of pick) {
    const occ = await api.getOccurrenceRecord(o.gbif_id);
    const pub = await api.resolvePublisher(occ);
    const [r, g, b] = colors[i % colors.length];
    const w = 800 + (i * 37) % 600;
    const h = 600 + (i * 53) % 500;
    const jpg = await sharp({ create: { width: w, height: h, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
    const row = await ds.saveOne({ parentDir: TARGET, occ, publisher: pub, imageBuffer: jpg });
    console.log('seeded', row.filename || o.gbif_id);
    i++;
  }
  await api.writeDwc(P.dwc, en.slug, pick.map((p) => p.gbif_id), { source_url: search, api_url: en.api_url, total: en.total });
  console.log(`\nSEED DONE -> ${TARGET}  (${pick.length} items, dwc slug ${en.slug})`);
})().catch((e) => { console.error('SEED FAILED:', e); process.exit(1); });
