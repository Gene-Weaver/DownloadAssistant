/*
 * Main-process bootstrap: create the window, register IPC, standard app
 * lifecycle. Kept deliberately small — window construction is in window.js and
 * all IPC handlers in ipc.js.
 */

const { app, BrowserWindow } = require('electron');
const { createMainWindow } = require('./window');
const ipc = require('./ipc');
const updater = require('./updater');
const downloadJobs = require('./download-jobs');

// Single-instance: focus the existing window instead of opening a second one.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  let mainWindow = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    mainWindow = createMainWindow();
    ipc.register(mainWindow);
    updater.register(mainWindow); // no-op unless app.isPackaged
    downloadJobs.init(mainWindow);
    // Re-attach any in-flight GBIF download jobs once the window can receive them.
    mainWindow.webContents.once('did-finish-load', () => { downloadJobs.resumeOnStartup().catch(() => {}); });

    app.on('activate', () => {
      // macOS: re-create a window when the dock icon is clicked and none exist.
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
        ipc.register(mainWindow);
        updater.register(mainWindow);
        downloadJobs.init(mainWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
