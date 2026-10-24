const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const id = new URLSearchParams(location.search).get('id');
const base = `/api/studio/projects/${encodeURIComponent(id)}`;
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  if (res.status === 401) { location.href = '/'; throw new Error('Signed out'); }
  const data = await res.json().catch(() => ({}));
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
const mmss = (sec) => (sec == null ? '' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`);

const TYPE = { face: 'You on camera', screen: 'Screen recording', broll: 'Your B-roll', text: 'Text on screen', mixed: 'Mixed' };
let s = null;          // project state from the API
let view = null;       // which step is shown (defaults to the project's stage)
let online = false;    // is the Mac transcript service up?

// ---- Step bar ----------------------------------------------------------------------
const STEPS = [
  { key: 'name', label: 'Name' },
  { key: 'inspire', label: 'Inspire' },
  { key: 'questions', label: 'Questions' },
  { key: 'storyboard', label: 'Storyboard' },
  { key: 'blueprint', label: 'Blueprint', lock: true },
];
const ORDER = ['name', 'inspire', 'questions', 'storyboard', 'approved'];
function renderSteps() {
  const reached = ORDER.indexOf(s.project.stage === 'approved' ? 'approved' : s.project.stage);
  $('#steps').innerHTML = STEPS.map((st, i) => {
    const cls = st.lock ? 'lock' : i < reached || (st.key === 'storyboard' && s.project.stage === 'approved') ? 'done' : i === reached ? 'now' : '';
    const can = !st.lock && st.key !== 'name' && i <= Math.max(reached, 1) && (st.key !== 'questions' || s.rounds.length);
    return `<div class="st ${cls}" ${can ? `data-go="${st.key}" style="cursor:pointer"` : ''} title="${st.lock ? 'Next phase' : st.label}">
      <div class="lbl">${cls === 'done' ? '✓' : st.lock ? '🔒' : i + 1}<span>${st.label}</span></div><div class="bar"></div></div>`;
  }).join('');
}
$('#steps').onclick = (e) => {
  const st = e.target.closest('[data-go]');
  if (!st) return;
  view = st.dataset.go;
  render();
};

// ---- Rendering --------------------------------------------------------------------
function render() {
  $('#projName').value = s.project.name;
  document.title = `${s.project.name} · Studio`;
  renderSteps();
  const v = view || (s.project.stage === 'approved' ? 'storyboard' : s.project.stage);
  if (typeof stopPlay === 'function') stopPlay();
  $('#stage').classList.toggle('wide', !['inspire', 'questions'].includes(v));
  if (v === 'inspire') return renderInspire();
  if (v === 'questions') return renderQuestions();
  return s.storyboard ? renderStoryboard() : generateStoryboard();
}

function working(title, detail) {
  stopPlay();
  $('#stage').innerHTML = `<div class="card working"><div class="spin"></div><b>${esc(title)}</b><div class="small muted" style="margin-top:6px">${esc(detail)}</div></div>`;
}

// ---- Step 2: inspiration ----------------------------------------------------------
function slotHtml(n) {
  const v = s.inspirations.find((x) => x.position === n);
  const url = v ? `https://youtu.be/${v.video_id}` : '';
  const tx = v && (v.transcriptWords
    ? `<span class="tx ok">✓ Transcript · ${v.transcriptWords.toLocaleString()} words${v.transcript_source === 'paste' ? ' (pasted)' : ''}</span>`
    : `<span class="tx bad">⚠ No transcript${online ? '' : ' (Mac offline)'} · <a href="#" data-paste="${n}">paste it</a></span>`);
  return `<section class="card slot" data-slot="${n}">
    <div class="n"><span>Video ${n}</span>${v ? `<a href="#" class="small" data-clear="${n}">Remove</a>` : ''}</div>
    ${v ? `<div class="vid-prev"><img src="${esc(v.thumb)}" alt="" referrerpolicy="no-referrer"><div>
        <div class="t">${esc(v.title)}</div><div class="small muted">${esc(v.channel)} · ${mmss(v.duration_sec)}</div><div style="margin-top:4px">${tx}</div></div></div>`
    : '<div class="empty-art">Paste a YouTube link below</div>'}
    <div class="urlrow"><input class="input" data-url="${n}" value="${esc(url)}" placeholder="https://youtube.com/watch?v=…">
      <button class="btn sm" data-add="${n}" type="button">${v ? 'Change' : 'Add'}</button></div>
    <textarea class="input" data-notes="${n}" rows="2" placeholder="What do you love about this one? The hook, the pacing, how they explain, the editing…">${esc(v?.notes || '')}</textarea>
    <div data-paste-box="${n}" hidden><textarea class="input" rows="4" placeholder="On YouTube: … More → Show transcript, then copy it all and paste here"></textarea>
      <button class="btn sm" data-paste-save="${n}" type="button" style="margin-top:6px">Save transcript</button></div>
  </section>`;
}

