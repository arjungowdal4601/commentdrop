import express from 'express';
import { q, one } from './db.js';
import { allComments, latestComments, cachedOverview, getVideo, parseVideoId, replyToComment, moderateComments, quota } from './youtube.js';
import { analyzeComments, polishReply, fallbackCategory, CATEGORIES } from './analyze.js';
import { requireCreator, canReply, accessToken } from './auth.js';
import { matchesKeyword } from './watcher.js';

// Comments page: Claude reads the video, then groups its comments by intent
// and sentiment, and the creator answers a whole group with one reply.
// Each comment also gets a category (spam and threats included) so the creator
// can hide comments, or hide them and ban the author, from the inbox.
export const commentsRouter = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => res.status(400).json({ error: err.message }));
commentsRouter.use(['/api/yt', '/api/comments'], requireCreator);

// Latest 50 uploads, shared with /api/overview's 10-minute cache.
commentsRouter.get('/api/yt/videos', wrap(async (req, res) => {
  const c = req.creator;
  if (!c.channel_id) throw new Error('No YouTube channel on this Google account');
  const { videos } = await cachedOverview(c.channel_id, Boolean(req.query.refresh));
  res.json(videos.map(({ id, title, thumb, publishedAt, views, comments }) => ({ id, title, thumb, publishedAt, views, comments })));
}));

commentsRouter.get('/api/comments/status', (req, res) => {
  res.json({ canReply: canReply(req.creator), quotaUsed: quota.used });
});

// Builds what the page shows: the saved analysis plus reply and moderation status per comment.
async function view(creatorId, videoId) {
  const row = await one('select * from analyses where creator_id = $1 and video_id = $2', [creatorId, videoId]);
  if (!row) return null;
  const a = row.data;
  const [replyRows, modRows] = await Promise.all([
    q('select * from comment_replies where creator_id = $1 and video_id = $2', [creatorId, videoId]),
    q('select * from comment_moderation where creator_id = $1 and video_id = $2', [creatorId, videoId]),
  ]);
  const replies = new Map(replyRows.map((r) => [r.comment_id, r]));
  const mods = new Map(modRows.map((r) => [r.comment_id, r]));
  // A comment asking for this video's giveaway (its keyword) is a normal request:
  // never spam, never something for the creator to review.
  const keywords = (await q('select keyword from campaigns where creator_id = $1 and video_id = $2', [creatorId, videoId])).map((r) => r.keyword);
  const asksForFile = (c) => keywords.some((k) => matchesKeyword(k, c.text));
  const byId = new Map(a.comments.map((c) => {
    let category = c.category || fallbackCategory(c); // old analyses have no category/risk
    const request = asksForFile(c);
    if (request && ['spam', 'threat', 'negative'].includes(category)) category = 'neutral';
    if (!request && category === 'neutral' && c.tone === 'suggestion') category = 'suggestion'; // a request for new content is a suggestion
    return [c.id, {
      tone: 'matter-of-fact',
      ...c,
      category,
      ...(request ? { needsReview: false, reviewReason: '', askedForFile: true } : {}),
      risk: request ? 'none' : c.risk || 'none',
      url: `https://www.youtube.com/watch?v=${videoId}&lc=${c.id}`,
      authorUrl: c.authorChannelId ? `https://www.youtube.com/channel/${c.authorChannelId}` : null,
      reply: replies.get(c.id) || null,
      moderation: mods.get(c.id) || null,
    }];
  }));
  const counts = { positive: 0, neutral: 0, negative: 0, total: a.comments.length };
  const categories = Object.fromEntries([...CATEGORIES, 'hidden'].map((k) => [k, 0]));
  const tones = {};
  for (const c of byId.values()) {
    counts[c.sentiment]++;
    categories[c.category]++;
    if (c.moderation?.status === 'done') categories.hidden++;
    tones[c.tone] = (tones[c.tone] || 0) + 1;
  }
  return {
    platform: 'youtube',
    video: { id: videoId, title: row.video_title, thumb: row.video_thumb },
    analyzedAt: row.created_at,
    brief: a.brief || null,
    summary: a.summary,
    model: a.model,
    counts,
    categories,
    tones,
    overview: a.overview || null,
    comments: [...byId.values()].sort((x, y) => String(y.publishedAt || '').localeCompare(String(x.publishedAt || ''))),
    groups: a.groups.map((g, i) => ({ index: i, tone: 'matter-of-fact', ...g, comments: g.commentIds.map((cid) => byId.get(cid)).filter(Boolean) })),
  };
}

