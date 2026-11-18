'use strict';

(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const ICONS = {
    DISPLAY: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20.5h8M12 16.5v4"/>',
    NET: '<path d="M4 9.5a12 12 0 0 1 16 0"/><path d="M7.5 13a7 7 0 0 1 9 0"/><path d="M10.5 16.5a2.5 2.5 0 0 1 3 0"/><circle cx="12" cy="19.6" r=".7"/>',
    MEDIA: '<path d="M4 10v4h3l4 3.5v-11L7 10H4z"/><path d="M15 9.5a4 4 0 0 1 0 5"/><path d="M17.5 7a7.5 7.5 0 0 1 0 10"/>',
    HDC: '<rect x="3" y="5" width="18" height="6" rx="1.6"/><rect x="3" y="13" width="18" height="6" rx="1.6"/><path d="M7 8h.01M7 16h.01"/>',
    SCSIADAPTER: '<rect x="3" y="5" width="18" height="6" rx="1.6"/><rect x="3" y="13" width="18" height="6" rx="1.6"/><path d="M7 8h.01M7 16h.01"/>',
    USB: '<path d="M12 3.5v12"/><circle cx="12" cy="18" r="2"/><path d="m12 7 3-2M12 10.5l-3-2M12 14l3-2"/><rect x="9.5" y="2.5" width="5" height="2.4" rx="1"/>',
    BLUETOOTH: '<path d="m8 7 8 10-4 3V4l4 3-8 10"/>',
    SYSTEM: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 3v3M14.5 3v3M9.5 18v3M14.5 18v3M3 9.5h3M3 14.5h3M18 9.5h3M18 14.5h3"/>',
    CAMERA: '<rect x="3" y="7" width="18" height="12" rx="2"/><circle cx="12" cy="13" r="3.2"/><path d="M8.5 7 10 5h4l1.5 2"/>',
    IMAGE: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 18 5-5 4 4 3-3 4 4"/>',
    MOUSE: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M12 7v4"/>',
    KEYBOARD: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/>',
    BATTERY: '<rect x="3" y="8" width="16" height="8" rx="2"/><path d="M21 11v2"/>',
    FIRMWARE: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6v6H9z"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2"/>',
    HIDCLASS: '<rect x="5" y="3" width="14" height="18" rx="4"/><path d="M12 7v4"/>',
    SECURITYDEVICES: '<path d="M12 3 5 6v6c0 4 3 7 7 9 4-2 7-5 7-9V6l-7-3z"/><path d="m9.5 12 1.8 1.8L15 10"/>',
    default: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/>',
  };

  const STATE_META = {
    update: { label: 'Update', cls: 'update' },
    current: { label: 'Up to date', cls: 'current' },
    newer: { label: 'Newer', cls: 'newer' },
    problem: { label: 'Problem', cls: 'problem' },
    missing: { label: 'Missing', cls: 'missing' },
    unknown: { label: 'Unknown', cls: 'unknown' },
  };

  const JOB_STATE = {
    queued: 'Queued',
    resolving: 'Resolving',
    downloading: 'Downloading',
    extracting: 'Extracting',
    installing: 'Installing',
    downloaded: 'Downloaded',
    done: 'Installed',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };

  const app = {
    scan: null,
    admin: false,
    jobs: [],
    filter: 'all',
    query: '',
    selected: new Set(),
    expanded: new Set(),
    scanning: false,
    startedAt: 0,
    ticker: null,
    jobId: null,
    offline: false,
  };

  const esc = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtBytes(n) {
    if (!Number.isFinite(n) || n <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  }

  function fmtDate(date) {
    if (!date) return '—';
    const parts = String(date).slice(0, 10).split('-');
    if (parts.length !== 3) return String(date);
    const [y, m, d] = parts.map(Number);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${months[(m || 1) - 1]} ${d}, ${y}`;
  }

  function iconFor(className) {
    const paths = ICONS[className] || ICONS.default;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  }

  async function api(path, { method = 'GET', body } = {}) {
    let res;
    try {
      res = await fetch(path, {
        method,
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      setOffline(true);
      const offline = new Error('The local server stopped. Run start.cmd to bring it back.');
      offline.offline = true;
      throw offline;
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(data?.error || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  let healthTimer = null;
  let sseDownTimer = null;

  function setOffline(offline) {
    app.offline = Boolean(offline);
    const banner = $('#offlineBanner');
    if (!banner) return;
    banner.hidden = !offline;
    document.body.classList.toggle('is-offline', Boolean(offline));
    if (offline && !healthTimer) {
      healthTimer = setInterval(probeServer, 2500);
    } else if (!offline && healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  async function probeServer() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      if (!res.ok) return false;
      setOffline(false);
      location.reload();
      return true;
    } catch {
      return false;
    }
  }

  let toastTimer = null;
  function toast(message, kind = '') {
    const el = $('#toast');
    el.textContent = message;
    el.className = `toast show ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.className = 'toast';
    }, 4500);
  }

  /* ── state ─────────────────────────────────────────────── */

  function applyState(payload) {
    if (!payload) return;
    if (typeof payload.admin === 'boolean') {
      app.admin = payload.admin;
      renderAdmin();
    }
    if (payload.scan) applyScan(payload.scan, true);
    if (Array.isArray(payload.jobs) && payload.jobs.length) {
      const latest = payload.jobs[payload.jobs.length - 1];
      app.jobs = payload.jobs;
      // Only surface work that is still in flight. Finished jobs from a
      // previous session should not pop open on page load.
      if (latest.status === 'running') renderJob(latest);
    }
    renderSystem();
  }

  function applyScan(snapshot, full = false) {
    const previous = app.scan;
    app.scan = full ? snapshot : { ...(app.scan || {}), ...snapshot };
    app.scanning = app.scan.phase === 'scanning';

    document.body.classList.toggle('scanning', app.scanning);
    if (app.scanning) {
      const started = app.scan.startedAt ? new Date(app.scan.startedAt).getTime() : Date.now();
      if (!app.startedAt) app.startedAt = started;
      startTicker();
    } else {
      app.startedAt = 0;
      stopTicker();
    }

    updateOrb();
    updateStage();

    if (app.scanning) {
      if (!previous || previous.phase !== 'scanning') {
        renderRows();
        renderStats();
      }
      return;
    }

    renderAll();
    if (app.scan.phase === 'ready' && previous && previous.phase === 'scanning') {
      const n = app.scan.stats?.updates || 0;
      toast(n ? `${n} update${n === 1 ? '' : 's'} available.` : 'Scan complete — everything is current.', 'good');
    }
    if (app.scan.phase === 'error') toast(app.scan.error || 'Scan failed.', 'bad');
  }

  function renderAll() {
    renderSystem();
    renderAdmin();
    renderStats();
    renderTabs();
    renderRows();
    renderNotes();
    updateActionBar();
    updateOrb();
    updateStage();
  }

  function renderSystem() {
    const system = app.scan?.system || {};
    const label = [system.manufacturer, system.model].filter(Boolean).join(' ');
    const pill = $('#systemPill');
    const text = label || (system.os ? system.os : 'Detecting system');
    pill.textContent = text.length > 46 ? `${text.slice(0, 44)}…` : text;
    pill.title = [label, system.os, system.build ? `Build ${system.build}` : null].filter(Boolean).join(' · ');
  }

  function renderAdmin() {
    const pill = $('#adminPill');
    pill.classList.toggle('is-admin', app.admin);
    pill.classList.toggle('is-bad', !app.admin);
    $('#adminText').textContent = app.admin ? 'Administrator' : 'Standard user';
    pill.title = app.admin
      ? 'Elevated — driver installation is enabled.'
      : 'Click to restart with administrator rights. Installation is disabled.';
    pill.style.cursor = app.admin ? 'default' : 'pointer';
  }

  function setStat(el, value) {
    const target = Math.max(0, Number(value) || 0);
    const from = Number(el.dataset.value || 0);
    el.dataset.value = String(target);
    if (from === target) {
      el.textContent = String(target);
      return;
    }
    const token = `${Date.now()}-${Math.random()}`;
    el.dataset.anim = token;
    const start = performance.now();
    const duration = 420;
    const step = (now) => {
      if (el.dataset.anim !== token) return;
      const t = Math.min(1, Math.max(0, (now - start) / duration));
      const eased = 1 - (1 - t) ** 3;
      el.textContent = String(Math.max(0, Math.round(from + (target - from) * eased)));
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  function renderStats() {
    const s = app.scan;
    if (!s || (!s.scannedAt && !app.scanning && !s.rows?.length)) {
      $('#statDevices').textContent = '—';
      $('#statUpdates').textContent = '—';
      $('#statProblems').textContent = '—';
      $('#statCurrent').textContent = '—';
      $('#statDevicesFoot').textContent = 'Not scanned';
      $('#statUpdatesFoot').textContent = 'Awaiting scan';
      $('#statProblemsFoot').textContent = 'Device health';
      $('#statCurrentFoot').textContent = 'Latest versions';
      return;
    }
    if (app.scanning) {
      $('#statDevices').textContent = String(s.stats?.devices || 0);
      $('#statDevicesFoot').textContent = 'Reading device tree';
      $('#statUpdatesFoot').textContent = 'Querying catalog';
      $('#statProblemsFoot').textContent = 'Device health';
      $('#statCurrentFoot').textContent = 'Latest versions';
      return;
    }
    const stats = s.stats || {};
    setStat($('#statDevices'), stats.devices || 0);
    setStat($('#statUpdates'), stats.updates || 0);
    setStat($('#statProblems'), stats.problems || 0);
    setStat($('#statCurrent'), stats.current || 0);

    $('#statDevicesFoot').textContent = stats.instances
      ? `${stats.instances} hardware instance${stats.instances === 1 ? '' : 's'}`
      : 'Present devices';
    $('#statUpdatesFoot').textContent = stats.updates
      ? `${stats.updates} package${stats.updates === 1 ? '' : 's'} available`
      : 'None available';
    $('#statProblemsFoot').textContent = stats.problems
      ? `${stats.problems} device${stats.problems === 1 ? '' : 's'} ${stats.problems === 1 ? 'needs' : 'need'} attention`
      : 'All devices healthy';
    $('#statCurrentFoot').textContent = stats.missing
      ? `${stats.missing} missing driver${stats.missing === 1 ? '' : 's'}`
      : 'Latest versions';
  }

  function renderTabs() {
    const rows = app.scan?.rows || [];
    const count = (predicate) => rows.filter(predicate).length;
    $('#countAll').textContent = rows.length;
    $('#countUpdate').textContent = count((r) => r.state === 'update');
    $('#countProblem').textContent = count((r) => r.state === 'problem' || r.state === 'missing' || r.problem);
    $('#countCurrent').textContent = count((r) => r.state === 'current' || r.state === 'newer');
    $('#selectAll').hidden = count((r) => r.state === 'update') === 0;
    $$('.tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.filter === app.filter);
      tab.setAttribute('aria-selected', String(tab.dataset.filter === app.filter));
    });
  }

  function renderNotes() {
    const notes = app.scan?.notes || [];
    const box = $('#notes');
    if (!notes.length) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML = notes.map((n) => `<span class="note ${esc(n.level)}">${esc(n.text)}</span>`).join('');
  }

  function filteredRows() {
    let rows = app.scan?.rows || [];
    if (app.filter === 'update') rows = rows.filter((r) => r.state === 'update');
    else if (app.filter === 'problem') rows = rows.filter((r) => r.state === 'problem' || r.state === 'missing' || r.problem);
    else if (app.filter === 'current') rows = rows.filter((r) => r.state === 'current' || r.state === 'newer');

    const q = app.query.trim().toLowerCase();
    if (q) {
      rows = rows.filter((r) =>
        [r.name, r.classLabel, r.installed?.provider, r.hardwareId, r.latest?.title]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    return rows;
  }

  function rowHtml(row) {
    const meta = STATE_META[row.state] || STATE_META.unknown;
    const open = app.expanded.has(row.id);
    const canSelect = row.state === 'update';
    const checked = app.selected.has(row.id);
    const provider = row.installed?.provider || 'Unknown provider';
    const hwid = row.hardwareId || row.instanceId;
    const shortHwid = hwid ? (hwid.length > 46 ? `${hwid.slice(0, 44)}…` : hwid) : '';

    const available =
      row.state === 'newer'
        ? '<span class="row-version available">—<span class="sub">installed is newer</span></span>'
        : row.latest
          ? `<span class="row-version available">${esc(row.latest.version)}<span class="sub">${esc(
              row.latest.sourceLabel || '',
            )}</span></span>`
          : '<span class="row-version available">—</span>';

    const installed = row.installed?.version
      ? `<span class="row-version installed">${esc(row.installed.version)}</span>`
      : '<span class="row-version installed">—</span>';

    const many = row.instances > 1 ? ` ×${row.instances}` : '';
    return `
      <article class="row state-${esc(row.state)}${open ? ' open' : ''}" data-id="${esc(row.id)}">
        <div class="row-main" role="button" tabindex="0" aria-expanded="${open}">
          <label class="row-check${canSelect ? '' : ' is-disabled'}" title="${canSelect ? 'Select for update' : 'No update available'}">
            <input type="checkbox" data-select="${esc(row.id)}" ${checked ? 'checked' : ''} ${canSelect ? '' : 'disabled'} aria-label="Select ${esc(row.name)}" />
          </label>
          <span class="class-icon" aria-hidden="true">${iconFor(row.className)}</span>
          <div class="row-title">
            <h3 title="${esc(row.name)}">${esc(row.name)}</h3>
            <p class="row-meta"><b>${esc(row.classLabel)}</b>${many} · ${esc(provider)}${shortHwid ? ` · <span title="${esc(hwid)}">${esc(shortHwid)}</span>` : ''}</p>
          </div>
          ${installed}
          ${available}
          <span class="badge ${meta.cls}">${meta.label}</span>
          <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
        </div>
        <div class="row-detail"><div class="row-detail-inner"><div class="row-detail-body">
          <div class="detail-col">
            <h4>Installed</h4>
            <div class="detail-line"><span>Version</span><b>${esc(row.installed?.version || 'Not installed')}</b></div>
            <div class="detail-line"><span>Driver date</span><b>${esc(fmtDate(row.installed?.date))}</b></div>
            <div class="detail-line"><span>Provider</span><b class="text">${esc(provider)}</b></div>
            <div class="detail-line"><span>INF</span><b>${esc(row.installed?.inf || '—')}</b></div>
            ${row.instances > 1 ? `<div class="detail-line"><span>Instances</span><b>${row.instances} devices</b></div>` : ''}
            ${row.problem ? `<div class="detail-line"><span>Problem code</span><b>${esc(row.problem)}</b></div>` : ''}
          </div>
          <div class="detail-col">
            <h4>${row.state === 'newer' ? 'Catalog newest' : 'Available'}</h4>
            <div class="detail-line"><span>Version</span><b>${esc(row.latest?.version || 'None found')}</b></div>
            <div class="detail-line"><span>Released</span><b>${esc(fmtDate(row.latest?.date))}</b></div>
            <div class="detail-line"><span>Source</span><b class="text">${esc(row.latest?.sourceLabel || '—')}</b></div>
            <div class="detail-line"><span>Size</span><b>${row.latest?.sizeBytes ? esc(fmtBytes(row.latest.sizeBytes)) : '—'}</b></div>
            <div class="detail-line"><span>Package</span><b class="text">${esc(row.latest?.title || '—')}</b></div>
            ${row.latest?.verified === true ? '<div class="detail-line"><span>Checked</span><b class="text">Hardware ID match</b></div>' : ''}
          </div>
          ${row.reason ? `<div class="detail-note warn">${esc(row.reason)}</div>` : ''}
          ${row.state === 'current' ? '<div class="detail-note">No newer package found for this device in the public catalog.</div>' : ''}
          ${row.state === 'problem' && !row.latest ? '<div class="detail-note warn">Windows reports a problem with this device and no replacement package was found automatically.</div>' : ''}
          <div class="detail-actions">
            ${
              row.state === 'update'
                ? `<button class="btn primary small" data-install="${esc(row.id)}">Download &amp; install</button>
                   <button class="btn ghost small" data-download="${esc(row.id)}">Download only</button>`
                : ''
            }
            ${
              row.latest?.detailsUrl
                ? `<a class="btn ghost small" href="${esc(row.latest.detailsUrl)}" target="_blank" rel="noopener">Vendor page</a>`
                : ''
            }
            <a class="btn ghost small" href="https://www.catalog.update.microsoft.com/Search.aspx?q=${encodeURIComponent(
              row.name,
            )}" target="_blank" rel="noopener">Catalog</a>
            <span class="spacer"></span>
            ${hwid ? `<button class="btn ghost small" data-copy="${esc(hwid)}">Copy hardware ID</button>` : ''}
          </div>
        </div></div></div>
      </article>`;
  }

  function setEmpty(title, text) {
    $('#emptyTitle').textContent = title;
    $('#emptyText').textContent = text;
    $('#emptyState').classList.remove('hidden');
  }

  function renderRows() {
    const list = $('#deviceList');
    const s = app.scan;

    if (app.scanning && (!s?.rows || !s.rows.length)) {
      $('#emptyState').classList.add('hidden');
      list.innerHTML = Array.from({ length: 7 }, () => '<div class="skeleton"></div>').join('');
      return;
    }

    if (!s || (!s.scannedAt && !s.rows?.length)) {
      list.innerHTML = '';
      setEmpty(
        'No scan yet',
        'Press SCAN to inventory this machine and check every driver against the public catalog.',
      );
      return;
    }

    const rows = filteredRows();
    if (!rows.length) {
      list.innerHTML = '';
      if (app.query) setEmpty('No matches', `Nothing matches “${app.query}”.`);
      else if (app.filter === 'update') setEmpty('Everything is current', 'No newer driver packages were found for this machine.');
      else if (app.filter === 'problem') setEmpty('No problems detected', 'Every device is reporting healthy.');
      else setEmpty('Nothing here', 'Try a different filter.');
      return;
    }

    $('#emptyState').classList.add('hidden');
    list.innerHTML = rows.map(rowHtml).join('');
  }

  function updateOrb() {
    const s = app.scan;
    const pct = Math.round(app.scanning ? s?.progress || 0 : s?.scannedAt ? 100 : 0);
    $('#orbPercent').textContent = `${pct}%`;
    const label = $('#orbLabel');
    if (app.scanning) label.textContent = '';
    else label.textContent = s?.scannedAt ? 'RESCAN' : 'SCAN';
    $('#scanBtn').setAttribute('aria-label', app.scanning ? `Scanning, ${pct} percent` : s?.scannedAt ? 'Rescan this computer' : 'Scan this computer for driver updates');
  }

  function updateStage() {
    const s = app.scan;
    const text = $('#stageText');
    const dot = $('#readoutDot');
    dot.className = 'readout-dot';
    if (app.scanning) {
      text.textContent = s?.stageLabel || 'Starting scan';
      dot.classList.add('live');
    } else if (s?.phase === 'error') {
      text.textContent = s.error || 'Scan failed';
      dot.classList.add('err');
    } else if (s?.scannedAt) {
      const count = s.stats?.updates || 0;
      text.textContent = count
        ? `${count} update${count === 1 ? '' : 's'} ready`
        : 'Everything is up to date';
      dot.classList.add('done');
    } else {
      text.textContent = 'Idle';
    }
    updateTickerText();
  }

  function updateTickerText() {
    const el = $('#stageTime');
    if (!app.scanning) {
      const at = app.scan?.scannedAt;
      el.textContent = at
        ? `scanned ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : '';
      return;
    }
    const started = app.startedAt || (app.scan?.startedAt ? new Date(app.scan.startedAt).getTime() : Date.now());
    el.textContent = `${Math.max(0, Math.round((Date.now() - started) / 1000))}s`;
  }

  function startTicker() {
    if (app.ticker) return;
    app.ticker = setInterval(updateTickerText, 500);
  }

  function stopTicker() {
    if (app.ticker) clearInterval(app.ticker);
    app.ticker = null;
  }

  function updateActionBar() {
    const rows = app.scan?.rows || [];
    const valid = new Set(rows.filter((r) => r.state === 'update').map((r) => r.id));
    for (const id of [...app.selected]) if (!valid.has(id)) app.selected.delete(id);

    const chosen = rows.filter((r) => app.selected.has(r.id));
    const bar = $('#actionBar');
    bar.hidden = chosen.length === 0;
    $('#selCount').textContent = chosen.length;
    const bytes = chosen.reduce((sum, r) => sum + (r.latest?.sizeBytes || 0), 0);
    $('#selSize').textContent = bytes ? fmtBytes(bytes) : 'size unknown';
    syncSelectAll();
  }

  function syncSelectAll() {
    const updates = (app.scan?.rows || []).filter((r) => r.state === 'update');
    const allSelected = updates.length > 0 && updates.every((r) => app.selected.has(r.id));
    $('#selectAll').textContent = allSelected ? 'Clear selection' : 'Select all updates';
  }

  /* ── scan ──────────────────────────────────────────────── */

  async function triggerScan() {
    if (app.scanning) {
      toast('A scan is already running.', '');
      return;
    }
    app.scanning = true;
    app.startedAt = Date.now();
    app.selected.clear();
    app.scan = {
      ...(app.scan || {}),
      phase: 'scanning',
      progress: 0,
      cached: false,
      stageLabel: 'Starting scan',
      startedAt: new Date().toISOString(),
    };
    document.body.classList.add('scanning');
    renderStats();
    renderTabs();
    updateOrb();
    updateStage();
    startTicker();
    updateActionBar();

    try {
      const res = await api('/api/scan', { method: 'POST' });
      if (res && res.started === false && res.error) throw new Error(res.error);
    } catch (err) {
      app.scanning = false;
      document.body.classList.remove('scanning');
      stopTicker();
      renderStats();
      updateOrb();
      updateStage();
      toast(err.message || 'Could not start the scan.', 'bad');
    }
  }

  /* ── jobs ──────────────────────────────────────────────── */

  function ask({
    title,
    body,
    rows = [],
    okLabel = 'Continue',
    showRestore = false,
    showBackup = false,
    cancelLabel = 'Cancel',
  }) {
    return new Promise((resolve) => {
      const dlg = $('#confirm');
      $('#confirmTitle').textContent = title;
      $('#confirmBody').textContent = body;
      $('#confirmList').innerHTML = rows
        .map((r) => `<li><span>${esc(r.name)}</span><b>${esc(r.latest?.version || '')}</b></li>`)
        .join('');
      $('#confirmList').style.display = rows.length ? '' : 'none';
      $('#confirmOk').textContent = okLabel;
      const cancelBtn = dlg.querySelector('button[value="cancel"]');
      cancelBtn.textContent = cancelLabel;
      const restoreLabel = $('#confirmRestore').closest('label');
      restoreLabel.style.display = showRestore ? '' : 'none';
      const backupLabel = $('#confirmBackup').closest('label');
      backupLabel.style.display = showBackup ? '' : 'none';

      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        resolve({
          ok: dlg.returnValue === 'ok',
          restore: $('#confirmRestore').checked,
          backup: $('#confirmBackup').checked,
        });
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = 'cancel';
      dlg.showModal();
    });
  }

  async function startJob(rowIds, install) {
    const rows = (app.scan?.rows || []).filter((r) => rowIds.includes(r.id));
    if (!rows.length) return;

    if (install && !app.admin) {
      promptElevate();
      return;
    }

    const bytes = rows.reduce((sum, r) => sum + (r.latest?.sizeBytes || 0), 0);
    const answer = await ask({
      title: install ? `Update ${rows.length} driver${rows.length === 1 ? '' : 's'}` : `Download ${rows.length} package${rows.length === 1 ? '' : 's'}`,
      body: install
        ? `Drivers will be downloaded over ${$('#partsSelect').value} parallel connections and installed with pnputil. A restart may be required. Total size ${fmtBytes(bytes)}.`
        : `Packages will be downloaded to data\\downloads. Nothing will be installed. Total size ${fmtBytes(bytes)}.`,
      rows,
      okLabel: install ? 'Install now' : 'Download',
      showRestore: install,
      showBackup: install,
    });
    if (!answer.ok) return;

    try {
      const res = await api('/api/install', {
        method: 'POST',
        body: {
          items: rows.map((r) => ({ rowId: r.id })),
          install,
          parts: Number($('#partsSelect').value),
          restorePoint: answer.restore,
          backup: answer.backup,
        },
      });
      if (res.error === 'admin') {
        promptElevate();
        return;
      }
      if (res.error) throw new Error(res.message || res.error);
      app.jobId = res.job.id;
      renderJob(res.job);
      toast(install ? 'Installation started.' : 'Download started.', 'good');
    } catch (err) {
      if (err.status === 409) promptElevate();
      else toast(err.message || 'Could not start the job.', 'bad');
    }
  }

  async function promptElevate() {
    const answer = await ask({
      title: 'Administrator rights required',
      body: 'Installing drivers needs an elevated process. Restart the app as administrator? A UAC prompt will appear; the page reconnects automatically.',
      okLabel: 'Restart as admin',
      cancelLabel: 'Not now',
    });
    if (!answer.ok) return;
    try {
      await api('/api/elevate', { method: 'POST' });
      toast('Restarting with administrator rights…', 'good');
    } catch (err) {
      toast(err.message || 'Could not elevate.', 'bad');
    }
  }

  let jobEmitAt = 0;
  function renderJob(job) {
    if (!job) return;
    const panel = $('#jobPanel');
    const running = job.status === 'running';
    const stats = job.totals || { bytes: 0, downloaded: 0, speed: 0 };

    panel.hidden = false;
    $('#jobKicker').textContent = running ? 'Live job' : job.status.toUpperCase();
    $('#jobTitle').textContent = running
      ? `${job.install ? 'Updating' : 'Downloading'} ${job.items.length} package${job.items.length === 1 ? '' : 's'}`
      : job.status === 'done'
        ? 'All packages finished'
        : job.status === 'partial'
          ? 'Finished with errors'
          : job.status === 'cancelled'
            ? 'Job cancelled'
            : 'Job failed';

    $('#jobSpeed').textContent = running ? `${fmtBytes(stats.speed)}/s` : '';
    $('#jobBytes').textContent = `${fmtBytes(stats.downloaded)} / ${fmtBytes(stats.bytes)}`;

    const notes = job.notes || [];
    const notesBox = $('#jobNotes');
    notesBox.hidden = notes.length === 0;
    notesBox.innerHTML = notes
      .map((n) => `<div class="job-note ${esc(n.level || '')}">${esc(n.text)}</div>`)
      .join('');

    const failed = job.items.filter((item) => item.status === 'failed' && item.rowId);
    $('#jobRetry').classList.toggle('hidden', running || failed.length === 0);
    $('#jobRetry').textContent = `Retry ${failed.length} failed`;

    $('#jobItems').innerHTML = job.items
      .map((item) => {
        const pct = item.percent || 0;
        const active = item.status === 'downloading' || item.status === 'installing' || item.status === 'extracting';
        const label = JOB_STATE[item.status] || item.status;
        const detail =
          item.status === 'failed'
            ? `<span class="err">${esc(item.error || 'Failed')}</span>`
            : item.status === 'downloading'
              ? `<span>${esc(fmtBytes(item.downloaded))} / ${esc(fmtBytes(item.size))}</span><span>${esc(fmtBytes(item.speed))}/s</span>`
              : `<span>${esc(item.message || '')}</span>`;
        return `
          <div class="job-item${active ? ' is-active' : ''}">
            <div class="job-item-top">
              <span class="job-item-name" title="${esc(item.name)}">${esc(item.name)}</span>
              <span class="job-item-state ${esc(item.status)}">${esc(label)}</span>
            </div>
            <div class="job-bar"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div>
            <div class="job-item-msg">${detail}</div>
          </div>`;
      })
      .join('');

    $('#jobCancel').classList.toggle('hidden', !running);
    $('#jobRescan').classList.toggle('hidden', running);
    $('#jobRescan').textContent = job.install ? 'Rescan to verify' : 'Rescan';
    $('#jobFolder').classList.toggle('hidden', running);
    $('#jobPanel').dataset.jobId = job.id;

    if (!running && job.rebootRequired && !job.notified) {
      job.notified = true;
      toast('A restart is required to finish installing the drivers.', '');
    }
  }

  /* ── events ────────────────────────────────────────────── */

  function bind() {
    $('#scanBtn').addEventListener('click', triggerScan);

    $('#deviceList').addEventListener('click', (event) => {
      const copy = event.target.closest('[data-copy]');
      if (copy) {
        navigator.clipboard?.writeText(copy.dataset.copy).then(
          () => toast('Hardware ID copied.', 'good'),
          () => toast('Could not copy.', 'bad'),
        );
        return;
      }
      const install = event.target.closest('[data-install]');
      if (install) {
        event.stopPropagation();
        startJob([install.dataset.install], true);
        return;
      }
      const download = event.target.closest('[data-download]');
      if (download) {
        event.stopPropagation();
        startJob([download.dataset.download], false);
        return;
      }
      if (event.target.closest('.row-check')) return;
      const main = event.target.closest('.row-main');
      if (main) {
        const id = main.closest('.row').dataset.id;
        if (app.expanded.has(id)) app.expanded.delete(id);
        else app.expanded.add(id);
        main.closest('.row').classList.toggle('open', app.expanded.has(id));
        main.setAttribute('aria-expanded', String(app.expanded.has(id)));
      }
    });

    $('#deviceList').addEventListener('change', (event) => {
      const box = event.target.closest('input[data-select]');
      if (!box) return;
      if (box.checked) app.selected.add(box.dataset.select);
      else app.selected.delete(box.dataset.select);
      updateActionBar();
      syncSelectAll();
    });

    $('#deviceList').addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const main = event.target.closest('.row-main');
      if (!main) return;
      event.preventDefault();
      main.click();
    });

    $$('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        app.filter = tab.dataset.filter;
        renderTabs();
        renderRows();
      });
    });

    let searchTimer = null;
    $('#search').addEventListener('input', (event) => {
      clearTimeout(searchTimer);
      const value = event.target.value;
      searchTimer = setTimeout(() => {
        app.query = value;
        renderRows();
      }, 140);
    });

    $('#selectAll').addEventListener('click', () => {
      const updates = (app.scan?.rows || []).filter((r) => r.state === 'update');
      const all = updates.every((r) => app.selected.has(r.id));
      if (all) app.selected.clear();
      else updates.forEach((r) => app.selected.add(r.id));
      renderRows();
      updateActionBar();
      syncSelectAll();
    });

    $('#installBtn').addEventListener('click', () => startJob([...app.selected], true));
    $('#downloadBtn').addEventListener('click', () => startJob([...app.selected], false));

    $('#adminPill').addEventListener('click', () => {
      if (!app.admin) promptElevate();
    });

    $('#offlineRetry').addEventListener('click', async () => {
      const ok = await probeServer();
      if (!ok) toast('Still offline. Run start.cmd in the app folder.', 'bad');
    });

    $('#jobClose').addEventListener('click', () => {
      $('#jobPanel').hidden = true;
    });

    $('#jobCancel').addEventListener('click', async () => {
      const jobId = $('#jobPanel').dataset.jobId;
      if (!jobId) return;
      try {
        await api('/api/cancel', { method: 'POST', body: { jobId } });
        toast('Cancelling…', '');
      } catch (err) {
        toast(err.message || 'Could not cancel.', 'bad');
      }
    });

    $('#jobRetry').addEventListener('click', () => {
      const job = app.jobs.find((j) => j.id === $('#jobPanel').dataset.jobId);
      if (!job) return;
      const known = new Set((app.scan?.rows || []).map((r) => r.id));
      const ids = job.items
        .filter((item) => item.status === 'failed' && item.rowId && known.has(item.rowId))
        .map((item) => item.rowId);
      if (!ids.length) {
        toast('Rescan first — these devices are no longer in the current scan.', 'bad');
        return;
      }
      startJob(ids, job.install);
    });

    $('#jobRescan').addEventListener('click', () => {
      $('#jobPanel').hidden = true;
      triggerScan();
    });

    $('#jobFolder').addEventListener('click', async () => {
      try {
        await api('/api/open', { method: 'POST', body: {} });
      } catch (err) {
        toast(err.message || 'Could not open the folder.', 'bad');
      }
    });
  }

  function connect() {
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'state') applyState(message.data);
      else if (message.type === 'scan') applyScan(message.data);
      else if (message.type === 'job') {
        const job = message.data;
        app.jobs = [...app.jobs.filter((j) => j.id !== job.id), job];
        renderJob(job);
        if (job.status !== 'running') {
          const label =
            job.status === 'done'
              ? job.install
                ? 'Drivers installed.'
                : 'Downloads complete.'
              : job.status === 'cancelled'
                ? 'Job cancelled.'
                : 'Job finished with errors.';
          toast(label, job.status === 'done' ? 'good' : job.status === 'cancelled' ? '' : 'bad');
        }
      }
    };
    source.onopen = () => {
      clearTimeout(sseDownTimer);
      setOffline(false);
    };
    source.onerror = () => {
      // EventSource retries by itself. Only show the banner if it stays down.
      clearTimeout(sseDownTimer);
      sseDownTimer = setTimeout(() => {
        if (source.readyState !== EventSource.OPEN) setOffline(true);
      }, 4000);
    };
  }

  bind();

  // Catch a server that disappeared while the page was idle (the classic
  // "click Download -> Failed to fetch" case). Two consecutive misses avoid
  // flashing the banner during a fast restart.
  let healthMisses = 0;
  setInterval(async () => {
    if (app.offline) return;
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      healthMisses = res.ok ? 0 : healthMisses + 1;
    } catch {
      healthMisses += 1;
    }
    if (healthMisses >= 2) setOffline(true);
  }, 8000);

  api('/api/state')
    .then(applyState)
    .catch((err) => {
      if (err.offline) setOffline(true);
      else toast(err.message || 'Could not reach the local server. Is it running?', 'bad');
    })
    .finally(connect);
})();