function renderInspire() {
  const p = s.project;
  const n = s.inspirations.length;
  $('#stage').innerHTML = `
    <span class="step-pill">Step 2 of 4 · Inspiration</span>
    <h2 class="big">What inspires this video?</h2>
    <p class="lead">Add up to 4 YouTube videos you'd love to learn from. The AI reads what they say and how they say it, then helps you make your own version, not a copy.</p>
    <div class="field"><label>Format</label><div class="chips-pick" id="fmt">
      ${[['auto', 'Not sure, AI decides'], ['long', 'Long video'], ['short', 'Short']].map(([k, l]) => `<button type="button" class="pick ${p.format === k ? 'on' : ''}" data-format="${k}">${l}</button>`).join('')}
    </div></div>
    <div class="slots">${[1, 2, 3, 4].map(slotHtml).join('')}</div>
    <section class="card" style="padding:16px;display:grid;gap:14px">
      <div class="field"><label>Your twist <span class="help" tabindex="0" data-tip="What will you do differently from these videos? Your angle, your story, your audience, or something they all missed. This is what makes it yours.">?</span></label>
        <textarea class="input" id="twist" rows="3" placeholder="e.g. Same idea, but for complete beginners, with everyday analogies and zero code">${esc(p.twist)}</textarea></div>
      <div class="field"><label>Research topics <span class="small muted">(optional)</span></label>
        <input class="input" id="research" value="${esc(p.research)}" placeholder="e.g. newest AI agent tools 2026, how companies use agents">
        <span class="hint">The AI searches the web for these before it asks you questions.</span></div>
    </section>
    <div class="actionbar">
      <span class="small muted"><b style="color:var(--ink)">${n} of 4</b> videos · Go works from 2 · 4 gives the sharpest storyboard
        · Transcripts <span class="pill ${online ? 'green' : 'amber'}">${online ? 'online' : 'offline, paste instead'}</span></span>
      <button class="btn dark" id="goBtn" ${n >= 2 ? '' : 'disabled'}>Go, study these ✨</button>
    </div>`;
}

const slotItems = () => [1, 2, 3, 4]
  .map((n) => ({ url: $(`[data-url="${n}"]`)?.value.trim() || '', notes: $(`[data-notes="${n}"]`)?.value || '' }))
  .filter((it) => it.url);

async function saveVideos(label) {
  const btns = $$('[data-add]');
  btns.forEach((b) => { b.disabled = true; });
  if (label) toast(label);
  try {
    s = await api(`${base}/inspirations`, { method: 'PUT', body: { items: slotItems() } });
    renderInspire();
  } catch (err) {
    toast(err.message);
    btns.forEach((b) => { b.disabled = false; });
  }
}

$('#stage').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('#ed') || $('#layoutPop')) {
    if (t.closest('[data-scrub]')) {
      const r = $('#tlRight').getBoundingClientRect();
      P.t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * sbTotal();
      const [bi, si] = at(P.t);
      return select(bi, si, { keepTime: true });
    }
    if (editorClick(t) !== false) return;
  }
  if (t.closest('[data-format]')) {
    const format = t.closest('[data-format]').dataset.format;
    $$('#fmt .pick').forEach((b) => b.classList.toggle('on', b.dataset.format === format));
    s = await api(base, { method: 'PATCH', body: { format } });
    return;
  }
  if (t.closest('[data-add]')) return saveVideos('Fetching video details and transcript…');
  if (t.closest('[data-clear]')) {
    e.preventDefault();
    const n = t.closest('[data-clear]').dataset.clear;
    $(`[data-url="${n}"]`).value = '';
    return saveVideos();
  }
  if (t.closest('[data-paste]')) {
    e.preventDefault();
    $(`[data-paste-box="${t.closest('[data-paste]').dataset.paste}"]`).hidden = false;
    return;
  }
  if (t.closest('[data-paste-save]')) {
    const n = t.closest('[data-paste-save]').dataset.pasteSave;
    try {
      s = await api(`${base}/inspirations/${n}/transcript`, { method: 'POST', body: { text: $(`[data-paste-box="${n}"] textarea`).value } });
      renderInspire();
      toast('Transcript saved');
    } catch (err) { toast(err.message); }
    return;
  }
  if (t.closest('#goBtn')) return go();
  if (t.closest('#skipBtn')) return skipQuestions();
  if (t.closest('#answerBtn')) return submitAnswers();
  if (t.closest('[data-pick]')) return togglePick(t.closest('[data-pick]'));
  if (t.closest('[data-approve]')) return approveBeat(t.closest('[data-approve]').dataset.approve);
  if (t.closest('[data-redo]')) return redo(t.closest('[data-redo]').dataset.redo);
  if (t.closest('#approveAll')) return approveAll();
  if (t.closest('#regen')) return regenerate(t.closest('#regen'));
});