// Which videos already have a saved analysis (for the video list).
commentsRouter.get('/api/comments/analysed', wrap(async (req, res) => {
  res.json(await q(`select video_id, created_at as analyzed_at, jsonb_array_length(data->'comments') as comments
    from analyses where creator_id = $1`, [req.creator.id]));
}));

// Newest comments straight from YouTube, so the inbox shows new ones without a
// reload. 1 quota unit; shared for 4 s so several open tabs don't multiply it.
const latestCache = new Map();
commentsRouter.get('/api/comments/youtube/:id/latest', wrap(async (req, res) => {
  const id = parseVideoId(req.params.id);
  if (!id) throw new Error('Not a valid YouTube video');
  if ((await one(`select v from app_config where k = 'live_paused'`))?.v === 'true') return res.json([]); // paused: no YouTube calls
  const hit = latestCache.get(id);
  if (!hit || Date.now() - hit.at > 4000) latestCache.set(id, { at: Date.now(), data: await latestComments(id) });
  res.json(latestCache.get(id).data);
}));

commentsRouter.get('/api/comments/youtube/:id', wrap(async (req, res) => {
  res.json(await view(req.creator.id, req.params.id));
}));

// Human review: the creator settles a comment Claude wasn't sure about.
commentsRouter.post('/api/comments/youtube/:id/review', wrap(async (req, res) => {
  const { commentId, category } = req.body;
  if (!CATEGORIES.includes(category)) throw new Error('Pick a category');
  const row = await one('select data from analyses where creator_id = $1 and video_id = $2', [req.creator.id, req.params.id]);
  if (!row) throw new Error('Analyse this video first');
  const c = row.data.comments.find((x) => x.id === commentId);
  if (!c) throw new Error('Unknown comment');
  Object.assign(c, { category, needsReview: false, reviewed: true, risk: ['spam', 'threat'].includes(category) ? (c.risk && c.risk !== 'none' ? c.risk : (category === 'spam' ? 'bot' : 'harassment')) : 'none' });
  await q('update analyses set data = $1 where creator_id = $2 and video_id = $3', [JSON.stringify(row.data), req.creator.id, req.params.id]);
  res.json(await view(req.creator.id, req.params.id));
}));

commentsRouter.post('/api/comments/youtube/:id/analyze', wrap(async (req, res) => {
  const c = req.creator;
  const id = parseVideoId(req.params.id);
  if (!id) throw new Error('Not a valid YouTube video');
  const before = quota.used;
  const video = await getVideo(id); // title, description, tags: what the video is about
  const { comments: all } = await allComments(id);
  // The creator's own comments are context for Claude, not viewer sentiment or reply targets.
  const own = (cm) => cm.authorChannelId && cm.authorChannelId === c.channel_id;
  const comments = all.filter((cm) => !own(cm));
  if (!comments.length) throw new Error('This video has no viewer comments yet');

  const keywords = (await q('select keyword from campaigns where creator_id = $1 and video_id = $2', [c.id, id])).map((r) => r.keyword);
  const result = await analyzeComments({ video, creatorName: c.channel_title || c.name || 'the creator', comments, creatorComments: all.filter(own), keywords });
  await q(`insert into analyses (creator_id, video_id, video_title, video_thumb, data) values ($1, $2, $3, $4, $5)
    on conflict (creator_id, video_id) do update set video_title = excluded.video_title, video_thumb = excluded.video_thumb,
      data = excluded.data, created_at = now()`,
  [c.id, id, video.title, video.thumb, JSON.stringify({ brief: result.brief, summary: result.summary, model: result.model, comments: result.comments, groups: result.groups, overview: result.overview })]);

  console.log(`🧠 ${c.email}: analysed ${comments.length} comments on ${id} (${result.usage.input_tokens} in / ${result.usage.output_tokens} out tokens)`);
  res.json({ ...(await view(c.id, id)), youtubeUnits: quota.used - before });
}));

// "Polish with AI": rewrites whatever the creator typed for a group. No YouTube quota.
commentsRouter.post('/api/comments/youtube/:id/polish', wrap(async (req, res) => {
  const c = req.creator;
  const current = await view(c.id, req.params.id);
  if (!current) throw new Error('Analyse this video first');
  const group = current.groups[Number(req.body.groupIndex)];
  if (!group) throw new Error('Unknown comment group');
  const draft = String(req.body.text || '').slice(0, 1000);
  const reply = await polishReply({ draft, video: current.video, brief: current.brief, group, creatorName: c.channel_title || c.name || 'the creator' });
  res.json({ reply });
}));

