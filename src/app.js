import express from 'express';
import QRCode from 'qrcode';
import { q, one } from './db.js';
import { parseVideoId, getVideo, resolveHandle, cachedOverview } from './youtube.js';
import { startGoogle, finishGoogle, signOut, requireCreator, publicCreator, canEmail, appUrl } from './auth.js';
import { pollAll, pollCampaign, catchUp } from './watcher.js';
import { commentsRouter } from './comments.js';

export const app = express();
app.set('trust proxy', true);
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch((err) => res.status(400).json({ error: err.message }));
const json = express.json({ limit: '64kb' });

// ---- Sign in with Google ------------------------------------------------------
app.get('/api/auth/google', startGoogle);
app.get('/api/auth/google/callback', (req, res) => finishGoogle(req, res).catch((err) => {
  console.error(`✗ Google sign-in failed: ${err.message}`);
  res.redirect(`/?error=${encodeURIComponent(err.message)}`);
}));
app.post('/api/auth/signout', signOut);

app.get('/api/me', requireCreator, (req, res) => res.json(publicCreator(req.creator)));

app.get('/api/status', requireCreator, (req, res) => {
  const c = req.creator;
  res.json({
    youtube: c.channel_id ? 'live' : 'no-channel',
    email: canEmail(c) ? 'gmail' : 'off',
    sender: c.email,
    creator: c.channel_title || c.name,
    pollSeconds: 60,
    publicJoinUrl: `${appUrl()}/join`,
  });
});

// ---- Materials (files a creator sends) -----------------------------------------
app.get('/api/materials', requireCreator, wrap(async (req, res) => {
  res.json(await q('select id, filename, mime, size, created_at from materials where creator_id = $1 order by created_at desc', [req.creator.id]));
}));

app.post('/api/materials', requireCreator, express.raw({ type: '*/*', limit: '4mb' }), wrap(async (req, res) => {
  const filename = decodeURIComponent(String(req.get('x-filename') || '')).replace(/[^\w .()-]/g, '_').slice(0, 120);
  if (!filename) throw new Error('Missing file name');
  if (!req.body?.length) throw new Error('Empty file');
  const m = await one('insert into materials (creator_id, filename, mime, size, data) values ($1, $2, $3, $4, $5) returning id, filename, mime, size',
    [req.creator.id, filename, req.get('content-type') || 'application/octet-stream', req.body.length, req.body]);
  res.json(m);
}));

// Public download link used in emails.
app.get('/api/m/:id/:filename', wrap(async (req, res) => {
  const m = /^[0-9a-f-]{36}$/.test(req.params.id) && (await one('select filename, mime, data from materials where id = $1', [req.params.id]));
  if (!m) return res.status(404).send('Not found');
  res.set({ 'Content-Type': m.mime, 'Content-Disposition': `inline; filename="${m.filename.replace(/"/g, '')}"`, 'Cache-Control': 'public, max-age=3600' });
  res.send(Buffer.from(m.data)); // bytea comes back as Buffer (pg) or Uint8Array
}));

// ---- Automations ---------------------------------------------------------------
app.get('/api/campaigns', requireCreator, wrap(async (req, res) => {
  res.json(await q(`
    select c.*,
      (select count(*)::int from deliveries d where d.campaign_id = c.id) as requests,
      (select count(*)::int from deliveries d where d.campaign_id = c.id and d.status = 'sent') as delivered
    from campaigns c where c.creator_id = $1 order by c.id desc`, [req.creator.id]));
}));

app.post('/api/campaigns', requireCreator, json, wrap(async (req, res) => {
  const c = req.creator;
  const { videoUrl, keyword, materialId, materialName, subject, message } = req.body;
  const videoId = parseVideoId(videoUrl);
  if (!videoId) throw new Error('Pick a video or paste a YouTube link');
  const kw = String(keyword || '').trim();
  if (!kw || /\s/.test(kw)) throw new Error('Keyword must be a single word, e.g. CHEATSHEET');
  const material = await one('select id, filename from materials where id = $1 and creator_id = $2', [materialId, c.id]);
  if (!material) throw new Error('Upload or pick a file to send');

  const video = await getVideo(videoId);
  const name = String(materialName || material.filename.replace(/\.[^.]+$/, '')).trim();
  const campaign = await one(`insert into campaigns (creator_id, video_id, video_title, video_thumb, keyword, material_id, material_name, subject, message)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`, [
    c.id, videoId, video.title, video.thumb, kw.toUpperCase(), material.id, name,
    String(subject || `Your ${name} is here`).trim(),
    String(message || `Thanks for commenting! Here's the ${name} I promised in the video.`).trim(),
  ]);
  await pollCampaign(campaign).catch(() => {}); // pick up comments that already exist
  res.json(campaign);
}));

// Same row shape as GET /api/campaigns.
const campaignRow = (id, creatorId) => one(`
  select c.*,
    (select count(*)::int from deliveries d where d.campaign_id = c.id) as requests,
    (select count(*)::int from deliveries d where d.campaign_id = c.id and d.status = 'sent') as delivered
  from campaigns c where c.id = $1 and c.creator_id = $2`, [id, creatorId]);