// Notes, twist, research and beat fields save when you leave the box.
$('#stage').addEventListener('focusout', async (e) => {
  const t = e.target;
  try {
    if (t.matches('[data-notes]')) {
      const v = s.inspirations.find((x) => x.position === Number(t.dataset.notes));
      if (v && v.notes !== t.value) { s = await api(`${base}/inspirations`, { method: 'PUT', body: { items: slotItems() } }); }
    } else if (t.id === 'twist' && t.value !== s.project.twist) {
      s = await api(base, { method: 'PATCH', body: { twist: t.value } });
    } else if (t.id === 'research' && t.value !== s.project.research) {
      s = await api(base, { method: 'PATCH', body: { research: t.value } });
    } else if (t.matches('[data-field]')) {
      const b = s.storyboard.beats.find((x) => x.id === t.dataset.beat);
      if (b && b[t.dataset.field] !== t.value) {
        s = await api(`${base}/storyboard/beats/${t.dataset.beat}`, { method: 'PATCH', body: { [t.dataset.field]: t.value } });
        if ($('#ed')) paintEditor();
        toast('Saved');
      }
    } else if (t.matches('[data-shot-field]')) {
      const i = Number(t.dataset.shotI);
      const sh = s.storyboard.beats.find((x) => x.id === t.dataset.beatId)?.shots[i];
      if (sh && sh[t.dataset.shotField] !== t.value) await patchBeat({ shot: { i, [t.dataset.shotField]: t.value } }, 'Saved', t.dataset.beatId);
    }
  } catch (err) { toast(err.message); }
});
$('#stage').addEventListener('change', (e) => {
  const t = e.target;
  if (t.matches('[data-cam]')) patchBeat({ shot: { i: sel.s, [t.dataset.cam]: t.value } });
  if (t.matches('[data-set]')) patchBeat({ set: { [t.dataset.set]: t.value } });
});
$('#stage').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-url]')) { e.preventDefault(); saveVideos('Fetching video details and transcript…'); }
  if (e.key === 'Enter' && e.target.matches('[data-redo-text]')) { e.preventDefault(); redo(e.target.dataset.redoText); }
});

$('#projName').addEventListener('change', async (e) => {
  try { s = await api(base, { method: 'PATCH', body: { name: e.target.value } }); renderSteps(); toast('Renamed'); } catch (err) { toast(err.message); }
});

async function go() {
  try {
    s = await api(`${base}/inspirations`, { method: 'PUT', body: { items: slotItems() } });
    const twist = $('#twist')?.value;
    const research = $('#research')?.value;
    if (twist !== s.project.twist || research !== s.project.research) s = await api(base, { method: 'PATCH', body: { twist, research } });
    working('Studying your videos…', `Reading ${s.inspirations.length} transcripts${s.project.research ? ', researching your topics on the web' : ''} and preparing a few questions. About 20–40 seconds.`);
    const r = await api(`${base}/go`, { method: 'POST' });
    s = r;
    view = null;
    if (r.ready) return generateStoryboard();
    render();
  } catch (err) {
    toast(err.message);
    view = 'inspire';
    render();
  }
}

// ---- Step 3: questions --------------------------------------------------------------
const answersDraft = {};
function renderQuestions() {
  const round = [...s.rounds].reverse().find((r) => !r.answers) || s.rounds.at(-1);
  if (!round) { view = 'inspire'; return renderInspire(); }
  const answered = Boolean(round.answers);
  $('#stage').innerHTML = `
    <span class="step-pill">Step 3 of 4 · Questions · round ${round.round} of 2</span>
    <h2 class="big">A few questions before I plan it</h2>
    <p class="lead">Tap what fits. Anything you skip, I'll decide for you.</p>
    ${s.project.understanding ? `<section class="card understand"><div class="eyebrow">Here's what I think you're making</div><p style="margin:6px 0 0">${esc(s.project.understanding)}</p></section>` : ''}
    ${round.questions.map((qn) => {
      const a = (round.answers || answersDraft)[qn.id];
      const chosen = new Set(Array.isArray(a) ? a : a ? [a] : []);
      const extra = [...chosen].find((x) => !qn.options.includes(x)) || '';
      return `<section class="card qcard" data-q="${esc(qn.id)}" data-kind="${qn.kind}">
        <div class="q">${esc(qn.question)}</div><div class="why">${esc(qn.why)}</div>
        ${qn.kind === 'text' || !qn.options.length
          ? `<textarea class="input" rows="2" data-text="${esc(qn.id)}" placeholder="Your answer">${esc(a || '')}</textarea>`
          : `<div class="chips-pick">${qn.options.map((o) => `<button type="button" class="pick ${chosen.has(o) ? 'on' : ''}" data-pick="${esc(qn.id)}" data-val="${esc(o)}">${esc(o)}</button>`).join('')}</div>
             <input class="input other" data-other="${esc(qn.id)}" value="${esc(extra)}" placeholder="Other: type your own answer">`}
      </section>`;
    }).join('')}
    <div class="actionbar">
      <button class="btn" id="skipBtn">Skip, write the storyboard</button>
      <button class="btn dark" id="answerBtn">${answered ? 'Write the storyboard' : 'Continue'}</button>
    </div>`;
}
function togglePick(btn) {
  const card = btn.closest('[data-q]');
  if (card.dataset.kind !== 'multi') $$('.pick', card).forEach((b) => { if (b !== btn) b.classList.remove('on'); });
  btn.classList.toggle('on');
}
function collectAnswers(round) {
  const out = {};
  for (const qn of round.questions) {
    const card = $(`[data-q="${CSS.escape(qn.id)}"]`);
    const text = $('[data-text]', card)?.value.trim();
    if (text != null && $('[data-text]', card)) { if (text) out[qn.id] = text; continue; }
    const picks = $$('.pick.on', card).map((b) => b.dataset.val);
    const other = $('[data-other]', card)?.value.trim();
    if (other) picks.push(other);
    if (picks.length) out[qn.id] = qn.kind === 'multi' ? picks : picks.at(-1);
  }
  return out;
}
async function submitAnswers() {
  const round = [...s.rounds].reverse().find((r) => !r.answers);
  if (!round) return generateStoryboard();
  const answers = collectAnswers(round);
  working('Thinking about your answers…', 'Checking whether anything important is still unclear.');
  try {
    s = await api(`${base}/rounds/${round.round}/answers`, { method: 'POST', body: { answers } });
    view = null;
    if (s.ready || s.project.stage === 'storyboard') return generateStoryboard();
    toast('One more short round');
    render();
  } catch (err) { toast(err.message); view = 'questions'; render(); }
}
async function skipQuestions() {
  try { s = await api(`${base}/skip`, { method: 'POST' }); view = null; generateStoryboard(); } catch (err) { toast(err.message); }
}

