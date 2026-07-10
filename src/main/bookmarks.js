/*
 * Saved-search bookmarks — app-wide, keyed by domain.
 *
 * Bookmarks belong to the app (not to a parent_dir), so they live in a single
 * JSON file in userData alongside settings.json, shaped:
 *
 *   { "gbif.org": [ { id, url, label, created_at }, … ], … }
 *
 * Today only the GBIF tab uses it (domain "gbif.org"); when more source tabs are
 * added each passes its own domain and gets its own list, so the feature is
 * generic from day one.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() {
  return path.join(app.getPath('userData'), 'bookmarks.json');
}

function readAll() {
  try { return JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (_) { return {}; }
}

function writeAll(obj) {
  try { fs.writeFileSync(file(), JSON.stringify(obj, null, 2)); }
  catch (_) { /* non-fatal: bookmarks just won't persist */ }
}

let counter = 0;
function genId() {
  counter += 1;
  return `${Date.now().toString(36)}${counter.toString(36)}`;
}

function list(domain) {
  if (!domain) return [];
  return readAll()[domain] || [];
}

function add(domain, url, label) {
  if (!domain || !url) throw new Error('Nothing to bookmark yet.');
  const all = readAll();
  const arr = all[domain] || [];
  const existing = arr.find((b) => b.url === url);
  if (existing) return { duplicate: true, item: existing };
  const item = { id: genId(), url, label: label || url, created_at: new Date().toISOString() };
  arr.unshift(item);
  all[domain] = arr;
  writeAll(all);
  return { duplicate: false, item };
}

function remove(domain, id) {
  const all = readAll();
  const arr = all[domain] || [];
  all[domain] = arr.filter((b) => b.id !== id);
  writeAll(all);
  return { ok: true };
}

module.exports = { list, add, remove };
