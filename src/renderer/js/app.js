/*
 * App shell: the save-location header, the worker-count control, and the tab
 * bar. Owns the single source of truth for the current project's parent_dir and
 * notifies the tabs. Switching projects (Projects tab) re-points everything here.
 */
(function () {
  const api = window.DA.api;
  const { toast } = window.DA.ui;

  const state = { parentDir: null, paths: null, workerCount: 16, jobRunning: false };

  const els = {};
  function cache() {
    els.parentDir = document.getElementById('parent-dir');
    els.pick = document.getElementById('pick-dir');
    els.set = document.getElementById('set-dir');
    els.reveal = document.getElementById('reveal-dir');
    els.piStatus = document.getElementById('pi-status');
    els.piTree = document.getElementById('pi-tree');
    els.wkCount = document.getElementById('wk-count');
    els.wkDec = document.getElementById('wk-dec');
    els.wkInc = document.getElementById('wk-inc');
    els.workerCtl = document.getElementById('worker-ctl');
    els.tabs = Array.from(document.querySelectorAll('.tab'));
    els.panels = Array.from(document.querySelectorAll('.tab-panel'));
  }

  function renderLocation() {
    const ready = !!state.parentDir;
    els.reveal.disabled = !ready;
    els.piStatus.classList.toggle('ready', ready);
    els.piTree.hidden = !ready;
    if (ready) {
      els.piStatus.textContent = `◉ SAVE LOCATION LOCKED → ${state.parentDir}`;
      if (document.activeElement !== els.parentDir) els.parentDir.value = state.parentDir;
    } else {
      els.piStatus.textContent = '◍ NO SAVE LOCATION SET — set one to begin';
    }
    // Tell the tabs whether a save location is set.
    if (window.DA.GbifPage) window.DA.GbifPage.setParentReady(ready);
    if (window.DA.ViewerPage) window.DA.ViewerPage.setParentReady(ready);
  }

  async function applyParentDir(path) {
    if (!path || !String(path).trim()) { toast('Enter a folder path first.', 'error'); return; }
    try {
      const res = await api.settings.setParentDir(String(path).trim());
      state.parentDir = res.parentDir;
      state.paths = res.paths;
      renderLocation();
      toast(`Save location ready — images/ dwc/ db/ under ${res.parentDir}`, 'ok');
      if (window.DA.ProjectsPage) window.DA.ProjectsPage.refresh();
    } catch (err) {
      toast(err.message || 'Could not set that location.', 'error');
    }
  }

  // --- worker-count control ------------------------------------------------
  function renderWorkerControl() {
    if (!els.wkCount) return;
    els.wkCount.textContent = String(state.workerCount);
    // Locked while a download is actively running (paused/idle = editable).
    els.workerCtl.classList.toggle('locked', state.jobRunning);
    els.wkDec.disabled = state.jobRunning || state.workerCount <= 1;
    els.wkInc.disabled = state.jobRunning || state.workerCount >= 64;
    els.workerCtl.title = state.jobRunning
      ? `Locked at ${state.workerCount} while a download is running`
      : 'Workers per download run — change before starting/resuming';
  }
  async function setWorkers(n) {
    if (state.jobRunning) return;
    const clamped = Math.max(1, Math.min(64, n));
    state.workerCount = await api.settings.setWorkerCount(clamped);
    renderWorkerControl();
  }
  function wireWorkerControl() {
    els.wkDec.addEventListener('click', () => setWorkers(state.workerCount - 1));
    els.wkInc.addEventListener('click', () => setWorkers(state.workerCount + 1));
  }

  function wireHeader() {
    els.set.addEventListener('click', () => applyParentDir(els.parentDir.value));
    els.parentDir.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyParentDir(els.parentDir.value);
    });
    els.pick.addEventListener('click', async () => {
      const picked = await api.settings.pickDir();
      if (picked) { els.parentDir.value = picked; applyParentDir(picked); }
    });
    els.reveal.addEventListener('click', () => api.settings.reveal());
    wireWorkerControl();
  }

  function activateTab(id) {
    const tab = els.tabs.find((t) => t.dataset.tab === id && !t.disabled);
    if (!tab) return;
    els.tabs.forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab); });
    els.panels.forEach((p) => p.classList.toggle('active', p.id === `tab-${id}`));
    if (id === 'viewer' && window.DA.ViewerPage) window.DA.ViewerPage.refresh();
    if (id === 'projects' && window.DA.ProjectsPage) window.DA.ProjectsPage.refresh();
  }

  function wireTabs() {
    els.tabs.forEach((tab) => {
      if (tab.disabled) return;
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });
  }

  // Load (or reload after a project switch) the current save location + settings.
  async function loadSettings() {
    try {
      const s = await api.settings.get();
      state.parentDir = (s && s.parentDir) || null;
      state.paths = (s && s.paths) || null;
      if (s && s.workerCount) state.workerCount = s.workerCount;
    } catch (_) { /* first run */ }
    renderLocation();
    renderWorkerControl();
  }

  // Called by the Projects tab after switching/removing the current project.
  async function reloadProject() {
    await loadSettings();
    if (window.DA.ViewerPage) window.DA.ViewerPage.refresh();
  }

  async function init() {
    cache();
    wireHeader();
    wireTabs();

    if (window.DA.GbifPage) window.DA.GbifPage.mount();
    if (window.DA.ViewerPage) window.DA.ViewerPage.mount();
    if (window.DA.ProjectsPage) window.DA.ProjectsPage.mount();

    // A download job's state gates the worker control (only for the current
    // project). busy && !paused == actively running -> lock the control.
    api.gbif.onJobProgress((snap) => {
      if (!snap || !snap.parentDir || snap.parentDir !== state.parentDir) return;
      state.jobRunning = !!(snap.busy && !snap.paused);
      renderWorkerControl();
    });

    await loadSettings();

    // Deep-link support: index.html#viewer opens straight on that tab.
    const hash = (location.hash || '').replace('#', '');
    if (hash) activateTab(hash);
  }

  window.DA = window.DA || {};
  window.DA.getParentDir = () => state.parentDir;
  window.DA.reloadProject = reloadProject;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