// ---- Step 4: storyboard ---------------------------------------------------------------
async function generateStoryboard() {
  working('Writing your storyboard…', 'Planning beats, script, sound and edit notes from your videos and answers. About a minute.');
  try {
    s = await api(`${base}/storyboard`, { method: 'POST' });
    view = 'storyboard';
    render();
    toast('Storyboard ready. Review each beat.');
  } catch (err) {
    $('#stage').innerHTML = `<div class="card working"><b>Couldn't write the storyboard</b><div class="small muted" style="margin:6px 0 12px">${esc(err.message)}</div><button class="btn dark" id="regen">Try again</button></div>`;
  }
}

// ---- Storyboard: an editor-style blueprint ------------------------------------------
// Program monitor (what the viewer sees, with dotted placement zones), the camera
// from the side, the set from above, a transport that plays the plan as an
// animatic, the timeline, and the selected beat's words underneath.
const ENUMS = {
  shot_size: ['extreme close-up', 'close-up', 'medium close-up', 'medium', 'wide', 'none'],
  angle: ['eye level', 'slightly high', 'low', 'overhead', 'none'],
  camera_side: ['front', 'front-left', 'front-right', 'side', 'above', 'none'],
  movement: ['static', 'slow push in', 'pull out', 'pan', 'handheld', 'none'],
  look: ['into the lens', 'off camera', 'at the screen', 'none'],
  you: ['sitting at desk', 'standing', 'walking', 'not on camera'],
  distance: ["arm's length", 'about 1 m', 'about 2 m', 'none'],
  light: ['window in front', 'key light + fill', 'ring light', 'room light', 'none'],
};
const ENUM_LABEL = { shot_size: 'Shot', angle: 'Height', camera_side: 'Camera', movement: 'Move', look: 'Look', you: 'You', distance: 'Distance', light: 'Light' };
const sel = { b: 0, s: 0 };
const P = { t: 0, playing: false, speed: 1, last: 0, raf: 0, word: -1 };
const sbTotal = () => Math.max(1, s.storyboard.beats.at(-1)?.end_sec || s.storyboard.target_length_sec);
const aspect = () => (s.storyboard.format === 'short' ? 'v' : 'h');
const beat = () => s.storyboard.beats[sel.b];
const shotStart = (b, i) => b.start_sec + b.shots.slice(0, i).reduce((a, sh) => a + sh.seconds, 0);
const pct = (sec) => `${((sec / sbTotal()) * 100).toFixed(3)}%`;
const sitting = (b) => b.set.you === 'sitting at desk';
function at(t) {
  const beats = s.storyboard.beats;
  let bi = beats.findIndex((b) => t >= b.start_sec && t < b.end_sec);
  if (bi < 0) bi = t >= sbTotal() ? beats.length - 1 : 0;
  const b = beats[bi];
  let si = 0;
  while (si < b.shots.length - 1 && t >= shotStart(b, si + 1)) si++;
  return [bi, si];
}

