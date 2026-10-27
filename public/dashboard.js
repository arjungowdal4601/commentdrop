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

// Per-platform split once Instagram has sent anything, else the waiting count.
function sentSub(t) {
  const p = t.byPlatform;
  if (p?.instagram?.sent) return `${num(p.youtube?.sent || 0)} YouTube · ${num(p.instagram.sent)} Instagram`;
  return t.waiting ? `${num(t.waiting)} waiting for the viewer's email` : 'Every request delivered';
}

const IG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/></svg>';

function giveawayBadge(a, addHref) {
  return a
    ? `<span class="badge ${a.active ? 'on' : ''}"><span class="kw">${esc(a.keyword)}</span>${a.active ? '' : ' · paused'} · ${num(a.sent)} sent</span>`
    : `<a class="badge off" href="${addHref}">+ Add giveaway</a>`;
}

// Instagram: a connect card until the account is linked, then its posts.
function renderInstagram(ig) {
  const card = $('#igCard');
  card.hidden = !ig;
  if (!ig) return;
  if (!ig.connected) {
    card.innerHTML = `<div class="card-h"><h2>Instagram</h2><span class="sub">Not connected</span></div>
      <div class="ig-connect">
        <span class="ig-mark">${IG_ICON}</span>
        <div class="ig-copy"><b>Connect Instagram</b>
          <p>Run the same comment-to-get giveaways on your posts and reels. Needs an Instagram Business or Creator account. Switching is free in the Instagram app: <span class="ig-path">Settings → Account type and tools → Switch to professional account</span>.</p></div>
        <div class="ig-cta">${ig.configured
          ? '<a class="btn dark" href="/api/auth/instagram">Connect Instagram</a>'
          : '<button class="btn dark" type="button" disabled>Connect Instagram</button><span class="hint">Instagram isn\'t set up on this server yet</span>'}</div>
      </div>`;
    return;
  }
  const name = ig.username ? `@${ig.username}` : 'Instagram';
  const posts = ig.posts;
  const rows = !posts
    ? '<tr><td colspan="3" class="err">Could not load your Instagram posts right now.</td></tr>'
    : posts.length ? posts.map((p) => `<tr><td><div class="vcell"><img src="${esc(p.thumb)}" alt="" loading="lazy"><div style="min-width:0"><div class="t">${esc(p.title || 'Untitled post')}</div><div class="d">${date(p.publishedAt)}${p.permalink ? ` · <a href="${esc(p.permalink)}" target="_blank" rel="noopener">View on Instagram</a>` : ''}</div></div></div></td>
      <td class="num hide-sm">${num(p.comments)}</td><td>${giveawayBadge(p.automation, `/automations?post=${encodeURIComponent(p.id)}`)}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No posts on this account yet.</td></tr>';
  card.innerHTML = `<div class="card-h">
      <div class="ig-who">${ig.avatar ? `<img src="${esc(ig.avatar)}" alt="" referrerpolicy="no-referrer">` : `<span class="ig-mark sm">${IG_ICON}</span>`}<h2>${esc(name)}</h2><span class="sub">Instagram</span></div>
      <button class="btn sm" id="igOut" type="button">Disconnect</button></div>
    <div class="tbl-wrap"><table class="vt plain ig-vt">
      <thead><tr><th>Post</th><th class="num hide-sm">Comments</th><th>Giveaway</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
  $('#igOut').onclick = async (e) => {
    if (!confirm(`Disconnect ${name}? Instagram giveaways stop until you connect it again.`)) return;
    e.target.disabled = true;
    try {
      const r = await fetch('/api/instagram/disconnect', { method: 'POST' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not disconnect Instagram');
      location.reload();
    } catch (err) { toast(err.message); e.target.disabled = false; }
  };
}

function render(o) {
  const t = o.totals;
  $('#chan').textContent = o.channel.title + (o.channel.handle ? ` · ${o.channel.handle}` : '');
  $('#kpis').innerHTML = [
    kpi('Views', num(t.views), 'All time'),
    kpi('Subscribers', num(t.subscribers), t.subscribers == null ? 'Hidden on YouTube' : ''),
    kpi('Comments', num(t.comments), `${num(t.keywordComments)} asked for a document`),
    kpi('Documents sent', num(t.documentsSent), sentSub(t)),
    kpi('Videos with a giveaway', `${t.withAutomation}<span class="of"> / ${t.videos}</span>`, `${t.withoutAutomation} without a call to action`),
  ].join('');

  // Busiest videos that still have no giveaway: the easiest wins.
  const missing = o.videos.filter((v) => !v.automation?.active).sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, 3);
  $('#nudge').hidden = !missing.length;
  $('#nudge').innerHTML = `<div class="card-h"><h2>Add a giveaway to your top videos</h2><span class="sub">${t.withoutAutomation} videos have no call to action</span></div>
    <div class="nudge-row">${missing.map((v) => `<a class="nv" href="/automations?video=${encodeURIComponent(v.id)}">
      <img src="${esc(v.thumb)}" alt=""><div><div class="t">${esc(v.title)}</div><div class="d">${num(v.views)} views · ${num(v.comments)} comments</div></div><span class="btn sm">Add</span></a>`).join('')}</div>`;

  $('#videos').innerHTML = o.videos.length ? o.videos.map((v) => {
    const badge = giveawayBadge(v.automation, `/automations?video=${encodeURIComponent(v.id)}`);
    return `<tr><td><div class="vcell"><img src="${esc(v.thumb)}" alt="" loading="lazy"><div style="min-width:0"><div class="t">${esc(v.title)}</div><div class="d">${date(v.publishedAt)}</div></div></div></td>
      <td class="num hide-sm">${num(v.views)}</td><td class="num hide-sm">${num(v.comments)}</td><td>${badge}</td></tr>`;
  }).join('') : '<tr><td colspan="4" class="muted">No public videos on this channel yet.</td></tr>';

  renderInstagram(o.instagram);
}

let lastSig = '';
async function load(refresh, silent) {
  try {
    const res = await fetch(`/api/overview${refresh ? '?refresh=1' : ''}`);
    if (res.status === 401) { location.href = '/'; return; }
    const o = await res.json();
    if (!res.ok) throw new Error(o.error || 'Could not load your channel');
    // Redraw only when a number changed, so the background refresh never flickers.
    const sig = JSON.stringify([o.totals, o.videos, o.instagram]);
    if (sig === lastSig) return;
    lastSig = sig;
    render(o);
  } catch (err) {
    if (silent) return;
    $('#videos').innerHTML = `<tr><td colspan="4" class="err">${esc(err.message)}</td></tr>`;
    toast(err.message);
  }
}

$('#refresh').onclick = async () => {
  const b = $('#refresh');
  b.disabled = true;
  await load(true);
  b.disabled = false;
  toast('Updated from YouTube');
};
// Back from connecting Instagram: say how it went, then tidy the URL.
(() => {
  const p = new URLSearchParams(location.search);
  if (p.get('instagram') === 'connected') toast('Instagram connected');
  else if (p.get('instagram_error')) toast(p.get('instagram_error'));
  else return;
  history.replaceState(null, '', location.pathname);
})();
load();
// Background refresh every 30 s: the server caches YouTube for 10 min, the sent / waiting counts come fresh from the database.
setInterval(() => { if (!document.hidden) load(false, true); }, 30000);
