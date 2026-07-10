/*
 * App shell: the save-location header and the tab bar. Owns the single source
 * of truth for whether a parent_dir is set, and notifies the active tab so it
 * can enable/disable its acquire actions.
 */
(function () {
  const api = window.DA.api;
  const { toast } = window.DA.ui;

  const state = { parentDir: null, paths: null };

  const els = {};
  function cache() {
    els.parentDir = document.getElementById('parent-dir');
    els.pick = document.getElementById('pick-dir');
    els.set = document.getElementById('set-dir');
    els.reveal = document.getElementById('reveal-dir');
    els.piStatus = document.getElementById('pi-status');
    els.piTree = document.getElementById('pi-tree');
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
      toast(`Save location ready — images/ dwc/ db/ created under ${res.parentDir}`, 'ok');
    } catch (err) {
      toast(err.message || 'Could not set that location.', 'error');
    }
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
  }

  function activateTab(id) {
    const tab = els.tabs.find((t) => t.dataset.tab === id && !t.disabled);
    if (!tab) return;
    els.tabs.forEach((t) => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab); });
    els.panels.forEach((p) => p.classList.toggle('active', p.id === `tab-${id}`));
    // The Viewer loads lazily each time it's shown, so it always reflects disk.
    if (id === 'viewer' && window.DA.ViewerPage) window.DA.ViewerPage.refresh();
  }

  function wireTabs() {
    els.tabs.forEach((tab) => {
      if (tab.disabled) return;
      tab.addEventListener('click', () => activateTab(tab.dataset.tab));
    });
  }

  async function init() {
    cache();
    wireHeader();
    wireTabs();

    if (window.DA.GbifPage) window.DA.GbifPage.mount();
    if (window.DA.ViewerPage) window.DA.ViewerPage.mount();

    try {
      const s = await api.settings.get();
      if (s && s.parentDir) { state.parentDir = s.parentDir; state.paths = s.paths; }
    } catch (_) { /* first run */ }
    renderLocation();

    // Deep-link support: index.html#viewer opens straight on that tab.
    const hash = (location.hash || '').replace('#', '');
    if (hash) activateTab(hash);
  }

  window.DA = window.DA || {};
  window.DA.getParentDir = () => state.parentDir;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