function renderStoryboard() {
  stopPlay();
  const sb = s.storyboard;
  sel.b = Math.min(sel.b, sb.beats.length - 1);
  sel.s = Math.min(sel.s, sb.beats[sel.b].shots.length - 1);
  const total = sbTotal();
  const approved = sb.beats.filter((b) => b.approved).length;
  const shots = sb.beats.reduce((a, b) => a + b.shots.length, 0);
  const types = [...new Set(sb.beats.map((b) => b.on_screen_type))];
  const isDone = s.project.stage === 'approved';
  const step = [5, 10, 15, 30, 60, 120, 300].find((x) => total / x <= 10) || 600;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, k) => k * step);
  $('#stage').classList.add('wide');
  $('#stage').innerHTML = `
    ${isDone ? `<section class="card done-card"><div style="font-size:30px">🎬</div><h3>Storyboard approved</h3>
      <p class="muted" style="margin:0">Your video has a plan: ${sb.beats.length} beats, ${shots} shots, ${mmss(total)} long.</p></section>` : ''}
    <span class="step-pill">Step 4 of 4 · Storyboard</span>
    <section class="card sb-strip">
      <div>
        <div class="eyebrow">The promise</div>
        <div class="promise">${esc(sb.summary)}</div>
        <div class="hook"><span class="eyebrow">Hook</span>“${esc(sb.hook)}”</div>
      </div>
      <div>
        <div class="chips"><span class="chip">${sb.format === 'short' ? 'Short · 9:16' : 'Long video · 16:9'}</span><span class="chip">${mmss(total)}</span><span class="chip">${sb.beats.length} beats</span><span class="chip">${shots} shots</span></div>
        <div class="eyebrow" style="margin-top:10px">Title ideas</div>
        <ol class="titles">${sb.title_ideas.map((t) => `<li>${esc(t)}</li>`).join('')}</ol>
      </div>
    </section>
    <section class="ed ${aspect()}" id="ed" aria-label="Storyboard blueprint">
      <div class="ed-top" id="edTop"></div>
      <div class="ed-body">
        <div class="ed-mon">
          <div class="mon-head"><span class="rec"></span>Program<span class="mon-tag" id="monTag"></span>
            <button class="ed-btn" id="layoutBtn" aria-haspopup="true" aria-expanded="false"></button></div>
          <div class="lp" id="layoutPop" hidden></div>
          <div class="mon-frame" id="frame"></div>
          <div class="zone-notes" id="zoneNotes"></div>
          <div class="shots" id="shots"></div>
        </div>
        <div class="ed-side">
          <div class="ed-card"><div class="ec-h">Camera<span>how it faces you</span></div><div id="cam"></div><div class="ec-chips" id="camChips"></div></div>
          <div class="ed-card"><div class="ec-h">Set<span>from above · where you sit</span></div><div id="set"></div><div class="ec-chips" id="setChips"></div></div>
        </div>
      </div>
      <div class="ed-transport">
        <button class="tbtn" data-nav="-1" aria-label="Previous beat"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h2v14H6zM20 5v14L9 12z"/></svg></button>
        <button class="tbtn play" id="playBtn" aria-label="Play the storyboard"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
        <button class="tbtn" data-nav="1" aria-label="Next beat"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 5h2v14h-2zM4 5v14l11-7z"/></svg></button>
        <span class="tc" id="tc"></span>
        <span class="keys">Space plays · ← → beats</span>
        <div class="speed" id="speed">${[1, 2, 4].map((x) => `<button data-speed="${x}" class="${P.speed === x ? 'on' : ''}">${x}×</button>`).join('')}</div>
      </div>
      <div class="ed-tl">
        <div class="tl-labels"><span></span><span>Beats</span><span>Shots</span></div>
        <div class="tl-right" id="tlRight">
          <div class="ruler" data-scrub>${ticks.map((x) => `<span style="left:${pct(x)}">${mmss(x)}</span>`).join('')}</div>
          <div class="timeline" role="list">${sb.beats.map((b, i) => `<div class="seg t-${b.on_screen_type} ${b.approved ? 'ok' : ''}" role="listitem" tabindex="0" data-seg="${i}"
            style="left:${pct(b.start_sec)};width:calc(${pct(b.end_sec - b.start_sec)} - 2px)" title="${esc(`${mmss(b.start_sec)}–${mmss(b.end_sec)} · ${b.label} · ${TYPE[b.on_screen_type]}`)}">${b.approved ? '✓ ' : ''}${esc(b.label)}</div>`).join('')}</div>
          <div class="shot-track">${sb.beats.map((b, i) => b.shots.map((sh, j) => `<i class="k-${BP.layoutKind(sh.layout)}" data-seg="${i}" data-shot-seg="${j}"
            style="left:${pct(shotStart(b, j))};width:calc(${pct(sh.seconds)} - 2px)" title="${esc(`${b.label} · shot ${j + 1} · ${BP.layoutName(sh.layout, aspect())}`)}"></i>`).join('')).join('')}</div>
          <div class="ph" id="ph"></div>
        </div>
      </div>
      <div class="legend ed-legend">${types.map((t) => `<span><i class="sw t-${t}"></i>${TYPE[t]}</span>`).join('')}<span class="sep"></span>
        ${['you', 'screen', 'broll', 'text'].map((k) => `<span><i class="zk z-${k}"></i>${{ you: 'You', screen: 'Screen', broll: 'B-roll', text: 'Text' }[k]} zone</span>`).join('')}</div>
    </section>
    <section class="card beat" id="beatText"></section>
    <div class="actionbar">
      <span class="small muted"><b style="color:var(--ink)">${approved} of ${sb.beats.length}</b> beats approved</span>
      <div style="display:flex;gap:8px">
        <button class="btn" id="regen">↻ New storyboard</button>
        <button class="btn dark" id="approveAll" ${isDone ? 'disabled' : ''}>${isDone ? 'Approved' : 'Approve storyboard'}</button>
      </div>
    </div>
    <section class="card locked" style="margin-top:14px">🔒 <b>Next phase: Assets</b> · drop in your footage and files for each zone, then edit in the CommentDrop editor.</section>`;
  select(sel.b, sel.s);
}

