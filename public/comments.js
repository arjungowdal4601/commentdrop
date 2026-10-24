const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  if (res.status === 401) { location.href = '/'; throw new Error('Signed out'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
};
const toast = (msg) => {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3600);
};
const store = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch {} },
};

const TONE = {
  excited: ['🤩', 'Excited'], grateful: ['🙏', 'Grateful'], curious: ['🤔', 'Curious'], confused: ['😕', 'Confused'],
  frustrated: ['😤', 'Frustrated'], critical: ['🧐', 'Critical'], skeptical: ['🤨', 'Skeptical'], suggestion: ['💡', 'Idea'],
  humorous: ['😂', 'Funny'], 'matter-of-fact': ['💬', 'Matter-of-fact'], spam: ['🚫', 'Spam'],
};
const toneChip = (t, cls = '') => {
  const [icon, label] = TONE[t] || TONE['matter-of-fact'];
  return `<span class="chip ${cls}">${icon} ${label}</span>`;
};
const initial = (c) => esc((c.authorName || '?').replace('@', '')[0]?.toUpperCase());
// YouTube avatar URLs can refuse hot-linking; load without a referrer and fall back to the initial.
const avatar = (c) => (c.authorAvatar
  ? `<img class="av" src="${esc(c.authorAvatar)}" alt="" referrerpolicy="no-referrer" onerror="this.outerHTML='<div class=&quot;av&quot;>${initial(c)}</div>'">`
  : `<div class="av">${initial(c)}</div>`);

const ago = (sql) => {
  const t = new Date(sql);
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : t.toLocaleString();
};

// Tabs, in the order a creator wants to read them. Spam and threats share one tab.
const CAT = {
  positive: { label: 'Positive', icon: '💙' },
  neutral: { label: 'Neutral', icon: '💬' },
  suggestion: { label: 'Suggestion', icon: '💡' },
  negative: { label: 'Negative', icon: '👎' },
  spam: { label: 'Spam', icon: '🚫' },
  threat: { label: 'Threat', icon: '⚠️' },
};
const TABS = [
  ['all', 'All'], ['positive', 'Positive'], ['neutral', 'Neutral'], ['suggestion', 'Suggestions'], ['negative', 'Negative'], ['danger', 'Spam & threats'],
];
const RISK = {
  scam: 'Scam', impersonation: 'Impersonator', self_promo: 'Self-promo', bot: 'Bot', harassment: 'Harassment', hate: 'Hate', threat: 'Threat',
};
const MOOD = ['positive', 'suggestion', 'neutral', 'negative', 'spam', 'threat'];
// Old analyses have no category; read one off sentiment and tone.
const catOf = (c) => c.category || (c.tone === 'spam' ? 'spam' : c.tone === 'suggestion' ? 'suggestion' : c.sentiment || 'neutral');
const inTab = (c, tab) => tab === 'all' || (tab === 'danger' ? ['spam', 'threat'].includes(catOf(c)) : catOf(c) === tab);
const hidden = (c) => c.moderation?.status === 'done';
const commentUrl = (c) => c.url || `https://www.youtube.com/watch?v=${analysis.video.id}&lc=${c.id}`;
const when = (iso) => {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso)) / 86400000;
  return d < 1 ? 'today' : d < 2 ? 'yesterday' : d < 30 ? `${Math.floor(d)}d ago` : new Date(iso).toLocaleDateString();
};

let status = { canReply: false, quotaUsed: 0 };
let analysis = null;
const ui = { view: 'all', tab: 'all', selected: null, query: '', only: null, onlyLabel: '', checked: new Set() };
let pending = null; // action waiting for confirmation
const undo = new Map(); // comment id -> text before the last polish

async function loadStatus() {
  status = await api('/api/comments/status');
  $('#connectYt').hidden = status.canReply;
}

