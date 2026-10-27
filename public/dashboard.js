const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const toast = (msg) => {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3600);
};
const num = (n) => (n == null ? '—' : Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
const date = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function kpi(label, value, sub) {
  return `<div class="card kpi2"><div class="k">${label}</div><div class="v">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}

function render(o) {
  const t = o.totals;
  $('#chan').textContent = o.channel.title + (o.channel.handle ? ` · ${o.channel.handle}` : '');
  $('#kpis').innerHTML = [
    kpi('Views', num(t.views), 'All time'),
    kpi('Subscribers', num(t.subscribers), t.subscribers == null ? 'Hidden on YouTube' : ''),
    kpi('Comments', num(t.comments), `${num(t.keywordComments)} asked for a document`),
    kpi('Documents sent', num(t.documentsSent), t.waiting ? `${num(t.waiting)} waiting for the viewer's email` : 'Every request delivered'),
    kpi('Videos with a giveaway', `${t.withAutomation}<span class="of"> / ${t.videos}</span>`, `${t.withoutAutomation} without a call to action`),
  ].join('');

  // Busiest videos that still have no giveaway: the easiest wins.
  const missing = o.videos.filter((v) => !v.automation?.active).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  $('#nudge').hidden = !missing.length;
  $('#nudge').innerHTML = `<div class="card-h"><h2>Add a giveaway to your top videos</h2><span class="sub">${t.withoutAutomation} videos have no call to action</span></div>
    <div class="nudge-row">${missing.map((v) => `<a class="nv" href="/automations?video=${encodeURIComponent(v.id)}">
      <img src="${esc(v.thumb)}" alt=""><div><div class="t">${esc(v.title)}</div><div class="d">${num(v.views)} views · ${num(v.comments)} comments</div></div><span class="btn sm">Add</span></a>`).join('')}</div>`;

  $('#videos').innerHTML = o.videos.length ? o.videos.map((v) => {
    const a = v.automation;
    const badge = a
      ? `<span class="badge ${a.active ? 'on' : ''}"><span class="kw">${esc(a.keyword)}</span>${a.active ? '' : ' · paused'} · ${num(a.sent)} sent</span>`
      : `<a class="badge off" href="/automations?video=${encodeURIComponent(v.id)}" onclick="event.stopPropagation()">+ Add giveaway</a>`;
    return `<tr data-v="${esc(v.id)}"><td><div class="vcell"><img src="${esc(v.thumb)}" alt="" loading="lazy"><div style="min-width:0"><div class="t">${esc(v.title)}</div><div class="d">${date(v.publishedAt)}</div></div></div></td>
      <td class="num hide-sm">${num(v.views)}</td><td class="num hide-sm">${num(v.comments)}</td><td>${badge}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">No public videos on this channel yet.</td></tr>';
}

let lastSig = '';
async function load(refresh, silent) {
  try {
    const res = await fetch(`/api/overview${refresh ? '?refresh=1' : ''}`);
    if (res.status === 401) { location.href = '/'; return; }
    const o = await res.json();
    if (!res.ok) throw new Error(o.error || 'Could not load your channel');
    // Redraw only when a number changed, so the background refresh never flickers.
    const sig = JSON.stringify([o.totals, o.videos]);
    if (sig === lastSig) return;
    lastSig = sig;
    render(o);
  } catch (err) {
    if (silent) return;
    $('#videos').innerHTML = `<tr><td colspan="4" class="err">${esc(err.message)}</td></tr>`;
    toast(err.message);
  }
}

// A video row opens its comments.
$('#videos').onclick = (e) => {
  const tr = e.target.closest('tr[data-v]');
  if (tr && !e.target.closest('a')) location.href = `/comments?v=${encodeURIComponent(tr.dataset.v)}`;
};
$('#refresh').onclick = async () => {
  const b = $('#refresh');
  b.disabled = true;
  await load(true);
  b.disabled = false;
  toast('Updated from YouTube');
};
load();
// Live for the demo: documents sent and comments update every 3 s in the background.
setInterval(() => { if (!document.hidden) load(false, true); }, 3000);
