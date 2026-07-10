/*
 * IPC handlers — the bridge between the renderer (via preload) and the
 * framework-agnostic server layer. Each handler mirrors a preload method.
 *
 * The renderer never knows the parent_dir; it's read from persisted settings
 * here and injected into the server calls, so the save location is a single
 * source of truth.
 */

const path = require('path');
const { ipcMain, dialog, shell } = require('electron');

const settings = require('./settings');
const capture = require('./capture');
const bookmarks = require('./bookmarks');
const paths = require('../server/paths');
const db = require('../server/db');
const api = require('../server/gbif-api');
const downloadService = require('../server/download-service');
const viewer = require('../server/viewer');
const downloadJobs = require('./download-jobs');
const authProvider = require('./auth');
const gbifDownloadApi = require('../server/gbif-download-api');

function dbFileFor(parentDir) {
  return parentDir ? path.join(paths.resolvePaths(parentDir).db, 'images.db') : null;
}

// data: URL | bare base64 | byte array -> Buffer
function decodeImage(imageData) {
  if (!imageData) return null;
  if (Buffer.isBuffer(imageData)) return imageData;
  if (imageData instanceof Uint8Array || Array.isArray(imageData)) return Buffer.from(imageData);
  if (typeof imageData === 'string') {
    const b64 = imageData.replace(/^data:[^,]*,/, '');
    return Buffer.from(b64, 'base64');
  }
  return null;
}

// The current window, updated on every register() call. Handlers are registered
// once (ipcMain.handle throws on a second registration); push channels use this
// mutable reference so a re-created window (macOS dock re-activate) still works.
let currentWin = null;
let registered = false;