const num = (n) => (n == null ? '—' : Intl.NumberFormat('en', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(n));
let videos = [];
// Page 1: every video, with its comment count and whether it has been analysed.
async function loadVideos() {
  const [vids, done] = await Promise.all([api('/api/yt/videos'), api('/api/comments/analysed').catch(() => [])]);
  videos = vids;
  const seen = new Map(done.map((d) => [d.video_id, d]));
  $('#videoRows').innerHTML = vids.length ? vids.map((v) => {
    const a = seen.get(v.id);
    return `<tr data-v="${esc(v.id)}"><td><div class="vcell"><img src="${esc(v.thumb)}" alt="" loading="lazy"><div style="min-width:0"><div class="t">${esc(v.title)}</div>
      <div class="d">${v.publishedAt ? new Date(v.publishedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''}</div></div></div></td>
      <td class="num hide-sm">${num(v.comments)}</td>
      <td>${a ? `<span class="badge on">${num(a.comments)} sorted · ${ago(a.analyzed_at)}</span>` : '<span class="badge">Not analysed</span>'}</td></tr>`;
  }).join('') : '<tr><td colspan="3" class="muted">No public videos on this channel yet.</td></tr>';
}
function showList() {
  $('#listView').hidden = false;
  $('#videoView').hidden = true;
  document.title = 'Comments · CommentDrop';
  loadVideos().catch((err) => toast(err.message));
}
async function showVideo(id) {
  $('#listView').hidden = true;
  $('#videoView').hidden = false;
  const v = videos.find((x) => x.id === id);
  $('#vTitle').textContent = v?.title || 'Video';
  analysis = null;
  render();
  await openVideo(id);
  if (analysis) $('#vTitle').textContent = analysis.video.title;
  document.title = `${$('#vTitle').textContent} · Comments`;
}
const route = () => {
  const id = new URLSearchParams(location.search).get('v');
  return id ? showVideo(id).catch((err) => toast(err.message)) : showList();
};
$('#videoRows').onclick = (e) => {
  const tr = e.target.closest('tr[data-v]');
  if (!tr) return;
  history.pushState(null, '', `/comments?v=${encodeURIComponent(tr.dataset.v)}`);
  route();
};
$('.back').onclick = (e) => { e.preventDefault(); history.pushState(null, '', '/comments'); route(); };
addEventListener('popstate', route);

let currentId = null;
async function openVideo(videoId) {
  if (!videoId) return;
  currentId = videoId;
  setAnalysis(await api(`/api/comments/youtube/${encodeURIComponent(videoId)}`)); // saved result, no quota
}
function setAnalysis(a, keep = false) {
  analysis = a;
  if (!keep) Object.assign(ui, { view: 'all', tab: 'all', selected: null, query: '', only: null, onlyLabel: '' });
  ui.checked.clear();
  render();
}

const allComments = () => {
  if (!analysis) return [];
  const flat = analysis.comments || analysis.groups.flatMap((g) => g.comments);
  return [...flat].sort((a, b) => String(b.publishedAt || '').localeCompare(String(a.publishedAt || '')));
};
const groupOf = (id) => analysis.groups.find((g) => g.comments.some((c) => c.id === id));
const counts = () => {
  const out = { all: 0, positive: 0, neutral: 0, suggestion: 0, negative: 0, spam: 0, threat: 0, danger: 0 };
  for (const c of allComments()) {
    out.all++;
    out[catOf(c)]++;
    if (['spam', 'threat'].includes(catOf(c)) && !hidden(c)) out.danger++;
  }
  return out;
};

// ---- Overview: the audience's collective feedback -------------------------------
function renderOverview() {
  const ov = analysis.overview;
  const n = counts();
  const total = Math.max(1, n.all);
  const mood = MOOD.filter((k) => n[k]).map((k) => `<span class="m-${k}" style="width:${(n[k] / total) * 100}%" tabindex="0"
    data-tip-v="${n[k]} · ${Math.round((n[k] / total) * 100)}%" data-tip-l="${CAT[k].label}"></span>`).join('');
  const col = (key, title, items, cls) => `<div class="ov-col ${cls}"><div class="ov-h">${title}</div>${items?.length
    ? `<ul>${items.map((it, i) => `<li><button class="ov-pt" data-only="${key}:${i}" type="button">${esc(it.point)}<span>${(it.commentIds || []).length} comment${(it.commentIds || []).length === 1 ? '' : 's'} →</span></button></li>`).join('')}</ul>`
    : '<p class="ov-none">Nothing here yet</p>'}</div>`;
  $('#overview').innerHTML = `
    <div class="ov-top">
      <img src="${esc(analysis.video.thumb || '')}" alt="">
      <div class="ov-main">
        <div class="eyebrow">What your audience is saying · ${n.all} comments · analysed ${ago(analysis.analyzedAt)}</div>
        <h2>${esc(ov?.headline || analysis.summary || '')}</h2>
        ${analysis.brief ? `<p class="small muted">About this video: ${esc(analysis.brief.topic)}</p>` : ''}
        <div class="mood" role="img" aria-label="Comment mix">${mood}</div>
        <div class="legend">${MOOD.filter((k) => n[k]).map((k) => `<span><i class="sw m-${k}"></i>${CAT[k].label} <b>${n[k]}</b></span>`).join('')}</div>
      </div>
    </div>
    ${ov ? `<div class="ov-grid">
      ${col('appreciation', '💙 What they love', ov.appreciation, '')}
      ${col('improvements', '🛠 What to improve', ov.improvements, '')}
      ${col('requests', '💡 What they want next', ov.requests, '')}
      ${col('warnings', '⚠️ Watch out', ov.warnings, ov.warnings?.length ? 'warn' : '')}
    </div>` : '<p class="small muted ov-old">Re-analyze this video to get the full overview: what viewers love, what to improve, what they want next and what to watch out for.</p>'}`;
}

// ---- Inbox ------------------------------------------------------------------------
function visible() {
  const q = ui.query.trim().toLowerCase();
  return allComments().filter((c) => (ui.only ? ui.only.has(c.id) : inTab(c, ui.tab))
    && (!q || `${c.authorName} ${c.text}`.toLowerCase().includes(q)));
}
function renderTabs() {
  const n = counts();
  $('#tabs').innerHTML = TABS.map(([k, label]) => `<button class="ix-tab ${!ui.only && ui.tab === k ? 'on' : ''} ${k === 'danger' && n.danger ? 'alert' : ''}" role="tab" data-tab="${k}" type="button">
    ${label}<span class="ct">${k === 'danger' ? n.spam + n.threat : n[k]}</span></button>`).join('');
  $('#filterNote').innerHTML = ui.only ? `Showing: <b>${esc(ui.onlyLabel)}</b> <button class="linkbtn" data-clear-only type="button">Show all</button>` : '';
  const bulk = ui.tab === 'danger' && !ui.only;
  $('#bulk').hidden = !bulk;
  if (bulk) {
    const open = visible().filter((c) => !hidden(c));
    $('#checkAll').checked = open.length > 0 && open.every((c) => ui.checked.has(c.id));
    $$('[data-bulk]').forEach((b) => { b.disabled = !ui.checked.size; });
  }
}
function rowHtml(c) {
  const cat = catOf(c);
  const risk = c.risk && c.risk !== 'none' ? `<span class="risk">${RISK[c.risk] || c.risk}</span>` : '';
  const check = ui.tab === 'danger' && !ui.only && !hidden(c)
    ? `<input type="checkbox" class="ix-check" data-check="${esc(c.id)}" ${ui.checked.has(c.id) ? 'checked' : ''} aria-label="Select">` : '';
  return `<li class="ix-row ${ui.selected === c.id ? 'on' : ''} ${hidden(c) ? 'gone' : ''}" role="option" aria-selected="${ui.selected === c.id}" data-id="${esc(c.id)}" tabindex="0">
    ${check}${avatar(c)}
    <div class="ix-r">
      <div class="ix-who"><b>${esc(c.authorName)}</b><i class="cdot m-${cat}" title="${CAT[cat].label}"></i>${risk}
        ${hidden(c) ? '<span class="tagx">Hidden</span>' : c.reply?.status === 'sent' ? '<span class="tagok">Replied</span>' : ''}<span class="ix-when">${when(c.publishedAt)}</span>
        <a class="ix-open" href="${esc(commentUrl(c))}" target="_blank" rel="noopener" title="Open this exact comment on YouTube" aria-label="Open this comment on YouTube">↗</a></div>
      <div class="ix-txt">${esc(c.text)}</div>
    </div></li>`;
}
// On narrow screens the list and the comment share one column, so the open
// comment unfolds right under its row instead of at the bottom of the list.
const stacked = () => matchMedia('(max-width: 1100px)').matches;
function placeDetail() {
  const detail = $('#detail');
  $$('.ix-inline').forEach((li) => { if (!li.contains(detail)) li.remove(); });
  const row = ui.selected && $(`.ix-row[data-id="${CSS.escape(ui.selected)}"]`);
  if (stacked() && row) {
    let li = row.nextElementSibling;
    if (!li?.classList.contains('ix-inline')) {
      li = document.createElement('li');
      li.className = 'ix-inline';
      row.after(li);
    }
    li.append(detail);
    $$('.ix-inline').forEach((x) => { if (x !== li) x.remove(); });
  } else {
    $('.ix-body').append(detail);
    $$('.ix-inline').forEach((x) => x.remove());
  }
  detail.hidden = stacked() && !row;
}
addEventListener('resize', () => { if (analysis && ui.view === 'all') placeDetail(); });

function renderList() {
  $('.ix-body').append($('#detail')); // park it before the list is rebuilt
  const rows = visible();
  if (ui.selected && !rows.some((c) => c.id === ui.selected)) ui.selected = null;
  if (!ui.selected && rows.length && !stacked()) ui.selected = rows[0].id;
  $('#list').innerHTML = rows.length ? rows.map(rowHtml).join('') : `<li class="ix-empty">${ui.tab === 'danger' ? '✨ No spam or threats here.' : 'No comments in this tab.'}</li>`;
}
function renderDetail() {
  const c = allComments().find((x) => x.id === ui.selected);
  if (!c) { $('#detail').innerHTML = '<div class="ix-empty">Pick a comment to read it, reply, or remove it.</div>'; placeDetail(); return; }
  const cat = catOf(c);
  const grp = groupOf(c.id);
  const g = grp?.comments.filter((x) => x.reply?.status !== 'sent' && !hidden(x)) || [];
  const danger = ['spam', 'threat'].includes(cat);
  const draft = undo.has(`d:${c.id}`) ? undo.get(`d:${c.id}`) : (danger ? '' : grp?.suggestedReply || '');
  $('#detail').innerHTML = `
    <div class="dt-head">${avatar(c)}
      <div style="min-width:0"><div class="dt-name">${c.authorUrl ? `<a href="${esc(c.authorUrl)}" target="_blank" rel="noopener">${esc(c.authorName)}</a>` : esc(c.authorName)}</div>
        <div class="small muted">${when(c.publishedAt)}${c.likes ? ` · 👍 ${c.likes}` : ''}</div></div>
      <a class="btn sm" href="${esc(commentUrl(c))}" target="_blank" rel="noopener">Open on YouTube ↗</a>
    </div>
    <div class="dt-chips"><span class="chip"><i class="sw m-${cat}"></i>${CAT[cat].label}</span>${c.risk && c.risk !== 'none' ? `<span class="chip warn">${RISK[c.risk] || c.risk}</span>` : ''}${c.tone ? toneChip(c.tone) : ''}
      ${grp ? `<span class="chip">In “${esc(grp.title)}”</span>` : ''}</div>
    <a class="dt-txt" href="${esc(commentUrl(c))}" target="_blank" rel="noopener" title="Open this exact comment on YouTube">${esc(c.text)}<span class="dt-go">Open this comment on YouTube ↗ <em>it appears pinned at the top of the comments as “Highlighted comment”</em></span></a>
    ${hidden(c) ? `<div class="dt-note gone">Hidden from your channel${c.moderation.action === 'ban' ? ' and the author is banned' : ''}. YouTube can't bring it back through the API.</div>`
      : c.moderation?.status === 'failed' ? `<div class="dt-note fail">Couldn't hide: ${esc(c.moderation.error)}</div>` : ''}
    ${c.reply ? `<div class="dt-note ${c.reply.status === 'sent' ? 'ok' : 'fail'}">${c.reply.status === 'sent' ? `✓ You replied: “${esc(c.reply.text)}”` : `✗ Reply failed: ${esc(c.reply.error)}`}</div>` : ''}
    ${hidden(c) || danger || c.reply?.status === 'sent' ? '' : `
    <div class="dt-reply">
      <label class="small" for="replyBox"><b>Reply</b></label>
      <textarea class="input" id="replyBox" maxlength="900" placeholder="Type a reply, or let AI write one">${esc(draft)}</textarea>
      <div class="row">
        <div class="actions">
          <button class="btn sm" id="polishBtn" type="button" ${grp ? '' : 'disabled'}>✨ Polish with AI</button>
          <button class="btn sm" id="undoBtn" type="button" ${undo.has(c.id) ? '' : 'hidden'}>↶ Undo</button>
        </div>
        <div class="actions">
          ${g.length > 1 ? `<button class="btn sm" id="replyAll" type="button">Reply to all ${g.length} like this</button>` : ''}
          <button class="btn sm dark" id="replyOne" type="button">Reply</button>
        </div>
      </div>
    </div>`}
    ${hidden(c) || !(danger || c.needsReview) ? '' : `<div class="dt-mod">
      <div class="small muted">${danger ? `Looks like ${(RISK[c.risk] || CAT[cat].label).toLowerCase()}.` : 'Claude wasn\'t sure about this one.'}</div>
      <div class="actions">
        <button class="btn sm ${danger ? 'dark' : ''}" data-mod="hide" type="button">Hide from channel</button>
        <button class="btn sm red" data-mod="ban" type="button">Hide &amp; ban author</button>
        <a class="btn sm" href="${esc(commentUrl(c))}" target="_blank" rel="noopener" data-report title="Opens the comment; use ⋮ → Report there">Report on YouTube ↗</a>
      </div>
    </div>`}`;
  placeDetail();
}

function render() {
  $('#empty').hidden = Boolean(analysis);
  $('#result').hidden = !analysis;
  $('#analyzeBtn').textContent = analysis ? 'Re-analyze' : 'Analyze comments';
  if (!analysis) return;
  renderOverview();
  renderInbox();
}
const reviewQueue = () => allComments().filter((c) => c.needsReview && !hidden(c));
function renderViews() {
  const n = { all: allComments().length, groups: analysis.groups.length, review: reviewQueue().length };
  $('#views').innerHTML = [['all', 'All comments'], ['groups', 'Groups'], ['review', 'Needs review']].map(([k, label]) => `<button class="ix-view ${ui.view === k ? 'on' : ''} ${k === 'review' && n.review ? 'alert' : ''}" role="tab" data-view="${k}" type="button">${label}<span class="ct">${n[k]}</span></button>`).join('');
}
function renderInbox() {
  renderViews();
  const all = ui.view === 'all';
  $('#tabs').hidden = !all;
  $('.ix-tools').hidden = !all;
  $('.ix-body').hidden = !all;
  $('#groupsView').hidden = ui.view !== 'groups';
  $('#reviewView').hidden = ui.view !== 'review';
  if (all) { renderList(); renderTabs(); renderDetail(); }
  if (ui.view === 'groups') renderGroupCards();
  if (ui.view === 'review') renderReview();
}

// Groups: comments that ask or say the same thing, answered with one reply.
function renderGroupCards() {
  const groups = [...analysis.groups].sort((a, b) => b.comments.length - a.comments.length);
  $('#groupsView').innerHTML = groups.map((g) => {
    const open = g.comments.filter((c) => c.reply?.status !== 'sent' && !hidden(c));
    const spam = g.type === 'spam' || g.comments.every((c) => ['spam', 'threat'].includes(catOf(c)));
    const key = `g:${g.index}`;
    const text = undo.has(`d:${key}`) ? undo.get(`d:${key}`) : g.suggestedReply || '';
    return `<section class="gcard" data-g="${g.index}">
      <div class="gc-h"><div style="min-width:0"><b>${esc(g.title)}</b><span class="small muted">${g.comments.length} comment${g.comments.length > 1 ? 's' : ''}${open.length < g.comments.length ? ` · ${g.comments.length - open.length} done` : ''}</span></div>${toneChip(g.tone, 'sm')}</div>
      <ul class="gc-list">${g.comments.map((c) => `<li class="${hidden(c) ? 'gone' : ''}">${avatar(c)}<div style="min-width:0"><b>${esc(c.authorName)}</b> <span>${esc(c.text)}</span>
        ${c.reply?.status === 'sent' ? ' <em class="tagok">Replied</em>' : hidden(c) ? ' <em class="tagx">Hidden</em>' : ''}</div><a class="ix-open" href="${esc(commentUrl(c))}" target="_blank" rel="noopener" title="Open on YouTube">↗</a></li>`).join('')}</ul>
      ${spam ? `<div class="gc-f"><span class="small muted">Spam is never replied to.</span>${open.length ? `<button class="btn sm red" data-ghide="${g.index}" type="button">Hide all ${open.length}</button>` : ''}</div>`
        : `<div class="gc-f col"><textarea class="input" data-gtext="${g.index}" maxlength="900" placeholder="Write one reply for everyone here">${esc(text)}</textarea>
        <div class="row"><button class="btn sm" data-gpolish="${g.index}" type="button">✨ Polish with AI</button>
        <button class="btn sm dark" data-greply="${g.index}" type="button" ${open.length ? '' : 'disabled'}>${open.length ? `Reply to all ${open.length}` : 'Everyone has a reply'}</button></div></div>`}
    </section>`;
  }).join('') || '<div class="ix-empty">No groups yet.</div>';
}

// Needs review: Claude wasn't sure, the creator decides.
function renderReview() {
  const rows = reviewQueue();
  $('#reviewView').innerHTML = rows.length ? rows.map((c) => {
    const cat = catOf(c);
    return `<div class="rv-row">${avatar(c)}<div class="rv-b">
      <div class="ix-who"><b>${esc(c.authorName)}</b><span class="ix-when">${when(c.publishedAt)}</span><a class="ix-open" href="${esc(commentUrl(c))}" target="_blank" rel="noopener" title="Open on YouTube">↗</a></div>
      <div class="rv-t">${esc(c.text)}</div>
      <div class="rv-why">Claude's guess: <b>${CAT[cat].label}</b>${c.reviewReason ? ` · ${esc(c.reviewReason)}` : ''}</div>
      <div class="rv-pick">${Object.entries(CAT).map(([k, v]) => `<button class="pickc ${k === cat ? 'on' : ''}" data-review="${esc(c.id)}" data-cat="${k}" type="button"><i class="cdot m-${k}"></i>${v.label}</button>`).join('')}
        <button class="btn sm red" data-review-hide="${esc(c.id)}" type="button">Hide</button></div>
    </div></div>`;
  }).join('') : '<div class="ix-empty">✓ Nothing to review. Claude was confident about every comment.</div>';
}

// One tooltip for every chart mark; value leads, label follows. textContent only.
const tip = $('#tip');
const showTip = (el, x, y) => {
  tip.replaceChildren();
  const v = document.createElement('b');
  v.textContent = el.dataset.tipV;
  tip.append(v, document.createTextNode(el.dataset.tipL));
  tip.style.left = `${Math.min(x + 14, innerWidth - 270)}px`;
  tip.style.top = `${y + 14}px`;
  tip.classList.add('show');
};
document.addEventListener('pointermove', (e) => {
  const el = e.target.closest('[data-tip-v]');
  if (el) showTip(el, e.clientX, e.clientY); else tip.classList.remove('show');
});
document.addEventListener('focusin', (e) => {
  const el = e.target.closest('[data-tip-v]');
  if (!el) return;
  const r = el.getBoundingClientRect();
  showTip(el, r.left, r.bottom);
});
document.addEventListener('focusout', () => tip.classList.remove('show'));


$('#analyzeBtn').onclick = async () => {
  const id = currentId;
  if (!id) return;
  const btn = $('#analyzeBtn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Reading the video, then comments…';
  try {
    setAnalysis(await api(`/api/comments/youtube/${encodeURIComponent(id)}/analyze`, { method: 'POST' }));
    undo.clear();
    toast(`Analysed ${counts().all} comments · ${analysis.youtubeUnits} YouTube unit${analysis.youtubeUnits === 1 ? '' : 's'}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    render();
    loadStatus();
  }
};