// Posts `text` under each comment, with the commenter's @handle in front.
// Comments already answered from here are skipped.
commentsRouter.post('/api/comments/youtube/:id/reply', wrap(async (req, res) => {
  const c = req.creator;
  if (!canReply(c)) throw new Error('Sign in again and allow YouTube so replies can be posted as your channel');
  const { commentIds = [], text = '' } = req.body;
  const reply = String(text).trim();
  if (!reply) throw new Error('Write a reply first');
  if (reply.length > 1000) throw new Error('Keep the reply under 1,000 characters');

  const current = await view(c.id, req.params.id);
  if (!current) throw new Error('Analyse this video first');
  const comments = new Map(current.groups.flatMap((g) => g.comments).map((cm) => [cm.id, cm]));
  const save = (cid, full, status, replyId, error) => q(`insert into comment_replies (comment_id, creator_id, video_id, text, status, reply_id, error)
    values ($1, $2, $3, $4, $5, $6, $7) on conflict (comment_id) do update set text = excluded.text, status = excluded.status,
      reply_id = excluded.reply_id, error = excluded.error, replied_at = now()`, [cid, c.id, req.params.id, full, status, replyId, error]);

  const token = await accessToken(c);
  const results = [];
  for (const cid of commentIds) {
    const cm = comments.get(cid);
    if (!cm) { results.push({ id: cid, status: 'skipped', error: 'Unknown comment' }); continue; }
    if (cm.reply?.status === 'sent') { results.push({ id: cid, status: 'skipped', error: 'Already replied' }); continue; }
    if (cm.moderation?.status === 'done') { results.push({ id: cid, status: 'skipped', error: 'Hidden from your channel' }); continue; }
    const full = cm.authorName?.startsWith('@') ? `${cm.authorName} ${reply}` : reply;
    try {
      const replyId = await replyToComment(cid, full, token);
      await save(cid, full, 'sent', replyId, null);
      results.push({ id: cid, status: 'sent' });
    } catch (err) {
      await save(cid, full, 'failed', null, err.message);
      results.push({ id: cid, status: 'failed', error: err.message });
    }
  }
  const sent = results.filter((r) => r.status === 'sent').length;
  console.log(`💬 ${c.email}: posted ${sent}/${commentIds.length} replies on ${req.params.id}`);
  res.json({ results, sent, analysis: await view(c.id, req.params.id), quotaUsed: quota.used });
}));

// Hides comments from the channel (YouTube "rejected"), or hides them and bans
// their authors. One-way: YouTube can't publish a rejected comment again via the API.
// Up to 50 ids per call, 50 quota units each. Already-hidden comments are skipped.
commentsRouter.post('/api/comments/youtube/:id/moderate', wrap(async (req, res) => {
  const c = req.creator;
  if (!canReply(c)) throw new Error('Sign in again and allow YouTube so comments can be moderated');
  const { commentIds = [], action } = req.body;
  if (!['hide', 'ban'].includes(action)) throw new Error('Pick hide or ban');
  if (!Array.isArray(commentIds) || !commentIds.length) throw new Error('Pick some comments first');

  const current = await view(c.id, req.params.id);
  if (!current) throw new Error('Analyse this video first');
  const comments = new Map(current.comments.map((cm) => [cm.id, cm]));
  const save = (cid, status, error) => q(`insert into comment_moderation (comment_id, creator_id, video_id, action, status, error)
    values ($1, $2, $3, $4, $5, $6) on conflict (comment_id) do update set action = excluded.action, status = excluded.status,
      error = excluded.error, moderated_at = now()`, [cid, c.id, req.params.id, action, status, error]);

  const results = [];
  const todo = [];
  for (const cid of new Set(commentIds)) {
    const cm = comments.get(cid);
    if (!cm) results.push({ id: cid, status: 'skipped', error: 'Unknown comment' });
    else if (cm.moderation?.status === 'done') results.push({ id: cid, status: 'skipped', error: 'Already hidden' });
    else todo.push(cid);
  }

  const token = todo.length ? await accessToken(c) : null;
  for (let i = 0; i < todo.length; i += 50) {
    const chunk = todo.slice(i, i + 50);
    try {
      await moderateComments(chunk, { ban: action === 'ban' }, token);
      await Promise.all(chunk.map((cid) => save(cid, 'done', null)));
      results.push(...chunk.map((cid) => ({ id: cid, status: 'done' })));
    } catch (err) {
      await Promise.all(chunk.map((cid) => save(cid, 'failed', err.message)));
      results.push(...chunk.map((cid) => ({ id: cid, status: 'failed', error: err.message })));
    }
  }
  const done = results.filter((r) => r.status === 'done').length;
  console.log(`🛡️ ${c.email}: ${action === 'ban' ? 'hid + banned' : 'hid'} ${done}/${commentIds.length} comments on ${req.params.id}`);
  res.json({ results, done, analysis: await view(c.id, req.params.id), quotaUsed: quota.used });
}));