function select(bi, si = 0, { keepTime = false } = {}) {
  const prev = sel.b;
  const prevS = sel.s;
  const beats = s.storyboard.beats;
  sel.b = Math.max(0, Math.min(bi, beats.length - 1));
  sel.s = Math.max(0, Math.min(si, beats[sel.b].shots.length - 1));
  if (!keepTime) P.t = shotStart(beats[sel.b], sel.s);
  paintEditor();
  if (!keepTime || prev !== sel.b || prevS !== sel.s || !$('#beatText').innerHTML) paintText();
}

function captionHtml(b) {
  const words = b.script.split(/\s+/).filter(Boolean);
  if (!P.playing) return esc(words.slice(0, 10).join(' ') + (words.length > 10 ? ' …' : ''));
  const i = Math.min(words.length - 1, Math.floor((words.length * (P.t - b.start_sec)) / Math.max(1, b.end_sec - b.start_sec)));
  P.word = i;
  const from = Math.max(0, i - 4);
  return words.slice(from, i + 6).map((w, k) => (from + k === i ? `<mark>${esc(w)}</mark>` : esc(w))).join(' ');
}
function paintFrame() {
  const b = beat();
  $('#frame').innerHTML = BP.frame(b.shots[sel.s], {
    aspect: aspect(), sitting: sitting(b), live: P.playing, captionHtml: captionHtml(b),
    captions: P.playing || /caption|subtitle/i.test(b.edit),
  });
}
function selectHtml(group, key, value) {
  return `<label class="ec-f"><span>${ENUM_LABEL[key]}</span><select data-${group}="${key}">${ENUMS[key].map((v) => `<option ${v === value ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
}
function paintEditor() {
  const b = beat();
  const sh = b.shots[sel.s];
  const a = aspect();
  $('#edTop').innerHTML = `<span class="ed-id">B${sel.b + 1}</span><b class="ed-lab">${esc(b.label)}</b>
    <span class="ed-time">${mmss(b.start_sec)}–${mmss(b.end_sec)} · ${b.end_sec - b.start_sec}s</span>
    <span class="ed-type"><i class="sw t-${b.on_screen_type}"></i>${TYPE[b.on_screen_type]}</span><span class="sp"></span>
    ${b.approved ? '<span class="ed-ok">✓ Approved</span>' : ''}<span class="ed-count">Beat ${sel.b + 1} of ${s.storyboard.beats.length}</span>`;
  $('#monTag').textContent = `${a === 'v' ? '9:16' : '16:9'} · Shot ${sel.s + 1} of ${b.shots.length}`;
  $('#layoutBtn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16M3 12h9"/></svg>${esc(BP.layoutName(sh.layout, a))}<span class="caret">▾</span>`;
  paintFrame();
  $('#zoneNotes').innerHTML = BP.zoneNotes(sh);
  $('#shots').innerHTML = b.shots.map((x, i) => `<button class="shot ${i === sel.s ? 'on' : ''}" data-shot="${i}">
      ${BP.frame(x, { aspect: a, sitting: sitting(b), mini: true })}
      <span class="sl"><b>Shot ${i + 1}</b> ${mmss(shotStart(b, i))} · ${x.seconds}s</span><span class="sl sub">${esc(BP.layoutName(x.layout, a))}${x.shot_size !== 'none' ? ` · ${esc(x.shot_size)}` : ''}</span></button>`).join('')
    + (sel.b < s.storyboard.beats.length - 1 ? `<button class="shot next" data-nav="1"><span class="sl sub">Next beat</span><span class="sl"><b>${esc(s.storyboard.beats[sel.b + 1].label)}</b> →</span></button>` : '');
  $('#cam').innerHTML = BP.cameraView(sh, b.set);
  $('#camChips').innerHTML = ['shot_size', 'angle', 'camera_side', 'movement', 'look'].map((k) => selectHtml('cam', k, sh[k])).join('')
    + (b.set.gear ? `<div class="ec-note">Gear · ${esc(b.set.gear)}</div>` : '');
  $('#set').innerHTML = BP.setView(sh, b.set);
  $('#setChips').innerHTML = ['you', 'distance', 'light'].map((k) => selectHtml('set', k, b.set[k])).join('')
    + `<div class="ec-note">${[b.set.background && `Behind you · ${esc(b.set.background)}`, b.set.props.length && `Props · ${esc(b.set.props.join(', '))}`].filter(Boolean).join('<br>') || 'Nothing else in the scene'}</div>`;
  $$('#ed .timeline .seg').forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === sel.b));
  $$('#ed .shot-track i').forEach((el) => el.classList.toggle('on', Number(el.dataset.seg) === sel.b && Number(el.dataset.shotSeg) === sel.s));
  if (!$('#layoutPop').hidden) paintLayoutPop();
  paintClock();
}
function paintClock() {
  $('#ph').style.left = pct(P.t);
  $('#tc').innerHTML = `${mmss(P.t)} <span>/ ${mmss(sbTotal())}</span>`;
}
function paintLayoutPop() {
  const b = beat();
  const sh = b.shots[sel.s];
  $('#layoutPop').innerHTML = BP.LAYOUT_GROUPS.map(([group, list]) => `<div class="lp-g">${group}</div><div class="lp-row">${list.map((l) => `
    <button class="lp-i ${l === sh.layout ? 'on' : ''}" data-layout="${l}">${BP.frame({ ...sh, layout: l, text: sh.text || (['cam_text', 'title_card'].includes(l) ? 'Text' : '') }, { aspect: aspect(), sitting: sitting(b), mini: true })}
    <span>${esc(BP.layoutName(l, aspect()))}</span></button>`).join('')}</div>`).join('');
}
function toggleLayoutPop(force) {
  const pop = $('#layoutPop');
  const open = force ?? pop.hidden;
  pop.hidden = !open;
  $('#layoutBtn').setAttribute('aria-expanded', String(open));
  if (open) paintLayoutPop();
}