// Overview points filter the inbox to the comments behind them.
$('#overview').onclick = (e) => {
  const pt = e.target.closest('[data-only]');
  if (!pt) return;
  const [key, i] = pt.dataset.only.split(':');
  const item = analysis.overview[key][Number(i)];
  Object.assign(ui, { only: new Set(item.commentIds || []), onlyLabel: item.point, selected: null });
  renderInbox();
  $('.ix').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

$('#search').oninput = (e) => { ui.query = e.target.value; renderList(); renderTabs(); renderDetail(); };

$('.ix').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('.ix-open')) return;
  if (t.closest('[data-view]')) { ui.view = t.closest('[data-view]').dataset.view; ui.only = null; return renderInbox(); }
  const gi = (attr) => analysis.groups.find((g) => g.index === Number(t.closest(`[${attr}]`).getAttribute(attr)));
  if (t.closest('[data-greply]')) {
    const g = gi('data-greply');
    return askReply(g.comments.filter((x) => x.reply?.status !== 'sent' && !hidden(x)).map((x) => x.id), g.title, $(`[data-gtext="${g.index}"]`).value);
  }
  if (t.closest('[data-ghide]')) { const g = gi('data-ghide'); return askModerate(g.comments.filter((x) => !hidden(x)).map((x) => x.id), 'hide'); }
  if (t.closest('[data-gpolish]')) return polishGroup(t.closest('[data-gpolish]'), gi('data-gpolish'));
  if (t.closest('[data-review]')) {
    const b = t.closest('[data-review]');
    try {
      setAnalysis(await api(`/api/comments/youtube/${encodeURIComponent(analysis.video.id)}/review`, { method: 'POST', body: { commentId: b.dataset.review, category: b.dataset.cat } }), true);
      toast(`Marked as ${CAT[b.dataset.cat].label}`);
    } catch (err) { toast(err.message); }
    return;
  }
  if (t.closest('[data-review-hide]')) return askModerate([t.closest('[data-review-hide]').dataset.reviewHide], 'hide');
  if (t.closest('[data-tab]')) { Object.assign(ui, { tab: t.closest('[data-tab]').dataset.tab, only: null, selected: null }); ui.checked.clear(); return renderInbox(); }
  if (t.closest('[data-clear-only]')) { ui.only = null; return renderInbox(); }
  if (t.closest('[data-check]')) {
    const id = t.closest('[data-check]').dataset.check;
    if (t.checked) ui.checked.add(id); else ui.checked.delete(id);
    return renderTabs();
  }
  if (t.id === 'checkAll') {
    visible().filter((c) => !hidden(c)).forEach((c) => (t.checked ? ui.checked.add(c.id) : ui.checked.delete(c.id)));
    renderList();
    return renderTabs();
  }
  if (t.closest('[data-bulk]')) return askModerate([...ui.checked], t.closest('[data-bulk]').dataset.bulk);
  if (t.closest('.ix-open')) return; // the link opens YouTube; don't change the selection
  const row = t.closest('.ix-row');
  if (row) {
    // Tapping the open comment again folds it away on narrow screens.
    ui.selected = stacked() && ui.selected === row.dataset.id ? null : row.dataset.id;
    $$('.ix-row').forEach((r) => { const on = r.dataset.id === ui.selected; r.classList.toggle('on', on); r.setAttribute('aria-selected', String(on)); });
    renderDetail();
    return;
  }
  if (t.closest('[data-mod]')) return askModerate([ui.selected], t.closest('[data-mod]').dataset.mod);
  if (t.closest('#polishBtn')) return polish(t.closest('#polishBtn'));
  if (t.closest('#undoBtn')) {
    $('#replyBox').value = undo.get(ui.selected) ?? '';
    undo.delete(ui.selected);
    t.closest('#undoBtn').hidden = true;
    return;
  }
  if (t.closest('#replyOne')) return askReply([ui.selected]);
  if (t.closest('#replyAll')) {
    const grp = groupOf(ui.selected);
    return askReply(grp.comments.filter((x) => x.reply?.status !== 'sent' && !hidden(x)).map((x) => x.id), grp.title);
  }
});
$('.ix').addEventListener('keydown', (e) => {
  const row = e.target.closest('.ix-row');
  if (!row) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
    if (next?.classList.contains('ix-row')) { next.focus(); next.click(); }
  }
});
$('.ix').addEventListener('input', (e) => {
  if (e.target.id === 'replyBox') undo.set(`d:${ui.selected}`, e.target.value);
  if (e.target.dataset.gtext) undo.set(`d:g:${e.target.dataset.gtext}`, e.target.value);
});
async function polishGroup(btn, g) {
  const box = $(`[data-gtext="${g.index}"]`);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Polishing…';
  try {
    const { reply } = await api(`/api/comments/youtube/${encodeURIComponent(analysis.video.id)}/polish`, { method: 'POST', body: { groupIndex: g.index, text: box.value } });
    box.value = reply;
    undo.set(`d:g:${g.index}`, reply);
  } catch (err) { toast(err.message); } finally { btn.disabled = false; btn.textContent = '✨ Polish with AI'; }
}

