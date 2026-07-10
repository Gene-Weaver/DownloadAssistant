/*
 * Tiny persisted-settings store: a single JSON file in the app's userData
 * directory. Right now it holds just the chosen parent_dir so the save location
 * survives restarts. (The image index + files live under parent_dir itself.)
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function read() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (_) { return {}; }
}

function write(obj) {
  try { fs.writeFileSync(file(), JSON.stringify(obj, null, 2)); }
  catch (_) { /* non-fatal: settings just won't persist */ }
}

function getParentDir() {
  const p = read().parentDir;
  return p && typeof p === 'string' ? p : null;
}

function setParentDir(p) {
  const s = read();
  s.parentDir = p;
  write(s);
  return p;
}

module.exports = { getParentDir, setParentDir };