function paintText() {
  const b = beat();
  const sh = b.shots[sel.s];
  const shotFields = [
    ['you', 'You do', BP.showsYou(sh.layout)],
    ['screen', 'Screen or graphic shows', ['split', 'screen_bubble', 'screen_full'].includes(sh.layout)],
    ['broll', 'B-roll shows', sh.layout === 'broll_full'],
    ['text', 'Text on screen', true],
  ].filter((f) => f[2]);
  const el = $('#beatText');
  el.className = `card beat ${b.approved ? 'approved' : ''}`;
  el.innerHTML = `
    <div class="bh"><span class="time">${mmss(b.start_sec)}–${mmss(b.end_sec)}</span><span class="lab">B${sel.b + 1} · ${esc(b.label)}</span>
      <span class="chip sm"><i class="sw t-${b.on_screen_type}"></i>${TYPE[b.on_screen_type]}</span>
      <button class="btn sm ${b.approved ? '' : 'dark'}" data-approve="${b.id}">${b.approved ? '✓ Approved' : 'Approve beat'}</button></div>
    <div class="fields">
      <div class="f wide script"><label>Script · what you say</label><textarea data-beat="${b.id}" data-field="script" rows="3">${esc(b.script)}</textarea></div>
      <div class="f"><label>Sound</label><textarea data-beat="${b.id}" data-field="sound" rows="3">${esc(b.sound)}</textarea></div>
      <div class="f"><label>Edit</label><textarea data-beat="${b.id}" data-field="edit" rows="3">${esc(b.edit)}</textarea></div>
      <div class="f wide"><label>On screen · notes</label><textarea data-beat="${b.id}" data-field="on_screen" rows="2">${esc(b.on_screen)}</textarea></div>
    </div>
    <div class="shot-fields">
      <div class="eyebrow">Shot ${sel.s + 1} of ${b.shots.length} · ${esc(BP.layoutName(sh.layout, aspect()))} · ${sh.seconds}s</div>
      <div class="sf-grid">${shotFields.map(([k, label]) => `<label class="sf"><span>${label}</span>
        <input class="input" data-shot-field="${k}" data-beat-id="${b.id}" data-shot-i="${sel.s}" value="${esc(sh[k])}" maxlength="${k === 'text' ? 80 : 600}" placeholder="${k === 'text' ? 'Optional, up to 8 words' : ''}"></label>`).join('')}</div>
    </div>
    <div class="bf"><span class="ref">${b.reference ? `Inspired by ${esc(b.reference)}` : ''}</span>
      <input class="input" data-redo-text="${b.id}" placeholder="Ask AI to change this beat…">
      <button class="btn sm" data-redo="${b.id}">↻ Redo with AI</button></div>`;
}

