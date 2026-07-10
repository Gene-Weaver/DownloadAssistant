/*
 * Small UI helpers shared across tabs: terminal-style toasts, an HTML escaper,
 * and the "acquire from search" options modal (download all / random subset).
 * Exposed on window.DA.ui.
 */
(function () {
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function toast(message, type) {
    const root = document.getElementById('toast-root');
    if (!root) return;
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ` ${type}` : '');
    el.textContent = message;
    root.appendChild(el);
    const ttl = type === 'error' ? 6500 : 4000;
    setTimeout(() => {
      el.style.transition = 'opacity 0.3s, transform 0.3s';
      el.style.opacity = '0';
      el.style.transform = 'translateX(12px)';
      setTimeout(() => el.remove(), 320);
    }, ttl);
  }

  /*
   * "Acquire from GBIF search" options. There's no hard cap anymore — you can
   * download all matched images — but the random-subset picker is kept.
   * Resolves to { mode: 'all' | 'subset', n } or null (cancelled).
   */
  function promptImport(info) {
    return new Promise((resolve) => {
      let root = document.getElementById('modal-root');
      if (!root) { root = document.createElement('div'); root.id = 'modal-root'; document.body.appendChild(root); }

      const maxN = Math.max(1, info.pending);
      const defN = Math.min(20, maxN);
      const noPending = info.pending === 0;
      const already = info.already ? ` <span class="muted">(${info.already} already acquired)</span>` : '';
      const capNote = info.capped
        ? `<p class="muted">Search matches <strong>${Number(info.total).toLocaleString()}</strong> imaged records — enumerated the first <strong>${info.found}</strong>. Narrow the search to reach the rest.</p>`
        : '';

      const dupIds = info.alreadyIds || [];
      const dupBlock = dupIds.length ? `
        <div class="dup-block">
          <div class="dup-head">${dupIds.length} already in this index — will be skipped (not re-downloaded):</div>
          <div>${dupIds.map((id) => `<span class="dup-id">${esc(id)}</span>`).join('')}</div>
        </div>` : '';

      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      const done = (v) => { document.removeEventListener('keydown', onKey); root.innerHTML = ''; resolve(v); };

      root.innerHTML = `
        <div class="modal-backdrop" data-backdrop>
          <div class="modal-card" role="dialog" aria-modal="true">
            <div class="modal-title">ACQUIRE FROM GBIF SEARCH</div>
            <div class="modal-body">
              <p>Found <strong>${info.found}</strong> imaged specimen(s)${already}.</p>
              ${capNote}
              ${dupBlock}
              ${noPending ? '<p class="muted">Everything here is already in the index — nothing new to download.</p>' : `
              <div class="subset-row">
                <label>▓ Random subset of
                  <input type="number" id="subset-n" min="1" max="${maxN}" value="${defN}" />
                  of ${info.pending} new
                </label>
              </div>`}
            </div>
            <div class="modal-actions">
              <button class="btn ghost" data-act="cancel">CANCEL</button>
              ${noPending ? '' : `<button class="btn" data-act="subset">DOWNLOAD SUBSET</button>`}
              ${noPending ? '' : `<button class="btn btn-go" data-act="all">DOWNLOAD ALL ${info.pending}</button>`}
            </div>
          </div>
        </div>`;

      const q = (s) => root.querySelector(s);
      const bd = q('[data-backdrop]');
      bd.addEventListener('click', (e) => { if (e.target === bd) done(null); });
      const cancel = q('[data-act="cancel"]'); if (cancel) cancel.addEventListener('click', () => done(null));
      const allBtn = q('[data-act="all"]'); if (allBtn) allBtn.addEventListener('click', () => done({ mode: 'all' }));
      const subBtn = q('[data-act="subset"]');
      if (subBtn) subBtn.addEventListener('click', () => {
        const inp = q('#subset-n');
        let n = parseInt(inp && inp.value, 10);
        if (!Number.isFinite(n) || n < 1) n = defN;
        done({ mode: 'subset', n: Math.min(n, maxN) });
      });
      document.addEventListener('keydown', onKey);
    });
  }

  window.DA = window.DA || {};
  window.DA.ui = { esc, toast, promptImport };
})();