async function polish(btn) {
  const grp = groupOf(ui.selected);
  const box = $('#replyBox');
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Polishing…';
  try {
    const { reply } = await api(`/api/comments/youtube/${encodeURIComponent(analysis.video.id)}/polish`, { method: 'POST', body: { groupIndex: grp.index, text: box.value } });
    undo.set(ui.selected, box.value);
    box.value = reply;
    undo.set(`d:${ui.selected}`, reply);
    $('#undoBtn').hidden = false;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Polish with AI';
  }
}

function openConfirm({ title, html, preview, cost, go, danger }) {
  $('#cfTitle').textContent = title;
  $('#cfText').innerHTML = html;
  $('#cfPreview').parentElement.hidden = !preview;
  $('#cfPreview').textContent = preview || '';
  $('#cfCost').textContent = cost;
  $('#cfErr').textContent = '';
  $('#cfGo').textContent = go;
  $('#cfGo').className = `btn ${danger ? 'red' : 'dark'}`;
  $('#confirm').classList.add('open');
}
function askReply(ids, groupTitle, own) {
  const text = (own ?? $('#replyBox').value).trim();
  if (!text) return toast('Write a reply first, or click Polish with AI');
  if (!status.canReply) return toast('Connect YouTube first (banner above)');
  const first = allComments().find((c) => c.id === ids[0]);
  pending = { kind: 'reply', ids, text };
  openConfirm({
    title: `Reply to ${ids.length} comment${ids.length > 1 ? 's' : ''}`,
    html: groupTitle ? `Posts publicly as your channel under every comment in <b>${esc(groupTitle)}</b>.` : 'Posts publicly as your channel.',
    preview: `${first?.authorName?.startsWith('@') ? `${first.authorName} ` : ''}${text}`,
    cost: `Uses ${ids.length * 50} of your 10,000 daily YouTube units. Each reply starts with that person's @handle.`,
    go: ids.length > 1 ? `Post ${ids.length} replies` : 'Post reply',
  });
}
function askModerate(ids, action) {
  if (!ids.length || !ids[0]) return;
  if (!status.canReply) return toast('Connect YouTube first (banner above)');
  pending = { kind: 'moderate', ids, action };
  const n = ids.length;
  const calls = Math.ceil(n / 50);
  openConfirm({
    title: `${action === 'ban' ? 'Hide & ban' : 'Hide'} ${n} comment${n > 1 ? 's' : ''}`,
    html: action === 'ban'
      ? `Removes ${n > 1 ? 'these comments' : 'this comment'} from your channel and <b>bans the author${n > 1 ? 's' : ''}</b>: their future comments are hidden automatically.`
      : `Removes ${n > 1 ? 'these comments' : 'this comment'} from your channel for everyone. Replies under it are hidden too.`,
    cost: `Can't be undone from here. Uses ${calls * 50} of your 10,000 daily YouTube units.`,
    go: action === 'ban' ? 'Hide & ban' : 'Hide',
    danger: true,
  });
}