// ---- Playback: the storyboard as an animatic ---------------------------------------
function tick(now) {
  if (!P.playing) return;
  P.t = Math.min(sbTotal(), P.t + ((now - P.last) / 1000) * P.speed);
  P.last = now;
  const [bi, si] = at(P.t);
  if (bi !== sel.b || si !== sel.s) select(bi, si, { keepTime: true });
  else {
    const prev = P.word;
    const html = captionHtml(beat());
    if (P.word !== prev) { const cap = $('#frame .cap-txt'); if (cap) cap.innerHTML = html; }
  }
  paintClock();
  if (P.t >= sbTotal()) return stopPlay();
  P.raf = requestAnimationFrame(tick);
}
function startPlay() {
  if (P.t >= sbTotal() - 0.05) P.t = 0;
  P.playing = true;
  P.last = performance.now();
  $('#ed').classList.add('playing');
  $('#playBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
  $('#playBtn').setAttribute('aria-label', 'Pause');
  const [bi, si] = at(P.t);
  select(bi, si, { keepTime: true });
  P.raf = requestAnimationFrame(tick);
}
function stopPlay() {
  if (!P.playing) return;
  P.playing = false;
  cancelAnimationFrame(P.raf);
  if (!$('#ed')) return;
  $('#ed').classList.remove('playing');
  $('#playBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  $('#playBtn').setAttribute('aria-label', 'Play the storyboard');
  paintFrame();
}

async function patchBeat(body, msg, beatId = beat().id) {
  try {
    s = await api(`${base}/storyboard/beats/${beatId}`, { method: 'PATCH', body });
    if (body.shot && 'layout' in body.shot) renderStoryboard(); else paintEditor();
    if (msg) toast(msg);
  } catch (err) { toast(err.message); }
}
function editorClick(t) {
  if (t.closest('[data-layout]')) { toggleLayoutPop(false); return patchBeat({ shot: { i: sel.s, layout: t.closest('[data-layout]').dataset.layout } }, 'Layout changed'); }
  if (t.closest('#layoutBtn')) return toggleLayoutPop();
  if (!t.closest('#layoutPop') && $('#layoutPop') && !$('#layoutPop').hidden) toggleLayoutPop(false);
  if (t.closest('#playBtn')) return P.playing ? stopPlay() : startPlay();
  if (t.closest('[data-speed]')) {
    P.speed = Number(t.closest('[data-speed]').dataset.speed);
    $$('#speed button').forEach((x) => x.classList.toggle('on', Number(x.dataset.speed) === P.speed));
    return;
  }
  if (t.closest('[data-nav]')) { stopPlay(); return select(sel.b + Number(t.closest('[data-nav]').dataset.nav)); }
  if (t.closest('[data-shot]')) { stopPlay(); return select(sel.b, Number(t.closest('[data-shot]').dataset.shot)); }
  if (t.closest('[data-seg]')) { const el = t.closest('[data-seg]'); return select(Number(el.dataset.seg), Number(el.dataset.shotSeg || 0)); }
  if (t.closest('[data-scrub]')) return true;
  return false;
}
document.addEventListener('keydown', (e) => {
  if (!$('#ed') || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (e.key === ' ') { e.preventDefault(); P.playing ? stopPlay() : startPlay(); }
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); stopPlay(); select(sel.b + (e.key === 'ArrowRight' ? 1 : -1)); }
  if (e.key === 'Escape') toggleLayoutPop(false);
});

async function approveBeat(beatId) {
  const beat = s.storyboard.beats.find((b) => b.id === beatId);
  try {
    s = await api(`${base}/storyboard/beats/${beatId}`, { method: 'PATCH', body: { approved: !beat.approved } });
    renderStoryboard();
  } catch (err) { toast(err.message); }
}
async function redo(beatId) {
  const input = $(`[data-redo-text="${beatId}"]`);
  const btn = $(`[data-redo="${beatId}"]`);
  btn.disabled = true;
  btn.innerHTML = '<span class="spin"></span> Rewriting…';
  try {
    s = await api(`${base}/storyboard/beats/${beatId}/redo`, { method: 'POST', body: { instruction: input.value } });
    renderStoryboard();
    toast('Beat rewritten');
  } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = '↻ Redo with AI'; }
}
async function approveAll() {
  try {
    s = await api(`${base}/approve`, { method: 'POST' });
    renderSteps();
    renderStoryboard();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) { toast(err.message); }
}
function regenerate(btn) {
  if (s.storyboard && !btn.dataset.sure) {
    btn.dataset.sure = '1';
    btn.textContent = 'Click again to replace it';
    setTimeout(() => { delete btn.dataset.sure; btn.textContent = '↻ New storyboard'; }, 3000);
    return;
  }
  generateStoryboard();
}

// ---- Start ---------------------------------------------------------------------------
(async () => {
  if (!id) { location.href = '/studio'; return; }
  try {
    const [state, status] = await Promise.all([api(base), api('/api/studio/status')]);
    s = state;
    online = status.transcriptsOnline;
    $('#sysTx').className = `pill ${online ? 'green' : 'amber'}`;
    $('#sysTx').textContent = online ? 'Online' : 'Offline';
    render();
  } catch (err) {
    $('#stage').innerHTML = `<div class="card working"><b>${esc(err.message)}</b><div style="margin-top:10px"><a class="btn" href="/studio">Back to Studio</a></div></div>`;
  }
})();
