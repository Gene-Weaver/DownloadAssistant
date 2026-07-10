/*
 * Streaming Darwin Core Archive reader for GBIF occurrence-download zips.
 *
 * Scale: occurrence.txt can be millions of rows / multi-GB, so nothing is ever
 * buffered whole — yauzl opens ONE entry at a time as a stream, and we read it
 * line-by-line. GBIF exports are TAB-delimited, UTF-8, with fieldsEnclosedBy=""
 * (NO quoting) — GBIF sanitizes embedded tabs/newlines in values — so a plain
 * split('\t') per line is correct and fast (no CSV quote parsing needed).
 * Column names come from the header row (GBIF uses DwC term local names).
 *
 * parseArchive streams multimedia.txt into a gbifID->[url] map first, then
 * streams occurrence.txt, joining media and emitting one compact record each.
 * extractFiles pulls GBIF's real DwC files out to the dwc/{slug}/ folder.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    // autoClose:false — we iterate all entries first to locate the ones we want,
    // THEN open read streams; the default autoClose would shut the file after the
    // entry walk and every later openReadStream would fail with "closed".
    yauzl.open(zipPath, { lazyEntries: true, autoClose: false }, (err, zf) => {
      if (err) return reject(err);
      const entries = new Map();
      zf.on('entry', (e) => { entries.set(e.fileName, e); zf.readEntry(); });
      zf.on('end', () => resolve({ zf, entries }));
      zf.on('error', reject);
      zf.readEntry();
    });
  });
}

function findEntry(entries, name) {
  for (const [k, e] of entries) {
    if (k === name || k.endsWith(`/${name}`) || path.basename(k) === name) return e;
  }
  return null;
}

function openEntryStream(zf, entry) {
  return new Promise((resolve, reject) => {
    zf.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

// Stream a tab-delimited entry, calling onRow(objectKeyedByHeader) per data row.
async function streamTsv(stream, onRow) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    if (header === null) { header = line.split('\t'); continue; }
    if (!line) continue;
    const cells = line.split('\t');
    const row = {};
    for (let i = 0; i < header.length; i++) row[header[i]] = cells[i] !== undefined ? cells[i] : '';
    onRow(row);
  }
}

// Compact, saveOne-shaped occurrence object built from occurrence.txt columns
// (so the image stage needs ZERO per-record API calls).
function compactOcc(row, id) {
  const num = (v) => (v !== undefined && v !== '' ? Number(v) : null);
  return {
    key: id, gbifID: id,
    institutionCode: row.institutionCode || null,
    institutionID: row.institutionID || null,
    ownerInstitutionCode: row.ownerInstitutionCode || null,
    collectionCode: row.collectionCode || null,
    occurrenceID: row.occurrenceID || null,
    order: row.order || null,
    family: row.family || null,
    genus: row.genus || null,
    specificEpithet: row.specificEpithet || null,
    scientificName: row.scientificName || null,
    decimalLatitude: num(row.decimalLatitude),
    decimalLongitude: num(row.decimalLongitude),
    continent: row.continent || null,
    country: row.country || null,
    stateProvince: row.stateProvince || null,
    eventDate: row.eventDate || null,
    publishingOrgKey: row.publishingOrgKey || null,
  };
}

/*
 * Stream the archive. For every occurrence with media, calls
 * onOccurrence({ gbifId, urls: [imageUrl…], occ }). Returns { count, mediaCount }.
 * `onOccurrence` should batch its own DB writes (never accumulate here).
 */
async function parseArchive(zipPath, { onOccurrence }) {
  const { zf, entries } = await openZip(zipPath);
  try {
    // 1) media map: gbifID -> [direct image URL]
    const media = new Map();
    const mmEntry = findEntry(entries, 'multimedia.txt');
    if (mmEntry) {
      const s = await openEntryStream(zf, mmEntry);
      await streamTsv(s, (row) => {
        const id = row.gbifID;
        const url = row.identifier || row.references;
        if (!id || !url) return;
        if (!media.has(id)) media.set(id, []);
        media.get(id).push(url);
      });
    }
    // 2) occurrences, joined to media
    const occEntry = findEntry(entries, 'occurrence.txt');
    if (!occEntry) throw new Error('occurrence.txt not found in the archive.');
    let count = 0;
    const os = await openEntryStream(zf, occEntry);
    await streamTsv(os, (row) => {
      const id = row.gbifID;
      if (!id) return;
      const urls = media.get(id) || [];
      onOccurrence({ gbifId: id, urls, occ: compactOcc(row, id) });
      count += 1;
    });
    return { count, mediaCount: media.size };
  } finally {
    try { zf.close(); } catch (_) { /* noop */ }
  }
}

// Extract named entries (GBIF's real DwC files) to destDir. Returns the basenames written.
async function extractFiles(zipPath, destDir, names) {
  const { zf, entries } = await openZip(zipPath);
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  try {
    for (const name of names) {
      const e = findEntry(entries, name);
      if (!e) continue;
      const s = await openEntryStream(zf, e);
      const dest = path.join(destDir, path.basename(name));
      await pipeline(s, fs.createWriteStream(dest));
      written.push(path.basename(name));
    }
  } finally {
    try { zf.close(); } catch (_) { /* noop */ }
  }
  return written;
}

module.exports = { parseArchive, extractFiles };
