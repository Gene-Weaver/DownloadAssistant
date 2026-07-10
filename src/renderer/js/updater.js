/*
 * Auto-update UI — a compact indicator in the header that only appears when
 * there's something to say. Consumes the updater namespace on window.DA.api.
 *
 * In DEVELOPMENT the main-process updater is a no-op (app.isPackaged === false),
 * so the 'updater:*' IPC handlers aren't registered; check() rejects and we
 * swallow it. The bar simply never shows. In a packaged build it drives the
 * download / restart flow the renderer initiates.
 */
(function () {
  const api = window.DA.api;
  const esc = (s) => (window.DA.ui && window.DA.ui.esc ? window.DA.ui.esc(s) : String(s == null ? '' : s));
  const bar = () => document.getElementById('updater-bar');

  function show(html) { const b = bar(); if (!b) return; b.hidden = false; b.innerHTML = html; }

  async function doDownload() {
    show('<span class="upd-msg">⬇ DOWNLOADING…</span>');
    try {
      const r = await api.updater.download();
      if (r && r.ok === false) { show(`<span class="upd-msg err">✗ ${esc(r.error || 'download failed')}</span>`); }
    } catch (e) { console.warn('[updater] download error', e); }
  }

  function onEvent(d) {
    const b = bar(); if (!b) return;
    switch (d.status) {
      case 'update-available':
        show(`<span class="upd-msg">⬆ UPDATE ${esc(d.version || '')} AVAILABLE</span> <button class="upd-btn" id="upd-download">DOWNLOAD</button>`);
        b.querySelector('#upd-download').addEventListener('click', doDownload);
        break;
      case 'download-progress':
        show(`<span class="upd-msg">⬇ DOWNLOADING ${Math.round(d.percent || 0)}%</span>`);
        break;
      case 'update-downloaded':
        show(`<span class="upd-msg ok">✓ ${esc(d.version || '')} READY</span> <button class="upd-btn go" id="upd-restart">RESTART &amp; INSTALL</button>`);
        b.querySelector('#upd-restart').addEventListener('click', () => api.updater.quitAndInstall());
        break;
      case 'error':
        console.warn('[updater]', d.message); // stay quiet in the UI
        break;
      default:
        break; // checking-for-update / update-not-available: no nag
    }
  }

  function init() {
    if (!api || !api.updater) return;
    api.updater.onEvent(onEvent);
    // Kick a check shortly after launch. In dev this rejects (no handler) — ignore.
    setTimeout(() => { Promise.resolve(api.updater.check()).catch(() => {}); }, 3000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
