/*
 * Renderer namespace bootstrap — must be the FIRST script.
 *
 * preload.js exposes the IPC surface via contextBridge as window.__DA__ (a
 * frozen object). This copies its `api` onto a plain, mutable window.DA that the
 * rest of the renderer (ui.js, gbif.js, viewer.js, updater.js, app.js) extends
 * with window.DA.ui / GbifPage / ViewerPage / etc. Extending the frozen bridge
 * object directly would silently fail.
 */
window.DA = { api: (window.__DA__ && window.__DA__.api) || {} };
