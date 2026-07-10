/*
 * Preload bridge.
 *
 * Exposes a single object `window.DA.api` to the renderer with namespaced
 * methods that mirror the IPC channels one-for-one. The renderer never touches
 * ipcRenderer directly — everything goes through this surface, which keeps the
 * renderer a plain web page that a future web port could back with fetch().
 *
 * Unlike IRIS this is a single-user local tool, so there is no auth token —
 * handlers take their real arguments directly.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

const api = {
  settings: {
    get:            invoke('settings:get'),            // () -> { parentDir, paths, currentProject, workerCount }
    setParentDir:   invoke('settings:setParentDir'),   // (path) -> { parentDir, paths }
    pickDir:        invoke('settings:pickDir'),        // () -> path | null (dialog)
    reveal:         invoke('settings:reveal'),         // () -> bool (open images/ in Finder)
    setWorkerCount: invoke('settings:setWorkerCount'), // (n) -> clampedN
  },
  projects: {
    list:       invoke('projects:list'),       // () -> [{ id,name,parentDir,status,current }]
    setCurrent: invoke('projects:setCurrent'), // (id) -> { project, paths }
    resume:     invoke('projects:resume'),     // (id)
    pause:      invoke('projects:pause'),       // (id)
    rename:     invoke('projects:rename'),      // (id, name)
    remove:     invoke('projects:remove'),      // (id)
  },
  gbif: {
    getOccurrence:   invoke('gbif:getOccurrence'),   // (ref) -> meta (+duplicate)
    enumerateSearch: invoke('gbif:enumerateSearch'), // (searchUrl) -> { slug,total,capped,occurrences }
    saveImport:      invoke('gbif:saveImport'),      // (gbifId, imageDataUrl) -> row
    writeDwc:        invoke('gbif:writeDwc'),         // (slug, ids, searchMeta) -> { dir, count }
    setCapture:      invoke('gbif:setCapture'),       // (on) -> true
    // main -> renderer push channels
    onDownload:    (cb) => ipcRenderer.on('gbif:download',     (_e, d) => cb(d)),
    onEnumProgress:(cb) => ipcRenderer.on('gbif:enumProgress', (_e, d) => cb(d)),
    // --- bulk download jobs (DWCA archive + DOI + resumable image queue) ---
    acquireSearch: invoke('gbif:acquireSearch'), // (searchUrl) -> { key, doi, slug }
    cancelJob:     invoke('gbif:cancelJob'),      // (key)
    resumeJob:     invoke('gbif:resumeJob'),      // (key)
    listJobs:      invoke('gbif:listJobs'),       // () -> [rows+counts]
    nextBlocked:   invoke('gbif:nextBlocked'),    // (key, limit) -> [{gbif_id,image_url}]
    saveBlocked:   invoke('gbif:saveBlocked'),    // (key, gbifId, dataUrl, method, trail)
    failBlocked:   invoke('gbif:failBlocked'),    // (key, gbifId, {kind,status,trail})
    requeueBlocked:   invoke('gbif:requeueBlocked'),   // (key, gbifId) -> park a CF-gated row back to blocked
    resetHostFailures: invoke('gbif:resetHostFailures'), // (key, host) -> count reset to blocked
    hasClearance:     invoke('gbif:hasClearance'),      // (host) -> bool (cf_clearance cookie present)
    onJobProgress: (cb) => ipcRenderer.on('gbif:jobProgress', (_e, d) => cb(d)),
    onJobsActive:  (cb) => ipcRenderer.on('gbif:jobsActive',  (_e, d) => cb(d)),
    onWorkers:     (cb) => ipcRenderer.on('gbif:workers',     (_e, d) => cb(d)),
  },
  auth: {
    status:   invoke('auth:status'),   // () -> { available, method, username }
    setToken: invoke('auth:setToken'), // (jwt) -> status
    verify:   invoke('auth:verify'),   // () -> { ok, username? }
    clear:    invoke('auth:clear'),    // () -> status
  },
  viewer: {
    dbSchema:        invoke('viewer:dbSchema'),        // () -> { table, columns, rowCount }
    dbRows:          invoke('viewer:dbRows'),          // ({limit,offset,search}) -> { rows, total, limit, offset }
    listDwc:         invoke('viewer:listDwc'),         // () -> [{ slug, hasOccurrence, hasMultimedia, meta }]
    dwcRows:         invoke('viewer:dwcRows'),         // (slug, file, {limit,offset,search}) -> { columns, rows, total, limit, offset }
    imageByFilename: invoke('viewer:imageByFilename'), // (filename, maxDim?) -> { dataUrl, width, height } | null
    imageByGbifId:   invoke('viewer:imageByGbifId'),   // (gbifId, maxDim?) -> { dataUrl, width, height, filename } | null
    fetchLog:        invoke('viewer:fetchLog'),        // ({limit,offset,search,onlyFailures}) -> { rows, total, limit, offset }
    fetchStats:      invoke('viewer:fetchStats'),      // () -> { byHost, winners }
  },
  bookmarks: {
    list:   invoke('bookmarks:list'),   // (domain) -> [{ id, url, label, created_at }]
    add:    invoke('bookmarks:add'),    // (domain, url, label) -> { duplicate, item }
    remove: invoke('bookmarks:remove'), // (domain, id) -> { ok }
  },
  updater: {
    check:          invoke('updater:check'),          // () -> { updateAvailable, version? }
    download:       invoke('updater:download'),       // () -> { ok, files?|error? }
    quitAndInstall: invoke('updater:quitAndInstall'), // () -> { ok }
    // main -> renderer push; payload discriminated by .status
    onEvent: (cb) => ipcRenderer.on('updater:event', (_e, d) => cb(d)),
  },
};

// contextBridge FREEZES whatever object it exposes, so the renderer can't add
// its own namespaces (ui, GbifPage, ViewerPage, …) onto it. Expose the bridge
// under a private key; bootstrap.js copies `api` onto a plain, mutable window.DA
// that the renderer modules extend.
contextBridge.exposeInMainWorld('__DA__', { api });
