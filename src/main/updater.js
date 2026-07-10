/*
 * Auto-update wiring (electron-updater, GitHub Releases feed).
 *
 * Mirrors the app's IPC conventions: the renderer talks to main only through
 * preload (window.DA.api.updater.*), which maps 1:1 to the ipcMain.handle
 * channels here, and main pushes state changes back over a single webContents
 * channel ('updater:event', discriminated by .status).
 *
 * register(win) is called once after the window is created. It is a NO-OP in
 * development (app.isPackaged === false): an unpackaged tree has no
 * resources/app-update.yml (electron-builder writes it at pack time from
 * build.publish), so checkForUpdates() would just throw.
 *
 * Platform reality (see README): Windows (NSIS) and Linux (AppImage) auto-update
 * unsigned; macOS auto-update ONLY works when the app is Developer ID-signed AND
 * notarized (Squirrel.Mac validates the update's signature against the running
 * app). The CI + package.json wire mac signing; add the Apple secrets to enable it.
 */

const { app, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');

let wired = false;
let win = null; // mutable so a re-created window still receives updater events

function register(w) {
  win = w;
  if (!app.isPackaged) return;       // dev: no update feed, nothing to do
  if (wired) return;                 // guard against re-register on macOS activate
  wired = true;

  // Renderer drives the UX: no silent download, no surprise install.
  // autoInstallOnAppQuit still applies a downloaded update on the next quit.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  const send = (status, payload) => {
    if (win && !win.isDestroyed()) win.webContents.send('updater:event', { status, ...payload });
  };

  autoUpdater.on('checking-for-update', () => send('checking-for-update', {}));
  autoUpdater.on('update-available', (info) => send('update-available', {
    version: info.version, releaseNotes: info.releaseNotes, releaseName: info.releaseName, releaseDate: info.releaseDate,
  }));
  autoUpdater.on('update-not-available', (info) => send('update-not-available', { version: info && info.version }));
  autoUpdater.on('download-progress', (p) => send('download-progress', {
    percent: p.percent, transferred: p.transferred, total: p.total, bytesPerSecond: p.bytesPerSecond,
  }));
  autoUpdater.on('update-downloaded', (info) => send('update-downloaded', { version: info.version, releaseName: info.releaseName }));
  autoUpdater.on('error', (err) => send('error', { message: (err && err.message) || String(err) }));

  // --- renderer -> main control surface (mirrors preload methods) ----------

  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      if (!result) return { updateAvailable: false };
      // Use isUpdateAvailable — a non-null result does NOT imply an update.
      return { updateAvailable: !!result.isUpdateAvailable, version: result.updateInfo && result.updateInfo.version };
    } catch (err) {
      return { updateAvailable: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('updater:download', async () => {
    try {
      const files = await autoUpdater.downloadUpdate(); // progress via 'download-progress'
      return { ok: true, files };
    } catch (err) {
      return { ok: false, error: (err && err.message) || String(err) };
    }
  });

  ipcMain.handle('updater:quitAndInstall', () => {
    // Runs after the current tick; terminates the app (return value may not
    // reach the renderer). isSilent=false, isForceRunAfter=true → relaunch.
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return { ok: true };
  });
}

module.exports = { register };