$('#cfClose').onclick = () => $('#confirm').classList.remove('open');
$('#confirm').onclick = (e) => { if (e.target.id === 'confirm') $('#confirm').classList.remove('open'); };

$('#cfGo').onclick = async () => {
  const btn = $('#cfGo');
  const label = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = `<span class="spin"></span> ${pending.kind === 'reply' ? 'Posting…' : 'Hiding…'}`;
  const vid = encodeURIComponent(analysis.video.id);
  try {
    if (pending.kind === 'reply') {
      const r = await api(`/api/comments/youtube/${vid}/reply`, { method: 'POST', body: { commentIds: pending.ids, text: pending.text } });
      pending.ids.forEach((id) => undo.delete(`d:${id}`));
      setAnalysis(r.analysis, true);
      const failed = r.results.filter((x) => x.status === 'failed').length;
      toast(failed ? `Posted ${r.sent}, ${failed} failed` : `Posted ${r.sent} repl${r.sent === 1 ? 'y' : 'ies'}`);
    } else {
      const r = await api(`/api/comments/youtube/${vid}/moderate`, { method: 'POST', body: { commentIds: pending.ids, action: pending.action } });
      setAnalysis(r.analysis, true);
      const failed = r.results.filter((x) => x.status === 'failed');
      toast(failed.length ? `Hid ${r.done}, ${failed.length} failed: ${failed[0].error}` : `Hid ${r.done} comment${r.done === 1 ? '' : 's'}${pending.action === 'ban' ? ' and banned the author' : ''}`);
    }
    $('#confirm').classList.remove('open');
  } catch (err) {
    $('#cfErr').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    loadStatus();
  }
};

if (new URLSearchParams(location.search).get('google') === 'connected') toast('YouTube connected, you can reply now');
loadStatus().catch(() => {});
route();