function register(win) {
  currentWin = win;
  if (registered) return;
  registered = true;

  // --- settings / save location -----------------------------------------
  ipcMain.handle('settings:get', () => {
    const pd = settings.getParentDir();
    return { parentDir: pd, paths: pd ? paths.resolvePaths(pd) : null };
  });

  ipcMain.handle('settings:setParentDir', (_e, p) => {
    if (!p || !String(p).trim()) throw new Error('Enter a folder path.');
    // Creating the tree here is how a full typed path "creates new dirs if they
    // don't exist" — mkdir -p on parent_dir + images/ dwc/ db/.
    const resolved = paths.ensurePaths(String(p).trim());
    settings.setParentDir(resolved.root);
    return { parentDir: resolved.root, paths: resolved };
  });

  ipcMain.handle('settings:pickDir', async () => {
    const res = await dialog.showOpenDialog(currentWin, {
      title: 'Choose a save location (parent_dir)',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('settings:reveal', () => {
    const pd = settings.getParentDir();
    if (!pd) return false;
    shell.openPath(paths.resolvePaths(pd).images);
    return true;
  });

  // --- GBIF --------------------------------------------------------------
  ipcMain.handle('gbif:getOccurrence', async (_e, ref) => {
    const id = api.parseOccurrenceId(ref);
    if (!id) throw new Error('No GBIF occurrence selected. Open a specimen on GBIF (click an image), then Add.');
    const occ = await api.getOccurrenceRecord(id);
    const meta = await api.buildMeta(occ, { resolvePublisher: true });
    const pd = settings.getParentDir();
    const duplicate = pd ? db.hasImage(dbFileFor(pd), id) : false;
    return { ...meta, duplicate };
  });

  ipcMain.handle('gbif:enumerateSearch', async (_e, searchUrl) => {
    const res = await api.enumerateSearch(searchUrl, {
      onProgress: (found, total) => {
        if (currentWin && !currentWin.isDestroyed()) currentWin.webContents.send('gbif:enumProgress', { found, total });
      },
    });
    const pd = settings.getParentDir();
    if (pd) {
      const ids = db.listDownloadedIds(dbFileFor(pd));
      for (const o of res.occurrences) o.already_downloaded = ids.has(o.gbif_id);
    } else {
      for (const o of res.occurrences) o.already_downloaded = false;
    }
    return res;
  });

  ipcMain.handle('gbif:saveImport', async (_e, gbifId, imageDataUrl) => {
    const pd = settings.getParentDir();
    if (!pd) throw new Error('Set a save location (parent_dir) first.');
    const id = String(gbifId);
    const dbFile = dbFileFor(pd);
    if (db.hasImage(dbFile, id)) return { gbif_id: id, duplicate: true };

    const buffer = decodeImage(imageDataUrl);
    if (!buffer || !buffer.length) {
      throw new Error('No image data captured — try again after the image finishes loading.');
    }
    const occ = await api.getOccurrenceRecord(id);
    const publisher = await api.resolvePublisher(occ);
    return downloadService.saveOne({ parentDir: pd, occ, publisher, imageBuffer: buffer });
  });

  ipcMain.handle('gbif:writeDwc', async (_e, slug, ids, searchMeta) => {
    const pd = settings.getParentDir();
    if (!pd) return null;
    const dwcRoot = paths.resolvePaths(pd).dwc;
    return api.writeDwc(dwcRoot, slug, ids || [], searchMeta || {});
  });

  ipcMain.handle('gbif:setCapture', (_e, on) => {
    capture.setCapturing(!!on);
    return true;
  });

  // --- GBIF bulk download jobs (DWCA archive + DOI + resumable image queue) ---
  ipcMain.handle('gbif:acquireSearch', (_e, searchUrl) => downloadJobs.submit(searchUrl));
  ipcMain.handle('gbif:cancelJob', (_e, key) => downloadJobs.cancel(key));
  ipcMain.handle('gbif:resumeJob', (_e, key) => downloadJobs.resume(key));
  ipcMain.handle('gbif:listJobs', () => downloadJobs.listActive());
  ipcMain.handle('gbif:nextBlocked', (_e, key, limit) => {
    const pd = settings.getParentDir();
    return pd ? downloadJobs.nextBlocked(pd, key, limit) : [];
  });
  ipcMain.handle('gbif:saveBlocked', async (_e, key, gbifId, dataUrl, method, trail) => {
    const pd = settings.getParentDir();
    if (!pd) return { ok: false };
    const buf = decodeImage(dataUrl);
    if (!buf || !buf.length) { downloadJobs.failBlocked(pd, key, gbifId, { kind: 'failed', trail }); return { ok: false }; }
    await downloadJobs.saveBlocked(pd, key, gbifId, buf, method, trail);
    return { ok: true };
  });
  ipcMain.handle('gbif:failBlocked', (_e, key, gbifId, info) => {
    const pd = settings.getParentDir();
    if (pd) downloadJobs.failBlocked(pd, key, gbifId, info);
    return true;
  });

  // --- GBIF auth (webview JWT preferred; .env Basic fallback) -------------
  ipcMain.handle('auth:status', async () => { await authProvider.scanCookies(); return authProvider.status(); });
  ipcMain.handle('auth:setToken', (_e, token) => authProvider.setWebviewToken(token));
  ipcMain.handle('auth:clear', () => authProvider.clearWebviewToken());
  ipcMain.handle('auth:verify', async () => {
    const a = authProvider.getAuth();
    if (!a) return { ok: false, reason: 'no-credentials' };
    try { return await gbifDownloadApi.verifyAuth(a); } catch (e) { return { ok: false, error: e.message }; }
  });

  // --- saved-search bookmarks (app-wide, per domain) ---------------------
  ipcMain.handle('bookmarks:list', (_e, domain) => bookmarks.list(domain));
  ipcMain.handle('bookmarks:add', (_e, domain, url, label) => bookmarks.add(domain, url, label));
  ipcMain.handle('bookmarks:remove', (_e, domain, id) => bookmarks.remove(domain, id));

  // --- Viewer (browse the downloaded db + dwc + images) ------------------
  // Every handler returns an empty/null shape when no parent_dir is set, so the
  // renderer can show an empty state instead of erroring.
  ipcMain.handle('viewer:dbSchema', () => {
    const pd = settings.getParentDir();
    if (!pd) return { table: 'images', columns: [], rowCount: 0 };
    const dbFile = dbFileFor(pd);
    return { table: 'images', columns: db.schema(dbFile), rowCount: db.count(dbFile) };
  });

  ipcMain.handle('viewer:dbRows', (_e, opts) => {
    const pd = settings.getParentDir();
    if (!pd) return { rows: [], total: 0, limit: 100, offset: 0 };
    return db.rows(dbFileFor(pd), opts || {});
  });

  ipcMain.handle('viewer:listDwc', () => {
    const pd = settings.getParentDir();
    if (!pd) return [];
    return viewer.listDwc(paths.resolvePaths(pd).dwc);
  });

  ipcMain.handle('viewer:dwcRows', async (_e, slug, file, opts) => {
    const pd = settings.getParentDir();
    if (!pd) return { columns: [], rows: [], total: 0, limit: 100, offset: 0 };
    return viewer.readDwcCsv(paths.resolvePaths(pd).dwc, slug, file, opts || {});
  });

  ipcMain.handle('viewer:imageByFilename', async (_e, filename, maxDim) => {
    const pd = settings.getParentDir();
    if (!pd) return null;
    return viewer.imageByFilename(paths.resolvePaths(pd).images, filename, maxDim || 1400);
  });

  ipcMain.handle('viewer:imageByGbifId', async (_e, gbifId, maxDim) => {
    const pd = settings.getParentDir();
    if (!pd) return null;
    return viewer.imageByGbifId(dbFileFor(pd), paths.resolvePaths(pd).images, gbifId, maxDim || 1400);
  });
}

module.exports = { register };
