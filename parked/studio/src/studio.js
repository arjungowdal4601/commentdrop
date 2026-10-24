import express from 'express';
import { q, one } from './db.js';
import { getVideos, parseVideoId } from './youtube.js';
import { requireCreator } from './auth.js';
import { research, clarify, writeStoryboard, redoBeat } from './studio-ai.js';
import { normalizeBeat, patchShot, patchSet } from './blueprint.js';

// Studio: one video per project. Inspiration → questions → storyboard.
export const studioRouter = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`✗ studio: ${err.message}`);
  res.status(400).json({ error: err.message });
});
studioRouter.use('/api/studio', requireCreator);

const MIN_VIDEOS = 2;
const MAX_ROUNDS = 2;

// ---- Transcripts come from Arjun's Mac (YouTube blocks cloud servers) -----------
async function workerUrl() {
  return (await one(`select v from app_config where k = 'transcript_worker_url'`))?.v || null;
}
async function workerOnline() {
  const seen = (await one(`select v from app_config where k = 'transcript_worker_seen'`))?.v;
  return Boolean(seen && Date.now() - new Date(seen) < 3 * 60_000);
}
async function fetchTranscript(videoId) {
  const base = await workerUrl();
  if (!base) throw new Error('Transcript service is not registered');
  const res = await fetch(`${base}/transcript?v=${videoId}`, {
    headers: { 'x-worker-secret': process.env.TRANSCRIPT_WORKER_SECRET || '' },
    signal: AbortSignal.timeout(25_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Transcript service ${res.status}`);
  return body.text;
}

// ---- Loading a project ------------------------------------------------------------
async function loadProject(creatorId, id) {
  const project = /^[0-9a-f-]{36}$/.test(id) && (await one('select * from studio_projects where id = $1 and creator_id = $2', [id, creatorId]));
  if (!project) throw new Error('Project not found');
  const inspirations = await q('select * from studio_inspirations where project_id = $1 order by position', [id]);
  const rounds = await q('select * from studio_rounds where project_id = $1 order by round', [id]);
  const sb = await one('select data, model, updated_at from studio_storyboards where project_id = $1', [id]);
  // Every beat gets its blueprint (shots + set), derived for storyboards written before it existed.
  const storyboard = sb?.data ? { ...sb.data, beats: sb.data.beats.map(normalizeBeat) } : null;
  return { project, inspirations, rounds, storyboard, storyboardModel: sb?.model || null };
}
// What the page gets: transcripts summarised, not sent whole.
const view = (s) => ({
  ...s,
  inspirations: s.inspirations.map(({ transcript, ...v }) => ({ ...v, transcriptWords: transcript ? transcript.split(/\s+/).length : 0 })),
});
const touch = (id, fields = {}) => {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  return q(`update studio_projects set ${[...sets, 'updated_at = now()'].join(', ')} where id = $1`, [id, ...keys.map((k) => fields[k])]);
};

// ---- Routes -------------------------------------------------------------------------
studioRouter.get('/api/studio/status', wrap(async (req, res) => {
  res.json({ transcriptsOnline: await workerOnline() });
}));

studioRouter.get('/api/studio/projects', wrap(async (req, res) => {
  res.json(await q(`
    select p.id, p.name, p.stage, p.format, p.updated_at,
      (select count(*)::int from studio_inspirations i where i.project_id = p.id) as videos,
      (select thumb from studio_inspirations i where i.project_id = p.id order by position limit 1) as thumb
    from studio_projects p where p.creator_id = $1 order by p.updated_at desc`, [req.creator.id]));
}));

studioRouter.post('/api/studio/projects', wrap(async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) throw new Error('Give your project a name');
  const format = ['auto', 'long', 'short'].includes(req.body.format) ? req.body.format : 'auto';
  res.json(await one('insert into studio_projects (creator_id, name, format) values ($1, $2, $3) returning *', [req.creator.id, name, format]));
}));

studioRouter.get('/api/studio/projects/:id', wrap(async (req, res) => {
  res.json(view(await loadProject(req.creator.id, req.params.id)));
}));

studioRouter.patch('/api/studio/projects/:id', wrap(async (req, res) => {
  const { project } = await loadProject(req.creator.id, req.params.id);
  const fields = {};
  if (req.body.name != null) fields.name = String(req.body.name).trim().slice(0, 120) || project.name;
  if (['auto', 'long', 'short'].includes(req.body.format)) fields.format = req.body.format;
  if (req.body.twist != null) fields.twist = String(req.body.twist).slice(0, 3000);
  if (req.body.research != null) {
    fields.research = String(req.body.research).slice(0, 1500);
    if (fields.research !== project.research) fields.research_notes = null; // research again on Go
  }
  await touch(project.id, fields);
  res.json(view(await loadProject(req.creator.id, project.id)));
}));

// Saves up to 4 inspiration links + notes; fetches details and transcripts for new ones.
studioRouter.put('/api/studio/projects/:id/inspirations', wrap(async (req, res) => {
  const { project, inspirations } = await loadProject(req.creator.id, req.params.id);
  const items = (req.body.items || []).slice(0, 4).map((it, i) => ({ position: i + 1, videoId: parseVideoId(it.url), url: it.url, notes: String(it.notes || '').slice(0, 2000) }));
  const bad = items.find((it) => it.url && !it.videoId);
  if (bad) throw new Error(`Video ${bad.position} isn't a YouTube link`);
  const wanted = items.filter((it) => it.videoId);

  const existing = new Map(inspirations.map((v) => [v.position, v]));
  const needDetails = wanted.filter((it) => existing.get(it.position)?.video_id !== it.videoId);
  const details = new Map((await getVideos(needDetails.map((it) => it.videoId))).map((v) => [v.id, v]));

  await Promise.all(wanted.map(async (it) => {
    const old = existing.get(it.position);
    if (old?.video_id === it.videoId) {
      await q('update studio_inspirations set notes = $1 where id = $2', [it.notes, old.id]);
      return;
    }
    const d = details.get(it.videoId);
    if (!d) throw new Error(`Video ${it.position} wasn't found (is it public?)`);
    let transcript = null;
    let error = null;
    try { transcript = await fetchTranscript(it.videoId); } catch (err) { error = err.message; }
    await q(`insert into studio_inspirations (project_id, position, video_id, title, channel, thumb, duration_sec, notes, transcript, transcript_source, transcript_error)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (project_id, position) do update set video_id = excluded.video_id, title = excluded.title, channel = excluded.channel,
        thumb = excluded.thumb, duration_sec = excluded.duration_sec, notes = excluded.notes, transcript = excluded.transcript,
        transcript_source = excluded.transcript_source, transcript_error = excluded.transcript_error`,
    [project.id, it.position, it.videoId, d.title, d.channel, d.thumb, d.durationSec, it.notes, transcript, transcript ? 'mac' : null, error]);
  }));
  const keep = wanted.map((it) => it.position);
  await q('delete from studio_inspirations where project_id = $1 and not (position = any($2::int[]))', [project.id, keep]);
  await touch(project.id);
  res.json(view(await loadProject(req.creator.id, project.id)));
}));

// Fallback when the Mac is offline or a video has no captions.
studioRouter.post('/api/studio/projects/:id/inspirations/:position/transcript', wrap(async (req, res) => {
  const { project } = await loadProject(req.creator.id, req.params.id);
  const text = String(req.body.text || '').trim();
  if (text.split(/\s+/).length < 30) throw new Error('Paste the full transcript (at least a few sentences)');
  await q(`update studio_inspirations set transcript = $1, transcript_source = 'paste', transcript_error = null where project_id = $2 and position = $3`,
    [text.slice(0, 200_000), project.id, Number(req.params.position)]);
  res.json(view(await loadProject(req.creator.id, project.id)));
}));

// "Go": research their topics (if any), then the first round of questions.
studioRouter.post('/api/studio/projects/:id/go', wrap(async (req, res) => {
  const s = await loadProject(req.creator.id, req.params.id);
  if (s.inspirations.length < MIN_VIDEOS) throw new Error(`Add at least ${MIN_VIDEOS} inspiration videos`);
  if (!s.inspirations.some((v) => v.transcript)) throw new Error('None of the videos has a transcript yet; paste one or try again');
  if (s.project.research && !s.project.research_notes) {
    s.project.research_notes = await research(s.project.research).catch(() => null);
    await touch(s.project.id, { research_notes: s.project.research_notes });
  }
  await q('delete from studio_rounds where project_id = $1', [s.project.id]); // a fresh Go restarts the questions
  const r = await clarify({ ...s, rounds: [], round: 1 });
  if (r.ready) {
    await touch(s.project.id, { stage: 'storyboard', understanding: r.understanding });
  } else {
    await q('insert into studio_rounds (project_id, round, questions) values ($1, 1, $2)', [s.project.id, JSON.stringify(r.questions)]);
    await touch(s.project.id, { stage: 'questions', understanding: r.understanding });
  }
  console.log(`🎬 ${req.creator.email}: Go on "${s.project.name}" → ${r.ready ? 'ready' : `${r.questions.length} questions`} (${r.model})`);
  res.json({ ...view(await loadProject(req.creator.id, s.project.id)), ready: r.ready });
}));

studioRouter.post('/api/studio/projects/:id/rounds/:round/answers', wrap(async (req, res) => {
  const s = await loadProject(req.creator.id, req.params.id);
  const n = Number(req.params.round);
  const round = s.rounds.find((r) => r.round === n);
  if (!round) throw new Error('Unknown question round');
  await q('update studio_rounds set answers = $1, answered_at = now() where id = $2', [JSON.stringify(req.body.answers || {}), round.id]);
  round.answers = req.body.answers || {};

  let ready = n >= MAX_ROUNDS;
  if (!ready) {
    const r = await clarify({ ...s, round: n + 1 });
    ready = r.ready;
    if (!ready) await q('insert into studio_rounds (project_id, round, questions) values ($1, $2, $3) on conflict (project_id, round) do nothing', [s.project.id, n + 1, JSON.stringify(r.questions)]);
    await touch(s.project.id, { understanding: r.understanding });
  }
  if (ready) await touch(s.project.id, { stage: 'storyboard' });
  res.json({ ...view(await loadProject(req.creator.id, s.project.id)), ready });
}));

studioRouter.post('/api/studio/projects/:id/skip', wrap(async (req, res) => {
  const { project } = await loadProject(req.creator.id, req.params.id);
  await touch(project.id, { stage: 'storyboard' });
  res.json(view(await loadProject(req.creator.id, project.id)));
}));

studioRouter.post('/api/studio/projects/:id/storyboard', wrap(async (req, res) => {
  const s = await loadProject(req.creator.id, req.params.id);
  if (!s.inspirations.some((v) => v.transcript)) throw new Error('Add inspiration videos first');
  const sb = await writeStoryboard(s);
  const { model, ...data } = sb;
  await q(`insert into studio_storyboards (project_id, data, model) values ($1, $2, $3)
    on conflict (project_id) do update set data = excluded.data, model = excluded.model, updated_at = now()`, [s.project.id, JSON.stringify(data), model]);
  await touch(s.project.id, { stage: 'storyboard' });
  console.log(`📋 ${req.creator.email}: storyboard for "${s.project.name}" — ${data.beats.length} beats, ${data.target_length_sec}s (${model})`);
  res.json(view(await loadProject(req.creator.id, s.project.id)));
}));

async function saveStoryboard(projectId, data) {
  await q('update studio_storyboards set data = $1, updated_at = now() where project_id = $2', [JSON.stringify(data), projectId]);
  await touch(projectId);
}

studioRouter.patch('/api/studio/projects/:id/storyboard/beats/:beatId', wrap(async (req, res) => {
  const s = await loadProject(req.creator.id, req.params.id);
  if (!s.storyboard) throw new Error('No storyboard yet');
  const beat = s.storyboard.beats.find((b) => b.id === req.params.beatId);
  if (!beat) throw new Error('Unknown beat');
  for (const k of ['label', 'on_screen', 'script', 'sound', 'edit']) if (typeof req.body[k] === 'string') beat[k] = req.body[k].slice(0, 4000);
  if (typeof req.body.approved === 'boolean') beat.approved = req.body.approved;
  if (req.body.shot) patchShot(beat, Number(req.body.shot.i), req.body.shot);
  if (req.body.set) patchSet(beat, req.body.set);
  await saveStoryboard(s.project.id, s.storyboard);
  res.json(view(await loadProject(req.creator.id, s.project.id)));
}));

studioRouter.post('/api/studio/projects/:id/storyboard/beats/:beatId/redo', wrap(async (req, res) => {
  const s = await loadProject(req.creator.id, req.params.id);
  if (!s.storyboard) throw new Error('No storyboard yet');
  const i = s.storyboard.beats.findIndex((b) => b.id === req.params.beatId);
  if (i < 0) throw new Error('Unknown beat');
  s.storyboard.beats[i] = await redoBeat({ ...s, beat: s.storyboard.beats[i], instruction: String(req.body.instruction || '').slice(0, 500) });
  await saveStoryboard(s.project.id, s.storyboard);
  res.json(view(await loadProject(req.creator.id, s.project.id)));
}));

studioRouter.post('/api/studio/projects/:id/approve', wrap(async (req, res) => {
  const s = await loadProject(req.creator.id, req.params.id);
  if (!s.storyboard) throw new Error('No storyboard yet');
  s.storyboard.beats.forEach((b) => { b.approved = true; });
  await saveStoryboard(s.project.id, s.storyboard);
  await touch(s.project.id, { stage: 'approved' });
  res.json(view(await loadProject(req.creator.id, s.project.id)));
}));
