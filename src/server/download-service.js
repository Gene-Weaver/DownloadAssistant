/*
 * Download orchestrator: given an occurrence record + the image bytes the
 * renderer pulled through the webview, commit one specimen to disk + index.
 *
 *   1. skip if this GBIF id is already indexed (idempotent per parent_dir)
 *   2. validate/normalize the bytes to a JPEG and read its dimensions
 *   3. write {parent_dir}/images/{herbCode}_{gbifID}_{Family}_{Genus}_{sp}.jpg
 *   4. upsert one row into {parent_dir}/db/images.db
 *
 * The Darwin Core files (dwc/) are written separately by gbif-api.writeDwc so a
 * search's full DwC lands even for occurrences whose image download failed.
 */

const fs = require('fs');
const path = require('path');
const { ensurePaths } = require('./paths');
const db = require('./db');
const image = require('./image');
const { generateImageFilename } = require('./herb-code');
const { pickImageUrl } = require('./gbif-api');

const OCC_WEB = 'https://www.gbif.org/occurrence';

async function saveOne({ parentDir, occ, publisher, imageBuffer }) {
  const paths = ensurePaths(parentDir);
  const dbFile = path.join(paths.db, 'images.db');

  const gbifId = String(occ.key != null ? occ.key : occ.gbifID);
  if (db.hasImage(dbFile, gbifId)) return { gbif_id: gbifId, duplicate: true };

  // Validate + normalize first: a bot-blocking host may have returned an HTML
  // page instead of the image — prepareImage throws on that, so we never write
  // a broken .jpg or an index row for it.
  const prepared = await image.prepareImage(imageBuffer);

  const fn = generateImageFilename(occ, publisher);
  const outPath = path.join(paths.images, fn.filenameJpg);
  fs.writeFileSync(outPath, prepared.buffer);

  const row = {
    gbif_id: gbifId,
    herb_code: fn.herbCode,
    dwc_order: occ.order || null,
    family: occ.family || null,
    genus: occ.genus || null,
    specific_epithet: occ.specificEpithet || null,
    fullname: fn.fullname,
    scientific_name: occ.scientificName || null,
    latitude: occ.decimalLatitude != null ? occ.decimalLatitude : null,
    longitude: occ.decimalLongitude != null ? occ.decimalLongitude : null,
    continent: occ.continent || null,
    country: occ.country || null,
    state_province: occ.stateProvince || null,
    filename: fn.filenameJpg,
    img_x: prepared.width,
    img_y: prepared.height,
    megapixels: prepared.megapixels,
    occurrence_url: `${OCC_WEB}/${gbifId}`,
    image_url: pickImageUrl(occ),
    source: 'gbif',
    downloaded_at: new Date().toISOString(),
  };
  db.upsertImage(dbFile, row);

  return {
    gbif_id: gbifId,
    filename: fn.filenameJpg,
    herb_code: fn.herbCode,
    fullname: fn.fullname,
    img_x: prepared.width,
    img_y: prepared.height,
    megapixels: prepared.megapixels,
    duplicate: false,
  };
}

module.exports = { saveOne };
