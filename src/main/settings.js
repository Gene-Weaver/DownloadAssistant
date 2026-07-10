/*
 * Persisted settings + the PROJECTS registry (the app is a multi-location
 * download manager). A single JSON file in userData holds:
 *   { projects: [{ id, name, parentDir, addedAt, lastActiveAt }],
 *     currentProjectId, workerCount }
 *
 * A "project" is just a save-location (parent_dir) with its own images/ dwc/
 * db/. Setting a save location creates-or-selects a project, so projects can
 * live anywhere. getParentDir() returns the current project's location, keeping
 * the rest of the app (which is single-project at a time) unchanged.
 */

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function file() { return path.join(app.getPath('userData'), 'settings.json'); }

function read() {
  let s;
  try { s = JSON.parse(fs.readFileSync(file(), 'utf8')); }
  catch (_) { return {}; }
  // Migrate the legacy single-{parentDir} settings into the projects registry.
  if (s.parentDir && (!s.projects || !s.projects.length)) {
    const resolved = path.resolve(s.parentDir);
    const proj = { id: genId(), name: path.basename(resolved) || resolved, parentDir: resolved, addedAt: now(), lastActiveAt: now() };
    s.projects = [proj];
    s.currentProjectId = proj.id;
    delete s.parentDir;
    write(s);
  }
  return s;
}
function write(obj) {
  try { fs.writeFileSync(file(), JSON.stringify(obj, null, 2)); }
  catch (_) { /* non-fatal */ }
}

let idCounter = 0;
function genId() { return `p${Date.now().toString(36)}${(idCounter++).toString(36)}`; }
function now() { return new Date().toISOString(); }

// --- projects --------------------------------------------------------------
function getProjects() { return read().projects || []; }

function getCurrentProject() {
  const s = read();
  return (s.projects || []).find((p) => p.id === s.currentProjectId) || null;
}

// Setting a save location = create-or-select the project living there.
function addOrSelectProject(parentDir, name) {
  const s = read();
  s.projects = s.projects || [];
  const resolved = path.resolve(String(parentDir));
  let proj = s.projects.find((p) => p.parentDir === resolved);
  if (!proj) {
    proj = { id: genId(), name: name || path.basename(resolved) || resolved, parentDir: resolved, addedAt: now(), lastActiveAt: now() };
    s.projects.push(proj);
  } else {
    proj.lastActiveAt = now();
    if (name) proj.name = name;
  }
  s.currentProjectId = proj.id;
  write(s);
  return proj;
}

function setCurrentProject(id) {
  const s = read();
  const proj = (s.projects || []).find((p) => p.id === id);
  if (proj) { s.currentProjectId = id; proj.lastActiveAt = now(); write(s); }
  return getCurrentProject();
}

function renameProject(id, name) {
  const s = read();
  const proj = (s.projects || []).find((p) => p.id === id);
  if (proj && name) { proj.name = String(name).slice(0, 120); write(s); }
  return proj || null;
}

// Forget a project from the registry (does NOT delete its files on disk).
function removeProject(id) {
  const s = read();
  s.projects = (s.projects || []).filter((p) => p.id !== id);
  if (s.currentProjectId === id) s.currentProjectId = (s.projects[0] && s.projects[0].id) || null;
  write(s);
  return { ok: true, currentProjectId: s.currentProjectId };
}

// --- current parent_dir (back-compat single-project surface) ---------------
function getParentDir() {
  const p = getCurrentProject();
  return p ? p.parentDir : null;
}
function setParentDir(p) { return addOrSelectProject(p).parentDir; }

// --- worker count ----------------------------------------------------------
function getWorkerCount() {
  const n = read().workerCount;
  return (Number.isFinite(n) && n >= 1) ? Math.min(64, Math.floor(n)) : 16;
}
function setWorkerCount(n) {
  const s = read();
  s.workerCount = Math.max(1, Math.min(64, parseInt(n, 10) || 16));
  write(s);
  return s.workerCount;
}

module.exports = {
  getParentDir, setParentDir,
  getProjects, getCurrentProject, addOrSelectProject, setCurrentProject, renameProject, removeProject,
  getWorkerCount, setWorkerCount,
};
