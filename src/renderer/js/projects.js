/*
 * Projects tab — the multi-location download manager.
 *
 * Every save location is a "project" with its own images/ dwc/ db/ and its own
 * downloads. This tab lists them all with live status and lets you OPEN (switch
 * to), RESUME, or PAUSE any project's downloads — even ones in other folders.
 *
 * Exposes window.DA.ProjectsPage = { mount, refresh }.
 */
(function () {
  const api = window.DA.api;
  const esc = window.DA.ui.esc;
  const { toast } = window.DA.ui;

  const els = {};

  function badge(s) {
    if (s.running) return '<span class="pj-badge run">● RUNNING</span>';
    if (s.paused) return '<span class="pj-badge pause">‖ PAUSED</span>';
    return '<span class="pj-badge idle">◌ IDLE</span>';
  }
  function counts(c) {
    const p = [];
    if (c.done) p.push(`${c.done.toLocaleString()} done`);
    if (c.pending) p.push(`${c.pending.toLocaleString()} pending`);
    if (c.blocked) p.push(`${c.blocked} via browser`);
    if (c.broken) p.push(`${c.broken} broken`);
    if (c.failed) p.push(`${c.failed} failed`);
    return p.join(' · ');
  }
  function card(p) {
    const s = p.status || {};
    const cs = counts(s.counts || {});
    return `<div class="pj-card${p.current ? ' current' : ''}">
      <div class="pj-head">
        <span class="pj-name">${esc(p.name)}${p.current ? ' <span class="pj-cur-tag">current</span>' : ''}</span>
        ${badge(s)}
      </div>
      <div class="pj-loc mono" title="${esc(p.parentDir)}">${esc(p.parentDir)}</div>
      <div class="pj-stats mono">
        <span class="pj-images">${(s.imageCount || 0).toLocaleString()} images</span>
        ${s.activeDownloads ? `<span class="pj-active">${s.activeDownloads} active download${s.activeDownloads > 1 ? 's' : ''}</span>` : ''}
        ${cs ? `<span class="pj-counts">${cs}</span>` : ''}
      </div>
      <div class="pj-actions">
        ${p.current ? '<span class="pj-cur-note mono">this project is open</span>' : `<button class="btn ghost sm" data-act="open" data-id="${esc(p.id)}">◈ OPEN</button>`}
        ${s.running
          ? `<button class="btn ghost sm" data-act="pause" data-id="${esc(p.id)}">‖ PAUSE</button>`
          : `<button class="btn sm" data-act="resume" data-id="${esc(p.id)}" ${(s.counts && (s.counts.pending || s.counts.blocked) || s.activeDownloads) ? '' : 'disabled title="nothing to resume"'}>▶ RESUME</button>`}
        <button class="btn ghost sm" data-act="remove" data-id="${esc(p.id)}" title="Forget this project (files are kept on disk)">✕ FORGET</button>
      </div>
    </div>`;
  }

  async function refresh() {
    if (!els.list) return;
    let projects = [];
    try { projects = await api.projects.list(); } catch (_) { /* noop */ }
    els.list.innerHTML = projects.length
      ? projects.map(card).join('')
      : '<div class="pj-empty">No projects yet — set a save location on the GBIF tab to create one.</div>';
  }

  async function onAction(act, id) {
    try {
      if (act === 'open') {
        const res = await api.projects.setCurrent(id);
        if (res) { if (window.DA.reloadProject) await window.DA.reloadProject(); toast(`Switched to project — ${res.project.name}`, 'ok'); }
      } else if (act === 'resume') { await api.projects.resume(id); toast('Resuming downloads…', 'ok'); }
      else if (act === 'pause') { await api.projects.pause(id); toast('Paused.', 'info'); }
      else if (act === 'remove') { await api.projects.remove(id); if (window.DA.reloadProject) await window.DA.reloadProject(); }
    } catch (err) { toast(err.message || 'Action failed.', 'error'); }
    refresh();
  }

  function isActive() { const el = document.getElementById('tab-projects'); return el && el.classList.contains('active'); }

  function mount() {
    els.list = document.getElementById('pj-list');
    els.refresh = document.getElementById('pj-refresh');
    els.refresh.addEventListener('click', refresh);
    els.list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (btn) onAction(btn.dataset.act, btn.dataset.id);
    });
    // Live status while the tab is visible (cheap poll).
    setInterval(() => { if (isActive()) refresh(); }, 2500);
  }

  window.DA = window.DA || {};
  window.DA.ProjectsPage = { mount, refresh };
})();
