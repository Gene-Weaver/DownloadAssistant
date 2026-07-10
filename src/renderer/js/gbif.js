/*
 * GBIF tab.
 *
 * Embeds live gbif.org in a <webview> (an out-of-process guest — unlike an
 * <iframe>, which GBIF's X-Frame-Options blocks). Metadata comes from the open
 * GBIF JSON API (in the main process); the image BYTES are pulled the way a
 * human would — inside a hidden <webview> that shares the browse session
 * (cookies + Cloudflare clearance), we navigate straight to the image URL and
 * read the bytes with a same-origin fetch. Ported/adapted from
 * IRIS_Electron/src/renderer/js/pages/gbif.js.
 */
(function () {
  const api = window.DA.api;
  const { toast, promptImport, esc } = window.DA.ui;

  const HOME = 'https://www.gbif.org/occurrence/search?occurrenceStatus=present&view=GALLERY&basisOfRecord=PRESERVED_SPECIMEN&mediaType=StillImage';
  const BULK_CONCURRENCY = 16; // parallel image-download workers
  const DOMAIN = 'gbif.org';   // bookmarks are stored app-wide, keyed by domain

  // Same-origin fetch run INSIDE the hidden webview once it has navigated to the
  // image URL — returns a data: URL of the original bytes (served from cache).
  const FETCH_SNIPPET = `(async () => {
    const r = await fetch(location.href, { credentials: 'include' });
    if (!r.ok) throw new Error('http ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct.startsWith('text/') || ct.includes('html') || ct.includes('json')) throw new Error('not-an-image:' + ct);
    const b = await r.blob();
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(fr.error || new Error('read failed'));
      fr.readAsDataURL(b);
    });
  })()`;

  // Plain-Chrome UA (default Electron UA minus the Electron token), used ONLY as
  // a per-image fallback when a host rejects the Electron UA (e.g. Smithsonian
  // ids.si.edu returns an HTML "Request Rejected" to any UA containing "Electron").
  const CLEAN_UA = navigator.userAgent.replace(/\s*Electron\/\S+/gi, '').replace(/\s{2,}/g, ' ').trim();

  const state = {
    view: null, currentId: null, onSearch: false, busy: false,
    parentReady: false, bulk: { running: false, cancel: false },
    bookmarks: [], menuOpen: false, enumerating: false,
    authStatus: { available: false }, job: { active: null, draining: false }, tokenTimer: null,
    directWorkers: [], webviewWorkers: [],
  };

  // Best-effort scan of the logged-in GBIF webview session for a JWT (three
  // base64url segments), incl. tokens nested in stored JSON. Lets us reuse the
  // browser login for the download API with no stored password.
  const JWT_SCAN = `(() => {
    const isJwt = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}$/.test(v);
    const out = [];
    const scan = (store) => { try { for (let i=0;i<store.length;i++){ const val = store.getItem(store.key(i)); if(!val) continue; if(isJwt(val)) out.push(val); else if(val[0]==='{'||val[0]==='['){ try{ JSON.stringify(JSON.parse(val), (k,v)=>{ if(isJwt(v)) out.push(v); return v; }); }catch(e){} } } } catch(e){} };
    scan(window.localStorage); scan(window.sessionStorage);
    return out[0] || null;
  })()`;
  const els = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // getURL() throws if the webview isn't attached + dom-ready yet (e.g. the app
  // started on another tab). Guard it so navigation callbacks stay quiet.
  const safeGetURL = () => { try { return state.view ? state.view.getURL() : ''; } catch (_) { return ''; } };

  // Attachment-style images become browser downloads captured in the main
  // process and pushed here, keyed by URL.
  const pendingDownloads = new Map();
  let downloadListenerReady = false;
  function ensureDownloadListener() {
    if (downloadListenerReady) return;
    downloadListenerReady = true;
    api.gbif.onDownload((data) => {
      const key = pendingDownloads.has(data.url) ? data.url
        : (Array.isArray(data.chain) ? data.chain.find((u) => pendingDownloads.has(u)) : null);
      if (!key) return;
      const resolve = pendingDownloads.get(key);
      pendingDownloads.delete(key);
      resolve(data.ok && data.dataBase64 ? `data:image/jpeg;base64,${data.dataBase64}` : null);
    });
  }

  function parseId(url) {
    if (!url) return null;
    let m = String(url).match(/occurrence\/(\d+)/);
    if (m) return m[1];
    m = String(url).match(/[?&]entity=o_(\d+)/);
    if (m) return m[1];
    return null;
  }

  function setStatus(msg, cls) {
    if (!els.status) return;
    els.status.textContent = msg || '';
    els.status.className = 'gbif-status mono' + (cls ? ` ${cls}` : '');
  }

  // --- image download through the browser session --------------------------
  function downloadViaWebview(imageUrl, opts = {}) {
    return new Promise((resolve, reject) => {
      const fw = document.createElement('webview');
      fw.setAttribute('partition', 'persist:gbif');
      if (opts.userAgent) fw.setAttribute('useragent', opts.userAgent);
      fw.className = 'gbif-fetch-view';
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return; settled = true;
        clearTimeout(timer);
        pendingDownloads.delete(imageUrl);
        try { fw.remove(); } catch (_) {}
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error('Timed out downloading the image.')), 60000);

      pendingDownloads.set(imageUrl, (dataUrl) => {
        if (dataUrl) finish(resolve, dataUrl);
        else finish(reject, new Error('The image could not be downloaded.'));
      });

      fw.addEventListener('did-finish-load', async () => {
        try {
          const dataUrl = await fw.executeJavaScript(FETCH_SNIPPET, true);
          finish(resolve, dataUrl);
        } catch (e) {
          finish(reject, new Error('Could not read a valid image (' + (e && e.message || e) + ').'));
        }
      });
      fw.addEventListener('did-fail-load', (e) => {
        // errorCode -3 (ERR_ABORTED) == navigation turned into a download; wait
        // for the capture event. Other main-frame errors are real failures.
        if (e.isMainFrame && e.errorCode !== -3) {
          finish(reject, new Error('The image failed to load in the browser (code ' + e.errorCode + ').'));
        }
      });
      document.body.appendChild(fw);
      fw.src = imageUrl;
    });
  }

  // A fully realistic modern-Chrome UA — the last-ditch fallback for hosts that
  // reject both the honest Electron UA and the token-stripped "Chrome face".
  const REALISTIC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  // Progressive UA fallback inside the webview session (each tried ONCE):
  //   1. default (honest Electron UA)
  //   2. CLEAN_UA — Electron/IRIS tokens stripped = plain Chrome face (fixes
  //      hosts like ids.si.edu that 403 anything containing "Electron")
  //   3. REALISTIC_UA — a full, current Chrome UA, for the stubborn ones
  // Returns { dataUrl, method, trail }. On total failure throws an error carrying
  // .kind ('broken' if every tier saw 404/410/DNS, else 'failed'), .status, and
  // .trail — one entry per tier — so the caller can log which emulation worked
  // (or that the link is dead). Every attempt still benefits from the
  // attachment/save-dialog capture path for direct-download links.
  function tierOutcome(msg) {
    const s = String(msg || '');
    const http = (s.match(/http (\d+)/) || [])[1];
    const net = (s.match(/code (-?\d+)/) || [])[1];
    const dns = net === '-105' || net === '-137'; // NAME_NOT_RESOLVED / NAME_RESOLUTION_FAILED
    return {
      http_status: http ? Number(http) : null,
      dns,
      outcome: /not-an-image/i.test(s) ? 'not_image' : (http ? 'http_error' : (dns ? 'broken' : 'error')),
    };
  }
  async function fetchImageBytes(imageUrl, opts = {}) {
    const tiers = [{ ua: null, method: 'webview-electron' }];
    if (CLEAN_UA && CLEAN_UA !== navigator.userAgent) tiers.push({ ua: CLEAN_UA, method: 'webview-clean' });
    if (REALISTIC_UA !== navigator.userAgent && REALISTIC_UA !== CLEAN_UA) tiers.push({ ua: REALISTIC_UA, method: 'webview-realistic' });
    const trail = [];
    for (const t of tiers) {
      if (opts.onAttempt) { try { opts.onAttempt(t.method); } catch (_) {} }
      try {
        const dataUrl = await downloadViaWebview(imageUrl, t.ua ? { userAgent: t.ua } : {});
        trail.push({ method: t.method, outcome: 'success' });
        return { dataUrl, method: t.method, trail };
      } catch (e) {
        const o = tierOutcome(e && e.message);
        trail.push({ method: t.method, outcome: o.outcome, http_status: o.http_status, message: e && e.message });
      }
    }
    const broken = trail.length > 0 && trail.every((a) => a.http_status === 404 || a.http_status === 410 || a.outcome === 'broken');
    const err = new Error('All webview fallbacks failed.');
    err.kind = broken ? 'broken' : 'failed';
    err.status = trail.map((a) => a.http_status).filter(Boolean).pop() || null;
    err.trail = trail;
    throw err;
  }

  // --- single specimen -----------------------------------------------------
  async function addCurrent() {
    if (state.busy || !state.parentReady) return;
    const id = parseId(safeGetURL());
    if (!id) { toast('Open a specimen occurrence on GBIF (click an image), then Acquire.', 'error'); return; }
    state.busy = true; updateActionButtons();
    try {
      setStatus(`resolving GBIF ${id}…`, 'work');
      const meta = await api.gbif.getOccurrence(id);
      if (meta.duplicate) { toast(`GBIF ${id} is already in the index.`, 'info'); return; }
      if (!meta.has_image || !meta.image_url) { toast('This occurrence has no downloadable image.', 'error'); return; }

      setStatus('pulling image through the browser…', 'work');
      await api.gbif.setCapture(true);
      let dataUrl;
      try { const r = await fetchImageBytes(meta.image_url); dataUrl = r.dataUrl; }
      finally { await api.gbif.setCapture(false); }

      setStatus('writing to disk + index…', 'work');
      const row = await api.gbif.saveImport(id, dataUrl);
      try {
        await api.gbif.writeDwc(`single_${id}`, [id], { source: 'single occurrence', occurrence_url: meta.occurrence_url });
      } catch (_) { /* DwC is best-effort */ }
      toast(`ACQUIRED · ${row.filename || meta.filename}`, 'ok');
    } catch (err) {
      toast(err.message || 'Acquire failed.', 'error');
    } finally {
      state.busy = false; setStatus('', ''); updateActionButtons();
      onNav(safeGetURL());
    }
  }

  // --- bulk acquire from a search -----------------------------------------
  // Random partial shuffle (Fisher–Yates).
  function sample(arr, n) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a.slice(0, Math.max(0, Math.min(n, a.length)));
  }

  // ACQUIRE SEARCH: full DwC-A download (every record + DOI, past the offset
  // wall) when signed in to GBIF; otherwise today's quick, capped path.
  async function importFromSearch() {
    if (state.busy || state.bulk.running || !state.parentReady) return;
    const url = safeGetURL();
    if (!/\/occurrence\/(search|gallery)/.test(url || '')) { toast('Open a GBIF search (gallery) first.', 'error'); return; }
    let st = state.authStatus;
    try { st = await api.auth.status(); state.authStatus = st; refreshAuthChip(); } catch (_) {}
    if (st && st.available) {
      try {
        const res = await api.gbif.acquireSearch(url);
        toast(`Full GBIF download requested${res && res.doi ? ` · DOI ${res.doi}` : ''} — images will download in the background.`, 'ok');
      } catch (err) { toast((err && err.message) || 'Could not start the download.', 'error'); }
      return;
    }
    toast('Not signed in to GBIF — running a quick capped download. Log into GBIF here (or add a .env) for the complete archive + DOI.', 'info');
    quickImport();
  }

  async function quickImport() {
    const url = safeGetURL();
    state.busy = true; state.enumerating = true; updateActionButtons();
    setStatus('enumerating search results…', 'work');
    let res;
    try {
      res = await api.gbif.enumerateSearch(url);
    } catch (err) {
      toast(err.message || 'Could not read the search.', 'error');
      return;
    } finally {
      state.busy = false; state.enumerating = false; setStatus('', ''); updateActionButtons();
    }

    const occ = res.occurrences || [];
    if (!occ.length) { toast('No images found for this search.', 'error'); return; }
    const pending = occ.filter((o) => !o.already_downloaded);
    const alreadyIds = occ.filter((o) => o.already_downloaded).map((o) => o.gbif_id);

    const choice = await promptImport({
      total: res.total, found: occ.length, pending: pending.length,
      already: alreadyIds.length, alreadyIds, capped: res.capped,
    });
    if (!choice) return;
    const items = choice.mode === 'subset' ? sample(pending, choice.n) : pending;
    if (!items.length) { toast('Nothing new to download.', 'info'); return; }
    runBulk(items, res.slug, { source_url: url, api_url: res.api_url, total: res.total });
  }

  // Bounded worker pool (up to 16 at once). A search's images span many
  // institution hosts, so concurrency parallelises across them.
  async function runBulk(items, slug, searchMeta) {
    state.bulk = { running: true, cancel: false };
    showBulk(); updateActionButtons();
    await api.gbif.setCapture(true);

    const total = items.length;
    let cursor = 0, completed = 0, ok = 0, skip = 0, fail = 0;
    updateBulk(0, total, { ok, skip, fail });

    const worker = async (idx) => {
      await sleep(idx * 80); // stagger so 16 navigations don't fire in one tick
      while (!state.bulk.cancel) {
        const i = cursor++;
        if (i >= total) break;
        const it = items[i];
        try {
          const r = await fetchImageBytes(it.image_url);
          const row = await api.gbif.saveImport(it.gbif_id, r.dataUrl);
          if (row && row.duplicate) skip++; else ok++;
        } catch (_) { fail++; }
        completed++;
        updateBulk(completed, total, { ok, skip, fail });
      }
    };

    const n = Math.min(BULK_CONCURRENCY, total);
    await Promise.all(Array.from({ length: n }, (_, k) => worker(k)));
    await api.gbif.setCapture(false);

    // Write the search's Darwin Core files for everything we selected (metadata
    // is independent of whether each image download succeeded).
    setStatus('writing Darwin Core files…', 'work');
    try { await api.gbif.writeDwc(slug, items.map((it) => it.gbif_id), searchMeta); }
    catch (_) { /* best-effort */ }

    const cancelled = state.bulk.cancel;
    state.bulk = { running: false, cancel: false };
    hideBulk(); setStatus('', ''); updateActionButtons(); onNav(safeGetURL());
    toast(
      `Acquire ${cancelled ? 'aborted' : 'complete'}: ${ok} added` +
      `${skip ? `, ${skip} skipped` : ''}${fail ? `, ${fail} failed` : ''}.`,
      (fail && !ok) ? 'error' : 'ok'
    );
  }

  function showBulk() {
    if (els.progress) els.progress.hidden = false;
    if (els.progressCancel) { els.progressCancel.disabled = false; els.progressCancel.textContent = '✕ ABORT'; }
    if (els.progressFill) els.progressFill.style.width = '0%';
  }
  function hideBulk() { if (els.progress) els.progress.hidden = true; }
  function updateBulk(completed, total, tally) {
    const pct = total ? Math.round(completed / total * 100) : 0;
    if (els.progressFill) els.progressFill.style.width = `${pct}%`;
    if (els.progressText) els.progressText.textContent = `ACQUIRING ${completed} / ${total}…`;
    if (els.progressSub) {
      els.progressSub.textContent =
        `${tally.ok} added${tally.skip ? `, ${tally.skip} skipped` : ''}` +
        `${tally.fail ? `, ${tally.fail} failed` : ''} · up to ${Math.min(BULK_CONCURRENCY, total)} at once`;
    }
  }

  // --- target preview (fun 90s "target lock" on a specimen page) ----------
  let previewTimer = null;
  let lastPreviewId = null;
  function schedulePreview(id) {
    clearTimeout(previewTimer);
    if (!id || id === lastPreviewId || state.busy || state.bulk.running) return;
    previewTimer = setTimeout(async () => {
      try {
        const meta = await api.gbif.getOccurrence(id);
        lastPreviewId = id;
        if (parseId(safeGetURL()) !== id || state.busy) return; // navigated away
        if (!meta.has_image) { setStatus(`GBIF ${id} — no image available`, ''); return; }
        const dup = meta.duplicate ? ' · ALREADY IN INDEX' : '';
        setStatus(`TARGET LOCKED ▸ ${meta.filename}${dup}`, 'locked');
      } catch (_) { /* preview is best-effort */ }
    }, 500);
  }

  // --- navigation / buttons ------------------------------------------------
  function onNav(url) {
    const u = url || (state.view && safeGetURL()) || '';
    state.currentId = parseId(u);
    state.onSearch = /\/occurrence\/(search|gallery)/.test(u);
    if (els.url && document.activeElement !== els.url) els.url.value = u;
    updateActionButtons();
    if (state.busy || state.bulk.running) return;
    if (state.currentId) schedulePreview(state.currentId);
    else setStatus(state.onSearch
      ? '▶ search loaded — ACQUIRE SEARCH to pull images'
      : '▶ browse gbif.org — click a specimen to lock a target', '');
  }

  function updateActionButtons() {
    const busy = state.busy || state.bulk.running;
    const ready = state.parentReady;
    if (els.add) {
      els.add.disabled = busy || !state.currentId || !ready;
      els.add.title = !ready ? 'Set a save location (parent_dir) first.'
        : (!state.currentId ? 'Open a specimen occurrence first — click an image on GBIF.' : '');
    }
    if (els.import) {
      els.import.disabled = busy || !state.onSearch || !ready;
      els.import.title = !ready ? 'Set a save location (parent_dir) first.'
        : (!state.onSearch ? 'Open a GBIF search (gallery) first.' : '');
    }
  }

  function setParentReady(ready) {
    state.parentReady = !!ready;
    updateActionButtons();
    if (!state.busy && !state.bulk.running && !state.currentId && !state.onSearch) {
      setStatus(ready ? '▶ browse gbif.org — click a specimen to lock a target'
        : '◍ set a save location above to enable acquisition', ready ? '' : 'work');
    }
  }

  // --- saved-search bookmarks (app-wide, domain 'gbif.org') ----------------
  // Short human label from a gbif.org search URL (query, then notable filters).
  function deriveBookmarkLabel(url) {
    try {
      const u = new URL(url);
      const p = u.searchParams;
      const q = p.get('q');
      if (q) return `“${q}”`;
      const parts = [];
      const taxon = p.get('taxon_key') || p.get('taxonKey');
      if (taxon) parts.push(`taxon ${taxon}`);
      if (p.get('country')) parts.push(p.get('country'));
      const bor = p.get('basisOfRecord') || p.get('basis_of_record');
      if (bor) parts.push(String(bor).toLowerCase().replace(/_/g, ' '));
      if (parts.length) return `GBIF: ${parts.join(', ')}`;
      return `${u.hostname}${u.pathname}`;
    } catch (_) { return String(url); }
  }

  async function loadBookmarks() {
    try { state.bookmarks = await api.bookmarks.list(DOMAIN); }
    catch (_) { state.bookmarks = []; }
    renderBookmarksMenu();
  }

  function renderBookmarksMenu() {
    const menu = els.bmMenu;
    if (!menu) return;
    const bms = state.bookmarks || [];
    menu.innerHTML = bms.length
      ? bms.map((b) => `
          <div class="split-menu-item" data-bm-url="${esc(b.url)}" title="${esc(b.url)}">
            <span class="bm-label">${esc(b.label || b.url)}</span>
            <button class="bm-del" data-bm-del="${esc(b.id)}" title="Remove bookmark">✕</button>
          </div>`).join('')
      : '<div class="split-menu-empty">No saved searches yet.</div>';
    menu.querySelectorAll('[data-bm-url]').forEach((el) => el.addEventListener('click', (e) => {
      if (e.target.closest('[data-bm-del]')) return;
      state.view.loadURL(el.dataset.bmUrl);
      toggleMenu(false);
    }));
    menu.querySelectorAll('[data-bm-del]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try { await api.bookmarks.remove(DOMAIN, b.dataset.bmDel); await loadBookmarks(); }
      catch (err) { toast(err.message, 'error'); }
    }));
  }

  async function bookmarkCurrent() {
    const url = state.view && safeGetURL();
    if (!url || !/^https?:/i.test(url)) { toast('Browse GBIF first, then bookmark.', 'error'); return; }
    try {
      const res = await api.bookmarks.add(DOMAIN, url, deriveBookmarkLabel(url));
      await loadBookmarks();
      toast(res.duplicate ? 'Already bookmarked.' : 'Search bookmarked.', res.duplicate ? 'info' : 'ok');
    } catch (err) { toast(err.message || 'Could not bookmark.', 'error'); }
  }

  function toggleMenu(open) {
    const menu = els.bmMenu;
    if (!menu) return;
    state.menuOpen = open == null ? !state.menuOpen : open;
    menu.hidden = !state.menuOpen;
    if (state.menuOpen) document.addEventListener('mousedown', onDocClick);
    else document.removeEventListener('mousedown', onDocClick);
  }
  function onDocClick(e) {
    if (els.bm && els.bm.contains(e.target)) return; // click inside the split button
    toggleMenu(false);
  }

  // --- GBIF account / auth for the full download --------------------------
  async function refreshAuthChip() {
    try { state.authStatus = await api.auth.status(); }
    catch (_) { state.authStatus = { available: false }; }
    const el = els.auth;
    if (!el) return;
    if (state.authStatus.available) {
      el.textContent = `⚿ ${state.authStatus.username || 'signed in'} · full download ready`;
      el.className = 'gbif-auth mono ok';
    } else if (state.authStatus.webviewRejected) {
      el.textContent = '⚿ GBIF won’t accept the browser login — add GBIF_USER/GBIF_PASS to .env';
      el.className = 'gbif-auth mono warn';
      el.title = 'GBIF’s website token is not accepted by its download API. Put your GBIF username + password in a .env file (gitignored) for the full download.';
    } else {
      el.textContent = '⚿ add GBIF_USER/GBIF_PASS to .env for full downloads';
      el.className = 'gbif-auth mono';
    }
  }

  // Lift a JWT from the logged-in GBIF session and hand it to main (no password).
  async function scanForToken() {
    try {
      if (!/gbif\.org/.test(safeGetURL())) return;
      const token = await state.view.executeJavaScript(JWT_SCAN, true);
      if (token) { await api.auth.setToken(token); refreshAuthChip(); }
    } catch (_) { /* best-effort */ }
  }
  function scheduleTokenScan() {
    clearTimeout(state.tokenTimer);
    state.tokenTimer = setTimeout(scanForToken, 800);
  }

  // --- bulk-download job card ---------------------------------------------
  // The phase line reflects the ARCHIVE track (DOI); images (Track B) run in
  // parallel and show on their own line — they don't wait for the archive.
  function jobPhaseLabel(status) {
    switch (status) {
      case 'PREPARING': return '◐ GBIF preparing archive (DOI)…';
      case 'RUNNING': return '◑ GBIF building archive (DOI)…';
      case 'DOWNLOADING_ZIP': return '⤓ downloading archive…';
      case 'PARSING': return '⚙ reading archive…';
      case 'EXTRACTED': return '▓ archive + DOI ready';
      case 'DONE': return '▓ complete';
      case 'QUEUED': return '▚ acquiring images…';
      case 'FAILED': return '✗ archive failed (images still downloading)';
      case 'KILLED': case 'CANCELLED': return '✗ cancelled';
      case 'FILE_ERASED': return '✗ archive expired on GBIF — re-request';
      default: return status || '';
    }
  }

  function renderJob(snap) {
    const el = els.job;
    if (!el) return;
    if (!snap || !snap.key) { el.hidden = true; return; }
    el.hidden = false;
    const c = snap.counts || {};
    const target = snap.total_records || c.total || 0;
    const total = snap.total_records != null ? `${Number(snap.total_records).toLocaleString()} records` : '';
    const doi = snap.doi ? `<span class="job-doi" data-doi="${esc(snap.doi)}" title="Open DOI">DOI ${esc(snap.doi)}</span>` : '';
    const hasImages = (c.total || 0) > 0;
    const settled = (c.done || 0) + (c.skipped || 0) + (c.failed || 0) + (c.broken || 0);
    const pct = target ? Math.min(100, Math.round((settled / target) * 100)) : null;
    const imgLine = hasImages
      ? `<div class="job-sub mono">images ${c.done || 0}/${target}${snap.enumerating ? ' (finding more…)' : ''}${c.blocked ? ` · ${c.blocked} via browser` : ''}${c.broken ? ` · ${c.broken} broken` : ''}${c.failed ? ` · ${c.failed} failed` : ''}${c.skipped ? ` · ${c.skipped} already had` : ''}</div>`
      : (snap.enumerating ? '<div class="job-sub mono">finding images…</div>' : '');
    const done = snap.busy === false;
    el.innerHTML = `
      <div class="job-head mono">
        <span class="job-phase">${esc(jobPhaseLabel(snap.status))}</span>
        <span class="job-meta">${total} ${doi}</span>
        <button class="btn ghost sm" id="gbif-job-close">${done ? '✕ CLOSE' : '✕ CANCEL'}</button>
      </div>
      ${pct != null && hasImages ? `<div class="gbif-progress-track"><div class="gbif-progress-fill" style="width:${pct}%"></div></div>` : ''}
      ${imgLine}`;
    const btn = el.querySelector('#gbif-job-close');
    if (btn) btn.addEventListener('click', () => { if (done) el.hidden = true; else api.gbif.cancelJob(snap.key); });
    const doiEl = el.querySelector('.job-doi');
    if (doiEl) doiEl.addEventListener('click', () => { try { window.open(`https://doi.org/${snap.doi}`); } catch (_) {} });
  }

  // Drain rows a host bot-blocked (tiers 2–4) through the webview session, using
  // a small fixed pool of reporting worker slots (rows come back domain-
  // interleaved). Each slot shows its live UA method on the board; the winning
  // UA / failure trail goes back to main for the fetch_log.
  const WEBVIEW_WORKERS = 4;
  async function startBlockedDrain(key) {
    if (state.job.draining) return;
    state.job.draining = true;
    state.webviewWorkers = Array.from({ length: WEBVIEW_WORKERS }, () => ({ current: null, prev: null }));
    await api.gbif.setCapture(true);
    let queue = [];
    const nextItem = async () => {
      if (!queue.length) queue = await api.gbif.nextBlocked(key, 12);
      return queue.shift() || null;
    };
    const worker = async (w) => {
      while (true) {
        const it = await nextItem();
        if (!it) break;
        state.webviewWorkers[w] = { current: { gbif_id: it.gbif_id, herbCode: it.herbCode, method: 'webview-electron', delayActive: false }, prev: (state.webviewWorkers[w] || {}).prev };
        renderWorkers();
        let ok = false;
        try {
          const r = await fetchImageBytes(it.image_url, { onAttempt: (m) => { if (state.webviewWorkers[w] && state.webviewWorkers[w].current) { state.webviewWorkers[w].current.method = m; renderWorkers(); } } });
          await api.gbif.saveBlocked(key, it.gbif_id, r.dataUrl, r.method, r.trail);
          ok = true;
        } catch (e) {
          await api.gbif.failBlocked(key, it.gbif_id, { kind: (e && e.kind) || 'failed', status: (e && e.status) || null, trail: (e && e.trail) || [] });
        }
        state.webviewWorkers[w] = { current: null, prev: { gbif_id: it.gbif_id, herbCode: it.herbCode, ok } };
        renderWorkers();
      }
    };
    await Promise.all(Array.from({ length: WEBVIEW_WORKERS }, (_, w) => worker(w)));
    await api.gbif.setCapture(false);
    state.webviewWorkers = (state.webviewWorkers || []).map((w) => ({ current: null, prev: w.prev }));
    renderWorkers();
    state.job.draining = false;
  }

  function onJobProgress(snap) {
    state.job.active = snap;
    renderJob(snap);
    renderWorkers();
    if (snap && snap.counts && snap.counts.blocked > 0) startBlockedDrain(snap.key);
  }

  // --- live worker board ---------------------------------------------------
  function methodLabel(m) {
    return {
      direct: '① Chrome (direct)',
      'webview-electron': '② Electron UA',
      'webview-clean': '③ Chrome face',
      'webview-realistic': '④ Realistic Chrome',
    }[m] || (m || '');
  }
  function workerCard(w) {
    const cur = w && w.current;
    const prev = w && w.prev;
    const item = cur ? `Item: ${esc(cur.gbif_id)} | ${esc(cur.herbCode || '—')}` : '<span class="wk-idle">— idle —</span>';
    const method = cur ? esc(methodLabel(cur.method)) : '';
    const delay = cur ? (cur.delayActive ? '<span class="wk-delay on">Delay Active</span>' : '<span class="wk-delay">Delay</span>') : '';
    const prevStatus = prev ? (prev.ok ? '<span class="wk-ok">Success</span>' : '<span class="wk-fail">Failure</span>') : '';
    const prevItem = prev ? `Item: ${esc(prev.gbif_id)} | ${esc(prev.herbCode || '—')}` : '';
    return `<div class="wk-card${cur ? ' busy' : ''}">
      <div class="wk-item">${item}</div>
      <div class="wk-method">${method}</div>
      <div class="wk-delayrow">${delay}</div>
      <div class="wk-hr"></div>
      <div class="wk-prevstatus">${prevStatus}</div>
      <div class="wk-previtem">${prevItem}</div>
    </div>`;
  }
  // 2 rows up to 16 workers, 3 rows beyond that; columns fit the count so the
  // last row stretches to fill (no empty tiles). 24→8×3, 20→7×3, 16→8×2.
  function gridCols(n) {
    const rows = n <= 16 ? 2 : 3;
    return Math.max(1, Math.ceil(n / rows));
  }
  function gridHtml(workers, cls) {
    return `<div class="wk-grid ${cls || ''}" style="--wcols:${gridCols(workers.length)}">${workers.map(workerCard).join('')}</div>`;
  }
  function renderWorkers() {
    const el = els.workers;
    if (!el) return;
    const direct = state.directWorkers || [];
    const web = (state.webviewWorkers || []).filter((w) => w && (w.current || w.prev));
    const anyBusy = direct.some((w) => w && w.current) || web.some((w) => w.current);
    const jobBusy = state.job.active && state.job.active.busy && !state.job.active.paused;
    if (!direct.length || (!anyBusy && !jobBusy)) { el.hidden = true; return; }
    el.hidden = false;
    let html = gridHtml(direct);
    if (web.length) html += `<div class="wk-weblabel mono">browser fallback</div>${gridHtml(web, 'wk-web')}`;
    el.innerHTML = html;
  }

  function wire() {
    els.status = document.getElementById('gbif-status');
    els.add = document.getElementById('gbif-add');
    els.import = document.getElementById('gbif-import');
    els.url = document.getElementById('gbif-url');
    els.bm = document.getElementById('gbif-bm');
    els.bmMenu = document.getElementById('gbif-bm-menu');
    els.auth = document.getElementById('gbif-auth');
    els.job = document.getElementById('gbif-job');
    els.workers = document.getElementById('gbif-workers');
    els.progress = document.getElementById('gbif-progress');
    els.progressText = document.getElementById('gbif-progress-text');
    els.progressSub = document.getElementById('gbif-progress-sub');
    els.progressFill = document.getElementById('gbif-progress-fill');
    els.progressCancel = document.getElementById('gbif-progress-cancel');

    const view = document.getElementById('gbif-view');
    state.view = view;

    document.getElementById('gbif-back').addEventListener('click', () => { if (view.canGoBack()) view.goBack(); });
    document.getElementById('gbif-fwd').addEventListener('click', () => { if (view.canGoForward()) view.goForward(); });
    document.getElementById('gbif-reload').addEventListener('click', () => view.reload());
    document.getElementById('gbif-home').addEventListener('click', () => view.loadURL(HOME));
    els.add.addEventListener('click', addCurrent);
    els.import.addEventListener('click', importFromSearch);
    document.getElementById('gbif-bm-add').addEventListener('click', bookmarkCurrent);
    document.getElementById('gbif-bm-toggle').addEventListener('click', () => toggleMenu());
    els.progressCancel.addEventListener('click', () => {
      state.bulk.cancel = true;
      els.progressCancel.disabled = true;
      els.progressCancel.textContent = 'ABORTING…';
    });

    els.url.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      let v = els.url.value.trim();
      if (!v) return;
      if (/^\d+$/.test(v)) v = `https://www.gbif.org/occurrence/${v}`;
      else if (!/^https?:\/\//i.test(v)) v = `https://www.gbif.org/occurrence/search?q=${encodeURIComponent(v)}`;
      view.loadURL(v);
    });

    view.addEventListener('did-navigate', (e) => { onNav(e.url); scheduleTokenScan(); });
    view.addEventListener('did-navigate-in-page', (e) => onNav(e.url));
    view.addEventListener('did-stop-loading', () => { onNav(safeGetURL()); scheduleTokenScan(); });
    view.addEventListener('page-title-updated', () => onNav(safeGetURL()));
  }

  function mount() {
    ensureDownloadListener();
    // Live enumeration progress (parallel paging can take a few seconds).
    api.gbif.onEnumProgress(({ found, total }) => {
      if (!state.enumerating) return;
      setStatus(`enumerating… ${found}${total ? ` of ${Number(total).toLocaleString()}` : ''} found`, 'work');
    });
    // Background bulk-download job progress + resumed jobs on startup.
    api.gbif.onJobProgress(onJobProgress);
    api.gbif.onWorkers((data) => { state.directWorkers = (data && data.workers) || []; renderWorkers(); });
    api.gbif.onJobsActive(async () => {
      try {
        const jobs = await api.gbif.listJobs();
        if (jobs && jobs[0]) onJobProgress(jobs[0]);
      } catch (_) { /* noop */ }
    });
    wire();
    updateActionButtons();
    onNav(safeGetURL());
    loadBookmarks();
    refreshAuthChip();
    scheduleTokenScan();
  }

  window.DA = window.DA || {};
  window.DA.GbifPage = { mount, setParentReady };
})();
