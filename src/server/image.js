/*
 * Image handling — the only module that touches `sharp`.
 *
 * The bytes arrive from the browser webview (the original file the institution
 * serves). We:
 *   1. decode with sharp to PROVE it's a real raster image — a bot-blocking
 *      host often returns an HTML "Request Rejected" page instead of the image,
 *      and we must never write that to disk as a .jpg;
 *   2. read true pixel dimensions (img_x, img_y) and megapixels (2 dp);
 *   3. keep the original JPEG bytes untouched when the source is already JPEG
 *      (no needless recompression), and transcode to JPEG only when it isn't.
 *
 * sharp ships prebuilt binaries and works under both Electron and plain Node;
 * electron-builder's install-app-deps rebuilds it for the packaged runtime.
 */

const sharp = require('sharp');

const JPEG_QUALITY = 92;

// Round to 2 decimal places, matching the DB spec for megapixels.
function round2(n) {
  return Math.round(n * 100) / 100;
}

/*
 * Validate + normalize downloaded bytes into a JPEG we can save, plus its
 * dimensions. Returns { buffer, width, height, megapixels }. Throws if the
 * bytes aren't a decodable image (caller treats that as a blocked/failed host).
 */
async function prepareImage(inputBuffer) {
  const meta = await sharp(inputBuffer).metadata(); // throws on non-images
  if (!meta || !meta.format || !meta.width || !meta.height) {
    throw new Error('Not a decodable image.');
  }

  let buffer = inputBuffer;
  let width = meta.width;
  let height = meta.height;

  if (meta.format !== 'jpeg') {
    // PNG/TIFF/etc. → transcode to JPEG, baking in EXIF orientation. Use the
    // encoder's reported dimensions (rotate() can swap width/height).
    const out = await sharp(inputBuffer, { failOn: 'none' })
      .rotate()
      .jpeg({ quality: JPEG_QUALITY, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    buffer = out.data;
    width = out.info.width;
    height = out.info.height;
  }

  return {
    buffer,
    width,
    height,
    megapixels: round2((width * height) / 1_000_000),
  };
}

module.exports = { prepareImage, round2 };
