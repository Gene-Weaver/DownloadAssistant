/*
 * Viewer tab.
 *
 * Browses what's been downloaded under the current parent_dir:
 *   - DATABASE: the images.db schema (PRAGMA strip) + its rows, each rendered as
 *     a collapsible JSON-tree item.
 *   - DWC FOLDERS: pick a dwc/{slug}/ folder + occurrence.csv|multimedia.csv and
 *     browse its rows as JSON-tree items.
 * Selecting/expanding a row loads its image into the right-hand panel (delivered
 * as a downsized data: URL over IPC, since the CSP blocks external file://).
 *
 * Exposes window.DA.ViewerPage = { mount, refresh, setParentReady } — same shape
 * as GbifPage; app.js drives it.
 */
(function () {
  const api = window.DA.api;
  const esc = window.DA.ui.esc;

  const state = {
    src: 'db', folder: null, file: 'occurrence.csv', search: '',
    page: 0, pageSize: 100, total: 0,
    parentReady: false, mounted: false, imgToken: 0, selectedEl: null,
  };
  const els = {};
  let searchTimer = null;

  // --- JSON tree ------------------------------------------------------------
  const isScalar = (v) => v === null || typeof v !== 'object';
  function valClass(v) {
    if (v === null || v === '') return 'null';
    if (typeof v === 'number') return 'num';
    if (typeof v === 'boolean') return 'bool';
    return 'str';
  }
  function fmtVal(v) {
    if (v === null) return 'null';
    if (v === '') return '∅';
    return String(v);
  }

  function makeLeaf(key, value) {
    const leaf = document.createElement('div');
    leaf.className = 'jtree-leaf';
    const k = document.createElement('span'); k.className = 'jtree-key'; k.textContent = key;
    const v = document.createElement('span'); v.className = 'jtree-val ' + valClass(value); v.textContent = fmtVal(value);
    leaf.append(k, v);
    return leaf;
  }

  // Collapsible object/array node; children are built LAZILY on first expand so
  // collapsed rows never construct DOM.
  function makeNode(label, value, { expanded = false } = {}) {
    const node = document.createElement('div');
    node.className = 'jtree-node' + (expanded ? '' : ' collapsed');
    const head = document.createElement('div'); head.className = 'jtree-head';
    const toggle = document.createElement('span'); toggle.className = 'jtree-toggle'; toggle.textContent = expanded ? '▾' : '▸';
    const k = document.createElement('span'); k.className = 'jtree-key'; k.textContent = label;
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v]) : Object.entries(value);
    const preview = document.createElement('span'); preview.className = 'jtree-preview';
    preview.textContent = Array.isArray(value) ? `[${value.length}]` : `{${entries.length}}`;
    head.append(toggle, k, preview);

    const children = document.createElement('div'); children.className = 'jtree-children';
    let built = false;
    const build = () => {
      if (built) return; built = true;
      for (const [ck, cv] of entries) children.append(isScalar(cv) ? makeLeaf(ck, cv) : makeNode(ck, cv));
    };
    if (expanded) build();

    const setExpanded = (exp) => {
      node.classList.toggle('collapsed', !exp);
      toggle.textContent = exp ? '▾' : '▸';
      if (exp) build();
    };
    node._setExpanded = setExpanded;
    node._head = head;
    node._toggleFromHead = () => setExpanded(node.classList.contains('collapsed'));
    node.append(head, children);
    return node;
  }

  // --- row rendering --------------------------------------------------------
  function rowLabel(rec) {
    if (state.src === 'db') {
      return `${rec.gbif_id != null ? rec.gbif_id : '?'} · ${rec.fullname || rec.scientific_name || ''}`.trim();
    }
    const id = rec.gbifID || rec.gbif_id || '?';
    if (state.file === 'multimedia.csv') return `${id} · ${rec.type || rec.format || 'media'}`;
    return `${id} · ${rec.scientificName || rec.acceptedScientificName || rec.genus || ''}`.trim();
  }

  function renderRows(records) {
    els.list.innerHTML = '';
    state.selectedEl = null;
    if (!records.length) { els.list.innerHTML = '<div class="vw-empty">— no rows —</div>'; return; }
    for (const rec of records) {
      const node = makeNode(rowLabel(rec), rec, { expanded: false });
      node.classList.add('jtree-row');
      node._head.addEventListener('click', () => {
        node._toggleFromHead();
        selectRow(node, rec);
      });
      els.list.append(node);
    }
  }

  function renderEmpty(msg) {
    els.list.innerHTML = `<div class="vw-empty">${esc(msg)}</div>`;
  }

  // --- image panel ----------------------------------------------------------
  function setImageState(mode, opts = {}) {
    // mode: 'hint' | 'loading' | 'missing' | 'image'
    if (mode === 'image') {
      els.imgEmpty.hidden = true;
      els.img.hidden = false;
      els.img.src = opts.dataUrl;
      els.imgCap.textContent = `${opts.filename || ''}  ${opts.width}×${opts.height}`.trim();
      return;
    }
    els.img.hidden = true; els.img.src = ''; els.imgCap.textContent = '';
    els.imgEmpty.hidden = false;
    els.imgEmpty.classList.toggle('missing', mode === 'missing');
    els.imgEmpty.textContent = mode === 'loading' ? '◌ loading…'
      : mode === 'missing' ? `◇ ${opts.msg}`
      : '◇ select an item to preview its image';
  }

  function clearImage() {
    if (state.selectedEl) { state.selectedEl.classList.remove('selected'); state.selectedEl = null; }
    state.imgToken++; // invalidate any in-flight load
    setImageState('hint');
  }

  function selectRow(node, rec) {
    if (state.selectedEl && state.selectedEl !== node) state.selectedEl.classList.remove('selected');
    node.classList.add('selected');
    state.selectedEl = node;
    loadImage(rec);
  }

  async function loadImage(rec) {
    const token = ++state.imgToken;
    setImageState('loading');
    let res = null;
    try {
      if (state.src === 'db') {
        if (rec.filename) res = await api.viewer.imageByFilename(rec.filename);
        if (!res && rec.gbif_id) res = await api.viewer.imageByGbifId(rec.gbif_id);
      } else {
        const id = rec.gbifID || rec.gbifID_images || rec.gbif_id;
        if (id) res = await api.viewer.imageByGbifId(id);
      }
    } catch (_) { /* handled below */ }
    if (token !== state.imgToken) return; // a newer selection superseded this
    if (res && res.dataUrl) setImageState('image', res);
    else setImageState('missing', { msg: state.src === 'dwc' ? 'not downloaded yet' : 'image file missing' });
  }

  // --- loaders --------------------------------------------------------------
  function renderSchema(columns, rowCount) {
    if (!columns.length) { els.schema.innerHTML = ''; return; }
    const chips = columns.map((c) => {
      const flags = [];
      if (c.pk) flags.push('PK');
      if (c.notnull) flags.push('NN');
      return `<span class="vw-schema-chip${c.pk ? ' pk' : ''}"><b>${esc(c.name)}</b> ${esc((c.type || '').toLowerCase())}${flags.length ? ` <i>${flags.join(' ')}</i>` : ''}</span>`;
    }).join('');
    els.schema.innerHTML = `<span class="vw-schema-title">TABLE images · ${rowCount} rows</span>${chips}`;
  }

  async function loadDb() {
    els.folder.hidden = true; els.file.hidden = true; els.schema.hidden = false;
    try {
      const info = await api.viewer.dbSchema();
      renderSchema(info.columns, info.rowCount);
    } catch (_) { els.schema.innerHTML = ''; }
    await loadDbRows();
  }

  async function loadDbRows() {
    const res = await api.viewer.dbRows({ limit: state.pageSize, offset: state.page * state.pageSize, search: state.search });
    state.total = res.total;
    if (!res.rows.length && !state.search) renderEmpty('— database is empty (nothing acquired yet) —');
    else renderRows(res.rows);
    els.count.textContent = `${res.total} row(s)`;
    setPager(res.offset, res.rows.length, res.total);
    clearImage();
  }

  async function loadDwc(reloadFolders) {
    els.schema.hidden = true; els.schema.innerHTML = '';
    els.folder.hidden = false; els.file.hidden = false;
    if (reloadFolders) {
      const folders = await api.viewer.listDwc();
      if (!folders.length) {
        els.folder.innerHTML = '<option>— none —</option>';
        renderEmpty('— no Darwin Core folders yet —');
        els.count.textContent = ''; setPager(0, 0, 0); clearImage();
        state.folder = null;
        return;
      }
      els.folder.innerHTML = folders.map((f) => {
        const n = (f.meta && f.meta.count != null) ? ` (${f.meta.count})` : '';
        return `<option value="${esc(f.slug)}">${esc(f.slug)}${n}</option>`;
      }).join('');
      if (state.folder && folders.some((f) => f.slug === state.folder)) els.folder.value = state.folder;
      else { state.folder = folders[0].slug; els.folder.value = state.folder; }
    }
    if (!state.folder) return;
    await loadDwcRows();
  }

  async function loadDwcRows() {
    const res = await api.viewer.dwcRows(state.folder, state.file, { limit: state.pageSize, offset: state.page * state.pageSize, search: state.search });
    state.total = res.total;
    if (!res.rows.length && !state.search) renderEmpty(`— ${state.file} is empty —`);
    else renderRows(res.rows);
    els.count.textContent = `${res.total} row(s) · ${state.file}`;
    setPager(res.offset, res.rows.length, res.total);
    clearImage();
  }

  function reloadRows() {
    if (state.src === 'db') loadDbRows();
    else loadDwcRows();
  }

  // --- pager ----------------------------------------------------------------
  function setPager(offset, shown, total) {
    els.prev.disabled = state.page <= 0;
    els.next.disabled = offset + shown >= total;
    els.pageinfo.textContent = total ? `${offset + 1}–${offset + shown} / ${total}` : '0 / 0';
  }

  // --- source switch / wiring ----------------------------------------------
  function setSource(src) {
    if (src === state.src) return;
    state.src = src;
    state.page = 0;
    state.search = ''; els.search.value = '';
    state.folder = state.folder; // keep last dwc folder if any
    els.srcBtns.forEach((b) => b.classList.toggle('active', b.dataset.src === src));
    refresh();
  }

  function refresh() {
    if (!state.mounted) return;
    if (!state.parentReady) {
      els.schema.innerHTML = ''; els.schema.hidden = true;
      els.folder.hidden = true; els.file.hidden = true;
      renderEmpty('◍ set a save location above to browse downloaded data');
      els.count.textContent = ''; setPager(0, 0, 0); clearImage();
      return;
    }
    state.page = 0;
    if (state.src === 'db') loadDb();
    else loadDwc(true);
  }

  function setParentReady(ready) {
    state.parentReady = !!ready;
    if (state.mounted) refresh();
  }

  function mount() {
    els.srcBtns = Array.from(document.querySelectorAll('#tab-viewer .vw-src-btn'));
    els.folder = document.getElementById('vw-folder');
    els.file = document.getElementById('vw-file');
    els.search = document.getElementById('vw-search');
    els.count = document.getElementById('vw-count');
    els.refresh = document.getElementById('vw-refresh');
    els.schema = document.getElementById('vw-schema');
    els.list = document.getElementById('vw-list');
    els.prev = document.getElementById('vw-prev');
    els.next = document.getElementById('vw-next');
    els.pageinfo = document.getElementById('vw-pageinfo');
    els.imgEmpty = document.getElementById('vw-image-empty');
    els.img = document.getElementById('vw-image-img');
    els.imgCap = document.getElementById('vw-image-cap');

    els.srcBtns.forEach((b) => b.addEventListener('click', () => setSource(b.dataset.src)));
    els.folder.addEventListener('change', () => { state.folder = els.folder.value; state.page = 0; loadDwcRows(); });
    els.file.addEventListener('change', () => { state.file = els.file.value; state.page = 0; loadDwcRows(); });
    els.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = els.search.value.trim(); state.page = 0; reloadRows(); }, 250);
    });
    els.refresh.addEventListener('click', () => refresh());
    els.prev.addEventListener('click', () => { if (state.page > 0) { state.page--; reloadRows(); } });
    els.next.addEventListener('click', () => { state.page++; reloadRows(); });

    state.mounted = true;
    // Do not auto-load; app.js calls refresh() when the tab is first shown.
  }

  window.DA = window.DA || {};
  window.DA.ViewerPage = { mount, refresh, setParentReady };
})();