// Edit any subset of an automation's fields; validation matches POST.
app.patch('/api/campaigns/:id', requireCreator, json, wrap(async (req, res) => {
  const c = req.creator;
  const id = /^\d+$/.test(req.params.id) && req.params.id;
  const current = id && (await one('select id, material_id from campaigns where id = $1 and creator_id = $2', [id, c.id]));
  if (!current) throw new Error('Automation not found');
  const b = req.body || {};
  const set = {};
  if ('active' in b) set.active = Boolean(b.active);
  if ('keyword' in b) {
    const kw = String(b.keyword || '').trim();
    if (!kw || /\s/.test(kw)) throw new Error('Keyword must be a single word, e.g. CHEATSHEET');
    set.keyword = kw.toUpperCase();
  }
  if ('materialId' in b) {
    const material = /^[0-9a-f-]{36}$/.test(String(b.materialId)) && (await one('select id, filename from materials where id = $1 and creator_id = $2', [b.materialId, c.id]));
    if (!material) throw new Error('Upload or pick a file to send');
    set.material_id = material.id;
    if (material.id !== current.material_id && !('materialName' in b)) set.material_name = material.filename.replace(/\.[^.]+$/, '');
  }
  const text = (field, label, max) => {
    const v = String(b[field] ?? '').trim();
    if (!v) throw new Error(`${label} can't be empty`);
    return v.slice(0, max);
  };
  if ('materialName' in b) set.material_name = text('materialName', 'File name', 200);
  if ('subject' in b) set.subject = text('subject', 'Subject', 200);
  if ('message' in b) set.message = text('message', 'Message', 2000);

  const cols = Object.keys(set);
  if (cols.length) {
    await q(`update campaigns set ${cols.map((k, i) => `${k} = $${i + 3}`).join(', ')} where id = $1 and creator_id = $2`,
      [id, c.id, ...Object.values(set)]);
  }
  res.json(await campaignRow(id, c.id));
}));

// ---- Overview (dashboard home) ----------------------------------------------------
// YouTube part is cached 10 min per channel (?refresh=1 skips it); DB counts are always fresh.
app.get('/api/overview', requireCreator, wrap(async (req, res) => {
  const c = req.creator;
  if (!c.channel_id) throw new Error('No YouTube channel on this Google account');
  const yt = await cachedOverview(c.channel_id, Boolean(req.query.refresh));
  const ids = yt.videos.map((v) => v.id);

  // Newest active campaign per video, else the newest one.
  const campaigns = ids.length ? await q(`
    select distinct on (c.video_id) c.id, c.video_id, c.keyword, c.material_name, c.active,
      (select count(*)::int from deliveries d where d.campaign_id = c.id and d.status = 'sent') as sent,
      (select count(*)::int from deliveries d where d.campaign_id = c.id and d.status = 'waiting') as waiting
    from campaigns c where c.creator_id = $1 and c.video_id = any($2)
    order by c.video_id, c.active desc, c.id desc`, [c.id, ids]) : [];
  const byVideo = new Map(campaigns.map((r) => [r.video_id, r]));

  const counts = await one(`
    select count(*)::int as total,
      count(*) filter (where status = 'sent')::int as sent,
      count(*) filter (where status = 'waiting')::int as waiting
    from deliveries where creator_id = $1`, [c.id]);

  const videos = yt.videos.map((v) => {
    const a = byVideo.get(v.id);
    return {
      id: v.id, title: v.title, thumb: v.thumb, publishedAt: v.publishedAt,
      views: v.views, likes: v.likes, comments: v.comments,
      automation: a ? { id: a.id, keyword: a.keyword, materialName: a.material_name, active: a.active, sent: a.sent, waiting: a.waiting } : null,
    };
  });
  const withAutomation = videos.filter((v) => v.automation?.active).length;
  res.json({
    channel: yt.channel,
    videos,
    totals: {
      views: yt.channel.views,
      subscribers: yt.channel.subscribers,
      comments: videos.reduce((n, v) => n + (v.comments || 0), 0),
      keywordComments: counts.total,
      documentsSent: counts.sent,
      waiting: counts.waiting,
      videos: videos.length,
      withAutomation,
      withoutAutomation: videos.length - withAutomation,
    },
  });
}));

app.get('/api/activity', requireCreator, wrap(async (req, res) => {
  res.json(await q(`
    select d.*, c.keyword, c.material_name, c.video_title, v.email as viewer_email
    from deliveries d join campaigns c on c.id = d.campaign_id left join viewers v on v.id = d.viewer_id
    where d.creator_id = $1 order by d.detected_at desc limit 50`, [req.creator.id]));
}));

// Viewers who asked this creator for something (viewer emails stay private to that creator).
app.get('/api/viewers', requireCreator, wrap(async (req, res) => {
  res.json(await q(`
    select distinct on (v.id) v.id, v.email, v.youtube_handle, v.youtube_name, v.youtube_avatar, v.created_at
    from viewers v join deliveries d on d.viewer_id = v.id where d.creator_id = $1 order by v.id desc`, [req.creator.id]));
}));

// ---- Viewer sign-up (public) ---------------------------------------------------
app.post('/api/viewers', json, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email');
  const ch = await resolveHandle(req.body.handle);
  await q(`insert into viewers (email, youtube_channel_id, youtube_handle, youtube_name, youtube_avatar) values ($1, $2, $3, $4, $5)
    on conflict (youtube_channel_id) do update set email = excluded.email, youtube_handle = excluded.youtube_handle,
      youtube_name = excluded.youtube_name, youtube_avatar = excluded.youtube_avatar`,
  [email, ch.channelId, ch.handle, ch.name, ch.avatar]);
  const caughtUp = await catchUp(ch.channelId);
  res.json({ ...ch, email, caughtUp });
}));

app.get('/api/join-qr.svg', wrap(async (req, res) => {
  res.type('image/svg+xml').send(await QRCode.toString(`${appUrl()}/join`, { type: 'svg', margin: 1, width: 220 }));
}));

// ---- Scheduler: Supabase pg_cron calls this every minute ------------------------
app.post('/api/cron/poll', wrap(async (req, res) => {
  if (!process.env.CRON_SECRET || req.get('x-cron-secret') !== process.env.CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ at: new Date().toISOString(), results: await pollAll() });
}));

app.use(json, commentsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});
