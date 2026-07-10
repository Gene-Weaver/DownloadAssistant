/*
 * Viewer tab.
 *
 * Three columns: a 20% list of stacked row buttons (gbifId · fullname), a 50%
 * JSON view of the selected row, and a 30% image preview. Clicking the preview
 * opens a lightbox with zoom/pan and prev/next cycling through the current page.
 *
 * Sources: DATABASE (images.db schema + rows) and DWC FOLDERS (a dwc/{slug}/
 * occurrence.csv | multimedia.csv). Images are delivered as downsized data URLs
 * over IPC (the CSP blocks external file://).
 *
 * Exposes window.DA.ViewerPage = { mount, refresh, setParentReady }.
 */
(function () {
  const api = window.DA.api;
  const esc = window.DA.ui.esc;

  const state = {
    src: 'db', folder: null, file: 'occurrence.csv', search: '',
    page: 0, pageSize: 100, total: 0,
    parentReady: false, mounted: false, imgToken: 0,
    rows: [], selectedIndex: -1, folders: [], onlyFailures: true, finalOnly: false,
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
    let v;
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
      // URL values (e.g. fetch-log image_url / gbif_url) open in the real browser
      // — the window-open handler routes http(s) to shell.openExternal.
      v = document.createElement('a');
      v.className = 'jtree-val str jtree-link';
      v.textContent = value; v.href = value; v.title = 'Open in browser';
      v.addEventListener('click', (e) => { e.preventDefault(); try { window.open(value); } catch (_) {} });
    } else {
      v = document.createElement('span');
      v.className = 'jtree-val ' + valClass(value); v.textContent = fmtVal(value);
    }
    leaf.append(k, v);
    return leaf;
  }
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
    const build = () => { if (built) return; built = true; for (const [ck, cv] of entries) children.append(isScalar(cv) ? makeLeaf(ck, cv) : makeNode(ck, cv)); };
    if (expanded) build();
    head.addEventListener('click', () => {
      const collapsed = node.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '▸' : '▾';
      if (!collapsed) build();
    });
    node.append(head, children);
    return node;
  }

  function rowLabel(rec) {
    if (state.src === 'db') {
      return `${rec.gbif_id != null ? rec.gbif_id : '?'} · ${rec.fullname || rec.scientific_name || ''}`.trim();
    }
    if (state.src === 'log') {
      return `${rec.host || '?'} · ${rec.outcome || ''}${rec.http_status ? ` ${rec.http_status}` : ''}`;
    }
    const id = rec.gbifID || rec.gbif_id || '?';
    if (state.file === 'multimedia.csv') return `${id} · ${rec.type || rec.format || 'media'}`;
    return `${id} · ${rec.scientificName || rec.acceptedScientificName || rec.genus || ''}`.trim();
  }

  // --- rows (left) + json (middle) -----------------------------------------
  function renderEmpty(msg) { els.list.innerHTML = `<div class="vw-empty">${esc(msg)}</div>`; }
  function clearJson() { els.json.innerHTML = '<div class="vw-empty">— select a row to view its fields —</div>'; }

  function renderRows(records) {
    state.rows = records || [];
    state.selectedIndex = -1;
    els.list.innerHTML = '';
    if (!state.rows.length) { renderEmpty('— no rows —'); clearJson(); clearImage(); return; }
    state.rows.forEach((rec, idx) => {
      const btn = document.createElement('button');
      btn.className = 'vw-row-btn';
      btn.textContent = rowLabel(rec);
      btn.title = rowLabel(rec);
      btn.addEventListener('click', () => selectRow(idx));
      els.list.append(btn);
    });
    selectRow(0); // auto-show the first row
  }

  function highlightRow(index) {
    state.selectedIndex = index;
    const btns = els.list.querySelectorAll('.vw-row-btn');
    btns.forEach((b, i) => b.classList.toggle('selected', i === index));
    if (btns[index]) btns[index].scrollIntoView({ block: 'nearest' });
    renderJson(state.rows[index]);
  }

  function selectRow(index) {
    if (index < 0 || index >= state.rows.length) return;
    highlightRow(index);
    loadImage(state.rows[index]);
  }

  function renderJson(rec) {
    els.json.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'jtree';
    for (const [k, v] of Object.entries(rec)) box.append(isScalar(v) ? makeLeaf(k, v) : makeNode(k, v));
    els.json.append(box);
  }

  // --- image panel (right) --------------------------------------------------
  function setImageState(mode, opts = {}) {
    if (mode === 'image') {
      els.imgEmpty.hidden = true;
      els.img.hidden = false;
      els.img.src = opts.dataUrl;
      // Report the STORED image's megapixels (not the downsized preview's pixels).
      const mp = (opts.megapixels != null && opts.megapixels !== '') ? `${opts.megapixels} MP` : '';
      els.imgCap.textContent = `${opts.filename || ''}${mp ? '  ·  ' + mp : ''}`.trim();
      return;
    }
    els.img.hidden = true; els.img.removeAttribute('src'); els.imgCap.textContent = '';
    els.imgEmpty.hidden = false;
    els.imgEmpty.classList.toggle('missing', mode === 'missing');
    els.imgEmpty.textContent = mode === 'loading' ? '◌ loading…'
      : mode === 'missing' ? `◇ ${opts.msg}`
      : '◇ select an item to preview its image';
  }
  function clearImage() { state.imgToken++; setImageState('hint'); }

  // Fetch the selected row's image at a given max dimension (panel: 1400,
  // lightbox: 2600). DB row → by filename (fallback by gbif_id); DwC row → by id.
  function resolveImage(rec, maxDim) {
    if (state.src === 'db') {
      if (rec.filename) return Promise.resolve(api.viewer.imageByFilename(rec.filename, maxDim))
        .then((r) => r || (rec.gbif_id ? api.viewer.imageByGbifId(rec.gbif_id, maxDim) : null));
      if (rec.gbif_id) return Promise.resolve(api.viewer.imageByGbifId(rec.gbif_id, maxDim));
      return Promise.resolve(null);
    }
    const id = rec.gbifID || rec.gbifID_images || rec.gbif_id;
    return id ? Promise.resolve(api.viewer.imageByGbifId(id, maxDim)) : Promise.resolve(null);
  }

  async function loadImage(rec) {
    const token = ++state.imgToken;
    setImageState('loading');
    let res = null;
    try { res = await resolveImage(rec, 1400); } catch (_) { /* handled below */ }
    if (token !== state.imgToken) return; // superseded
    if (res && res.dataUrl) {
      const megapixels = state.src === 'db' ? rec.megapixels : res.megapixels;
      setImageState('image', { ...res, megapixels });
    } else setImageState('missing', { msg: state.src === 'dwc' ? 'not downloaded yet' : 'image file missing' });
  }

  // --- lightbox (zoom + pan + prev/next) -----------------------------------
  const lb = { el: null, img: null, cap: null, zlabel: null, open: false, index: -1, scale: 1, tx: 0, ty: 0, dragging: false, lastX: 0, lastY: 0, token: 0 };

  function applyTransform() {
    lb.img.style.transform = `translate(${lb.tx}px, ${lb.ty}px) scale(${lb.scale})`;
    if (lb.zlabel) lb.zlabel.textContent = `${Math.round(lb.scale * 100)}%`;
  }
  function resetZoom() { lb.scale = 1; lb.tx = 0; lb.ty = 0; applyTransform(); }
  function zoomBy(f) {
    lb.scale = Math.min(8, Math.max(1, lb.scale * f));
    if (lb.scale === 1) { lb.tx = 0; lb.ty = 0; }
    applyTransform();
  }

  function buildLightbox() {
    const el = document.createElement('div');
    el.className = 'vw-lightbox';
    el.hidden = true;
    el.innerHTML = `
      <button class="vw-lb-close" title="Close (Esc)">✕</button>
      <button class="vw-lb-arrow vw-lb-prev" title="Previous (←)">‹</button>
      <img class="vw-lb-img grab" alt="" />
      <button class="vw-lb-arrow vw-lb-next" title="Next (→)">›</button>
      <div class="vw-lb-bar">
        <button class="vw-lb-zoombtn" data-z="out" title="Zoom out">−</button>
        <span class="vw-lb-zlabel">100%</span>
        <button class="vw-lb-zoombtn" data-z="in" title="Zoom in">+</button>
        <button class="vw-lb-zoombtn" data-z="reset" title="Reset">⟲</button>
        <span class="vw-lb-cap"></span>
        <span class="vw-lb-hint">scroll = zoom · drag = pan · ←/→ = cycle</span>
      </div>`;
    document.body.append(el);
    lb.el = el;
    lb.img = el.querySelector('.vw-lb-img');
    lb.cap = el.querySelector('.vw-lb-cap');
    lb.zlabel = el.querySelector('.vw-lb-zlabel');

    el.querySelector('.vw-lb-close').addEventListener('click', closeLightbox);
    el.querySelector('.vw-lb-prev').addEventListener('click', (e) => { e.stopPropagation(); lbStep(-1); });
    el.querySelector('.vw-lb-next').addEventListener('click', (e) => { e.stopPropagation(); lbStep(1); });
    el.querySelectorAll('.vw-lb-zoombtn').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const z = b.dataset.z;
      if (z === 'in') zoomBy(1.25); else if (z === 'out') zoomBy(0.8); else resetZoom();
    }));
    el.addEventListener('click', (e) => { if (e.target === el) closeLightbox(); }); // backdrop
    lb.img.addEventListener('click', (e) => e.stopPropagation());
    lb.img.addEventListener('wheel', (e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.12 : 0.89); }, { passive: false });
    lb.img.addEventListener('mousedown', (e) => { e.preventDefault(); lb.dragging = true; lb.lastX = e.clientX; lb.lastY = e.clientY; lb.img.classList.add('grabbing'); });
    window.addEventListener('mousemove', (e) => { if (!lb.dragging) return; lb.tx += e.clientX - lb.lastX; lb.ty += e.clientY - lb.lastY; lb.lastX = e.clientX; lb.lastY = e.clientY; applyTransform(); });
    window.addEventListener('mouseup', () => { if (lb.dragging) { lb.dragging = false; lb.img.classList.remove('grabbing'); } });
    lb.img.addEventListener('dblclick', (e) => { e.preventDefault(); if (lb.scale > 1) resetZoom(); else zoomBy(2); });
  }

  function lbKey(e) {
    if (e.key === 'Escape') closeLightbox();
    else if (e.key === 'ArrowLeft') lbStep(-1);
    else if (e.key === 'ArrowRight') lbStep(1);
    else if (e.key === '+' || e.key === '=') zoomBy(1.25);
    else if (e.key === '-') zoomBy(0.8);
  }

  async function lbLoad(index) {
    resetZoom();
    const token = ++lb.token;
    const rec = state.rows[index];
    lb.img.hidden = false;
    lb.img.removeAttribute('src');
    lb.cap.textContent = 'loading…';
    let res = null;
    try { res = await resolveImage(rec, 2600); } catch (_) { /* handled below */ }
    if (token !== lb.token || !lb.open) return;
    if (res && res.dataUrl) {
      lb.img.hidden = false;
      lb.img.src = res.dataUrl;
      const mp = state.src === 'db' ? rec.megapixels : res.megapixels;
      lb.cap.textContent = `${res.filename || rowLabel(rec)}${mp != null && mp !== '' ? `  ·  ${mp} MP` : ''}`;
    } else {
      lb.img.hidden = true;
      lb.cap.textContent = `${state.src === 'dwc' ? 'not downloaded yet' : 'image file missing'} — ${rowLabel(rec)}`;
    }
  }

  function lbStep(delta) {
    if (!state.rows.length) return;
    let i = lb.index + delta;
    if (i < 0) i = state.rows.length - 1;
    if (i >= state.rows.length) i = 0;
    lb.index = i;
    highlightRow(i);   // keep the left list + JSON in sync (no panel refetch)
    lbLoad(i);
  }

  function openLightbox(index) {
    if (index < 0 || index >= state.rows.length) return;
    if (!lb.el) buildLightbox();
    lb.open = true; lb.index = index; lb.el.hidden = false;
    document.addEventListener('keydown', lbKey);
    lbLoad(index);
  }
  function closeLightbox() {
    lb.open = false;
    if (lb.el) lb.el.hidden = true;
    document.removeEventListener('keydown', lbKey);
    // sync the panel image to wherever we cycled to
    if (state.rows[lb.index]) loadImage(state.rows[lb.index]);
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
    if (els.failOnly) els.failOnly.hidden = true;
    if (els.finalOnly) els.finalOnly.hidden = true;
    try { const info = await api.viewer.dbSchema(); renderSchema(info.columns, info.rowCount); }
    catch (_) { els.schema.innerHTML = ''; }
    await loadDbRows();
  }
  async function loadDbRows() {
    const res = await api.viewer.dbRows({ limit: state.pageSize, offset: state.page * state.pageSize, search: state.search });
    state.total = res.total;
    if (!res.rows.length && !state.search) { renderEmpty('— database is empty (nothing acquired yet) —'); clearJson(); clearImage(); }
    else renderRows(res.rows);
    els.count.textContent = `${res.total} row(s)`;
    setPager(res.offset, res.rows.length, res.total);
  }

  async function loadDwc(reloadFolders) {
    els.schema.hidden = true; els.schema.innerHTML = '';
    els.folder.hidden = false; els.file.hidden = false;
    if (els.failOnly) els.failOnly.hidden = true;
    if (els.finalOnly) els.finalOnly.hidden = true;
    if (reloadFolders) {
      const folders = await api.viewer.listDwc();
      state.folders = folders;
      if (!folders.length) {
        els.folder.innerHTML = '<option>— none —</option>';
        renderEmpty('— no Darwin Core folders yet —'); clearJson(); clearImage();
        els.count.textContent = ''; setPager(0, 0, 0); state.folder = null;
        return;
      }
      els.folder.innerHTML = folders.map((f) => {
        const n = (f.meta && f.meta.count != null) ? ` (${f.meta.count})` : '';
        const doi = (f.meta && f.meta.doi) ? ' ★' : ''; // ★ = has a GBIF download DOI
        return `<option value="${esc(f.slug)}">${esc(f.slug)}${n}${doi}</option>`;
      }).join('');
      if (state.folder && folders.some((f) => f.slug === state.folder)) els.folder.value = state.folder;
      else { state.folder = folders[0].slug; els.folder.value = state.folder; }
    }
    if (!state.folder) return;
    updateFileOptions();
    await loadDwcRows();
  }

  // Populate the file dropdown from the selected folder's actual files (a quick
  // search has occurrence.csv; a full download has GBIF's occurrence.txt etc.).
  function updateFileOptions() {
    const folder = state.folders.find((f) => f.slug === state.folder);
    const files = (folder && folder.files && folder.files.length) ? folder.files : ['occurrence.csv'];
    els.file.innerHTML = files.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    if (!files.includes(state.file)) state.file = files[0];
    els.file.value = state.file;
  }
  async function loadDwcRows() {
    const res = await api.viewer.dwcRows(state.folder, state.file, { limit: state.pageSize, offset: state.page * state.pageSize, search: state.search });
    state.total = res.total;
    if (!res.rows.length && !state.search) { renderEmpty(`— ${state.file} is empty —`); clearJson(); clearImage(); }
    else renderRows(res.rows);
    els.count.textContent = `${res.total} row(s) · ${state.file}`;
    setPager(res.offset, res.rows.length, res.total);
  }
  // --- FETCH LOG (failure analytics) --------------------------------------
  async function loadFetchLog() {
    els.folder.hidden = true; els.file.hidden = true;
    els.schema.hidden = false;
    if (els.failOnly) els.failOnly.hidden = false;
    if (els.finalOnly) els.finalOnly.hidden = false;
    try { renderFetchSummary(await api.viewer.fetchStats()); }
    catch (_) { els.schema.innerHTML = ''; }
    await loadFetchLogRows();
  }

  // Per-domain trend strip: which hosts bot-block / break / fail, and the UA that
  // wins for each (from the winners aggregate).
  function renderFetchSummary(stats) {
    const byHost = (stats && stats.byHost) || [];
    if (!byHost.length) { els.schema.innerHTML = '<span class="vw-schema-title">FETCH LOG — no attempts recorded yet</span>'; return; }
    const totalAtt = byHost.reduce((a, h) => a + (h.attempts || 0), 0);
    const win = {};
    for (const w of ((stats && stats.winners) || [])) { if (!win[w.host]) win[w.host] = w.method; }
    const sorted = byHost.slice().sort((a, b) =>
      ((b.blocked + b.broken + b.failed) - (a.blocked + a.broken + a.failed)) || (b.attempts - a.attempts));
    const chips = sorted.slice(0, 50).map((h) => {
      const bad = (h.blocked || 0) + (h.broken || 0) + (h.failed || 0);
      const title = win[h.host] ? `wins via ${win[h.host]}` : '';
      return `<span class="vw-schema-chip${bad ? ' bad' : ''}" title="${esc(title)}"><b>${esc(h.host)}</b> ${h.ok || 0}✓${h.blocked ? ` ${h.blocked}⊘` : ''}${h.broken ? ` ${h.broken}✗` : ''}${h.failed ? ` ${h.failed}⚠` : ''}</span>`;
    }).join('');
    els.schema.innerHTML = `<span class="vw-schema-title">FETCH LOG · ${totalAtt.toLocaleString()} attempts · ${byHost.length} hosts · ✓ok ⊘blocked ✗broken ⚠failed</span>${chips}`;
  }

  async function loadFetchLogRows() {
    const res = await api.viewer.fetchLog({ limit: state.pageSize, offset: state.page * state.pageSize, search: state.search, onlyFailures: state.onlyFailures, finalOnly: state.finalOnly });
    state.total = res.total;
    const noun = state.finalOnly ? 'terminal failure' : state.onlyFailures ? 'failure' : 'attempt';
    if (!res.rows.length) renderEmpty(`— no ${noun}s logged —`);
    else renderRows(res.rows);
    els.count.textContent = `${res.total.toLocaleString()} ${noun}(s)`;
    setPager(res.offset, res.rows.length, res.total);
  }

  function reloadRows() {
    if (state.src === 'db') loadDbRows();
    else if (state.src === 'log') loadFetchLogRows();
    else loadDwcRows();
  }

  function setPager(offset, shown, total) {
    els.prev.disabled = state.page <= 0;
    els.next.disabled = offset + shown >= total;
    els.pageinfo.textContent = total ? `${offset + 1}–${offset + shown} / ${total}` : '0 / 0';
  }

  // --- source switch / wiring ----------------------------------------------
  function setSource(src) {
    if (src === state.src) return;
    state.src = src; state.page = 0; state.search = ''; els.search.value = '';
    els.srcBtns.forEach((b) => b.classList.toggle('active', b.dataset.src === src));
    refresh();
  }

  function refresh() {
    if (!state.mounted) return;
    if (!state.parentReady) {
      els.schema.innerHTML = ''; els.schema.hidden = true;
      els.folder.hidden = true; els.file.hidden = true;
      if (els.failOnly) els.failOnly.hidden = true;
    if (els.finalOnly) els.finalOnly.hidden = true;
      renderEmpty('◍ set a save location above to browse downloaded data');
      clearJson(); clearImage();
      els.count.textContent = ''; setPager(0, 0, 0);
      return;
    }
    state.page = 0;
    if (state.src === 'db') loadDb();
    else if (state.src === 'log') loadFetchLog();
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
    els.failOnly = document.getElementById('vw-failonly');
    els.failOnlyCb = document.getElementById('vw-failonly-cb');
    els.finalOnly = document.getElementById('vw-finalonly');
    els.finalOnlyCb = document.getElementById('vw-finalonly-cb');
    els.search = document.getElementById('vw-search');
    els.count = document.getElementById('vw-count');
    els.refresh = document.getElementById('vw-refresh');
    els.schema = document.getElementById('vw-schema');
    els.list = document.getElementById('vw-list');
    els.json = document.getElementById('vw-json');
    els.prev = document.getElementById('vw-prev');
    els.next = document.getElementById('vw-next');
    els.pageinfo = document.getElementById('vw-pageinfo');
    els.imgEmpty = document.getElementById('vw-image-empty');
    els.img = document.getElementById('vw-image-img');
    els.imgCap = document.getElementById('vw-image-cap');

    els.srcBtns.forEach((b) => b.addEventListener('click', () => setSource(b.dataset.src)));
    els.folder.addEventListener('change', () => { state.folder = els.folder.value; state.page = 0; updateFileOptions(); loadDwcRows(); });
    els.file.addEventListener('change', () => { state.file = els.file.value; state.page = 0; loadDwcRows(); });
    els.failOnlyCb.addEventListener('change', () => { state.onlyFailures = els.failOnlyCb.checked; state.page = 0; loadFetchLogRows(); });
    els.finalOnlyCb.addEventListener('change', () => { state.finalOnly = els.finalOnlyCb.checked; state.page = 0; loadFetchLogRows(); });
    els.search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => { state.search = els.search.value.trim(); state.page = 0; reloadRows(); }, 250);
    });
    els.refresh.addEventListener('click', () => refresh());
    els.prev.addEventListener('click', () => { if (state.page > 0) { state.page--; reloadRows(); } });
    els.next.addEventListener('click', () => { state.page++; reloadRows(); });
    els.img.addEventListener('click', () => { if (!els.img.hidden && state.selectedIndex >= 0) openLightbox(state.selectedIndex); });

    clearJson();
    state.mounted = true;
    // Do not auto-load; app.js calls refresh() when the tab is shown.
  }

  window.DA = window.DA || {};
  window.DA.ViewerPage = { mount, refresh, setParentReady };
})();
