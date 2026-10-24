// Automations page: live automations, every video with its status, recent requests,
// and one modal that creates or edits an automation (keyword, document, email).
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
    if (res.status === 401) { location.href = '/'; throw new Error('Signed out'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  };
  const toast = (msg) => {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => el.classList.remove('show'), 2800);
  };
  const ago = (iso) => {
    if (!iso) return '';
    const t = new Date(iso);
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const compact = (n) => (n == null ? '–' : new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n));
  const size = (b) => (b == null ? '' : b < 1024 ? `${b} B` : b < 1048576 ? `${Math.round(b / 1024)} KB` : `${(b / 1048576).toFixed(1)} MB`);
  const FILE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';

  // ---- State ----
  let campaigns = [];   // GET /api/campaigns rows
  let videos = [];      // [{ id, title, thumb, publishedAt, views, automation }]
  let activity = [];
  let materials = [];
  let status = {};
  let filter = 'all';
  let feedLimit = 10;
  let overviewOk = false;

  // ---- Loaders ----
  async function loadVideos() {
    try {
      const ov = await api('/api/overview');
      videos = ov.videos || [];
      overviewOk = true;
    } catch (err) {
      if (err.status !== 404 && overviewOk) throw err;
      // Fallback while /api/overview is not available: plain video list.
      const list = await api('/api/yt/videos').catch(() => []);
      videos = list.map((v) => ({ ...v, views: null, automation: null }));
      overviewOk = false;
    }
  }
  const loadCampaigns = async () => { campaigns = await api('/api/campaigns'); };
  const loadActivity = async () => { activity = await api('/api/activity'); };
  const loadMaterials = async () => { materials = await api('/api/materials'); };
  const loadStatus = async () => { status = await api('/api/status').catch(() => ({})); };

  // Sent / waiting for one automation: overview counts when present, else derived.
  function counts(c) {
    const v = videos.find((x) => x.automation && x.automation.id === c.id);
    if (v) return { sent: v.automation.sent || 0, waiting: v.automation.waiting || 0 };
    return {
      sent: c.delivered || 0,
      waiting: activity.filter((a) => a.campaign_id === c.id && a.status === 'waiting').length,
    };
  }
  // The automation shown for a video: newest active campaign, else newest.
  function automationFor(v) {
    const own = campaigns.filter((c) => c.video_id === v.id).sort((a, b) => (b.active - a.active) || (b.id - a.id));
    if (own.length) return own[0];
    return v.automation ? campaigns.find((c) => c.id === v.automation.id) || null : null;
  }

  // ---- Render ----
  function renderLive() {
    const rows = [...campaigns].sort((a, b) => (b.active - a.active) || (b.id - a.id));
    const on = rows.filter((c) => c.active).length;
    $('#liveSub').textContent = rows.length ? `${on} on · ${rows.length - on} paused` : '';
    $('#liveList').innerHTML = rows.length ? rows.map((c) => {
      const n = counts(c);
      return `<li class="au-row${c.active ? '' : ' paused'}">
        <img class="au-thumb" src="${esc(c.video_thumb)}" alt="" loading="lazy">
        <div class="au-main">
          <div class="au-title" title="${esc(c.video_title)}">${esc(c.video_title)}</div>
          <div class="au-meta"><span class="au-kw">${esc(c.keyword)}</span><span class="au-file">${FILE_ICON}<span>${esc(c.material_name)}</span></span></div>
        </div>
        <div class="au-side">
          <span class="au-stat"><b>${n.sent}</b> sent</span>
          <span class="au-stat${n.waiting ? ' wait' : ''}"><b>${n.waiting}</b> waiting</span>
          <button class="au-sw" type="button" role="switch" aria-checked="${!!c.active}" aria-label="${c.active ? 'Pause' : 'Turn on'} ${esc(c.keyword)}" data-toggle="${c.id}"></button>
          <button class="btn sm" type="button" data-edit="${c.id}">Edit</button>
        </div>
      </li>`;
    }).join('') : '<li class="au-empty">No automations yet.</li>';
  }

  function renderVideos() {
    const list = videos.map((v) => ({ v, a: automationFor(v) }))
      .filter(({ a }) => filter === 'all' || (filter === 'with' ? !!a : !a));
    const empty = { all: 'No videos found.', with: 'No videos with an automation.', without: 'Every video has an automation.' }[filter];
    $('#videoRows').innerHTML = list.length ? list.map(({ v, a }) => `
      <tr data-video="${esc(v.id)}">
        <td><div class="vcell"><img src="${esc(v.thumb)}" alt="" loading="lazy"><div style="min-width:0">
          <div class="t">${esc(v.title)}</div><div class="d">${day(v.publishedAt)}</div></div></div></td>
        <td class="num hide-sm">${compact(v.views)}</td>
        <td class="num">${a
          ? `<span class="badge ${a.active ? 'on' : 'off'}"><span class="au-mono">${esc(a.keyword)}</span> · ${a.active ? 'on' : 'paused'}</span>`
          : `<button class="btn sm" type="button" data-add="${esc(v.id)}">Add<span class="hide-xs">&nbsp;automation</span></button>`}</td>
      </tr>`).join('') : `<tr><td colspan="3" class="au-empty">${empty}</td></tr>`;
  }

  const STATUS = {
    sent: (r) => ['sent', `Sent${r.viewer_email ? ` to ${r.viewer_email}` : ''}`],
    waiting: () => ['waiting', 'Waiting for email link'],
    failed: (r) => ['failed', `Failed${r.error ? `: ${r.error}` : ''}`],
  };
  function renderFeed() {
    const rows = activity.slice(0, feedLimit);
    $('#feed').innerHTML = rows.length ? rows.map((r) => {
      const [cls, label] = (STATUS[r.status] || (() => ['', r.status]))(r);
      const name = r.author_name || 'Someone';
      const av = r.author_avatar
        ? `<img class="au-av" src="${esc(r.author_avatar)}" alt="" referrerpolicy="no-referrer">`
        : `<span class="au-av">${esc(name.replace('@', '')[0]?.toUpperCase() || '?')}</span>`;
      return `<li>${av}<div class="au-fb">
          <div class="au-fl"><b>${esc(name)}</b><span class="au-kw">${esc(r.keyword)}</span></div>
          <div class="au-fs ${cls}">${esc(label)}</div>
        </div><span class="au-when" title="${esc(r.video_title)}">${ago(r.delivered_at || r.detected_at)}</span></li>`;
    }).join('') : '<li class="au-empty">No requests yet.</li>';
    $('#moreWrap').hidden = activity.length <= feedLimit;
  }

  const renderAll = () => { renderLive(); renderVideos(); renderFeed(); };

  // ---- Live list: toggle + edit ----
  $('#liveList').onclick = async (e) => {
    const sw = e.target.closest('[data-toggle]');
    if (sw) {
      const c = campaigns.find((x) => String(x.id) === sw.dataset.toggle);
      if (!c) return;
      sw.disabled = true;
      try {
        const row = await api(`/api/campaigns/${c.id}`, { method: 'PATCH', body: { active: !c.active } });
        Object.assign(c, row && row.id ? row : { active: !c.active });
        toast(`${c.keyword} ${c.active ? 'is on' : 'paused'}`);
        renderAll();
      } catch (err) { toast(err.message); sw.disabled = false; }
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) openEdit(ed.dataset.edit);
  };

  // ---- Videos table: filter, add, edit ----
  $('#filters').onclick = (e) => {
    const b = e.target.closest('[data-f]');
    if (!b) return;
    filter = b.dataset.f;
    document.querySelectorAll('#filters .au-chip').forEach((x) => x.classList.toggle('on', x === b));
    renderVideos();
  };
  $('#videoRows').onclick = (e) => {
    const tr = e.target.closest('tr[data-video]');
    if (!tr) return;
    const v = videos.find((x) => x.id === tr.dataset.video);
    const a = v && automationFor(v);
    if (a) openEdit(a.id); else openCreate(tr.dataset.video);
  };

  // ---- Feed ----
  $('#moreBtn').onclick = () => { feedLimit += 10; renderFeed(); };

  // ---- Viewer link ----
  $('#copyJoinBtn').onclick = async () => {
    if (!status.publicJoinUrl) await loadStatus();
    const url = status.publicJoinUrl || `${location.origin}/join`;
    try {
      await navigator.clipboard.writeText(url);
      toast('Viewer link copied');
    } catch {
      // Clipboard blocked (e.g. embedded browsers): copy through a hidden field instead.
      const f = Object.assign(document.createElement('textarea'), { value: url });
      f.style.cssText = 'position:fixed;opacity:0';
      document.body.append(f);
      f.select();
      const ok = document.execCommand('copy');
      f.remove();
      toast(ok ? 'Viewer link copied' : `Viewer link: ${url}`);
    }
  };

  // ---- Modal (create + edit) ----
  let editing = null;     // campaign row when editing, null when creating
  let selectedFile = '';  // material id

  function renderFiles() {
    $('#amFiles').innerHTML = materials.length ? materials.map((m) => `
      <label class="au-opt${m.id === selectedFile ? ' sel' : ''}">
        <input type="radio" name="amFile" value="${esc(m.id)}" ${m.id === selectedFile ? 'checked' : ''}>
        <span class="n">${esc(m.filename)}</span><span class="z">${size(m.size)}</span>
      </label>`).join('') : '<div class="au-opt none">No files yet. Upload one.</div>';
  }
  $('#amFiles').onchange = (e) => {
    if (e.target.name !== 'amFile') return;
    const prev = materials.find((m) => m.id === selectedFile);
    selectedFile = e.target.value;
    const next = materials.find((m) => m.id === selectedFile);
    // Keep the default email text in step with the document name.
    const base = (m) => m && m.filename.replace(/\.[^.]+$/, '');
    if (prev && next) {
      const a = base(prev); const b = base(next);
      if ($('#amSubject').value === `Your ${a} is here`) $('#amSubject').value = `Your ${b} is here`;
      if ($('#amMessage').value === `Thanks for commenting! Here's the ${a} I promised in the video.`) $('#amMessage').value = `Thanks for commenting! Here's the ${b} I promised in the video.`;
    }
    renderFiles();
  };

  $('#amUpload').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) { $('#amErr').textContent = 'Keep files under 4 MB'; e.target.value = ''; return; }
    $('#amErr').textContent = '';
    $('#amUpBtn').firstChild.textContent = 'Uploading…';
    try {
      const res = await fetch('/api/materials', {
        method: 'POST',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
        body: file,
      });
      const m = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(m.error || 'Upload failed');
      await loadMaterials().catch(() => { materials = [m, ...materials]; });
      if (!materials.some((x) => x.id === m.id)) materials.unshift(m);
      selectedFile = m.id;
      renderFiles();
      toast(`Uploaded ${m.filename}`);
    } catch (err) {
      $('#amErr').textContent = err.message;
    } finally {
      $('#amUpBtn').firstChild.textContent = 'Upload new';
      e.target.value = '';
    }
  };

  function videoOptions(pick) {
    const opts = videos.map((v) => {
      const a = automationFor(v);
      return `<option value="${esc(v.id)}">${esc(v.title)}${a ? ` (${esc(a.keyword)})` : ''}</option>`;
    });
    $('#amVideo').innerHTML = opts.join('') + '<option value="__link">Paste a YouTube link…</option>';
    $('#amVideo').value = pick && videos.some((v) => v.id === pick) ? pick : (videos[0] ? videos.find((v) => !automationFor(v))?.id || videos[0].id : '__link');
    $('#amLink').hidden = $('#amVideo').value !== '__link';
  }
  $('#amVideo').onchange = () => { $('#amLink').hidden = $('#amVideo').value !== '__link'; };

  async function openModal() {
    $('#amErr').textContent = '';
    $('#amSave').disabled = false;
    renderFiles();
    $('#amModal').classList.add('open');
    try { await loadMaterials(); renderFiles(); } catch (err) { $('#amErr').textContent = err.message; }
  }

  function openCreate(videoId) {
    editing = null;
    selectedFile = '';
    $('#amTitle').textContent = 'New automation';
    $('#amSave').textContent = 'Create';
    $('#amVideoView').hidden = true;
    $('#amVideo').hidden = false;
    videoOptions(videoId);
    $('#amKeyword').value = '';
    $('#amSubject').value = '';
    $('#amMessage').value = '';
    openModal().then(() => { if (!selectedFile && materials[0]) { selectedFile = materials[0].id; renderFiles(); } });
    setTimeout(() => $('#amKeyword').focus(), 50);
  }

  function openEdit(id) {
    const c = campaigns.find((x) => String(x.id) === String(id));
    if (!c) { toast('Automation not found, refreshing'); refresh(); return; }
    editing = c;
    selectedFile = c.material_id;
    $('#amTitle').textContent = 'Edit automation';
    $('#amSave').textContent = 'Save';
    $('#amVideo').hidden = true;
    $('#amLink').hidden = true;
    $('#amVideoView').hidden = false;
    $('#amVideoView').innerHTML = `<img src="${esc(c.video_thumb)}" alt=""><div style="min-width:0"><div class="t">${esc(c.video_title)}</div><div class="d">Sends ${esc(c.material_name)}</div></div>`;
    $('#amKeyword').value = c.keyword || '';
    $('#amSubject').value = c.subject || '';
    $('#amMessage').value = c.message || '';
    openModal();
  }

  const closeModal = () => { $('#amModal').classList.remove('open'); editing = null; };
  $('#amClose').onclick = closeModal;
  $('#amCancel').onclick = closeModal;
  $('#amModal').onclick = (e) => { if (e.target.id === 'amModal') closeModal(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#amModal').classList.contains('open')) closeModal(); });
  $('#newBtn').onclick = () => openCreate();

  $('#amForm').onsubmit = async (e) => {
    e.preventDefault();
    const keyword = $('#amKeyword').value.trim();
    const subject = $('#amSubject').value.trim();
    const message = $('#amMessage').value.trim();
    if (!keyword || /\s/.test(keyword)) { $('#amErr').textContent = 'Keyword must be one word, e.g. CHEATSHEET'; return; }
    if (!selectedFile) { $('#amErr').textContent = 'Pick or upload a document'; return; }
    $('#amErr').textContent = '';
    $('#amSave').disabled = true;
    try {
      if (editing) {
        const body = { keyword, materialId: selectedFile };
        if (subject) body.subject = subject;
        if (message) body.message = message;
        const row = await api(`/api/campaigns/${editing.id}`, { method: 'PATCH', body });
        if (row && row.id) Object.assign(editing, row);
        toast('Automation saved');
      } else {
        const videoUrl = $('#amVideo').value === '__link' ? $('#amLink').value.trim() : $('#amVideo').value;
        if (!videoUrl) throw new Error('Pick a video or paste a YouTube link');
        const body = { videoUrl, keyword, materialId: selectedFile };
        if (subject) body.subject = subject;
        if (message) body.message = message;
        const c = await api('/api/campaigns', { method: 'POST', body });
        toast(`Watching for ${c.keyword || keyword.toUpperCase()}`);
      }
      closeModal();
      await refresh(true);
    } catch (err) {
      $('#amErr').textContent = err.message;
    } finally {
      $('#amSave').disabled = false;
    }
  };

  // ---- Boot + polling ----
  async function refresh(withVideos) {
    const jobs = [loadCampaigns(), loadActivity()];
    if (withVideos) jobs.push(loadVideos());
    const results = await Promise.allSettled(jobs);
    results.forEach((r) => r.status === 'rejected' && console.error(r.reason));
    renderAll();
  }

  Promise.allSettled([loadCampaigns(), loadActivity(), loadVideos(), loadStatus()]).then((results) => {
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) toast(failed.reason?.message || 'Could not load everything');
    renderAll();
  });
  setInterval(() => { if (!document.hidden) refresh(false); }, 20000);
})();
