/*
 * Image-download capture.
 *
 * Some institution image hosts serve occurrence images with
 * `Content-Disposition: attachment`, so navigating the hidden webview to the
 * image URL triggers a DOWNLOAD (and, by default, an OS "Save As" dialog)
 * instead of rendering the image inline — which breaks the renderer's
 * same-origin fetch trick.
 *
 * During an active import we capture those downloads silently to a temp file
 * (setting a save path suppresses the dialog) and stream the bytes back to the
 * renderer, so forced-download images acquire exactly like inline ones.
 *
 * Capture is GATED to active import operations (setCapturing) so a user's own
 * downloads while browsing still behave normally (dialog + save).
 *
 * Ported from IRIS_Electron/src/main/gbif-capture.js.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { session } = require('electron');

let capturing = false;
let win = null;
let attached = false;

function setCapturing(on) { capturing = !!on; }

function setup(mainWindow) {
  win = mainWindow; // keep the reference fresh across window re-creation
  if (attached) return; // attach the session listener only once
  attached = true;
  // The GBIF browse + fetch webviews share this partition (persist:gbif) so the
  // download here happens in the same session that already cleared Cloudflare
  // and carries the right cookies. Future source tabs can add their own.
  const ses = session.fromPartition('persist:gbif');

  ses.on('will-download', (event, item) => {
    if (!capturing) return; // user-initiated download while browsing → default behaviour

    let tmp = null;
    try {
      tmp = path.join(os.tmpdir(), `da-gbif-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
      item.setSavePath(tmp); // a preset path suppresses the Save dialog
    } catch (_) { /* fall through — done handler still reports failure */ }

    const url = item.getURL();
    const chain = (item.getURLChain && item.getURLChain()) || [url];

    item.once('done', (_e, state) => {
      let payload = { url, chain, ok: false };
      if (state === 'completed' && tmp) {
        try {
          payload = { url, chain, ok: true, dataBase64: fs.readFileSync(tmp).toString('base64') };
        } catch (_) { /* ok stays false */ }
      }
      try { if (tmp) fs.unlinkSync(tmp); } catch (_) {}
      if (win && !win.isDestroyed()) win.webContents.send('gbif:download', payload);
    });
  });
}

module.exports = { setup, setCapturing };
