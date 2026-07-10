const path = require('path');
const { BrowserWindow, shell } = require('electron');
const capture = require('./capture');

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    title: 'Download Assistant',
    backgroundColor: '#04070c', // matches the terminal theme so there's no white flash
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Each source tab (GBIF today, more later) embeds the live site in a
      // <webview> — an out-of-process guest, unlike an <iframe> which most of
      // these sites block via X-Frame-Options. Image bytes are pulled through
      // this guest's real browser session; see src/renderer/js/gbif.js.
      webviewTag: true,
    },
  });

  // Open filling the screen (maximized) by default — the browse webview wants
  // the room. The width/height above are the restored-down size.
  win.maximize();

  // DA_START_TAB (optional) deep-links the initial tab, e.g. DA_START_TAB=viewer.
  const indexHtml = path.join(__dirname, '..', 'renderer', 'index.html');
  win.loadFile(indexHtml, process.env.DA_START_TAB ? { hash: process.env.DA_START_TAB } : undefined);

  // Silently capture forced-download images (Content-Disposition: attachment)
  // during an active import so they don't pop an OS Save dialog — see capture.js.
  capture.setup(win);

  // The renderer is a trusted local page; it must never navigate away from
  // itself. Any http(s) link (or popup) opens in the system browser instead.
  // NB: this governs the renderer's own webContents, NOT the <webview> guest —
  // the guest browses freely inside the tab.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  return win;
}

module.exports = { createMainWindow };
